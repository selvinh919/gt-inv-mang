import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const TCG_API_BASE = "https://api.tcgapi.dev/v1";
const TCG_API_KEY = process.env.TCG_API_KEY;

/**
 * Parse a raw search query into a name part and an optional card-number filter.
 *
 * Examples:
 *   "charizard ex 199"      → { name: "charizard ex", numberFilter: "199" }
 *   "charizard ex 199/165"  → { name: "charizard ex", numberFilter: "199/165" }
 *   "pikachu"               → { name: "pikachu",       numberFilter: null }
 *   "dark magician"         → { name: "dark magician", numberFilter: null }
 */
function parseQuery(raw: string): { name: string; numberFilter: string | null } {
  const tokens = raw.trim().split(/\s+/);
  const numberTokens: string[] = [];
  const nameTokens: string[] = [];

  for (const token of tokens) {
    // A card number looks like "199", "199/165", "006", "XY121"
    // Pure digit (with optional /digits) = number; otherwise name token
    if (/^\d+(\/\d+)?$/.test(token)) {
      numberTokens.push(token);
    } else {
      nameTokens.push(token);
    }
  }

  const name = nameTokens.join(" ").trim() || raw.trim();
  const numberFilter = numberTokens.length > 0 ? numberTokens.join("/") : null;

  return { name, numberFilter };
}

// GET /api/cards/search?q=...&game=...&per_page=...
router.get("/search", async (req, res) => {
  const rawQ = (req.query.q as string | undefined)?.trim() ?? "";
  if (rawQ.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const game = (req.query.game as string | undefined) ?? undefined;
  const requestedPerPage = req.query.per_page ? Number(req.query.per_page) : undefined;

  const { name, numberFilter } = parseQuery(rawQ);

  // When filtering by number we need a bigger result set since the number match
  // happens after the API call. Max the API allows is 100.
  const perPage = numberFilter ? 100 : Math.min(requestedPerPage ?? 50, 100);

  const params = new URLSearchParams({ q: name, per_page: String(perPage) });
  if (game) params.set("game", game);

  try {
    const response = await fetch(`${TCG_API_BASE}/search?${params.toString()}`, {
      headers: { "X-API-Key": TCG_API_KEY ?? "" },
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text }, "TCG API error");
      res.status(502).json({ error: `TCG API error: ${response.status}` });
      return;
    }

    const data = await response.json() as { data?: Record<string, unknown>[] };
    let cards = data.data ?? [];

    // If the user included a card number, filter results to those whose `number`
    // field contains the requested token (e.g. "199" matches "199/165").
    if (numberFilter) {
      const needle = numberFilter.split("/")[0]; // e.g. "199" from "199/165"
      cards = cards.filter((card) => {
        const num = card.number as string | null | undefined;
        if (!num) return false;
        // Match when the card number starts with or equals the needle
        return num === needle || num.startsWith(`${needle}/`) || num.endsWith(`/${needle}`);
      });
    }

    res.json(cards);
  } catch (err) {
    logger.error({ err }, "Failed to fetch from TCG API");
    res.status(502).json({ error: "Failed to reach TCG API" });
  }
});

export default router;
