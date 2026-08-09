import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const posProducts = pgTable(
  "pos_products",
  {
    id: serial("id").primaryKey(),
    tenant_id: text("tenant_id").notNull().default("public"),
    organization_id: text("organization_id").notNull().default("default"),
    location_id: text("location_id").notNull().default("main"),
    collection_id: integer("collection_id").notNull().default(1),
    external_product_id: integer("external_product_id"),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    set_name: text("set_name"),
    game_name: text("game_name"),
    rarity: text("rarity"),
    printing: text("printing").notNull().default("Normal"),
    condition: text("condition").notNull().default("Near Mint"),
    image_url: text("image_url"),
    market_price: numeric("market_price", { precision: 10, scale: 2 }),
    market_price_updated_at: timestamp("market_price_updated_at"),
    active: boolean("active").notNull().default(true),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pos_products_scope_collection_sku_uidx").on(
      table.tenant_id,
      table.organization_id,
      table.location_id,
      table.collection_id,
      table.sku,
    ),
    index("pos_products_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
  ],
);

export const posInventoryLots = pgTable("pos_inventory_lots", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull().default("public"),
  organization_id: text("organization_id").notNull().default("default"),
  location_id: text("location_id").notNull().default("main"),
  product_id: integer("product_id")
    .notNull()
    .references(() => posProducts.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull(),
  quantity_remaining: integer("quantity_remaining").notNull(),
  unit_cost: numeric("unit_cost", { precision: 10, scale: 2 }).notNull(),
  source: text("source"),
  note: text("note"),
  received_at: timestamp("received_at").notNull().defaultNow(),
}, (table) => [
  index("pos_inventory_lots_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
]);

export const posSales = pgTable("pos_sales", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull().default("public"),
  organization_id: text("organization_id").notNull().default("default"),
  location_id: text("location_id").notNull().default("main"),
  collection_id: integer("collection_id").notNull().default(1),
  order_number: text("order_number").notNull(),
  status: text("status").notNull().default("PENDING_PAYMENT"),
  payment_status: text("payment_status").notNull().default("pending"),
  stripe_checkout_session_id: text("stripe_checkout_session_id"),
  stripe_payment_intent_id: text("stripe_payment_intent_id"),
  payment_last_event: text("payment_last_event"),
  settled_at: timestamp("settled_at"),
  sold_at: timestamp("sold_at").notNull().defaultNow(),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
  tax: numeric("tax", { precision: 10, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 10, scale: 2 }).notNull(),
  cogs: numeric("cogs", { precision: 10, scale: 2 }).notNull(),
  profit: numeric("profit", { precision: 10, scale: 2 }).notNull(),
  note: text("note"),
}, (table) => [
  uniqueIndex("pos_sales_scope_order_uidx").on(table.tenant_id, table.organization_id, table.location_id, table.order_number),
  index("pos_sales_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
]);

export const posSaleLines = pgTable("pos_sale_lines", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull().default("public"),
  organization_id: text("organization_id").notNull().default("default"),
  location_id: text("location_id").notNull().default("main"),
  sale_id: integer("sale_id")
    .notNull()
    .references(() => posSales.id, { onDelete: "cascade" }),
  product_id: integer("product_id")
    .notNull()
    .references(() => posProducts.id, { onDelete: "restrict" }),
  lot_id: integer("lot_id").references(() => posInventoryLots.id, { onDelete: "set null" }),
  quantity: integer("quantity").notNull(),
  unit_price: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  unit_cost: numeric("unit_cost", { precision: 10, scale: 2 }).notNull(),
  line_total: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  line_profit: numeric("line_profit", { precision: 10, scale: 2 }).notNull(),
}, (table) => [
  index("pos_sale_lines_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
]);
