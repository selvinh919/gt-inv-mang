import pg from "pg";

const poolSymbol = Symbol.for("cardsync.pos.pg.pool");
const readySymbol = Symbol.for("cardsync.pos.pg.ready");
const globalStore = globalThis;

function getPool() {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("Missing DATABASE_URL");
  if (!globalStore[poolSymbol]) globalStore[poolSymbol] = new pg.Pool({ connectionString });
  return globalStore[poolSymbol];
}

export async function ensurePosSchema() {
  if (!globalStore[readySymbol]) {
    globalStore[readySymbol] = getPool().query(`
      create table if not exists pos_settings (
        tenant_id text not null,
        organization_id text not null,
        location_id text not null,
        tax_rate numeric(7,4) not null default 8.25,
        updated_at timestamptz not null default now(),
        primary key (tenant_id, organization_id, location_id)
      );
      create table if not exists pos_customers (
        id bigserial primary key,
        tenant_id text not null,
        organization_id text not null,
        name text not null,
        email text,
        phone text,
        tax_exempt boolean not null default false,
        notes text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists pos_customers_scope_idx on pos_customers (tenant_id, organization_id, created_at desc);
      create table if not exists pos_sales (
        id bigserial primary key,
        tenant_id text not null,
        organization_id text not null,
        location_id text not null,
        collection_id bigint not null,
        receipt_number text not null unique,
        customer_id bigint references pos_customers(id),
        payment_status text not null,
        subtotal numeric(14,2) not null,
        tax numeric(14,2) not null,
        total numeric(14,2) not null,
        amount_paid numeric(14,2) not null,
        total_cogs numeric(14,2) not null,
        notes text,
        idempotency_key text not null,
        actor_subject text not null,
        actor_email text,
        stripe_session_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, idempotency_key)
      );
      create index if not exists pos_sales_scope_idx on pos_sales (tenant_id, organization_id, location_id, created_at desc);
      create table if not exists pos_sale_lines (
        id bigserial primary key,
        sale_id bigint not null references pos_sales(id) on delete cascade,
        inventory_item_id bigint not null,
        sku text,
        item_name text not null,
        printing text,
        quantity integer not null check (quantity > 0),
        unit_price numeric(14,2) not null,
        unit_cost numeric(14,2) not null,
        line_total numeric(14,2) not null,
        line_profit numeric(14,2) not null
      );
      create table if not exists pos_audit_log (
        id bigserial primary key,
        tenant_id text not null,
        organization_id text not null,
        location_id text not null,
        actor_subject text not null,
        actor_email text,
        action text not null,
        entity_type text not null,
        entity_id text not null,
        metadata jsonb,
        created_at timestamptz not null default now()
      );
      create table if not exists stripe_pending_checkouts (
        session_id text primary key,
        tenant_id text not null,
        organization_id text not null,
        location_id text not null,
        actor_subject text not null,
        actor_email text,
        payload jsonb not null,
        completed_sale_id bigint references pos_sales(id),
        created_at timestamptz not null default now(),
        completed_at timestamptz
      );
    `).catch((error) => {
      delete globalStore[readySymbol];
      throw error;
    });
  }
  await globalStore[readySymbol];
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function serializeSale(row) {
  return {
    ...row,
    subtotal: Number(row.subtotal), tax: Number(row.tax), total: Number(row.total),
    amount_paid: Number(row.amount_paid), total_cogs: Number(row.total_cogs),
    total_profit: money(Number(row.subtotal) - Number(row.total_cogs)),
  };
}

export async function listSales(scope) {
  await ensurePosSchema();
  const result = await getPool().query(
    `select s.*, coalesce(json_agg(l order by l.id) filter (where l.id is not null), '[]') as lines
       from pos_sales s left join pos_sale_lines l on l.sale_id = s.id
      where s.tenant_id=$1 and s.organization_id=$2 and s.location_id=$3
      group by s.id order by s.created_at desc limit 250`,
    [scope.tenantId, scope.organizationId, scope.locationId],
  );
  return result.rows.map(serializeSale);
}

export async function quoteCheckout(scope, body) {
  await ensurePosSchema();
  const collectionId = Number(body?.collection_id);
  const inputs = Array.isArray(body?.lines) ? body.lines : [];
  if (!Number.isInteger(collectionId) || collectionId < 1 || inputs.length === 0) {
    throw new Error("collection_id and lines are required");
  }
  const lines = [];
  let subtotal = 0;
  for (const input of inputs) {
    const id = Number(input?.item_id);
    const quantity = Math.floor(Number(input?.quantity));
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(quantity) || quantity < 1) throw new Error("Invalid sale line");
    const found = await getPool().query(
      `select id,card_name,set_name,printing,market_price,quantity from collection_items
        where id=$1 and tenant_id=$2 and organization_id=$3 and location_id=$4 and collection_id=$5 limit 1`,
      [id, scope.tenantId, scope.organizationId, scope.locationId, collectionId],
    );
    const item = found.rows[0];
    if (!item || Number(item.quantity) < quantity) throw new Error("Inventory changed; review the cart and try again");
    const unitPrice = money(item.market_price);
    if (unitPrice <= 0) throw new Error(`${item.card_name} does not have a valid sale price`);
    subtotal = money(subtotal + unitPrice * quantity);
    lines.push({ item_id: id, quantity, unit_price: unitPrice, name: item.card_name, description: [item.set_name, item.printing].filter(Boolean).join(" • ") });
  }
  const settings = await getSettings(scope);
  const tax = money(subtotal * settings.tax_rate / 100);
  return { collection_id: collectionId, lines, subtotal, tax, total: money(subtotal + tax) };
}

export async function checkout(scope, body) {
  await ensurePosSchema();
  const collectionId = Number(body?.collection_id);
  const inputs = Array.isArray(body?.lines) ? body.lines : [];
  const idempotencyKey = String(body?.idempotency_key || "").trim().slice(0, 200);
  if (!Number.isInteger(collectionId) || collectionId < 1 || inputs.length === 0 || !idempotencyKey) {
    throw new Error("collection_id, lines, and idempotency_key are required");
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const prior = await client.query(
      `select * from pos_sales where tenant_id=$1 and idempotency_key=$2 limit 1`,
      [scope.tenantId, idempotencyKey],
    );
    if (prior.rowCount) {
      await client.query("commit");
      return serializeSale(prior.rows[0]);
    }

    let subtotal = 0;
    let totalCogs = 0;
    const lines = [];
    const canOverridePrice = scope.roles.includes("OWNER") || scope.roles.includes("MANAGER");
    for (const input of inputs) {
      const id = Number(input?.item_id);
      const quantity = Math.floor(Number(input?.quantity));
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(quantity) || quantity < 1) {
        throw new Error("Every sale line needs a valid item and quantity");
      }
      const found = await client.query(
        `select * from collection_items where id=$1 and tenant_id=$2 and organization_id=$3 and location_id=$4 and collection_id=$5 for update`,
        [id, scope.tenantId, scope.organizationId, scope.locationId, collectionId],
      );
      const item = found.rows[0];
      if (!item) throw new Error("An inventory item is no longer available");
      if (Number(item.quantity) < quantity) throw new Error(`${item.card_name} has insufficient stock`);

      const catalogPrice = money(item.market_price);
      const requestedPrice = money(input?.unit_price);
      const unitPrice = canOverridePrice && Number.isFinite(Number(input?.unit_price)) && requestedPrice >= 0
        ? requestedPrice : catalogPrice;
      const unitCost = money(item.price_paid);
      const lineTotal = money(unitPrice * quantity);
      const lineCost = money(unitCost * quantity);
      subtotal = money(subtotal + lineTotal);
      totalCogs = money(totalCogs + lineCost);
      lines.push({ id, quantity, unitPrice, unitCost, lineTotal, lineProfit: money(lineTotal - lineCost), item });

      await client.query(`update collection_items set quantity=quantity-$1, updated_at=now() where id=$2`, [quantity, id]);
    }

    const customerId = Number(body?.customer_id) || null;
    let taxExempt = false;
    if (customerId) {
      const customer = await client.query(
        `select tax_exempt from pos_customers where id=$1 and tenant_id=$2 and organization_id=$3`,
        [customerId, scope.tenantId, scope.organizationId],
      );
      if (!customer.rowCount) throw new Error("Customer not found");
      taxExempt = Boolean(customer.rows[0].tax_exempt);
    }
    const settings = await client.query(
      `select tax_rate from pos_settings where tenant_id=$1 and organization_id=$2 and location_id=$3`,
      [scope.tenantId, scope.organizationId, scope.locationId],
    );
    const taxRate = Number(settings.rows[0]?.tax_rate || 0);
    const tax = taxExempt ? 0 : money(subtotal * taxRate / 100);
    const total = money(subtotal + tax);
    const status = ["paid", "partial", "unpaid"].includes(body?.payment_status) ? body.payment_status : "paid";
    const amountPaid = status === "paid" ? total : Math.min(total, Math.max(0, money(body?.amount_paid)));
    const receiptNumber = `R-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    const saleResult = await client.query(
      `insert into pos_sales (tenant_id,organization_id,location_id,collection_id,receipt_number,customer_id,payment_status,subtotal,tax,total,amount_paid,total_cogs,notes,idempotency_key,actor_subject,actor_email)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [scope.tenantId, scope.organizationId, scope.locationId, collectionId, receiptNumber, customerId, status, subtotal, tax, total, amountPaid, totalCogs, String(body?.notes || "").trim() || null, idempotencyKey, scope.userId, scope.email],
    );
    const sale = saleResult.rows[0];
    for (const line of lines) {
      await client.query(
        `insert into pos_sale_lines (sale_id,inventory_item_id,sku,item_name,printing,quantity,unit_price,unit_cost,line_total,line_profit)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sale.id, line.id, line.item.sku, line.item.card_name, line.item.printing, line.quantity, line.unitPrice, line.unitCost, line.lineTotal, line.lineProfit],
      );
    }
    await client.query(
      `insert into pos_audit_log (tenant_id,organization_id,location_id,actor_subject,actor_email,action,entity_type,entity_id,metadata)
       values ($1,$2,$3,$4,$5,'sale.checkout','sale',$6,$7::jsonb)`,
      [scope.tenantId, scope.organizationId, scope.locationId, scope.userId, scope.email, String(sale.id), JSON.stringify({ receipt_number: receiptNumber, total, lines: lines.length })],
    );
    await client.query("commit");
    return { ...serializeSale(sale), lines: lines.map((line) => ({ item_id: line.id, sku: line.item.sku, card_name: line.item.card_name, printing: line.item.printing, quantity: line.quantity, unit_price: line.unitPrice, unit_cost: line.unitCost, line_total: line.lineTotal, line_profit: line.lineProfit })) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCustomers(scope) {
  await ensurePosSchema();
  const result = await getPool().query(`select * from pos_customers where tenant_id=$1 and organization_id=$2 order by created_at desc`, [scope.tenantId, scope.organizationId]);
  return result.rows;
}

export async function createCustomer(scope, body) {
  await ensurePosSchema();
  const name = String(body?.name || "").trim();
  if (!name) throw new Error("Customer name is required");
  const result = await getPool().query(
    `insert into pos_customers (tenant_id,organization_id,name,email,phone,tax_exempt,notes) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [scope.tenantId, scope.organizationId, name, String(body?.email || "").trim() || null, String(body?.phone || "").trim() || null, Boolean(body?.tax_exempt), String(body?.notes || "").trim() || null],
  );
  return result.rows[0];
}

export async function getSettings(scope) {
  await ensurePosSchema();
  const result = await getPool().query(
    `insert into pos_settings (tenant_id,organization_id,location_id,tax_rate) values ($1,$2,$3,8.25)
     on conflict (tenant_id,organization_id,location_id) do update set tenant_id=excluded.tenant_id returning *`,
    [scope.tenantId, scope.organizationId, scope.locationId],
  );
  return { tax_rate: Number(result.rows[0].tax_rate) };
}

export async function updateSettings(scope, body) {
  if (!scope.roles.includes("OWNER") && !scope.roles.includes("MANAGER")) throw new Error("Manager role is required");
  const rate = Number(body?.tax_rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 30) throw new Error("Tax rate must be between 0 and 30");
  await ensurePosSchema();
  const result = await getPool().query(
    `insert into pos_settings (tenant_id,organization_id,location_id,tax_rate) values ($1,$2,$3,$4)
     on conflict (tenant_id,organization_id,location_id) do update set tax_rate=excluded.tax_rate,updated_at=now() returning *`,
    [scope.tenantId, scope.organizationId, scope.locationId, rate],
  );
  return { tax_rate: Number(result.rows[0].tax_rate) };
}

export async function savePendingStripeCheckout(scope, sessionId, payload) {
  await ensurePosSchema();
  await getPool().query(
    `insert into stripe_pending_checkouts (session_id,tenant_id,organization_id,location_id,actor_subject,actor_email,payload)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)
     on conflict (session_id) do nothing`,
    [sessionId, scope.tenantId, scope.organizationId, scope.locationId, scope.userId, scope.email, JSON.stringify(payload)],
  );
}

export async function completePendingStripeCheckout(sessionId) {
  await ensurePosSchema();
  const result = await getPool().query(`select * from stripe_pending_checkouts where session_id=$1 limit 1`, [sessionId]);
  const pending = result.rows[0];
  if (!pending) throw new Error("Stripe checkout record not found");
  if (pending.completed_sale_id) return { id: pending.completed_sale_id };
  const scope = {
    tenantId: pending.tenant_id, organizationId: pending.organization_id, locationId: pending.location_id,
    userId: pending.actor_subject, email: pending.actor_email, roles: ["OWNER"],
  };
  const sale = await checkout(scope, { ...pending.payload, payment_status: "paid", amount_paid: pending.payload.total });
  await getPool().query(
    `update stripe_pending_checkouts set completed_sale_id=$2,completed_at=now() where session_id=$1 and completed_sale_id is null`,
    [sessionId, sale.id],
  );
  await getPool().query(`update pos_sales set stripe_session_id=$2 where id=$1`, [sale.id, sessionId]);
  return sale;
}
