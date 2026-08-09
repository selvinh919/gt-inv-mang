import { auditLogs, db } from "@workspace/db";
import type { Request } from "express";

export async function writeAuditLog(input: {
  req: Request;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  const ctx = input.req.authContext;
  if (!ctx) return;

  await db.insert(auditLogs).values({
    tenant_id: ctx.tenantId,
    organization_id: ctx.organizationId,
    location_id: ctx.locationId,
    user_id: ctx.userId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    before_json: input.before == null ? null : JSON.stringify(input.before),
    after_json: input.after == null ? null : JSON.stringify(input.after),
    metadata_json: input.metadata == null ? null : JSON.stringify(input.metadata),
    ip_address: input.req.ip || null,
    device_id: (input.req.headers["x-device-id"] as string | undefined) || null,
  });
}
