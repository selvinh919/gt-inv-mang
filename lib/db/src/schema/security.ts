import { pgTable, serial, text, timestamp, uniqueIndex, index, integer, boolean, bigint } from "drizzle-orm/pg-core";

export const authUsers = pgTable("auth_users", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  password_hash: text("password_hash").notNull(),
  role: text("role").notNull().default("clerk"),
  active: boolean("active").notNull().default(true),
  external_sub: text("external_sub"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("auth_users_email_uidx").on(table.email),
  index("auth_users_role_idx").on(table.role),
  index("auth_users_active_idx").on(table.active),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull().default("public"),
  organization_id: text("organization_id").notNull().default("default"),
  location_id: text("location_id").notNull().default("main"),
  route_key: text("route_key").notNull(),
  idempotency_key: text("idempotency_key").notNull(),
  request_hash: text("request_hash").notNull(),
  response_status: integer("response_status"),
  response_body: text("response_body"),
  created_by_user_id: text("created_by_user_id"),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idempotency_scope_route_key_uidx").on(
    table.tenant_id,
    table.organization_id,
    table.location_id,
    table.route_key,
    table.idempotency_key,
  ),
  index("idempotency_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
]);

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull().default("public"),
  organization_id: text("organization_id").notNull().default("default"),
  location_id: text("location_id").notNull().default("main"),
  stripe_event_id: text("stripe_event_id").notNull(),
  event_type: text("event_type").notNull(),
  event_created_at: timestamp("event_created_at"),
  payload_json: text("payload_json").notNull(),
  processed_at: timestamp("processed_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("stripe_webhook_scope_event_uidx").on(
    table.tenant_id,
    table.organization_id,
    table.location_id,
    table.stripe_event_id,
  ),
  index("stripe_webhook_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
]);

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  organization_id: text("organization_id").notNull(),
  location_id: text("location_id").notNull(),
  user_id: text("user_id").notNull(),
  action: text("action").notNull(),
  entity_type: text("entity_type").notNull(),
  entity_id: text("entity_id").notNull(),
  before_json: text("before_json"),
  after_json: text("after_json"),
  metadata_json: text("metadata_json"),
  ip_address: text("ip_address"),
  device_id: text("device_id"),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("audit_scope_idx").on(table.tenant_id, table.organization_id, table.location_id),
  index("audit_entity_idx").on(table.entity_type, table.entity_id),
]);
