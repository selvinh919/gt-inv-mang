import Stripe from "stripe";
import { setCors } from "../_lib/auth.js";
import { requireAuthContext } from "../_lib/collection.js";
import { quoteCheckout, savePendingStripeCheckout } from "../_lib/pos.js";

function moneyToCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.round(numeric * 100);
}

export default async function handler(req, res) {
  setCors(req, res, "POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const scope = await requireAuthContext(req, res);
  if (!scope) return;

  const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!stripeSecretKey) {
    res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    return;
  }

  const stripe = new Stripe(stripeSecretKey);

  try {
    const body = req.body || {};
    const quote = await quoteCheckout(scope, body);
    const line_items = quote.lines.map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency: "usd",
        product_data: { name: line.name.slice(0, 120), description: line.description.slice(0, 400) || undefined },
        unit_amount: moneyToCents(line.unit_price),
      },
    }));
    const taxAmount = moneyToCents(quote.tax);
    if (taxAmount > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          product_data: { name: "Sales Tax" },
          unit_amount: taxAmount,
        },
      });
    }

    const appOrigin = String(process.env.AUTH_DEFAULT_REDIRECT_URL || "https://gtcollectibles.io/auth");
    const origin = new URL(appOrigin).origin;
    const successUrl = `${origin}/pos?stripe=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/pos?stripe=cancel`;

    const metadata = {
      source: "vault-pos",
      tenant_id: scope.tenantId.slice(0, 120),
      organization_id: scope.organizationId.slice(0, 120),
      location_id: scope.locationId.slice(0, 120),
      collection_id: String(quote.collection_id),
      actor_subject: scope.userId.slice(0, 120),
      idempotency_key: String(body.idempotency_key || "").slice(0, 200),
    };

    const stripeAccount = String(process.env.STRIPE_CONNECTED_ACCOUNT || "").trim();

    const stripeIdempotencyKey = String(body.idempotency_key || req.headers["idempotency-key"] || "").trim();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      customer_email: body.customer_email ? String(body.customer_email) : undefined,
      billing_address_collection: "auto",
    }, {
      ...(stripeAccount ? { stripeAccount } : {}),
      ...(stripeIdempotencyKey ? { idempotencyKey: stripeIdempotencyKey } : {}),
    });

    await savePendingStripeCheckout(scope, session.id, {
      collection_id: quote.collection_id,
      lines: quote.lines.map(({ item_id, quantity, unit_price }) => ({ item_id, quantity, unit_price })),
      customer_id: Number(body.customer_id) || null,
      notes: String(body.notes || "").trim() || null,
      idempotency_key: String(body.idempotency_key || session.id),
      total: quote.total,
    });

    res.status(200).json({
      id: session.id,
      url: session.url,
    });
  } catch (error) {
    res.status(500).json({ error: "Stripe checkout session creation failed", detail: String(error) });
  }
}
