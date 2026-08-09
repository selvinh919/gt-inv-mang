import { Router } from "express";
import type { CookieOptions, Request } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, toErrorPayload } from "../lib/api-errors";
import { signSessionToken } from "../lib/auth-token";
import { requireAuth } from "../middlewares/auth";

type Provider = "google" | "discord";

type OAuthContext = {
  state: string;
  provider: Provider;
  redirect: string;
  createdAt: number;
};

const router = Router();

const OAUTH_COOKIE = "oauth_ctx";
const OAUTH_MAX_AGE_MS = 10 * 60 * 1000;

function getCookieSecret(): string {
  return (
    process.env.AUTH_COOKIE_SECRET?.trim() ||
    process.env.AUTH_JWT_SECRET?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    ""
  );
}

function requireCookieSecret(): string {
  const secret = getCookieSecret();
  if (!secret) {
    throw new ApiError("AUTH_CONFIGURATION_ERROR", "AUTH_COOKIE_SECRET (or AUTH_JWT_SECRET) is required", 500);
  }
  return secret;
}

function signValue(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function serializeSignedContext(context: OAuthContext): string {
  const payload = Buffer.from(JSON.stringify(context), "utf8").toString("base64url");
  const signature = signValue(payload, requireCookieSecret());
  return `${payload}.${signature}`;
}

function parseSignedContext(raw: string | undefined): OAuthContext | null {
  if (!raw) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;

  const expected = signValue(payload, requireCookieSecret());
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthContext;
    if (!parsed || !parsed.state || !parsed.provider || !parsed.redirect || !parsed.createdAt) {
      return null;
    }
    if (Date.now() - parsed.createdAt > OAUTH_MAX_AGE_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function asProvider(value: string): Provider | null {
  return value === "google" || value === "discord" ? value : null;
}

function getApiBaseUrl(req: Request): string {
  const configured = process.env.AUTH_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const protocol = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  if (!host) {
    throw new ApiError("AUTH_CONFIGURATION_ERROR", "Unable to resolve API host for OAuth callback", 500);
  }
  return `${protocol}://${host}`.replace(/\/+$/, "");
}

function getCallbackUrl(req: Request, provider: Provider): string {
  return `${getApiBaseUrl(req)}/api/auth/callback/${provider}`;
}

function parseAllowedRedirectHosts(): Set<string> {
  const raw = process.env.AUTH_REDIRECT_ALLOWLIST?.trim() || "";
  const defaults = ["gtcollectibles.io", "www.gtcollectibles.io", "localhost", "127.0.0.1"];
  const hosts = raw
    ? raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
    : defaults;
  return new Set(hosts);
}

function resolveRedirectUrl(req: Request): string {
  const candidate = String(req.query.redirect || "").trim();
  const fallback = process.env.AUTH_DEFAULT_REDIRECT_URL?.trim() || "https://gtcollectibles.io/auth";
  if (!candidate) return fallback;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fallback;
    }
    const allowHosts = parseAllowedRedirectHosts();
    if (!allowHosts.has(parsed.hostname.toLowerCase())) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: OAUTH_MAX_AGE_MS,
    path: "/api/auth",
  };
}

function appendQuery(url: string, params: Record<string, string>): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    next.searchParams.set(key, value);
  }
  return next.toString();
}

function adminEmailSet(): Set<string> {
  const raw = process.env.AUTH_ADMIN_EMAILS?.trim() || "";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{ id: string; email: string; name: string; picture: string | null }> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new ApiError("AUTH_CONFIGURATION_ERROR", "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required", 500);
  }

  const tokenBody = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) {
    throw new ApiError("AUTH_OAUTH_EXCHANGE_FAILED", "Google token exchange failed", 502);
  }

  const tokenJson = await tokenResponse.json() as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    throw new ApiError("AUTH_OAUTH_EXCHANGE_FAILED", "Google token exchange returned no access token", 502);
  }

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) {
    throw new ApiError("AUTH_PROFILE_FETCH_FAILED", "Google profile fetch failed", 502);
  }

  const profile = await profileResponse.json() as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!profile.sub || !profile.email) {
    throw new ApiError("AUTH_PROFILE_FETCH_FAILED", "Google profile missing required fields", 502);
  }

  return {
    id: profile.sub,
    email: profile.email,
    name: profile.name || profile.email,
    picture: profile.picture || null,
  };
}

async function exchangeDiscordCode(code: string, redirectUri: string): Promise<{ id: string; email: string; name: string; picture: string | null }> {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim() || process.env.DISCORD_CLIENT_SERVER?.trim();
  if (!clientId || !clientSecret) {
    throw new ApiError("AUTH_CONFIGURATION_ERROR", "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required", 500);
  }

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) {
    throw new ApiError("AUTH_OAUTH_EXCHANGE_FAILED", "Discord token exchange failed", 502);
  }

  const tokenJson = await tokenResponse.json() as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    throw new ApiError("AUTH_OAUTH_EXCHANGE_FAILED", "Discord token exchange returned no access token", 502);
  }

  const profileResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) {
    throw new ApiError("AUTH_PROFILE_FETCH_FAILED", "Discord profile fetch failed", 502);
  }

  const profile = await profileResponse.json() as {
    id?: string;
    email?: string;
    username?: string;
    global_name?: string;
    avatar?: string;
  };

  if (!profile.id || !profile.email) {
    throw new ApiError("AUTH_PROFILE_FETCH_FAILED", "Discord profile missing required fields", 502);
  }

  const avatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : null;

  return {
    id: profile.id,
    email: profile.email,
    name: profile.global_name || profile.username || profile.email,
    picture: avatar,
  };
}

router.get("/:provider/start", async (req, res) => {
  try {
    const provider = asProvider(String(req.params.provider || ""));
    if (!provider) {
      throw new ApiError("AUTH_PROVIDER_UNSUPPORTED", "Unsupported auth provider", 404);
    }

    const state = randomBytes(24).toString("hex");
    const redirect = resolveRedirectUrl(req);
    const callbackUrl = getCallbackUrl(req, provider);

    const context: OAuthContext = {
      state,
      provider,
      redirect,
      createdAt: Date.now(),
    };

    res.cookie(OAUTH_COOKIE, serializeSignedContext(context), cookieOptions());

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
      if (!clientId) {
        throw new ApiError("AUTH_CONFIGURATION_ERROR", "GOOGLE_CLIENT_ID is required", 500);
      }

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", callbackUrl);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid profile email");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "select_account");
      res.redirect(authUrl.toString());
      return;
    }

    const clientId = process.env.DISCORD_CLIENT_ID?.trim();
    if (!clientId) {
      throw new ApiError("AUTH_CONFIGURATION_ERROR", "DISCORD_CLIENT_ID is required", 500);
    }

    const authUrl = new URL("https://discord.com/oauth2/authorize");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", callbackUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "identify email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "none");
    res.redirect(authUrl.toString());
  } catch (error) {
    const { statusCode, payload } = toErrorPayload(error);
    res.status(statusCode).json(payload);
  }
});

router.get("/callback/:provider", async (req, res) => {
  const provider = asProvider(String(req.params.provider || ""));
  const fallbackRedirect = process.env.AUTH_DEFAULT_REDIRECT_URL?.trim() || "https://gtcollectibles.io/auth";

  try {
    if (!provider) {
      res.redirect(appendQuery(fallbackRedirect, { auth_error: "unsupported_provider" }));
      return;
    }

    const context = parseSignedContext(req.cookies?.[OAUTH_COOKIE]);
    res.clearCookie(OAUTH_COOKIE, cookieOptions());
    if (!context || context.provider !== provider) {
      res.redirect(appendQuery(fallbackRedirect, { auth_error: "invalid_oauth_context" }));
      return;
    }

    const returnedState = String(req.query.state || "");
    const code = String(req.query.code || "");
    if (!returnedState || !code || returnedState !== context.state) {
      res.redirect(appendQuery(context.redirect, { auth_error: "state_mismatch" }));
      return;
    }

    const callbackUrl = getCallbackUrl(req, provider);
    const profile = provider === "google"
      ? await exchangeGoogleCode(code, callbackUrl)
      : await exchangeDiscordCode(code, callbackUrl);

    const email = profile.email.trim().toLowerCase();
    const roles = adminEmailSet().has(email) ? ["OWNER"] : ["CASHIER"];

    const token = await signSessionToken({
      sub: `${provider}|${profile.id}`,
      email,
      name: profile.name,
      picture: profile.picture,
      provider,
      tenant_id: "public",
      organization_id: "default",
      location_id: "main",
      roles,
      permissions: [],
    });

    res.redirect(appendQuery(context.redirect, { auth_token: token }));
  } catch {
    res.redirect(appendQuery(fallbackRedirect, { auth_error: "oauth_callback_failed" }));
  }
});

router.get("/me", requireAuth, (req, res) => {
  const ctx = req.authContext;
  if (!ctx) {
    res.status(401).json({ code: "AUTH_REQUIRED", message: "Authentication required" });
    return;
  }

  res.json({
    sub: ctx.tokenSubject,
    email: ctx.email,
    name: ctx.name,
    picture: ctx.picture,
    provider: ctx.provider,
    role: ctx.roles[0] || "CASHIER",
  });
});

router.post("/logout", (_req, res) => {
  res.status(204).end();
});

export default router;
