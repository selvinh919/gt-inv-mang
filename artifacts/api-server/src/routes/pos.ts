import { Router } from "express";
import type { Request } from "express";
import {
  db,
  posProducts,
  posInventoryLots,
  posSales,
  posSaleLines,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { requirePermission } from "../middlewares/permissions";
import { ApiError, toErrorPayload } from "../lib/api-errors";
import { runWithIdempotency } from "../lib/idempotency";
import { writeAuditLog } from "../lib/audit";

const router = Router();
router.use(requireAuth);

function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): number {
  return Number(value.toFixed(2));
}

function parseCollectionId(input: unknown): number {
  const parsed = Number(input ?? 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function scopeFromRequest(req: Request): {
  tenantId: string;
  organizationId: string;
  locationId: string;
  userId: string;
} {
  if (!req.authContext) {
    throw new ApiError("AUTH_REQUIRED", "Authentication required", 401);
  }

  return {
    tenantId: req.authContext.tenantId,
    organizationId: req.authContext.organizationId,
    locationId: req.authContext.locationId,
    userId: req.authContext.userId,
  };
}

function cleanSkuPart(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function fallbackSku(data: {
  externalProductId: number | null;
  name: string;
  setName: string | null;
  printing: string;
  condition: string;
}): string {
  if (data.externalProductId && data.externalProductId > 0) {
    return `TCG-${data.externalProductId}-${cleanSkuPart(data.printing)}-${cleanSkuPart(data.condition)}`;
  }

  const nameToken = cleanSkuPart(data.name).slice(0, 14) || "ITEM";
  const setToken = cleanSkuPart(data.setName || "GEN").slice(0, 8) || "GEN";
  return `${nameToken}-${setToken}-${cleanSkuPart(data.printing)}-${cleanSkuPart(data.condition)}`;
}

function generateOrderNumber(locationId: string): string {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const rand = Math.floor(Math.random() * 9000) + 1000;
  const locationToken = cleanSkuPart(locationId).slice(0, 8) || "MAIN";
  return `POS-${locationToken}-${ts}-${rand}`;
}

async function getInventory(
  collectionId: number,
  scope: { tenantId: string; organizationId: string; locationId: string },
) {
  const products = await db
    .select()
    .from(posProducts)
    .where(and(
      eq(posProducts.tenant_id, scope.tenantId),
      eq(posProducts.organization_id, scope.organizationId),
      eq(posProducts.location_id, scope.locationId),
      eq(posProducts.collection_id, collectionId),
    ))
    .orderBy(desc(posProducts.updated_at));

  if (products.length === 0) {
    return [];
  }

  const productIds = products.map((product) => product.id);
  const lots = await db
    .select()
    .from(posInventoryLots)
    .where(
      and(
        eq(posInventoryLots.tenant_id, scope.tenantId),
        eq(posInventoryLots.organization_id, scope.organizationId),
        eq(posInventoryLots.location_id, scope.locationId),
        inArray(posInventoryLots.product_id, productIds),
        sql`${posInventoryLots.quantity_remaining} > 0`,
      ),
    );

  const lotMap = new Map<number, { onHand: number; totalCost: number }>();
  for (const lot of lots) {
    const existing = lotMap.get(lot.product_id) ?? { onHand: 0, totalCost: 0 };
    const onHand = existing.onHand + lot.quantity_remaining;
    const totalCost = existing.totalCost + lot.quantity_remaining * toNum(lot.unit_cost);
    lotMap.set(lot.product_id, { onHand, totalCost });
  }

  return products.map((product) => {
    const lotData = lotMap.get(product.id) ?? { onHand: 0, totalCost: 0 };
    const avgCost = lotData.onHand > 0 ? lotData.totalCost / lotData.onHand : 0;
    const market = toNum(product.market_price);
    return {
      id: product.id,
      tenant_id: product.tenant_id,
      organization_id: product.organization_id,
      location_id: product.location_id,
      collection_id: product.collection_id,
      external_product_id: product.external_product_id,
      sku: product.sku,
      name: product.name,
      set_name: product.set_name,
      game_name: product.game_name,
      rarity: product.rarity,
      printing: product.printing,
      condition: product.condition,
      image_url: product.image_url,
      market_price: market,
      market_price_updated_at: product.market_price_updated_at?.toISOString() ?? null,
      quantity_on_hand: lotData.onHand,
      avg_cost: money(avgCost),
      stock_value_cost: money(lotData.totalCost),
      stock_value_market: money(lotData.onHand * market),
      unrealized_profit: money((lotData.onHand * market) - lotData.totalCost),
      updated_at: product.updated_at.toISOString(),
    };
  });
}

router.get("/inventory", requirePermission("inventory.read"), async (req, res) => {
  try {
    const collectionId = parseCollectionId(req.query.collection_id);
    const scope = scopeFromRequest(req);
    const inventory = await getInventory(collectionId, scope);
    res.json(inventory);
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

router.post("/products/import", requirePermission("products.create"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const body = req.body as Record<string, unknown>;

    const result = await runWithIdempotency({
      req,
      routeKey: "pos.products.import",
      execute: async () => {
        const collectionId = parseCollectionId(body.collection_id);
        const name = String(body.name || "").trim();
        if (!name) {
          throw new ApiError("INVALID_INPUT", "name is required", 400);
        }

        const externalProductId = Number(body.external_product_id || body.card_id || 0) || null;
        const printing = String(body.printing || "Normal").trim() || "Normal";
        const condition = String(body.condition || "Near Mint").trim() || "Near Mint";
        const setName = body.set_name ? String(body.set_name) : null;
        const sku = String(body.sku || "").trim() || fallbackSku({
          externalProductId,
          name,
          setName,
          printing,
          condition,
        });

        const existing = await db
          .select()
          .from(posProducts)
          .where(and(
            eq(posProducts.tenant_id, scope.tenantId),
            eq(posProducts.organization_id, scope.organizationId),
            eq(posProducts.location_id, scope.locationId),
            eq(posProducts.collection_id, collectionId),
            eq(posProducts.sku, sku),
          ))
          .limit(1);

        const marketPrice = body.market_price == null ? null : money(toNum(body.market_price));
        const now = new Date();

        let product: typeof posProducts.$inferSelect;
        if (existing[0]) {
          const [updated] = await db
            .update(posProducts)
            .set({
              external_product_id: externalProductId,
              name,
              set_name: setName,
              game_name: body.game_name ? String(body.game_name) : null,
              rarity: body.rarity ? String(body.rarity) : null,
              printing,
              condition,
              image_url: body.image_url ? String(body.image_url) : null,
              market_price: marketPrice != null ? String(marketPrice) : null,
              market_price_updated_at: marketPrice != null ? now : null,
              updated_at: now,
            })
            .where(eq(posProducts.id, existing[0].id))
            .returning();

          product = updated;
        } else {
          const [created] = await db
            .insert(posProducts)
            .values({
              tenant_id: scope.tenantId,
              organization_id: scope.organizationId,
              location_id: scope.locationId,
              collection_id: collectionId,
              external_product_id: externalProductId,
              sku,
              name,
              set_name: setName,
              game_name: body.game_name ? String(body.game_name) : null,
              rarity: body.rarity ? String(body.rarity) : null,
              printing,
              condition,
              image_url: body.image_url ? String(body.image_url) : null,
              market_price: marketPrice != null ? String(marketPrice) : null,
              market_price_updated_at: marketPrice != null ? now : null,
            })
            .returning();

          product = created;
        }

        const receiveQty = Math.floor(toNum(body.receive_quantity));
        const receiveUnitCost = toNum(body.receive_unit_cost);
        if (receiveQty > 0 && receiveUnitCost >= 0) {
          await db.insert(posInventoryLots).values({
            tenant_id: scope.tenantId,
            organization_id: scope.organizationId,
            location_id: scope.locationId,
            product_id: product.id,
            quantity: receiveQty,
            quantity_remaining: receiveQty,
            unit_cost: String(money(receiveUnitCost)),
            source: body.receive_source ? String(body.receive_source) : "manual-import",
            note: body.receive_note ? String(body.receive_note) : null,
          });
        }

        const responseBody = {
          id: product.id,
          collection_id: product.collection_id,
          external_product_id: product.external_product_id,
          sku: product.sku,
          name: product.name,
          set_name: product.set_name,
          game_name: product.game_name,
          rarity: product.rarity,
          printing: product.printing,
          condition: product.condition,
          image_url: product.image_url,
          market_price: product.market_price == null ? null : toNum(product.market_price),
        };

        await writeAuditLog({
          req,
          action: existing[0] ? "product.update" : "product.create",
          entityType: "pos_product",
          entityId: String(product.id),
          before: existing[0] ?? null,
          after: responseBody,
          metadata: { collection_id: collectionId },
        });

        return { statusCode: 201, body: responseBody };
      },
    });

    res.status(result.statusCode).json(result.body);
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

router.post("/stock/receive", requirePermission("inventory.receive"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const body = req.body as Record<string, unknown>;

    const result = await runWithIdempotency({
      req,
      routeKey: "pos.stock.receive",
      execute: async () => {
        const productId = Math.floor(toNum(body.product_id));
        const quantity = Math.floor(toNum(body.quantity));
        const unitCost = toNum(body.unit_cost);

        if (productId <= 0) {
          throw new ApiError("INVALID_INPUT", "product_id is required", 400);
        }
        if (quantity <= 0) {
          throw new ApiError("INVALID_INPUT", "quantity must be > 0", 400);
        }
        if (unitCost < 0) {
          throw new ApiError("INVALID_INPUT", "unit_cost must be >= 0", 400);
        }

        const [product] = await db
          .select()
          .from(posProducts)
          .where(and(
            eq(posProducts.id, productId),
            eq(posProducts.tenant_id, scope.tenantId),
            eq(posProducts.organization_id, scope.organizationId),
            eq(posProducts.location_id, scope.locationId),
          ))
          .limit(1);

        if (!product) {
          throw new ApiError("PRODUCT_NOT_FOUND", "product not found", 404);
        }

        const [lot] = await db
          .insert(posInventoryLots)
          .values({
            tenant_id: scope.tenantId,
            organization_id: scope.organizationId,
            location_id: scope.locationId,
            product_id: productId,
            quantity,
            quantity_remaining: quantity,
            unit_cost: String(money(unitCost)),
            source: body.source ? String(body.source) : "manual",
            note: body.note ? String(body.note) : null,
          })
          .returning();

        const responseBody = {
          lot_id: lot.id,
          product_id: lot.product_id,
          quantity: lot.quantity,
          quantity_remaining: lot.quantity_remaining,
          unit_cost: toNum(lot.unit_cost),
          source: lot.source,
          note: lot.note,
          received_at: lot.received_at.toISOString(),
        };

        await writeAuditLog({
          req,
          action: "inventory.receive",
          entityType: "pos_inventory_lot",
          entityId: String(lot.id),
          after: responseBody,
        });

        return { statusCode: 201, body: responseBody };
      },
    });

    res.status(result.statusCode).json(result.body);
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

router.post("/sales", requirePermission("sales.create"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const body = req.body as Record<string, unknown>;

    const result = await runWithIdempotency({
      req,
      routeKey: "pos.sales.create",
      execute: async () => {
        const collectionId = parseCollectionId(body.collection_id);
        const tax = money(toNum(body.tax));
        const note = body.note ? String(body.note) : null;
        const inputLines = Array.isArray(body.lines) ? body.lines : [];

        if (inputLines.length === 0) {
          throw new ApiError("INVALID_INPUT", "lines are required", 400);
        }

        type Allocation = {
          product_id: number;
          quantity: number;
          unit_price: number;
          lot_id: number;
          unit_cost: number;
          next_remaining: number;
        };

        const responseBody = await db.transaction(async (tx) => {
          const allocations: Allocation[] = [];
          let subtotal = 0;
          let cogs = 0;

          for (const rawLine of inputLines) {
            const line = rawLine as Record<string, unknown>;
            const productId = Math.floor(toNum(line.product_id));
            const quantity = Math.floor(toNum(line.quantity));
            const unitPrice = money(toNum(line.unit_price));

            if (productId <= 0 || quantity <= 0 || unitPrice < 0) {
              throw new ApiError("INVALID_INPUT", "Invalid sale line payload", 400);
            }

            const [product] = await tx
              .select()
              .from(posProducts)
              .where(and(
                eq(posProducts.id, productId),
                eq(posProducts.tenant_id, scope.tenantId),
                eq(posProducts.organization_id, scope.organizationId),
                eq(posProducts.location_id, scope.locationId),
                eq(posProducts.collection_id, collectionId),
              ))
              .limit(1);

            if (!product) {
              throw new ApiError("PRODUCT_NOT_FOUND", `Product ${productId} not found in collection`, 404);
            }

            const lots = await tx
              .select()
              .from(posInventoryLots)
              .where(and(
                eq(posInventoryLots.tenant_id, scope.tenantId),
                eq(posInventoryLots.organization_id, scope.organizationId),
                eq(posInventoryLots.location_id, scope.locationId),
                eq(posInventoryLots.product_id, productId),
                sql`${posInventoryLots.quantity_remaining} > 0`,
              ))
              .orderBy(asc(posInventoryLots.received_at), asc(posInventoryLots.id));

            let remaining = quantity;
            for (const lot of lots) {
              if (remaining <= 0) break;
              const allocQty = Math.min(remaining, lot.quantity_remaining);
              if (allocQty <= 0) continue;

              const unitCost = money(toNum(lot.unit_cost));
              allocations.push({
                product_id: productId,
                quantity: allocQty,
                unit_price: unitPrice,
                lot_id: lot.id,
                unit_cost: unitCost,
                next_remaining: lot.quantity_remaining - allocQty,
              });

              subtotal += unitPrice * allocQty;
              cogs += unitCost * allocQty;
              remaining -= allocQty;
            }

            if (remaining > 0) {
              throw new ApiError("INSUFFICIENT_INVENTORY", `Insufficient stock for ${product.name}`, 409);
            }
          }

          const roundedSubtotal = money(subtotal);
          const roundedCogs = money(cogs);
          const total = money(roundedSubtotal + tax);
          const profit = money(total - roundedCogs);

          const [sale] = await tx
            .insert(posSales)
            .values({
              tenant_id: scope.tenantId,
              organization_id: scope.organizationId,
              location_id: scope.locationId,
              collection_id: collectionId,
              order_number: generateOrderNumber(scope.locationId),
              status: "PENDING_PAYMENT",
              payment_status: "pending",
              subtotal: String(roundedSubtotal),
              tax: String(tax),
              total: String(total),
              cogs: String(roundedCogs),
              profit: String(profit),
              note,
            })
            .returning();

          for (const alloc of allocations) {
            await tx
              .update(posInventoryLots)
              .set({ quantity_remaining: alloc.next_remaining })
              .where(eq(posInventoryLots.id, alloc.lot_id));

            await tx.insert(posSaleLines).values({
              tenant_id: scope.tenantId,
              organization_id: scope.organizationId,
              location_id: scope.locationId,
              sale_id: sale.id,
              product_id: alloc.product_id,
              lot_id: alloc.lot_id,
              quantity: alloc.quantity,
              unit_price: String(alloc.unit_price),
              unit_cost: String(alloc.unit_cost),
              line_total: String(money(alloc.unit_price * alloc.quantity)),
              line_profit: String(money((alloc.unit_price - alloc.unit_cost) * alloc.quantity)),
            });
          }

          return {
            sale_id: sale.id,
            order_number: sale.order_number,
            subtotal: roundedSubtotal,
            tax,
            total,
            cogs: roundedCogs,
            profit,
            payment_status: sale.payment_status,
            status: sale.status,
            sold_at: sale.sold_at.toISOString(),
            lines: allocations.length,
          };
        });

        await writeAuditLog({
          req,
          action: "sale.create",
          entityType: "pos_sale",
          entityId: String(responseBody.sale_id),
          after: responseBody,
          metadata: { collection_id: collectionId },
        });

        return { statusCode: 201, body: responseBody };
      },
    });

    res.status(result.statusCode).json(result.body);
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

router.get("/sales", requirePermission("sales.read"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const collectionId = parseCollectionId(req.query.collection_id);
    const limit = Math.min(Math.max(Math.floor(toNum(req.query.limit)), 1), 100) || 25;

    const sales = await db
      .select()
      .from(posSales)
      .where(and(
        eq(posSales.tenant_id, scope.tenantId),
        eq(posSales.organization_id, scope.organizationId),
        eq(posSales.location_id, scope.locationId),
        eq(posSales.collection_id, collectionId),
      ))
      .orderBy(desc(posSales.sold_at))
      .limit(limit);

    res.json(
      sales.map((sale) => ({
        id: sale.id,
        order_number: sale.order_number,
        status: sale.status,
        payment_status: sale.payment_status,
        sold_at: sale.sold_at.toISOString(),
        subtotal: toNum(sale.subtotal),
        tax: toNum(sale.tax),
        total: toNum(sale.total),
        cogs: toNum(sale.cogs),
        profit: toNum(sale.profit),
        note: sale.note,
      })),
    );
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

router.get("/dashboard", requirePermission("reports.financial"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const collectionId = parseCollectionId(req.query.collection_id);
    const inventory = await getInventory(collectionId, scope);

    const sales = await db
      .select({
        id: posSales.id,
        total: posSales.total,
        cogs: posSales.cogs,
        profit: posSales.profit,
      })
      .from(posSales)
      .where(and(
        eq(posSales.tenant_id, scope.tenantId),
        eq(posSales.organization_id, scope.organizationId),
        eq(posSales.location_id, scope.locationId),
        eq(posSales.collection_id, collectionId),
      ));

    const grossRevenue = money(sales.reduce((sum, sale) => sum + toNum(sale.total), 0));
    const grossCogs = money(sales.reduce((sum, sale) => sum + toNum(sale.cogs), 0));
    const realizedProfit = money(sales.reduce((sum, sale) => sum + toNum(sale.profit), 0));

    const inventoryUnits = inventory.reduce((sum, row) => sum + row.quantity_on_hand, 0);
    const inventoryCostValue = money(inventory.reduce((sum, row) => sum + row.stock_value_cost, 0));
    const inventoryMarketValue = money(inventory.reduce((sum, row) => sum + row.stock_value_market, 0));

    const productIds = inventory.map((row) => row.id);
    let topProducts: Array<{ product_id: number; qty_sold: number; revenue: number; name: string }> = [];
    if (productIds.length > 0) {
      const products = await db
        .select({ id: posProducts.id, name: posProducts.name })
        .from(posProducts)
        .where(and(
          eq(posProducts.tenant_id, scope.tenantId),
          eq(posProducts.organization_id, scope.organizationId),
          eq(posProducts.location_id, scope.locationId),
          eq(posProducts.collection_id, collectionId),
          inArray(posProducts.id, productIds),
        ));

      const lines = await db
        .select()
        .from(posSaleLines)
        .where(and(
          eq(posSaleLines.tenant_id, scope.tenantId),
          eq(posSaleLines.organization_id, scope.organizationId),
          eq(posSaleLines.location_id, scope.locationId),
          inArray(posSaleLines.product_id, productIds),
        ));

      const map = new Map<number, { qty: number; revenue: number }>();
      for (const line of lines) {
        const current = map.get(line.product_id) ?? { qty: 0, revenue: 0 };
        current.qty += line.quantity;
        current.revenue += toNum(line.line_total);
        map.set(line.product_id, current);
      }

      const productNameMap = new Map(products.map((p) => [p.id, p.name]));
      topProducts = Array.from(map.entries())
        .map(([productId, stats]) => ({
          product_id: productId,
          qty_sold: stats.qty,
          revenue: money(stats.revenue),
          name: productNameMap.get(productId) ?? `Product ${productId}`,
        }))
        .sort((a, b) => b.qty_sold - a.qty_sold)
        .slice(0, 10);
    }

    res.json({
      inventory_units: inventoryUnits,
      inventory_cost_value: inventoryCostValue,
      inventory_market_value: inventoryMarketValue,
      gross_revenue: grossRevenue,
      cogs: grossCogs,
      realized_profit: realizedProfit,
      orders_count: sales.length,
      top_products: topProducts,
    });
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

export default router;
