import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, idempotencyKeys } from "@workspace/db";
import type { Request } from "express";
import { ApiError } from "./api-errors";

function stableStringify(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function makeRequestHash(req: Request): string {
  const raw = `${req.method}:${req.path}:${stableStringify(req.body ?? {})}`;
  return createHash("sha256").update(raw).digest("hex");
}

export async function runWithIdempotency<T>(input: {
  req: Request;
  routeKey: string;
  execute: () => Promise<{ statusCode: number; body: T }>;
}) {
  const ctx = input.req.authContext;
  if (!ctx) {
    throw new ApiError("AUTH_REQUIRED", "Authentication required", 401);
  }

  const idempotencyKey = String(input.req.headers["idempotency-key"] || "").trim();
  if (!idempotencyKey) {
    throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", 400);
  }

  const requestHash = makeRequestHash(input.req);

  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(and(
      eq(idempotencyKeys.tenant_id, ctx.tenantId),
      eq(idempotencyKeys.organization_id, ctx.organizationId),
      eq(idempotencyKeys.location_id, ctx.locationId),
      eq(idempotencyKeys.route_key, input.routeKey),
      eq(idempotencyKeys.idempotency_key, idempotencyKey),
    ))
    .limit(1);

  if (existing[0]) {
    if (existing[0].request_hash !== requestHash) {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with a different request payload",
        409,
      );
    }

    if (existing[0].response_status != null && existing[0].response_body) {
      return {
        replay: true,
        statusCode: existing[0].response_status,
        body: JSON.parse(existing[0].response_body) as T,
      };
    }

    throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "Request with this key is already in progress", 409);
  }

  await db.insert(idempotencyKeys).values({
    tenant_id: ctx.tenantId,
    organization_id: ctx.organizationId,
    location_id: ctx.locationId,
    route_key: input.routeKey,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    created_by_user_id: ctx.userId,
  });

  const result = await input.execute();
  await db
    .update(idempotencyKeys)
    .set({
      response_status: result.statusCode,
      response_body: JSON.stringify(result.body),
    })
    .where(and(
      eq(idempotencyKeys.tenant_id, ctx.tenantId),
      eq(idempotencyKeys.organization_id, ctx.organizationId),
      eq(idempotencyKeys.location_id, ctx.locationId),
      eq(idempotencyKeys.route_key, input.routeKey),
      eq(idempotencyKeys.idempotency_key, idempotencyKey),
    ));

  return {
    replay: false,
    statusCode: result.statusCode,
    body: result.body,
  };
}
