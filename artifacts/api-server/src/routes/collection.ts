import { Router } from "express";
import type { Request } from "express";
import { db, collectionItems } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import {
  AddToCollectionBody,
  UpdateCollectionItemBody,
  GetCollectionItemParams,
  UpdateCollectionItemParams,
  RemoveFromCollectionParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { requirePermission } from "../middlewares/permissions";
import { ApiError, toErrorPayload } from "../lib/api-errors";
import { writeAuditLog } from "../lib/audit";

const router = Router();
router.use(requireAuth);

function scopeFromRequest(req: Request) {
  if (!req.authContext) {
    throw new ApiError("AUTH_REQUIRED", "Authentication required", 401);
  }

  return {
    tenantId: req.authContext.tenantId,
    organizationId: req.authContext.organizationId,
    locationId: req.authContext.locationId,
  };
}

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
    price_paid: toNumber(item.price_paid),
    price_paid_percent: toNumber(item.price_paid_percent),
    market_price_at_add: toNumber(item.market_price_at_add),
    added_at: item.added_at.toISOString(),
    updated_at: item.updated_at.toISOString(),
  };
}

// GET /api/collection
router.get("/", requirePermission("inventory.read"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const collectionId = Number(req.query.collection_id);
    const hasCollectionFilter = Number.isInteger(collectionId) && collectionId > 0;
    const items = await db
      .select()
      .from(collectionItems)
      .where(and(
        eq(collectionItems.tenant_id, scope.tenantId),
        eq(collectionItems.organization_id, scope.organizationId),
        eq(collectionItems.location_id, scope.locationId),
        ...(hasCollectionFilter ? [eq(collectionItems.collection_id, collectionId)] : []),
      ))
      .orderBy(desc(collectionItems.updated_at));
    res.json(items.map(serializeItem));
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

// POST /api/collection
router.post("/", requirePermission("products.create"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const parsed = AddToCollectionBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError("INVALID_INPUT", parsed.error.message, 400);
    }
    const data = parsed.data;
    const [item] = await db
      .insert(collectionItems)
      .values({
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        location_id: scope.locationId,
        collection_id: data.collection_id ?? 1,
        sku: data.sku ?? null,
        barcode: data.barcode ?? null,
        vendor_brand: data.vendor_brand ?? null,
        product_category: data.product_category ?? null,
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
        price_paid: data.price_paid != null ? String(data.price_paid) : null,
        price_paid_input_type: data.price_paid_input_type ?? null,
        price_paid_percent: data.price_paid_percent != null ? String(data.price_paid_percent) : null,
        sale_price_source: data.sale_price_source ?? null,
        sale_price_rule: data.sale_price_rule ?? null,
        market_price_at_add: data.market_price_at_add != null ? String(data.market_price_at_add) : null,
      })
      .returning();
    await writeAuditLog({
      req,
      action: "collection_item.create",
      entityType: "collection_item",
      entityId: String(item.id),
      after: serializeItem(item),
    });
    res.status(201).json(serializeItem(item));
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

// GET /api/collection/summary
router.get("/summary", requirePermission("inventory.read"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const items = await db
      .select()
      .from(collectionItems)
      .where(and(
        eq(collectionItems.tenant_id, scope.tenantId),
        eq(collectionItems.organization_id, scope.organizationId),
        eq(collectionItems.location_id, scope.locationId),
      ));

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
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

// GET /api/collection/:id
router.get("/:id", requirePermission("inventory.read"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const parsed = GetCollectionItemParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) {
      throw new ApiError("INVALID_INPUT", "Invalid id", 400);
    }
    const [item] = await db
      .select()
      .from(collectionItems)
      .where(and(
        eq(collectionItems.id, parsed.data.id),
        eq(collectionItems.tenant_id, scope.tenantId),
        eq(collectionItems.organization_id, scope.organizationId),
        eq(collectionItems.location_id, scope.locationId),
      ));
    if (!item) {
      throw new ApiError("PRODUCT_NOT_FOUND", "Not found", 404);
    }
    res.json(serializeItem(item));
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

// PATCH /api/collection/:id
router.patch("/:id", requirePermission("products.update"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const paramsParsed = UpdateCollectionItemParams.safeParse({ id: Number(req.params.id) });
    if (!paramsParsed.success) {
      throw new ApiError("INVALID_INPUT", "Invalid id", 400);
    }
    const bodyParsed = UpdateCollectionItemBody.safeParse(req.body);
    if (!bodyParsed.success) {
      throw new ApiError("INVALID_INPUT", bodyParsed.error.message, 400);
    }

    const [before] = await db
      .select()
      .from(collectionItems)
      .where(and(
        eq(collectionItems.id, paramsParsed.data.id),
        eq(collectionItems.tenant_id, scope.tenantId),
        eq(collectionItems.organization_id, scope.organizationId),
        eq(collectionItems.location_id, scope.locationId),
      ));
    if (!before) {
      throw new ApiError("PRODUCT_NOT_FOUND", "Not found", 404);
    }

    const updates: Partial<typeof collectionItems.$inferInsert> = {};
    const body = bodyParsed.data;
    if (body.quantity !== undefined) updates.quantity = body.quantity;
    if (body.collection_id !== undefined) updates.collection_id = body.collection_id;
    if (body.sku !== undefined) updates.sku = body.sku ?? null;
    if (body.barcode !== undefined) updates.barcode = body.barcode ?? null;
    if (body.vendor_brand !== undefined) updates.vendor_brand = body.vendor_brand ?? null;
    if (body.product_category !== undefined) updates.product_category = body.product_category ?? null;
    if (body.card_name !== undefined) updates.card_name = body.card_name;
    if (body.set_name !== undefined) updates.set_name = body.set_name ?? null;
    if (body.game_name !== undefined) updates.game_name = body.game_name ?? null;
    if (body.rarity !== undefined) updates.rarity = body.rarity ?? null;
    if (body.printing !== undefined) updates.printing = body.printing;
    if (body.notes !== undefined) updates.notes = body.notes ?? null;
    if (body.market_price !== undefined) {
      updates.market_price = body.market_price != null ? String(body.market_price) : null;
    }
    if (body.low_price !== undefined) {
      updates.low_price = body.low_price != null ? String(body.low_price) : null;
    }
    if (body.image_url !== undefined) {
      updates.image_url = body.image_url ?? null;
    }
    if (body.price_paid !== undefined) {
      updates.price_paid = body.price_paid != null ? String(body.price_paid) : null;
    }
    if (body.price_paid_input_type !== undefined) {
      updates.price_paid_input_type = body.price_paid_input_type ?? null;
    }
    if (body.price_paid_percent !== undefined) {
      updates.price_paid_percent = body.price_paid_percent != null ? String(body.price_paid_percent) : null;
    }
    if (body.sale_price_source !== undefined) {
      updates.sale_price_source = body.sale_price_source ?? null;
    }
    if (body.sale_price_rule !== undefined) {
      updates.sale_price_rule = body.sale_price_rule ?? null;
    }
    if (body.market_price_at_add !== undefined) {
      updates.market_price_at_add = body.market_price_at_add != null ? String(body.market_price_at_add) : null;
    }
    updates.updated_at = new Date();

    const [item] = await db
      .update(collectionItems)
      .set(updates)
      .where(and(
        eq(collectionItems.id, paramsParsed.data.id),
        eq(collectionItems.tenant_id, scope.tenantId),
        eq(collectionItems.organization_id, scope.organizationId),
        eq(collectionItems.location_id, scope.locationId),
      ))
      .returning();

    await writeAuditLog({
      req,
      action: "collection_item.update",
      entityType: "collection_item",
      entityId: String(item.id),
      before: serializeItem(before),
      after: serializeItem(item),
    });

    res.json(serializeItem(item));
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

// DELETE /api/collection/:id
router.delete("/:id", requirePermission("inventory.adjust"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const parsed = RemoveFromCollectionParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) {
      throw new ApiError("INVALID_INPUT", "Invalid id", 400);
    }

    const [before] = await db
      .select()
      .from(collectionItems)
      .where(and(
        eq(collectionItems.id, parsed.data.id),
        eq(collectionItems.tenant_id, scope.tenantId),
        eq(collectionItems.organization_id, scope.organizationId),
        eq(collectionItems.location_id, scope.locationId),
      ));

    if (!before) {
      throw new ApiError("PRODUCT_NOT_FOUND", "Not found", 404);
    }

    await db.delete(collectionItems).where(and(
      eq(collectionItems.id, parsed.data.id),
      eq(collectionItems.tenant_id, scope.tenantId),
      eq(collectionItems.organization_id, scope.organizationId),
      eq(collectionItems.location_id, scope.locationId),
    ));

    await writeAuditLog({
      req,
      action: "collection_item.delete",
      entityType: "collection_item",
      entityId: String(parsed.data.id),
      before: serializeItem(before),
    });

    res.status(204).send();
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

export default router;
