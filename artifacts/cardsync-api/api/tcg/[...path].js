const OPENAPI_BASE = "https://openapi.tcgtracking.com/v1";
const LEGACY_BASE = "https://tcgtracking.com/tcgapi/v1";
const MAX_LOCAL_CACHE_ENTRIES = 500;

const localCache = globalThis.__tcgLocalCache ?? new Map();
globalThis.__tcgLocalCache = localCache;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildTargetUrl(base, pathParts, query) {
  const cleanParts = pathParts.filter(Boolean).map((part) => encodeURIComponent(String(part)));
  const url = new URL(`${base}/${cleanParts.join("/")}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (key === "path" || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function proxyRequest(url, req) {
  const init = {
    method: req.method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };

  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    init.body = JSON.stringify(req.body ?? {});
  }

  return fetch(url, init);
}

function ttlSecondsForPath(parts) {
  const normalized = parts.map((part) => String(part).toLowerCase());

  if (normalized.includes("scan")) return 0;
  if (normalized.includes("search") || normalized.includes("meta")) return 300;
  if (normalized.includes("pricing") || normalized.includes("skus")) return 86400;

  // Static catalog/product payloads: keep locally for 7 days.
  if (
    normalized.includes("categories") ||
    normalized.includes("sets") ||
    normalized.includes("cards") ||
    normalized.includes("sealed") ||
    normalized.includes("products")
  ) {
    return 604800;
  }

  return 3600;
}

function cacheKey(url, method) {
  return `${method}:${url.toString()}`;
}

function trimCache() {
  if (localCache.size <= MAX_LOCAL_CACHE_ENTRIES) return;

  const now = Date.now();
  for (const [key, value] of localCache.entries()) {
    if (value.expiresAt <= now) {
      localCache.delete(key);
    }
  }

  while (localCache.size > MAX_LOCAL_CACHE_ENTRIES) {
    const oldestKey = localCache.keys().next().value;
    if (!oldestKey) break;
    localCache.delete(oldestKey);
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!["GET", "POST"].includes(req.method)) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const parts = Array.isArray(req.query?.path)
    ? req.query.path
    : req.query?.path
      ? [req.query.path]
      : [];

  if (parts.length === 0) {
    res.status(400).json({ error: "Gateway path is required" });
    return;
  }

  const openapiUrl = buildTargetUrl(OPENAPI_BASE, parts, req.query);
  const legacyUrl = buildTargetUrl(LEGACY_BASE, parts, req.query);
  const ttlSeconds = ttlSecondsForPath(parts);
  const method = req.method;

  if (method === "GET" && ttlSeconds > 0) {
    const key = cacheKey(openapiUrl, method);
    const cached = localCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      res.status(cached.status);
      res.setHeader("Content-Type", cached.contentType);
      res.setHeader("Cache-Control", cached.cacheControl || `public, max-age=${ttlSeconds}, must-revalidate`);
      if (cached.etag) res.setHeader("ETag", cached.etag);
      if (cached.lastModified) res.setHeader("Last-Modified", cached.lastModified);
      res.send(cached.body);
      return;
    }
  }

  try {
    let upstream = await proxyRequest(openapiUrl, req);

    // Some paths may still be served only on legacy endpoint during transition.
    if (upstream.status === 404) {
      upstream = await proxyRequest(legacyUrl, req);
    }

    const contentType = upstream.headers.get("content-type") || "application/json";
    const raw = await upstream.text();

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);

    // Preserve useful caching metadata from upstream docs.
    const cacheControl = upstream.headers.get("cache-control");
    const etag = upstream.headers.get("etag");
    const lastModified = upstream.headers.get("last-modified");
    if (cacheControl) {
      res.setHeader("Cache-Control", cacheControl);
    } else if (ttlSeconds > 0) {
      res.setHeader("Cache-Control", `public, max-age=${ttlSeconds}, must-revalidate`);
    }
    if (etag) res.setHeader("ETag", etag);
    if (lastModified) res.setHeader("Last-Modified", lastModified);

    if (req.method === "GET" && ttlSeconds > 0 && upstream.ok) {
      localCache.set(cacheKey(openapiUrl, req.method), {
        status: upstream.status,
        contentType,
        cacheControl: cacheControl || `public, max-age=${ttlSeconds}, must-revalidate`,
        etag,
        lastModified,
        body: raw,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      trimCache();
    }

    res.send(raw);
  } catch (error) {
    res.status(502).json({
      error: "Failed to reach TCGtracking gateway",
      detail: String(error),
      tried: [openapiUrl.toString(), legacyUrl.toString()],
    });
  }
}
