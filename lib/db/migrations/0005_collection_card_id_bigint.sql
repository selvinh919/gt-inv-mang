-- Card and locally generated product identifiers can exceed PostgreSQL's
-- signed 32-bit integer range. Keep them as exact JavaScript-safe integers.

ALTER TABLE collection_items
  ALTER COLUMN card_id TYPE bigint USING card_id::bigint;
