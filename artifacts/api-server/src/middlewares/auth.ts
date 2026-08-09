import type { NextFunction, Request, Response } from "express";
import { ApiError, toErrorPayload } from "../lib/api-errors";
import { expandPermissions, type AppRole } from "../lib/permissions";
import { verifySessionToken, type SessionTokenClaims } from "../lib/auth-token";

const authRequired = String(process.env.AUTH_REQUIRED || "true").toLowerCase() === "true";
const allowDevBypass = String(process.env.AUTH_ALLOW_DEV_BYPASS || "false").toLowerCase() === "true";

function readStringClaim(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArrayClaim(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).map((s) => s.trim()).filter(Boolean);
}

function requireConfiguredAuth(): void {
  if (!process.env.AUTH_JWT_SECRET?.trim() && !process.env.AUTH_SESSION_SECRET?.trim()) {
    throw new ApiError(
      "AUTH_CONFIGURATION_ERROR",
      "Auth is required but AUTH_JWT_SECRET/AUTH_SESSION_SECRET is not configured",
      500,
    );
  }
}

function parseBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

function payloadToContext(payload: SessionTokenClaims) {
  const rawPayload = payload as Record<string, unknown>;

  const userId = readStringClaim(rawPayload, "sub");
  if (!userId) {
    throw new ApiError("AUTH_INVALID", "JWT missing subject", 401);
  }

  const tenantId = readStringClaim(rawPayload, "tenant_id") || "public";
  const organizationId = readStringClaim(rawPayload, "organization_id") || "default";
  const locationId = readStringClaim(rawPayload, "location_id") || "main";

  const roles = readStringArrayClaim(rawPayload, "roles").map((role) => role.toUpperCase() as AppRole);
  const directPermissions = readStringArrayClaim(rawPayload, "permissions");

  return {
    userId,
    email: readStringClaim(rawPayload, "email"),
    name: readStringClaim(rawPayload, "name"),
    picture: readStringClaim(rawPayload, "picture"),
    provider: readStringClaim(rawPayload, "provider"),
    tenantId,
    organizationId,
    locationId,
    roles,
    directPermissions,
    permissions: expandPermissions(roles, directPermissions),
    tokenSubject: userId,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = parseBearerToken(req);

    if (!token && !authRequired && allowDevBypass) {
      const directPermissions = ["*"];
      req.authContext = {
        userId: "dev-user",
        email: "dev@local",
        name: "Dev User",
        picture: null,
        provider: "dev",
        tenantId: "public",
        organizationId: "default",
        locationId: "main",
        roles: ["OWNER"],
        directPermissions,
        permissions: expandPermissions(["OWNER"], directPermissions),
        tokenSubject: "dev-user",
      };
      next();
      return;
    }

    if (!token) {
      throw new ApiError("AUTH_REQUIRED", "Authentication required", 401);
    }

    requireConfiguredAuth();
    const payload = await verifySessionToken(token);
    req.authContext = payloadToContext(payload);

    next();
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
}
