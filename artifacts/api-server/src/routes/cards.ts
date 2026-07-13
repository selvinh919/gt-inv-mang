import { Router } from "express";
import { SearchCardsQueryParams } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

const TCG_API_BASE = "https://api.tcgapi.dev/v1";
const TCG_API_KEY = process.env.TCG_API_KEY;

// GET /api/cards/search
router.get("/search", async (req, res) => {
  const parsed = SearchCardsQueryParams.safeParse({
    q: req.query.q,
    game: req.query.game,
    per_page: req.query.per_page ? Number(req.query.per_page) : undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required query parameter: q" });
    return;
  }

  const { q, game, per_page } = parsed.data;

  const params = new URLSearchParams({ q: q! });
  if (game) params.set("game", game);
  if (per_page) params.set("per_page", String(per_page));

  try {
    const response = await fetch(`${TCG_API_BASE}/search/cards?${params.toString()}`, {
      headers: {
        "X-API-Key": TCG_API_KEY ?? "",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text }, "TCG API error");
      res.status(502).json({ error: `TCG API error: ${response.status}` });
      return;
    }

    const data = await response.json() as { data?: unknown[] };
    const cards = data.data ?? [];
    res.json(cards);
  } catch (err) {
    logger.error({ err }, "Failed to fetch from TCG API");
    res.status(502).json({ error: "Failed to reach TCG API" });
  }
});

export default router;
