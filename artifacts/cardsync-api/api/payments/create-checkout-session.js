import Stripe from "stripe";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function moneyToCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.round(numeric * 100);
}

function sanitizeLineItem(raw) {
  const quantity = Math.max(1, Math.floor(Number(raw?.quantity || 1)));
  const unitAmount = moneyToCents(raw?.unit_price);
  const name = String(raw?.name || "Inventory Item").trim().slice(0, 120) || "Inventory Item";
  const description = String(raw?.description || "").trim().slice(0, 400) || undefined;

  return {
    quantity,
    price_data: {
      currency: "usd",
      product_data: {
        name,
        description,
      },
      unit_amount: unitAmount,
    },
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!stripeSecretKey) {
    res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    return;
  }

  const stripe = new Stripe(stripeSecretKey);

  try {
    const body = req.body || {};
    const lineItemsRaw = Array.isArray(body.line_items) ? body.line_items : [];
    const line_items = lineItemsRaw.map(sanitizeLineItem).filter((item) => item.price_data.unit_amount > 0);

    if (line_items.length === 0) {
      res.status(400).json({ error: "At least one valid line item is required" });
      return;
    }

    const taxAmount = moneyToCents(body.tax_amount || 0);
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

    const successUrl = String(body.success_url || "").trim();
    const cancelUrl = String(body.cancel_url || "").trim();
    if (!successUrl || !cancelUrl) {
      res.status(400).json({ error: "success_url and cancel_url are required" });
      return;
    }

    const metadata = {
      source: "vault-pos",
      tenant_id: String(body.tenant_id || "").slice(0, 120),
      organization_id: String(body.organization_id || "").slice(0, 120),
      location_id: String(body.location_id || "").slice(0, 120),
      collection_id: String(body.collection_id || ""),
      sale_id: String(body.sale_id || ""),
      customer_name: String(body.customer_name || "").slice(0, 200),
      payment_status: String(body.payment_status || "").slice(0, 40),
    };

    const stripeAccount = String(body.stripe_account || process.env.STRIPE_CONNECTED_ACCOUNT || "").trim();

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

    res.status(200).json({
      id: session.id,
      url: session.url,
    });
  } catch (error) {
    res.status(500).json({ error: "Stripe checkout session creation failed", detail: String(error) });
  }
}
