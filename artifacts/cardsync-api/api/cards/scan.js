function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const GAME_IDS = {
  pokemon: 3,
  magic: 1,
  yugioh: 2,
  "flesh-and-blood": 62,
  lorcana: 77,
  "one-piece-card-game": 58,
};

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

  const game = req.body?.game || "pokemon";
  const image = req.body?.image;
  if (!image) {
    res.status(400).json({ error: "image is required" });
    return;
  }

  const gameId = GAME_IDS[game] || 3;

  try {
    const response = await fetch("https://openapi.tcgtracking.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gameId, image }),
    });

    if (!response.ok) {
      const body = await response.text();
      res.status(502).json({ error: "Scan API error", body });
      return;
    }

    const data = await response.json();
    const results = (data?.results || []).map((r) => ({
      product_id: r.product_id,
      score: r.score,
      name: r.name,
      number: r.number ?? null,
      printing: r.printing ?? null,
      set_id: r.set_id ?? null,
    }));

    res.status(200).json({
      success: Boolean(data?.success),
      results,
      candidates_scanned: data?.candidates_scanned || 0,
    });
  } catch (error) {
    res.status(502).json({ error: "Failed to reach scan API", detail: String(error) });
  }
}
