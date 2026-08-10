import pg from "pg";
import { setCors, verifySessionToken } from "./auth.js";
import { ensureAccountScope } from "./local-auth.js";

const poolSymbol = Symbol.for("cardsync.collection.pg.pool");
const schemaReadySymbol = Symbol.for("cardsync.collection.pg.schema-ready");
const globalStore = globalThis;

function getConnectionString() {
  const value = String(process.env.DATABASE_URL || "").trim();
  if (!value) {
    throw new Error("Missing DATABASE_URL");
  }
  return value;
}

function getPool() {
  if (!globalStore[poolSymbol]) {
    globalStore[poolSymbol] = new pg.Pool({ connectionString: getConnectionString() });
  }
  return globalStore[poolSymbol];
}

export async function ensureCollectionSchema() {
  if (!globalStore[schemaReadySymbol]) {
    const pool = getPool();
    globalStore[schemaReadySymbol] = (async () => {
      const column = await pool.query(
        `select data_type
           from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'collection_items'
            and column_name = 'card_id'
          limit 1`,
      );

      if (column.rowCount === 0) {
        throw new Error("collection_items.card_id is missing; run the database migrations");
      }

      if (column.rows[0].data_type !== "bigint") {
        await pool.query(
          `alter table collection_items
             alter column card_id type bigint using card_id::bigint`,
        );
        console.info("[inventory] migrated collection_items.card_id to bigint");
      }
    })().catch((error) => {
      delete globalStore[schemaReadySymbol];
      throw error;
    });
  }

  await globalStore[schemaReadySymbol];
}

function parseBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

export async function requireAuthContext(req, res) {
  const token = parseBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  try {
    const payload = await verifySessionToken(token);
    const sub = String(payload.sub || "").trim();
    if (!sub) {
      res.status(401).json({ error: "JWT missing subject" });
      return null;
    }

    const email = String(payload.email || "").trim().toLowerCase();
    const name = String(payload.name || email).trim() || email;
    if (!email) {
      res.status(401).json({ error: "JWT missing email" });
      return null;
    }
    const membership = await ensureAccountScope({ subject: sub, email, name });
    return {
      userId: sub,
      tenantId: membership.tenantId,
      organizationId: membership.organizationId,
      locationId: membership.locationId,
      email,
      name,
      roles: userRoleToRoles(membership.role),
    };
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
}

function userRoleToRoles(role) {
  if (role === "owner") return ["OWNER"];
  if (role === "manager") return ["MANAGER"];
  return ["CASHIER"];
}

export function parsePathId(req) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/api\/collection\/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function parseCollectionFilter(req) {
  const url = new URL(req.url, "http://localhost");
  const raw = Number(url.searchParams.get("collection_id") || 0);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

export function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function serializeItem(row) {
  return {
    ...row,
    market_price: toNullableNumber(row.market_price),
    low_price: toNullableNumber(row.low_price),
    price_paid: toNullableNumber(row.price_paid),
    price_paid_percent: toNullableNumber(row.price_paid_percent),
    market_price_at_add: toNullableNumber(row.market_price_at_add),
    added_at: toIso(row.added_at),
    updated_at: toIso(row.updated_at),
  };
}

export function normalizeCreatePayload(body) {
  const cardId = Number(body?.card_id);
  const cardName = String(body?.card_name || "").trim();
  if (!Number.isSafeInteger(cardId) || cardId <= 0 || !cardName) {
    return { error: "card_id must be a positive safe integer and card_name is required" };
  }

  return {
    value: {
      collection_id: Number(body?.collection_id) > 0 ? Number(body.collection_id) : 1,
      sku: body?.sku ? String(body.sku) : null,
      barcode: body?.barcode ? String(body.barcode) : null,
      vendor_brand: body?.vendor_brand ? String(body.vendor_brand) : null,
      product_category: body?.product_category ? String(body.product_category) : null,
      card_id: cardId,
      card_name: cardName,
      set_name: body?.set_name ? String(body.set_name) : null,
      game_name: body?.game_name ? String(body.game_name) : null,
      rarity: body?.rarity ? String(body.rarity) : null,
      printing: body?.printing ? String(body.printing) : "Normal",
      market_price: toNullableNumber(body?.market_price),
      low_price: toNullableNumber(body?.low_price),
      image_url: body?.image_url ? String(body.image_url) : null,
      quantity: Number(body?.quantity) > 0 ? Number(body.quantity) : 1,
      notes: body?.notes ? String(body.notes) : null,
      price_paid: toNullableNumber(body?.price_paid),
      price_paid_input_type:
        body?.price_paid_input_type === "amount" || body?.price_paid_input_type === "percent"
          ? body.price_paid_input_type
          : null,
      price_paid_percent: toNullableNumber(body?.price_paid_percent),
      sale_price_source:
        body?.sale_price_source === "custom" || body?.sale_price_source === "market_rule"
          ? body.sale_price_source
          : null,
      sale_price_rule: body?.sale_price_rule ? String(body.sale_price_rule) : null,
      market_price_at_add: toNullableNumber(body?.market_price_at_add),
    },
  };
}

export function normalizeUpdatePayload(body) {
  const updates = {};
  const apply = (key, value) => {
    updates[key] = value;
  };

  if (body.collection_id !== undefined) apply("collection_id", Number(body.collection_id) > 0 ? Number(body.collection_id) : 1);
  if (body.sku !== undefined) apply("sku", body.sku ? String(body.sku) : null);
  if (body.barcode !== undefined) apply("barcode", body.barcode ? String(body.barcode) : null);
  if (body.vendor_brand !== undefined) apply("vendor_brand", body.vendor_brand ? String(body.vendor_brand) : null);
  if (body.product_category !== undefined) apply("product_category", body.product_category ? String(body.product_category) : null);
  if (body.card_name !== undefined) apply("card_name", body.card_name ? String(body.card_name) : null);
  if (body.set_name !== undefined) apply("set_name", body.set_name ? String(body.set_name) : null);
  if (body.game_name !== undefined) apply("game_name", body.game_name ? String(body.game_name) : null);
  if (body.rarity !== undefined) apply("rarity", body.rarity ? String(body.rarity) : null);
  if (body.printing !== undefined) apply("printing", body.printing ? String(body.printing) : "Normal");
  if (body.market_price !== undefined) apply("market_price", toNullableNumber(body.market_price));
  if (body.low_price !== undefined) apply("low_price", toNullableNumber(body.low_price));
  if (body.image_url !== undefined) apply("image_url", body.image_url ? String(body.image_url) : null);
  if (body.quantity !== undefined) apply("quantity", Number(body.quantity) > 0 ? Number(body.quantity) : 1);
  if (body.notes !== undefined) apply("notes", body.notes ? String(body.notes) : null);
  if (body.price_paid !== undefined) apply("price_paid", toNullableNumber(body.price_paid));
  if (body.price_paid_input_type !== undefined) {
    apply(
      "price_paid_input_type",
      body.price_paid_input_type === "amount" || body.price_paid_input_type === "percent"
        ? body.price_paid_input_type
        : null,
    );
  }
  if (body.price_paid_percent !== undefined) apply("price_paid_percent", toNullableNumber(body.price_paid_percent));
  if (body.sale_price_source !== undefined) {
    apply(
      "sale_price_source",
      body.sale_price_source === "custom" || body.sale_price_source === "market_rule"
        ? body.sale_price_source
        : null,
    );
  }
  if (body.sale_price_rule !== undefined) apply("sale_price_rule", body.sale_price_rule ? String(body.sale_price_rule) : null);
  if (body.market_price_at_add !== undefined) apply("market_price_at_add", toNullableNumber(body.market_price_at_add));

  return updates;
}

export async function queryItems(scope, collectionId) {
  await ensureCollectionSchema();
  const pool = getPool();
  const params = [scope.tenantId, scope.organizationId, scope.locationId];
  let filter = "";
  if (collectionId) {
    params.push(collectionId);
    filter = " and collection_id = $4";
  }

  const result = await pool.query(
    `select * from collection_items
      where tenant_id = $1 and organization_id = $2 and location_id = $3${filter}
      order by updated_at desc`,
    params,
  );

  return result.rows.map(serializeItem);
}

export async function insertItem(scope, payload) {
  await ensureCollectionSchema();
  const pool = getPool();
  const result = await pool.query(
    `insert into collection_items (
      tenant_id, organization_id, location_id, collection_id,
      sku, barcode, vendor_brand, product_category,
      card_id, card_name, set_name, game_name, rarity, printing,
      market_price, low_price, image_url, quantity, notes,
      price_paid, price_paid_input_type, price_paid_percent,
      sale_price_source, sale_price_rule, market_price_at_add
    ) values (
      $1,$2,$3,$4,
      $5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,
      $15,$16,$17,$18,$19,
      $20,$21,$22,
      $23,$24,$25
    ) returning *`,
    [
      scope.tenantId,
      scope.organizationId,
      scope.locationId,
      payload.collection_id,
      payload.sku,
      payload.barcode,
      payload.vendor_brand,
      payload.product_category,
      payload.card_id,
      payload.card_name,
      payload.set_name,
      payload.game_name,
      payload.rarity,
      payload.printing,
      payload.market_price,
      payload.low_price,
      payload.image_url,
      payload.quantity,
      payload.notes,
      payload.price_paid,
      payload.price_paid_input_type,
      payload.price_paid_percent,
      payload.sale_price_source,
      payload.sale_price_rule,
      payload.market_price_at_add,
    ],
  );

  return serializeItem(result.rows[0]);
}

export async function findItemById(scope, id) {
  await ensureCollectionSchema();
  const pool = getPool();
  const result = await pool.query(
    `select * from collection_items
      where id = $1 and tenant_id = $2 and organization_id = $3 and location_id = $4
      limit 1`,
    [id, scope.tenantId, scope.organizationId, scope.locationId],
  );

  return result.rows[0] ? serializeItem(result.rows[0]) : null;
}

export async function updateItemById(scope, id, updates) {
  await ensureCollectionSchema();
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return await findItemById(scope, id);
  }

  const setters = keys.map((key, idx) => `${key} = $${idx + 1}`);
  const values = keys.map((key) => updates[key]);
  setters.push(`updated_at = now()`);

  const pool = getPool();
  const result = await pool.query(
    `update collection_items
      set ${setters.join(", ")}
      where id = $${keys.length + 1}
        and tenant_id = $${keys.length + 2}
        and organization_id = $${keys.length + 3}
        and location_id = $${keys.length + 4}
      returning *`,
    [...values, id, scope.tenantId, scope.organizationId, scope.locationId],
  );

  return result.rows[0] ? serializeItem(result.rows[0]) : null;
}

export async function deleteItemById(scope, id) {
  await ensureCollectionSchema();
  const pool = getPool();
  const result = await pool.query(
    `delete from collection_items
      where id = $1 and tenant_id = $2 and organization_id = $3 and location_id = $4
      returning id`,
    [id, scope.tenantId, scope.organizationId, scope.locationId],
  );

  return result.rowCount > 0;
}

export function setCollectionCors(req, res, methods) {
  setCors(req, res, methods);
}
