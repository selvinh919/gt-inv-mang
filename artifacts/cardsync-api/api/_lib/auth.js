import { SignJWT, jwtVerify } from "jose";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const textEncoder = new TextEncoder();

function getAllowedOrigins() {
  const configured = String(process.env.AUTH_ALLOWED_ORIGINS || "").trim();
  const defaults = ["https://gtcollectibles.io", "https://www.gtcollectibles.io", "http://localhost:5173"];
  return new Set((configured ? configured.split(",") : defaults).map((item) => item.trim()).filter(Boolean));
}

export function setCors(req, res, methods = "GET,POST,OPTIONS") {
  const origin = String(req.headers.origin || "").trim();
  const allowList = getAllowedOrigins();
  if (origin && allowList.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function getStateSecret() {
  const secret =
    String(process.env.AUTH_OAUTH_STATE_SECRET || "").trim() ||
    String(process.env.AUTH_JWT_SECRET || "").trim() ||
    String(process.env.NEXTAUTH_SECRET || "").trim();
  if (!secret) {
    throw new Error("Missing AUTH_OAUTH_STATE_SECRET (or AUTH_JWT_SECRET)");
  }
  return secret;
}

function signData(data, secret) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createState(provider, redirectUrl) {
  const payload = {
    nonce: randomBytes(16).toString("hex"),
    provider,
    redirectUrl,
    ts: Date.now(),
  };

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signData(encoded, getStateSecret());
  return `${encoded}.${signature}`;
}

export function verifyState(state, expectedProvider) {
  if (!state || typeof state !== "string") return null;
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;

  const expected = Buffer.from(signData(encoded, getStateSecret()));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!decoded || decoded.provider !== expectedProvider) return null;
  if (!decoded.redirectUrl || typeof decoded.redirectUrl !== "string") return null;
  if (!decoded.ts || Date.now() - Number(decoded.ts) > 10 * 60 * 1000) return null;
  return decoded;
}

export function sanitizeRedirectUrl(input) {
  const fallback = String(process.env.AUTH_DEFAULT_REDIRECT_URL || "https://gtcollectibles.io/auth").trim();
  const allowHosts = new Set(
    String(process.env.AUTH_REDIRECT_ALLOWLIST || "gtcollectibles.io,www.gtcollectibles.io,localhost,127.0.0.1")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

  try {
    const url = new URL(String(input || "").trim() || fallback);
    if (!["http:", "https:"].includes(url.protocol)) return fallback;
    if (!allowHosts.has(url.hostname.toLowerCase())) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function jwtSecret() {
  const secret =
    String(process.env.AUTH_JWT_SECRET || "").trim() ||
    String(process.env.NEXTAUTH_SECRET || "").trim();
  if (!secret) throw new Error("Missing AUTH_JWT_SECRET");
  return textEncoder.encode(secret);
}

function jwtIssuer() {
  return String(process.env.AUTH_JWT_ISSUER || "vault-pos").trim();
}

function jwtAudience() {
  const value = String(process.env.AUTH_JWT_AUDIENCE || "").trim();
  return value || undefined;
}

export async function signSessionToken(payload) {
  const issuer = jwtIssuer();
  const audience = jwtAudience();

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("7d");

  if (audience) jwt = jwt.setAudience(audience);
  return jwt.sign(jwtSecret());
}

export async function verifySessionToken(token) {
  const issuer = jwtIssuer();
  const audience = jwtAudience();

  const { payload } = await jwtVerify(token, jwtSecret(), {
    issuer,
    audience,
  });

  return payload;
}
