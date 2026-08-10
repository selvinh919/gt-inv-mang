import Stripe from "stripe";
import { completePendingStripeCheckout } from "../_lib/pos.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
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
