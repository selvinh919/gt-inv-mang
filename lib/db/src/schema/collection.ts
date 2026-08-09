import { pgTable, serial, text, integer, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const collectionItems = pgTable("collection_items", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull().default("public"),
  organization_id: text("organization_id").notNull().default("default"),
  location_id: text("location_id").notNull().default("main"),
  collection_id: integer("collection_id").notNull().default(1),
  sku: text("sku"),
  barcode: text("barcode"),
  vendor_brand: text("vendor_brand"),
  product_category: text("product_category"),
  card_id: integer("card_id").notNull(),
  card_name: text("card_name").notNull(),
  set_name: text("set_name"),
  game_name: text("game_name"),
  rarity: text("rarity"),
  printing: text("printing").notNull().default("Normal"),
  market_price: numeric("market_price", { precision: 10, scale: 2 }),
  low_price: numeric("low_price", { precision: 10, scale: 2 }),
  image_url: text("image_url"),
  quantity: integer("quantity").notNull().default(1),
  notes: text("notes"),
  price_paid: numeric("price_paid", { precision: 10, scale: 2 }),
  price_paid_input_type: text("price_paid_input_type"),
  price_paid_percent: numeric("price_paid_percent", { precision: 8, scale: 2 }),
  sale_price_source: text("sale_price_source"),
  sale_price_rule: text("sale_price_rule"),
  market_price_at_add: numeric("market_price_at_add", { precision: 10, scale: 2 }),
  added_at: timestamp("added_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("collection_items_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
  index("collection_items_scope_collection_idx").on(table.tenant_id, table.organization_id, table.location_id, table.collection_id),
]);

export const insertCollectionItemSchema = createInsertSchema(collectionItems).omit({ id: true, added_at: true });
export type InsertCollectionItem = z.infer<typeof insertCollectionItemSchema>;
export type CollectionItem = typeof collectionItems.$inferSelect;
