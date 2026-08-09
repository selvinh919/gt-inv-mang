import { sanitizeRedirectUrl, setCors, signSessionToken, verifySessionToken, verifyState, createState } from "./_lib/auth.js";
import {
  authenticateLocalUser,
  findUserByEmail,
  migrateLocalUsers,
  registerLocalUser,
  resetLocalPassword,
  userRoleToJwtRoles,
} from "./_lib/local-auth.js";
import {
  deleteItemById,
  findItemById,
  insertItem,
  normalizeCreatePayload,
  normalizeUpdatePayload,
  parseCollectionFilter,
  queryItems,
  requireAuthContext,
  updateItemById,
} from "./_lib/collection.js";

const ADMIN_EMAILS = new Set(
  String(process.env.AUTH_ADMIN_EMAILS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

function withParam(url, key, value) {
  const next = new URL(url);
  next.searchParams.set(key, value);
  return next.toString();
}

function parseAuthPath(req) {
  const url = new URL(req.url, "http://localhost");
  const prefix = "/api/auth";
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  return path.split("/").map((part) => part.trim()).filter(Boolean);
}

function parseBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "owner" || value === "manager" || value === "clerk") return value;
  return "clerk";
}

function roleFromJwt(payload) {
  const roles = Array.isArray(payload?.roles) ? payload.roles.map((item) => String(item).toUpperCase()) : [];
  if (roles.includes("OWNER")) return "owner";
  if (roles.includes("MANAGER")) return "manager";
  return "clerk";
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(String(req.body || "{}"));
  } catch {
    return null;
  }
}

async function signLocalSession(user) {
  const role = normalizeRole(user.role);
  const token = await signSessionToken({
    sub: `local|${user.id}`,
    email: String(user.email || "").trim().toLowerCase(),
    name: String(user.name || user.email || "").trim() || String(user.email || "").trim().toLowerCase(),
    picture: null,
    provider: "local",
    tenant_id: "public",
    organization_id: "default",
    location_id: "main",
    roles: userRoleToJwtRoles(role),
    permissions: [],
  });

  return {
    token,
    user: {
      id: Number(user.id),
      email: String(user.email || "").trim().toLowerCase(),
      name: String(user.name || "").trim() || String(user.email || "").trim().toLowerCase(),
      role,
      provider: "local",
    },
  };
}

async function startGoogle(req, res) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) {
    res.status(500).json({ error: "Missing GOOGLE_CLIENT_ID" });
    return;
  }

  const redirectUrl = sanitizeRedirectUrl(req.query.redirect);
  const callbackUrl = String(process.env.AUTH_GOOGLE_CALLBACK_URL || "").trim();
  if (!callbackUrl) {
    res.status(500).json({ error: "Missing AUTH_GOOGLE_CALLBACK_URL" });
    return;
  }

  const state = createState("google", redirectUrl);
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "select_account");

  res.redirect(authUrl.toString());
}

async function startDiscord(req, res) {
  const clientId = String(process.env.DISCORD_CLIENT_ID || "").trim();
  if (!clientId) {
    res.status(500).json({ error: "Missing DISCORD_CLIENT_ID" });
    return;
  }

  const redirectUrl = sanitizeRedirectUrl(req.query.redirect);
  const callbackUrl = String(process.env.AUTH_DISCORD_CALLBACK_URL || "").trim();
  if (!callbackUrl) {
    res.status(500).json({ error: "Missing AUTH_DISCORD_CALLBACK_URL" });
    return;
  }

  const state = createState("discord", redirectUrl);
  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "identify email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "none");

  res.redirect(authUrl.toString());
}

async function callbackGoogle(req, res) {
  const fallbackRedirect = sanitizeRedirectUrl(process.env.AUTH_DEFAULT_REDIRECT_URL || "https://gtcollectibles.io/auth");
  try {
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const ctx = verifyState(state, "google");

    if (!ctx || !code) {
      res.redirect(withParam(fallbackRedirect, "auth_error", "state_mismatch"));
      return;
    }

    const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
    const callbackUrl = String(process.env.AUTH_GOOGLE_CALLBACK_URL || "").trim();
    if (!clientId || !clientSecret || !callbackUrl) {
      throw new Error("Google OAuth env is incomplete");
    }

    const tokenBody = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (!tokenResponse.ok) {
      throw new Error("Google token exchange failed");
    }

    const tokenJson = await tokenResponse.json();
    const accessToken = String(tokenJson.access_token || "").trim();
    if (!accessToken) {
      throw new Error("Google access token missing");
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) {
      throw new Error("Google profile fetch failed");
    }

    const profile = await profileResponse.json();
    const id = String(profile.sub || "").trim();
    const email = String(profile.email || "").trim().toLowerCase();
    const name = String(profile.name || email).trim() || email;
    const picture = String(profile.picture || "").trim() || null;

    if (!id || !email) {
      throw new Error("Google profile missing required fields");
    }

    const token = await signSessionToken({
      sub: `google|${id}`,
      email,
      name,
      picture,
      provider: "google",
      tenant_id: "public",
      organization_id: "default",
      location_id: "main",
      roles: ADMIN_EMAILS.has(email) ? ["OWNER"] : ["CASHIER"],
      permissions: [],
    });

    res.redirect(withParam(ctx.redirectUrl, "auth_token", token));
  } catch {
    res.redirect(withParam(fallbackRedirect, "auth_error", "oauth_callback_failed"));
  }
}

async function callbackDiscord(req, res) {
  const fallbackRedirect = sanitizeRedirectUrl(process.env.AUTH_DEFAULT_REDIRECT_URL || "https://gtcollectibles.io/auth");
  try {
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const ctx = verifyState(state, "discord");

    if (!ctx || !code) {
      res.redirect(withParam(fallbackRedirect, "auth_error", "state_mismatch"));
      return;
    }

    const clientId = String(process.env.DISCORD_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.DISCORD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SERVER || "").trim();
    const callbackUrl = String(process.env.AUTH_DISCORD_CALLBACK_URL || "").trim();
    if (!clientId || !clientSecret || !callbackUrl) {
      throw new Error("Discord OAuth env is incomplete");
    }

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
    });

    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (!tokenResponse.ok) {
      throw new Error("Discord token exchange failed");
    }

    const tokenJson = await tokenResponse.json();
    const accessToken = String(tokenJson.access_token || "").trim();
    if (!accessToken) {
      throw new Error("Discord access token missing");
    }

    const profileResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) {
      throw new Error("Discord profile fetch failed");
    }

    const profile = await profileResponse.json();
    const id = String(profile.id || "").trim();
    const email = String(profile.email || "").trim().toLowerCase();
    const name = String(profile.global_name || profile.username || email).trim() || email;
    const avatarHash = String(profile.avatar || "").trim();
    const picture = avatarHash ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png` : null;

    if (!id || !email) {
      throw new Error("Discord profile missing required fields");
    }

    const token = await signSessionToken({
      sub: `discord|${id}`,
      email,
      name,
      picture,
      provider: "discord",
      tenant_id: "public",
      organization_id: "default",
      location_id: "main",
      roles: ADMIN_EMAILS.has(email) ? ["OWNER"] : ["CASHIER"],
      permissions: [],
    });

    res.redirect(withParam(ctx.redirectUrl, "auth_token", token));
  } catch {
    res.redirect(withParam(fallbackRedirect, "auth_error", "oauth_callback_failed"));
  }
}

async function me(req, res) {
  const token = parseBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = await verifySessionToken(token);
    const sub = String(payload.sub || "").trim();
    const email = String(payload.email || "").trim().toLowerCase();
    const name = String(payload.name || email).trim() || email;
    const picture = payload.picture ? String(payload.picture) : null;
    const provider = payload.provider ? String(payload.provider) : null;
    const roles = Array.isArray(payload.roles) ? payload.roles.map((item) => String(item)) : [];

    if (!sub || !email) {
      res.status(401).json({ error: "Token is missing required profile fields" });
      return;
    }

    res.status(200).json({
      sub,
      email,
      name,
      picture,
      provider,
      role: roles[0] || "CASHIER",
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function localRegister(req, res) {
  const body = parseJsonBody(req);
  if (!body) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "").trim();
  const name = String(body.name || email).trim() || email;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  try {
    const existing = await findUserByEmail(email);
    if (existing && existing.active) {
      res.status(409).json({ error: "A user with this email already exists" });
      return;
    }

    const role = ADMIN_EMAILS.has(email) ? "owner" : "clerk";
    const user = await registerLocalUser({ name, email, password, role, externalSub: null });
    const session = await signLocalSession(user);
    res.status(201).json(session);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not register user" });
  }
}

async function localLogin(req, res) {
  const body = parseJsonBody(req);
  if (!body) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "").trim();
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const user = await authenticateLocalUser(email, password);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const session = await signLocalSession(user);
    res.status(200).json(session);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not sign in" });
  }
}

async function localReset(req, res) {
  const body = parseJsonBody(req);
  if (!body) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const email = String(body.email || "").trim().toLowerCase();
  const newPassword = String(body.password || body.newPassword || "").trim();

  if (!email || !newPassword) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  if (newPassword.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  try {
    const user = await resetLocalPassword(email, newPassword);
    if (!user) {
      res.status(404).json({ error: "No account found for this email" });
      return;
    }

    const session = await signLocalSession(user);
    res.status(200).json(session);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not reset password" });
  }
}

async function localMigrate(req, res) {
  const token = parseBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = await verifySessionToken(token);
    if (roleFromJwt(payload) !== "owner") {
      res.status(403).json({ error: "Owner role is required for migration" });
      return;
    }

    const body = parseJsonBody(req);
    const users = Array.isArray(body?.users) ? body.users : [];
    const result = await migrateLocalUsers(users);
    res.status(200).json(result);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function logout(res) {
  res.status(204).end();
}

async function collectionRoot(req, res) {
  const scope = await requireAuthContext(req, res);
  if (!scope) return;

  if (req.method === "GET") {
    const collectionId = parseCollectionFilter(req);
    const items = await queryItems(scope, collectionId);
    res.status(200).json(items);
    return;
  }

  if (req.method === "POST") {
    const body = parseJsonBody(req);
    if (!body) {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    const parsed = normalizeCreatePayload(body);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const item = await insertItem(scope, parsed.value);
    res.status(201).json(item);
    return;
  }

  res.setHeader("Allow", "GET,POST,OPTIONS");
  res.status(405).json({ error: "Method not allowed" });
}

async function collectionById(req, res, rawId) {
  const scope = await requireAuthContext(req, res);
  if (!scope) return;

  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid item id" });
    return;
  }

  if (req.method === "GET") {
    const item = await findItemById(scope, id);
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.status(200).json(item);
    return;
  }

  if (req.method === "PATCH") {
    const body = parseJsonBody(req);
    if (!body) {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    const updates = normalizeUpdatePayload(body);
    const updated = await updateItemById(scope, id, updates);
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.status(200).json(updated);
    return;
  }

  if (req.method === "DELETE") {
    const deleted = await deleteItemById(scope, id);
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.status(204).end();
    return;
  }

  res.setHeader("Allow", "GET,PATCH,DELETE,OPTIONS");
  res.status(405).json({ error: "Method not allowed" });
}

export default async function handler(req, res) {
  setCors(req, res, "GET,POST,PATCH,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const [section, provider, third] = parseAuthPath(req);

  if (section === "google" && provider === "start" && req.method === "GET") {
    await startGoogle(req, res);
    return;
  }

  if (section === "discord" && provider === "start" && req.method === "GET") {
    await startDiscord(req, res);
    return;
  }

  if (section === "callback" && provider === "google" && req.method === "GET") {
    await callbackGoogle(req, res);
    return;
  }

  if (section === "callback" && provider === "discord" && req.method === "GET") {
    await callbackDiscord(req, res);
    return;
  }

  if (section === "me" && req.method === "GET") {
    await me(req, res);
    return;
  }

  if (section === "local" && provider === "register" && req.method === "POST") {
    await localRegister(req, res);
    return;
  }

  if (section === "local" && provider === "login" && req.method === "POST") {
    await localLogin(req, res);
    return;
  }

  if (section === "local" && provider === "reset" && req.method === "POST") {
    await localReset(req, res);
    return;
  }

  if (section === "local" && provider === "migrate" && req.method === "POST") {
    await localMigrate(req, res);
    return;
  }

  if (section === "collection" && !provider) {
    await collectionRoot(req, res);
    return;
  }

  if (section === "collection" && provider) {
    await collectionById(req, res, provider || third);
    return;
  }

  if (section === "logout" && req.method === "POST") {
    logout(res);
    return;
  }

  res.status(404).json({ error: "Not found" });
}
