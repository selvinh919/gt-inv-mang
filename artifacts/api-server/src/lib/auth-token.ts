import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export type SessionTokenClaims = JWTPayload & {
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  provider?: "google" | "discord";
  tenant_id?: string;
  organization_id?: string;
  location_id?: string;
  roles?: string[];
  permissions?: string[];
};

const encoder = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET?.trim() || process.env.AUTH_SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("AUTH_JWT_SECRET (or AUTH_SESSION_SECRET) is required");
  }
  return encoder.encode(secret);
}

function getIssuer(): string {
  return process.env.AUTH_JWT_ISSUER?.trim() || "vault-pos";
}

function getAudience(): string | undefined {
  const audience = process.env.AUTH_JWT_AUDIENCE?.trim();
  return audience || undefined;
}

export async function signSessionToken(claims: SessionTokenClaims): Promise<string> {
  const issuer = getIssuer();
  const audience = getAudience();

  let token = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("7d");

  if (audience) {
    token = token.setAudience(audience);
  }

  return token.sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionTokenClaims> {
  const issuer = getIssuer();
  const audience = getAudience();

  const { payload } = await jwtVerify(token, getSecret(), {
    issuer,
    audience,
  });

  return payload as SessionTokenClaims;
}
