-- Priority 1 security foundation migration
-- Adds scope columns, idempotency, webhook idempotency, and audit trail tables.

ALTER TABLE collection_items
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS location_id text NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS collection_items_scope_idx
  ON collection_items (tenant_id, organization_id, location_id);

ALTER TABLE pos_products
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS location_id text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

DROP INDEX IF EXISTS pos_products_collection_sku_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS pos_products_scope_collection_sku_uidx
  ON pos_products (tenant_id, organization_id, location_id, collection_id, sku);

CREATE INDEX IF NOT EXISTS pos_products_scope_idx
  ON pos_products (tenant_id, organization_id, location_id);

ALTER TABLE pos_inventory_lots
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS location_id text NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS pos_inventory_lots_scope_idx
  ON pos_inventory_lots (tenant_id, organization_id, location_id);

ALTER TABLE pos_sales
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS location_id text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDING_PAYMENT',
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS payment_last_event text,
  ADD COLUMN IF NOT EXISTS settled_at timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_scope_order_uidx
  ON pos_sales (tenant_id, organization_id, location_id, order_number);

CREATE INDEX IF NOT EXISTS pos_sales_scope_idx
  ON pos_sales (tenant_id, organization_id, location_id);

ALTER TABLE pos_sale_lines
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS location_id text NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS pos_sale_lines_scope_idx
  ON pos_sale_lines (tenant_id, organization_id, location_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id serial PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'public',
  organization_id text NOT NULL DEFAULT 'default',
  location_id text NOT NULL DEFAULT 'main',
  route_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body text,
  created_by_user_id text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_scope_route_key_uidx
  ON idempotency_keys (tenant_id, organization_id, location_id, route_key, idempotency_key);

CREATE INDEX IF NOT EXISTS idempotency_scope_idx
  ON idempotency_keys (tenant_id, organization_id, location_id);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id serial PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'public',
  organization_id text NOT NULL DEFAULT 'default',
  location_id text NOT NULL DEFAULT 'main',
  stripe_event_id text NOT NULL,
  event_type text NOT NULL,
  event_created_at timestamp,
  payload_json text NOT NULL,
  processed_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_webhook_scope_event_uidx
  ON stripe_webhook_events (tenant_id, organization_id, location_id, stripe_event_id);

CREATE INDEX IF NOT EXISTS stripe_webhook_scope_idx
  ON stripe_webhook_events (tenant_id, organization_id, location_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY,
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  location_id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_json text,
  after_json text,
  metadata_json text,
  ip_address text,
  device_id text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_scope_idx
  ON audit_logs (tenant_id, organization_id, location_id);

CREATE INDEX IF NOT EXISTS audit_entity_idx
  ON audit_logs (entity_type, entity_id);
