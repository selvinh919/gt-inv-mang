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

  // The TCG API matches against card names only (clean_name), not card numbers.
  // Strip trailing tokens that look like card numbers (e.g. "199", "199/264", "6/100")
  // so a query like "charizard ex 199" becomes "charizard ex".
  const cleanedQ = (q ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => !/^\d+(\/\d+)?$/.test(token))
    .join(" ")
    .trim() || (q ?? "");

  const params = new URLSearchParams({ q: cleanedQ });
  if (game) params.set("game", game);
  if (per_page) params.set("per_page", String(per_page));

  try {
    const response = await fetch(`${TCG_API_BASE}/search?${params.toString()}`, {
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
