const OPENAPI_BASE = "https://openapi.tcgtracking.com/v1";
const LEGACY_BASE = "https://tcgtracking.com/tcgapi/v1";
const MAX_LOCAL_CACHE_ENTRIES = 500;

const localCache = globalThis.__tcgGatewayLocalCache ?? new Map();
globalThis.__tcgGatewayLocalCache = localCache;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizePath(pathParam) {
  if (!pathParam) return ["meta"];
  if (Array.isArray(pathParam)) {
    return pathParam.flatMap((item) => String(item).split("/")).filter(Boolean);
  }
  return String(pathParam).split("/").filter(Boolean);
}

function buildTarget(base, pathParts, query) {
  const encoded = pathParts.map((p) => encodeURIComponent(String(p)));
  const url = new URL(`${base}/${encoded.join("/")}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (key === "path" || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function upstreamFetch(url, req) {
  const init = {
    method: req.method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };

  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    init.body = JSON.stringify(req.body ?? {});
  }

  return fetch(url, init);
}

function ttlSecondsForPath(parts) {
  const normalized = parts.map((part) => String(part).toLowerCase());

  if (normalized.includes("scan")) return 0;
  if (normalized.includes("search") || normalized.includes("meta")) return 300;
  if (normalized.includes("pricing") || normalized.includes("skus")) return 86400;
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

  const pathParts = normalizePath(req.query?.path);
  const openapiUrl = buildTarget(OPENAPI_BASE, pathParts, req.query);
  const legacyUrl = buildTarget(LEGACY_BASE, pathParts, req.query);
  const ttlSeconds = ttlSecondsForPath(pathParts);

  if (req.method === "GET" && ttlSeconds > 0) {
    const key = cacheKey(openapiUrl, req.method);
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
    let upstream = await upstreamFetch(openapiUrl, req);

    if (upstream.status === 404) {
      upstream = await upstreamFetch(legacyUrl, req);
    }

    const text = await upstream.text();
    res.status(upstream.status);

    const contentType = upstream.headers.get("content-type") || "application/json";
    res.setHeader("Content-Type", contentType);

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
        body: text,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      trimCache();
    }

    res.send(text);
  } catch (error) {
    res.status(502).json({
      error: "Failed to reach TCGtracking gateway",
      detail: String(error),
      tried: [openapiUrl.toString(), legacyUrl.toString()],
    });
  }
}
