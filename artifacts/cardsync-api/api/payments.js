import Stripe from "stripe";
import { setCors } from "./_lib/auth.js";
import { requireAuthContext } from "./_lib/collection.js";
import { completePendingStripeCheckout, quoteCheckout, savePendingStripeCheckout } from "./_lib/pos.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function route(req) {
  return new URL(req.url, "http://localhost").pathname.replace(/^\/api\/payments\/?/, "");
}

function cents(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 100) : 0;
}

async function webhook(req, res) {
  const secret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const signature = String(req.headers["stripe-signature"] || "");
  if (!secret || !webhookSecret || !signature) return res.status(503).json({ error: "Stripe webhook is not configured" });
  try {
    const stripe = new Stripe(secret);
    const event = stripe.webhooks.constructEvent(await rawBody(req), signature, webhookSecret);
    if (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") {
      await completePendingStripeCheckout(event.data.object.id);
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid webhook" });
  }
}

async function createCheckout(req, res) {
  setCors(req, res, "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const scope = await requireAuthContext(req, res);
  if (!scope) return;
  const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!stripeSecretKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
  try {
    const raw = await rawBody(req);
    const body = JSON.parse(raw.toString("utf8") || "{}");
    const quote = await quoteCheckout(scope, body);
    const line_items = quote.lines.map((line) => ({
      quantity: line.quantity,
      price_data: { currency: "usd", product_data: { name: line.name.slice(0, 120), description: line.description.slice(0, 400) || undefined }, unit_amount: cents(line.unit_price) },
    }));
    if (quote.tax > 0) line_items.push({ quantity: 1, price_data: { currency: "usd", product_data: { name: "Sales Tax" }, unit_amount: cents(quote.tax) } });
    const origin = new URL(String(process.env.AUTH_DEFAULT_REDIRECT_URL || "https://gtcollectibles.io/auth")).origin;
    const idempotencyKey = String(body.idempotency_key || req.headers["idempotency-key"] || "").trim();
    if (!idempotencyKey) return res.status(400).json({ error: "Idempotency key is required" });
    const stripeAccount = String(process.env.STRIPE_CONNECTED_ACCOUNT || "").trim();
    const stripe = new Stripe(stripeSecretKey);
    const session = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card"], line_items,
      success_url: `${origin}/pos?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pos?stripe=cancel`,
      metadata: { source: "vault-pos", tenant_id: scope.tenantId.slice(0, 120), collection_id: String(quote.collection_id), actor_subject: scope.userId.slice(0, 120), idempotency_key: idempotencyKey.slice(0, 200) },
      customer_email: body.customer_email ? String(body.customer_email) : undefined,
      billing_address_collection: "auto",
    }, { ...(stripeAccount ? { stripeAccount } : {}), idempotencyKey });
    await savePendingStripeCheckout(scope, session.id, {
      collection_id: quote.collection_id,
      lines: quote.lines.map(({ item_id, quantity, unit_price }) => ({ item_id, quantity, unit_price })),
      customer_id: Number(body.customer_id) || null, notes: String(body.notes || "").trim() || null,
      idempotency_key: idempotencyKey, total: quote.total,
    });
    return res.status(200).json({ id: session.id, url: session.url });
  } catch (error) {
    return res.status(500).json({ error: "Stripe checkout session creation failed", detail: String(error) });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "OPTIONS") return res.status(405).json({ error: "Method not allowed" });
  if (route(req) === "webhook") return webhook(req, res);
  if (route(req) === "create-checkout-session") return createCheckout(req, res);
  return res.status(404).json({ error: "Not found" });
}
