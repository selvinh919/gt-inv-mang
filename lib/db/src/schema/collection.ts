import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const collectionItems = pgTable("collection_items", {
  id: serial("id").primaryKey(),
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
  added_at: timestamp("added_at").notNull().defaultNow(),
});

export const insertCollectionItemSchema = createInsertSchema(collectionItems).omit({ id: true, added_at: true });
export type InsertCollectionItem = z.infer<typeof insertCollectionItemSchema>;
export type CollectionItem = typeof collectionItems.$inferSelect;
