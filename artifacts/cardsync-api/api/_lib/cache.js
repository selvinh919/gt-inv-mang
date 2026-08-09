const CACHE_MAX_ENTRIES = 1000;

const globalCache = globalThis.__cardsyncApiCache || new Map();
globalThis.__cardsyncApiCache = globalCache;

function stableSerialize(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pruneExpiredEntries(now) {
  for (const [key, entry] of globalCache.entries()) {
    if (entry.expiresAt <= now) {
      globalCache.delete(key);
    }
  }
}

function enforceMaxEntries() {
  if (globalCache.size <= CACHE_MAX_ENTRIES) return;

  const entries = Array.from(globalCache.entries()).sort(
    (a, b) => a[1].createdAt - b[1].createdAt,
  );

  const overflow = globalCache.size - CACHE_MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    globalCache.delete(entries[i][0]);
  }
}

export function buildCacheKey(namespace, params) {
  return `${namespace}:${stableSerialize(params)}`;
}

export function getCachedValue(cacheKey) {
  const now = Date.now();
  pruneExpiredEntries(now);

  const entry = globalCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    globalCache.delete(cacheKey);
    return null;
  }

  return {
    status: entry.status,
    body: entry.body,
  };
}

export function setCachedValue(cacheKey, status, body, ttlMs) {
  const now = Date.now();
  globalCache.set(cacheKey, {
    createdAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || 0),
    status,
    body,
  });

  enforceMaxEntries();
}

export function setResponseCacheHeaders(res, { sMaxAge = 60, staleWhileRevalidate = 300 } = {}) {
  const sMax = Math.max(0, Math.floor(Number(sMaxAge) || 0));
  const stale = Math.max(0, Math.floor(Number(staleWhileRevalidate) || 0));
  res.setHeader("Cache-Control", `public, s-maxage=${sMax}, stale-while-revalidate=${stale}`);
}
