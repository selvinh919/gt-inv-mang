import { Router } from "express";
import { db, collectionItems } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import {
  AddToCollectionBody,
  UpdateCollectionItemBody,
  GetCollectionItemParams,
  UpdateCollectionItemParams,
  RemoveFromCollectionParams,
  SearchCardsQueryParams,
} from "@workspace/api-zod";

const router = Router();

function toNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function serializeItem(item: typeof collectionItems.$inferSelect) {
  return {
    ...item,
    market_price: toNumber(item.market_price),
    low_price: toNumber(item.low_price),
    added_at: item.added_at.toISOString(),
  };
}

// GET /api/collection
router.get("/", async (req, res) => {
  const items = await db
    .select()
    .from(collectionItems)
    .orderBy(desc(collectionItems.added_at));
  res.json(items.map(serializeItem));
});

// POST /api/collection
router.post("/", async (req, res) => {
  const parsed = AddToCollectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const [item] = await db
    .insert(collectionItems)
    .values({
      card_id: data.card_id,
      card_name: data.card_name,
      set_name: data.set_name ?? null,
      game_name: data.game_name ?? null,
      rarity: data.rarity ?? null,
      printing: data.printing,
      market_price: data.market_price != null ? String(data.market_price) : null,
      low_price: data.low_price != null ? String(data.low_price) : null,
      image_url: data.image_url ?? null,
      quantity: data.quantity,
      notes: data.notes ?? null,
    })
    .returning();
  res.status(201).json(serializeItem(item));
});

// GET /api/collection/summary
router.get("/summary", async (req, res) => {
  const items = await db.select().from(collectionItems);

  const total_cards = items.reduce((sum, i) => sum + i.quantity, 0);
  const unique_cards = items.length;
  const total_value = items.reduce((sum, i) => {
    const price = toNumber(i.market_price) ?? 0;
    return sum + price * i.quantity;
  }, 0);

  const gameMap = new Map<string, { count: number; total_value: number }>();
  for (const item of items) {
    const game = item.game_name ?? "Unknown";
    const existing = gameMap.get(game) ?? { count: 0, total_value: 0 };
    const price = toNumber(item.market_price) ?? 0;
    gameMap.set(game, {
      count: existing.count + item.quantity,
      total_value: existing.total_value + price * item.quantity,
    });
  }

  const by_game = Array.from(gameMap.entries())
    .map(([game, stats]) => ({ game, ...stats }))
    .sort((a, b) => b.total_value - a.total_value);

  const top_cards = [...items]
    .sort((a, b) => (toNumber(b.market_price) ?? 0) - (toNumber(a.market_price) ?? 0))
    .slice(0, 5)
    .map(serializeItem);

  res.json({ total_cards, unique_cards, total_value, by_game, top_cards });
});

// GET /api/collection/:id
router.get("/:id", async (req, res) => {
  const parsed = GetCollectionItemParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [item] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, parsed.data.id));
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeItem(item));
});

// PATCH /api/collection/:id
router.patch("/:id", async (req, res) => {
  const paramsParsed = UpdateCollectionItemParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateCollectionItemBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }
  const updates: Partial<typeof collectionItems.$inferInsert> = {};
  const body = bodyParsed.data;
  if (body.quantity !== undefined) updates.quantity = body.quantity;
  if (body.notes !== undefined) updates.notes = body.notes ?? null;
  if (body.market_price !== undefined)
    updates.market_price = body.market_price != null ? String(body.market_price) : null;

  const [item] = await db
    .update(collectionItems)
    .set(updates)
    .where(eq(collectionItems.id, paramsParsed.data.id))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeItem(item));
});

// DELETE /api/collection/:id
router.delete("/:id", async (req, res) => {
  const parsed = RemoveFromCollectionParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(collectionItems).where(eq(collectionItems.id, parsed.data.id));
  res.status(204).send();
});

export default router;
