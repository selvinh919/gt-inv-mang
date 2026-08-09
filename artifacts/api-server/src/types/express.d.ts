import type { AppRole } from "../lib/permissions";

declare global {
  namespace Express {
    interface Request {
      authContext?: {
        userId: string;
        email: string | null;
        name: string | null;
        picture: string | null;
        provider: string | null;
        tenantId: string;
        organizationId: string;
        locationId: string;
        roles: AppRole[];
        directPermissions: string[];
        permissions: Set<string>;
        tokenSubject: string;
      };
      idempotencyReplay?: boolean;
    }
  }
}

export {};
