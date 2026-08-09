-- Add product metadata columns required for full inventory sync across clients.

ALTER TABLE collection_items
  ADD COLUMN IF NOT EXISTS collection_id integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS vendor_brand text,
  ADD COLUMN IF NOT EXISTS product_category text,
  ADD COLUMN IF NOT EXISTS price_paid numeric(10,2),
  ADD COLUMN IF NOT EXISTS price_paid_input_type text,
  ADD COLUMN IF NOT EXISTS price_paid_percent numeric(8,2),
  ADD COLUMN IF NOT EXISTS sale_price_source text,
  ADD COLUMN IF NOT EXISTS sale_price_rule text,
  ADD COLUMN IF NOT EXISTS market_price_at_add numeric(10,2),
  ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS collection_items_scope_collection_idx
  ON collection_items (tenant_id, organization_id, location_id, collection_id);
