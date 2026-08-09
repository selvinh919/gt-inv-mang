function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const tcgplayerId = Number(req.query?.tcgplayerId);
  if (!Number.isInteger(tcgplayerId) || tcgplayerId <= 0) {
    res.status(400).json({ error: "Invalid tcgplayerId" });
    return;
  }

  try {
    const response = await fetch(`https://openapi.tcgtracking.com/v1/products/${tcgplayerId}`, {
      headers: { Accept: "application/json" },
    });

    if (response.status === 404) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (!response.ok) {
      res.status(502).json({ error: `tcgtracking error: ${response.status}` });
      return;
    }

    const data = await response.json();
    const skus = (data?.skus || [])
      .filter((sku) => sku.language_name === "English")
      .map((sku) => ({
        sku_id: sku.sku_id,
        condition_name: sku.condition_name,
        variant_name: sku.variant_name,
        language_name: sku.language_name,
        market_price: sku.market_price ? Number(sku.market_price) : null,
        lowest_price: sku.lowest_price ? Number(sku.lowest_price) : null,
        highest_price: sku.highest_price ? Number(sku.highest_price) : null,
        price_count: sku.price_count ?? null,
        price_updated_at: sku.price_updated_at ?? null,
      }));

    res.status(200).json({
      product_id: data?.product_id ?? tcgplayerId,
      product_name: data?.product?.name ?? null,
      skus,
    });
  } catch (error) {
    res.status(502).json({ error: "Failed to reach tcgtracking", detail: String(error) });
  }
}
