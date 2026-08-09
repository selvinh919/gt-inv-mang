import type { NextFunction, Request, Response } from "express";
import { ApiError, toErrorPayload } from "../lib/api-errors";
import { hasPermission } from "../lib/permissions";

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.authContext) {
        throw new ApiError("AUTH_REQUIRED", "Authentication required", 401);
      }

      if (!hasPermission(req.authContext.permissions, permission)) {
        throw new ApiError("FORBIDDEN", `Missing required permission: ${permission}`, 403);
      }

      next();
    } catch (error) {
      const { statusCode, payload } = toErrorPayload(error);
      res.status(statusCode).json(payload);
    }
  };
}
