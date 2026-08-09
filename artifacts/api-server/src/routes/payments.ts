import { Router } from "express";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db, posSales, stripeWebhookEvents } from "@workspace/db";

const router = Router();

function getStripeClient(): Stripe {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }
  return new Stripe(secretKey);
}

function asNullableString(value: unknown): string | null {
  const v = String(value || "").trim();
  return v ? v : null;
}

function parseScopeFromMetadata(metadata: Record<string, string> | null | undefined) {
  return {
    tenantId: asNullableString(metadata?.tenant_id) || "public",
    organizationId: asNullableString(metadata?.organization_id) || "default",
    locationId: asNullableString(metadata?.location_id) || "main",
  };
}

async function reconcileSalePayment(input: {
  saleId: number;
  tenantId: string;
  organizationId: string;
  locationId: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  eventType: string;
  checkoutSessionId?: string | null;
  paymentIntentId?: string | null;
  settled: boolean;
}) {
  const existing = await db
    .select()
    .from(posSales)
    .where(and(
      eq(posSales.id, input.saleId),
      eq(posSales.tenant_id, input.tenantId),
      eq(posSales.organization_id, input.organizationId),
      eq(posSales.location_id, input.locationId),
    ))
    .limit(1);

  if (!existing[0]) return;

  await db
    .update(posSales)
    .set({
      payment_status: input.status,
      payment_last_event: input.eventType,
      status: input.settled ? "PAID" : input.status === "failed" ? "PENDING_PAYMENT" : existing[0].status,
      stripe_checkout_session_id: input.checkoutSessionId ?? existing[0].stripe_checkout_session_id,
      stripe_payment_intent_id: input.paymentIntentId ?? existing[0].stripe_payment_intent_id,
      settled_at: input.settled ? new Date() : existing[0].settled_at,
    })
    .where(and(
      eq(posSales.id, input.saleId),
      eq(posSales.tenant_id, input.tenantId),
      eq(posSales.organization_id, input.organizationId),
      eq(posSales.location_id, input.locationId),
    ));
}

router.post("/stripe/webhook", async (req, res) => {
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    res.status(500).json({ error: "AUTH_CONFIGURATION_ERROR", message: "Missing STRIPE_WEBHOOK_SECRET" });
    return;
  }

  try {
    const stripe = getStripeClient();
    const signature = req.headers["stripe-signature"];
    if (!signature || Array.isArray(signature)) {
      res.status(400).json({ error: "INVALID_WEBHOOK_SIGNATURE", message: "Missing Stripe signature header" });
      return;
    }

    const event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    const eventObject = event.data.object as unknown as Record<string, unknown>;
    const metadata = (eventObject.metadata || {}) as Record<string, string>;
    const scope = parseScopeFromMetadata(metadata);

    const existing = await db
      .select()
      .from(stripeWebhookEvents)
      .where(and(
        eq(stripeWebhookEvents.tenant_id, scope.tenantId),
        eq(stripeWebhookEvents.organization_id, scope.organizationId),
        eq(stripeWebhookEvents.location_id, scope.locationId),
        eq(stripeWebhookEvents.stripe_event_id, event.id),
      ))
      .limit(1);

    if (existing[0]) {
      res.status(200).json({ received: true, replay: true });
      return;
    }

    await db.insert(stripeWebhookEvents).values({
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      location_id: scope.locationId,
      stripe_event_id: event.id,
      event_type: event.type,
      event_created_at: new Date(event.created * 1000),
      payload_json: JSON.stringify(event),
    });

    const saleId = Number(metadata.sale_id || 0);
    const checkoutSessionId = asNullableString((eventObject.id as string) || null);
    const paymentIntentId = asNullableString((eventObject.payment_intent as string) || null);

    if (saleId > 0) {
      if (event.type === "checkout.session.completed") {
        await reconcileSalePayment({
          saleId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          locationId: scope.locationId,
          status: "succeeded",
          eventType: event.type,
          checkoutSessionId,
          paymentIntentId,
          settled: true,
        });
      }

      if (event.type === "payment_intent.succeeded") {
        await reconcileSalePayment({
          saleId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          locationId: scope.locationId,
          status: "succeeded",
          eventType: event.type,
          paymentIntentId: asNullableString((eventObject.id as string) || null),
          settled: true,
        });
      }

      if (event.type === "payment_intent.payment_failed") {
        await reconcileSalePayment({
          saleId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          locationId: scope.locationId,
          status: "failed",
          eventType: event.type,
          paymentIntentId: asNullableString((eventObject.id as string) || null),
          settled: false,
        });
      }

      if (event.type === "charge.refunded") {
        await reconcileSalePayment({
          saleId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          locationId: scope.locationId,
          status: "refunded",
          eventType: event.type,
          paymentIntentId: asNullableString((eventObject.payment_intent as string) || null),
          settled: false,
        });
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    res.status(400).json({
      error: "INVALID_WEBHOOK_PAYLOAD",
      message: error instanceof Error ? error.message : "Invalid Stripe event",
    });
  }
});

export default router;
