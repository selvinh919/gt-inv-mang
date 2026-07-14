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

// GET /api/cards/:tcgplayerId/condition-prices
router.get("/:tcgplayerId/condition-prices", async (req, res) => {
  const tcgplayerId = Number(req.params.tcgplayerId);
  if (!Number.isInteger(tcgplayerId) || tcgplayerId <= 0) {
    res.status(400).json({ error: "Invalid tcgplayerId" });
    return;
  }

  try {
    const response = await fetch(
      `https://openapi.tcgtracking.com/v1/products/${tcgplayerId}`,
      { headers: { Accept: "application/json" } }
    );

    if (response.status === 404) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (!response.ok) {
      req.log.error({ status: response.status }, "tcgtracking error");
      res.status(502).json({ error: `tcgtracking error: ${response.status}` });
      return;
    }

    const data = await response.json() as {
      success: boolean;
      product_id: number;
      product?: { name?: string };
      skus?: Array<{
        sku_id: number;
        condition_name: string;
        variant_name: string;
        language_name: string;
        market_price: string | null;
        lowest_price: string | null;
        highest_price: string | null;
        price_count: number | null;
        price_updated_at: string | null;
      }>;
    };

    const skus = (data.skus ?? [])
      .filter((s) => s.language_name === "English")
      .map((s) => ({
        sku_id: s.sku_id,
        condition_name: s.condition_name,
        variant_name: s.variant_name,
        language_name: s.language_name,
        market_price: s.market_price ? parseFloat(s.market_price) : null,
        lowest_price: s.lowest_price ? parseFloat(s.lowest_price) : null,
        highest_price: s.highest_price ? parseFloat(s.highest_price) : null,
        price_count: s.price_count,
        price_updated_at: s.price_updated_at,
      }));

    res.json({
      product_id: data.product_id,
      product_name: data.product?.name ?? null,
      skus,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch condition prices");
    res.status(502).json({ error: "Failed to reach tcgtracking" });
  }
});

const TCGTRACKING_GAME_IDS: Record<string, number> = {
  pokemon: 3,
  magic: 1,
  yugioh: 2,
  "flesh-and-blood": 62,
  lorcana: 77,
  "one-piece-card-game": 58,
};

// POST /api/cards/scan
router.post("/scan", async (req, res) => {
  const { game, image } = req.body as { game?: string; image?: string };

  if (!image) {
    res.status(400).json({ error: "image is required" });
    return;
  }

  const gameId = TCGTRACKING_GAME_IDS[game ?? "pokemon"] ?? 3;

  try {
    const response = await fetch("https://openapi.tcgtracking.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gameId, image }),
    });

    if (!response.ok) {
      const text = await response.text();
      req.log.error({ status: response.status, body: text }, "tcgtracking scan error");
      res.status(502).json({ error: "Scan API error" });
      return;
    }

    const data = await response.json() as {
      success: boolean;
      results?: Array<{
        product_id: number;
        score: number;
        name: string;
        number?: string;
        printing?: string;
        set_id?: number;
      }>;
      candidates_scanned?: number;
    };

    res.json({
      success: data.success,
      results: (data.results ?? []).map((r) => ({
        product_id: r.product_id,
        score: r.score,
        name: r.name,
        number: r.number ?? null,
        printing: r.printing ?? null,
        set_id: r.set_id ?? null,
      })),
      candidates_scanned: data.candidates_scanned ?? 0,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to scan card");
    res.status(502).json({ error: "Failed to reach scan API" });
  }
});

export default router;
