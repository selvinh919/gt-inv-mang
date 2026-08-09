import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { auditLogs, db } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { requirePermission } from "../middlewares/permissions";
import { ApiError, toErrorPayload } from "../lib/api-errors";

const router = Router();
router.use(requireAuth);

function scopeFromRequest(req: any) {
  if (!req.authContext) {
    throw new ApiError("AUTH_REQUIRED", "Authentication required", 401);
  }

  return {
    tenantId: req.authContext.tenantId,
    organizationId: req.authContext.organizationId,
    locationId: req.authContext.locationId,
  };
}

router.get("/logs", requirePermission("inventory.read"), async (req, res) => {
  try {
    const scope = scopeFromRequest(req);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

    const action = String(req.query.action || "").trim();
    const entityType = String(req.query.entity_type || "").trim();
    const entityId = String(req.query.entity_id || "").trim();
    const actorEmail = String(req.query.actor_email || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const filters = [
      eq(auditLogs.tenant_id, scope.tenantId),
      eq(auditLogs.organization_id, scope.organizationId),
      eq(auditLogs.location_id, scope.locationId),
    ];

    if (action) filters.push(eq(auditLogs.action, action));
    if (entityType) filters.push(eq(auditLogs.entity_type, entityType));
    if (entityId) filters.push(eq(auditLogs.entity_id, entityId));
    if (actorEmail) filters.push(eq(auditLogs.user_id, actorEmail));

    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    if (fromDate && !Number.isNaN(fromDate.valueOf())) {
      filters.push(gte(auditLogs.created_at, fromDate));
    }
    if (toDate && !Number.isNaN(toDate.valueOf())) {
      filters.push(lte(auditLogs.created_at, toDate));
    }

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(...filters))
      .orderBy(desc(auditLogs.created_at))
      .limit(limit);

    const logs = rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      organization_id: row.organization_id,
      location_id: row.location_id,
      user_id: row.user_id,
      action: row.action,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      ip_address: row.ip_address,
      device_id: row.device_id,
      created_at: row.created_at.toISOString(),
    }));

    res.json(logs);
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

export default router;
