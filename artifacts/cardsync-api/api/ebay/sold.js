import { buildCacheKey, getCachedValue, setCachedValue, setResponseCacheHeaders } from "../_lib/cache.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildKeywords({ name, number, setName }) {
  return [name, number, setName].filter(Boolean).join(" ").trim();
}

function buildKeywordCandidates({ name, number, setName }) {
  const candidates = [
    [name, number, setName].filter(Boolean).join(" ").trim(),
    [name, number].filter(Boolean).join(" ").trim(),
    [name, setName].filter(Boolean).join(" ").trim(),
    String(name || "").trim(),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function resolveAppId() {
  return process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID || process.env.EBAY_BROWSE_CLIENT_ID || null;
}

function resolveSoldCompsKey() {
  return process.env.SOLD_COMPS_API_KEY || process.env.SOLD_COMPS_KEY || process.env.SOLD_COMPS_TOKEN || null;
}

function isSandbox(appId) {
  const env = String(process.env.EBAY_ENV || "").toLowerCase();
  if (env === "sandbox") return true;
  return String(appId || "").startsWith("SBX-") || String(appId || "").includes("-SBX-");
}

async function fetchWithTimeout(url, timeoutMs = 8000, headers = { Accept: "application/json" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeItem(item) {
  const price = item?.sellingStatus?.[0]?.currentPrice?.[0];
  const shipping = item?.shippingInfo?.[0]?.shippingServiceCost?.[0];
  const condition = item?.condition?.[0]?.conditionDisplayName?.[0] ?? null;
  const soldAt = item?.listingInfo?.[0]?.endTime?.[0] ?? null;

  return {
    item_id: item?.itemId?.[0] ?? null,
    title: item?.title?.[0] ?? null,
    url: item?.viewItemURL?.[0] ?? null,
    image_url: item?.galleryURL?.[0] ?? null,
    condition,
    sold_price: toNumber(price?.__value__),
    currency: price?.["@currencyId"] ?? "USD",
    shipping: toNumber(shipping?.__value__),
    total_price: (toNumber(price?.__value__) ?? 0) + (toNumber(shipping?.__value__) ?? 0),
    listing_type: item?.listingInfo?.[0]?.listingType?.[0] ?? null,
    accepted_best_offer: item?.listingInfo?.[0]?.bestOfferEnabled?.[0] === "true",
    bid_count: toNumber(item?.sellingStatus?.[0]?.bidCount?.[0]),
    sold_at: soldAt,
    location: item?.location?.[0] ?? null,
  };
}

function normalizeSoldCompsItem(item) {
  const soldPrice = toNumber(item?.soldPrice);
  const shippingPrice = toNumber(item?.shippingPrice);
  const totalPrice = toNumber(item?.totalPrice);

  return {
    item_id: item?.itemId ?? null,
    title: item?.title ?? null,
    url: item?.url ?? null,
    image_url: item?.thumbnailUrl ?? null,
    condition: item?.condition ?? null,
    sold_price: soldPrice,
    currency: item?.soldCurrency ?? "USD",
    shipping: shippingPrice,
    total_price: totalPrice ?? (soldPrice ?? 0) + (shippingPrice ?? 0),
    listing_type: item?.buyingFormat ?? null,
    accepted_best_offer: Boolean(item?.bestOfferAccepted),
    bid_count: toNumber(item?.bidCount),
    sold_at: item?.endedAt ?? null,
    location: item?.itemLocation ?? null,
  };
}

async function soldCompsRequest(params) {
  const apiKey = resolveSoldCompsKey();
  if (!apiKey) {
    return {
      error: "Missing SOLD_COMPS_API_KEY env var on cardsync-api.",
      items: [],
    };
  }

  const qs = new URLSearchParams({
    keyword: String(params.keyword || "").trim(),
    page: String(params.page || 1),
    count: String(params.count || 50),
    daysToScrape: String(params.daysToScrape || 90),
    ebaySite: String(params.ebaySite || "ebay.com"),
    includeCompleteListing: "true",
    sortOrder: "endedRecently",
  });

  const response = await fetchWithTimeout(`https://api.sold-comps.com/v1/scrape?${qs.toString()}`, 12000, {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  });

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }
    throw new Error(`SoldComps request failed: ${response.status}${details ? ` ${details}` : ""}`);
  }

  const payload = await response.json();
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    hasNextPage: Boolean(payload?.hasNextPage),
  };
}

function summarize(sold) {
  if (sold.length === 0) {
    return {
      count: 0,
      avg_price: null,
      median_price: null,
      min_price: null,
      max_price: null,
      latest_sold_at: null,
    };
  }

  const values = sold
    .map((s) => s.total_price)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  const count = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(count / 2);
  const median = count % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];

  const sortedByDate = [...sold].sort((a, b) => {
    const ta = a.sold_at ? Date.parse(a.sold_at) : 0;
    const tb = b.sold_at ? Date.parse(b.sold_at) : 0;
    return tb - ta;
  });

  return {
    count,
    avg_price: Number((sum / count).toFixed(2)),
    median_price: Number(median.toFixed(2)),
    min_price: values[0],
    max_price: values[values.length - 1],
    latest_sold_at: sortedByDate[0]?.sold_at ?? null,
  };
}

function stripTags(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function extractUsd(value) {
  const m = String(value || "").match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!m) return null;
  return toNumber(m[1].replace(/,/g, ""));
}

async function scrapeSoldItems({ keywords, limit }) {
  const qs = new URLSearchParams({
    _nkw: keywords,
    LH_Sold: "1",
    LH_Complete: "1",
    _sop: "13",
  });

  const url = `https://www.ebay.com/sch/i.html?${qs.toString()}`;
  const response = await fetchWithTimeout(url, 12000, {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });

  if (!response.ok) {
    throw new Error(`eBay HTML fallback failed: ${response.status}`);
  }

  const html = await response.text();
  const blocks = html.match(/<li[^>]*class="[^"]*s-item[^"]*"[^>]*>[\s\S]*?<\/li>/g) || [];
  const sold = [];

  for (const block of blocks) {
    const titleRaw = block.match(/<div[^>]*class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    const title = decodeHtml(stripTags(titleRaw));
    if (!title || /shop on ebay|sponsored/i.test(title)) continue;

    const urlValue = block.match(/<a[^>]*class="[^"]*s-item__link[^"]*"[^>]*href="([^"]+)"/i)?.[1] || null;
    const imageUrl = block.match(/<img[^>]*class="[^"]*s-item__image-img[^"]*"[^>]*src="([^"]+)"/i)?.[1] || null;
    const priceRaw = block.match(/<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "";
    const shippingRaw = block.match(/<span[^>]*class="[^"]*s-item__shipping[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "";
    const conditionRaw = block.match(/<span[^>]*class="[^"]*SECONDARY_INFO[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "";

    const soldPrice = extractUsd(stripTags(priceRaw));
    const shipping = /free shipping/i.test(shippingRaw) ? 0 : extractUsd(stripTags(shippingRaw));

    sold.push({
      item_id: null,
      title,
      url: decodeHtml(urlValue || "") || null,
      image_url: decodeHtml(imageUrl || "") || null,
      condition: decodeHtml(stripTags(conditionRaw)) || null,
      sold_price: soldPrice,
      currency: "USD",
      shipping,
      total_price: (soldPrice ?? 0) + (shipping ?? 0),
      listing_type: null,
      accepted_best_offer: null,
      bid_count: null,
      sold_at: null,
      location: null,
    });

    if (sold.length >= limit) break;
  }

  return sold;
}

async function findingRequest(params) {
  const appId = resolveAppId();
  if (!appId) {
    const hasBrowseCreds =
      !!(process.env.EBAY_CLIENT_ID || process.env.EBAY_BROWSE_CLIENT_ID) &&
      !!(process.env.EBAY_CLIENT_SECRET || process.env.EBAY_BROWSE_CLIENT_SECRET);

    if (hasBrowseCreds) {
      return {
        error:
          "Browse API credentials detected, but sold/completed history requires Finding API App ID. Set EBAY_APP_ID to enable sold history.",
        items: [],
      };
    }

    return {
      error:
        "Missing EBAY_APP_ID env var on cardsync-api. Sold/completed history needs Finding API App ID.",
      items: [],
    };
  }

  const qs = new URLSearchParams({
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": appId,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "",
    "GLOBAL-ID": "EBAY-US",
    ...params,
  });

  const base = isSandbox(appId)
    ? "https://svcs.sandbox.ebay.com/services/search/FindingService/v1"
    : "https://svcs.ebay.com/services/search/FindingService/v1";
  const url = `${base}?${qs.toString()}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`eBay request failed: ${response.status}`);
  }

  const payload = await response.json();
  const body = payload?.findCompletedItemsResponse?.[0];
  const ack = body?.ack?.[0];
  if (ack !== "Success" && ack !== "Warning") {
    const apiError = body?.errorMessage?.[0]?.error?.[0]?.message?.[0] ?? "Unknown eBay API error";
    throw new Error(apiError);
  }

  const items = body?.searchResult?.[0]?.item ?? [];
  return { items };
}

async function findingRequestWithRetry(params, maxAttempts = 1) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await findingRequest(params);
    } catch (error) {
      lastError = error;
      const message = String(error || "");
      const isTransient = /request failed: 5\d\d|aborted|timeout|network|fetch failed/i.test(message);
      if (!isTransient || attempt === maxAttempts) {
        break;
      }

      await sleep(200 * attempt);
    }
  }

  return {
    error: `Finding API failed after retries: ${String(lastError)}`,
    items: [],
  };
}

export default async function handler(req, res) {
  setCors(res);
  setResponseCacheHeaders(res, { sMaxAge: 120, staleWhileRevalidate: 600 });

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const name = String(req.query?.name || "").trim();
  const number = String(req.query?.number || "").trim();
  const setName = String(req.query?.set_name || "").trim();
  const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const daysToScrape = Math.max(1, Math.min(365, Number(req.query?.days_to_scrape || 90)));
  const ebaySite = String(req.query?.ebay_site || "ebay.com");
  const cacheKey = buildCacheKey("ebay-sold", {
    name,
    number,
    set_name: setName,
    limit,
    days_to_scrape: daysToScrape,
    ebay_site: ebaySite,
  });
  const cached = getCachedValue(cacheKey);
  if (cached) {
    res.setHeader("x-cache", "HIT");
    res.status(cached.status).json(cached.body);
    return;
  }

  const keywords = buildKeywords({ name, number, setName });
  const keywordCandidates = buildKeywordCandidates({ name, number, setName });
  const activeCandidates = keywordCandidates.slice(0, 2);

  const uniqueById = (items) => {
    const seen = new Set();
    const merged = [];
    for (const item of items) {
      const key = item?.item_id || item?.url || item?.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  };

  try {
    let queryError = null;
    const warnings = [];
    let sold = [];

    for (const q of activeCandidates) {
      try {
        const soldComps = await soldCompsRequest({
          keyword: q,
          page: 1,
          count: Math.min(240, limit),
          daysToScrape,
          ebaySite,
        });

        if (soldComps.error) {
          warnings.push(`SoldComps: ${soldComps.error}`);
          continue;
        }

        sold = uniqueById([...sold, ...soldComps.items.map(normalizeSoldCompsItem)]);
        if (sold.length >= Math.min(8, limit)) {
          queryError = warnings.length > 0 ? warnings.join(" | ") : null;
          break;
        }
      } catch (error) {
        warnings.push(`SoldComps query failed for "${q}": ${String(error)}`);
      }
    }

    if (sold.length > 0) {
      sold = sold.sort((a, b) => {
        const ta = a.sold_at ? Date.parse(a.sold_at) : 0;
        const tb = b.sold_at ? Date.parse(b.sold_at) : 0;
        return tb - ta;
      });

      const body = {
        query: { name, number, set_name: setName, keywords },
        sold,
        summary: summarize(sold),
        total: sold.length,
        warning: queryError || undefined,
        source: "soldcomps",
      };
      setCachedValue(cacheKey, 200, body, 5 * 60 * 1000);
      res.setHeader("x-cache", "MISS");
      res.status(200).json(body);
      return;
    }

    queryError = warnings.length > 0 ? warnings.join(" | ") : null;

    for (const q of activeCandidates) {
      let result;
      try {
        result = await findingRequestWithRetry({
          keywords: q,
          "paginationInput.entriesPerPage": String(limit),
          "paginationInput.pageNumber": "1",
          "itemFilter(0).name": "SoldItemsOnly",
          "itemFilter(0).value": "true",
          sortOrder: "EndTimeSoonest",
        });
      } catch (error) {
        queryError = `Sold query failed for "${q}": ${String(error)}`;
        continue;
      }

      if (!result.error) {
        sold = uniqueById([...sold, ...result.items.map(normalizeItem)]);
        if (sold.length >= Math.min(8, limit)) break;
      } else {
        queryError = result.error;

        try {
          const fallbackSold = await scrapeSoldItems({ keywords: q, limit });
          if (fallbackSold.length > 0) {
            sold = uniqueById([...sold, ...fallbackSold]);
            queryError = `Finding API unavailable; using HTML sold fallback. ${result.error}`;
            if (sold.length >= Math.min(8, limit)) break;
          }
        } catch (fallbackError) {
          queryError = `${result.error}; fallback failed: ${String(fallbackError)}`;
        }
      }
    }

    if (sold.length === 0 && queryError) {
      const body = {
        query: { name, number, set_name: setName, keywords },
        sold: [],
        summary: summarize([]),
        total: 0,
        warning: queryError,
        source: "fallback-none",
      };
      setCachedValue(cacheKey, 200, body, 60 * 1000);
      res.setHeader("x-cache", "MISS");
      res.status(200).json(body);
      return;
    }

    sold = sold.sort((a, b) => {
      const ta = a.sold_at ? Date.parse(a.sold_at) : 0;
      const tb = b.sold_at ? Date.parse(b.sold_at) : 0;
      return tb - ta;
    });

    const body = {
      query: { name, number, set_name: setName, keywords },
      sold,
      summary: summarize(sold),
      total: sold.length,
      warning: queryError || undefined,
      source: "ebay-finding",
    };
    setCachedValue(cacheKey, 200, body, 3 * 60 * 1000);
    res.setHeader("x-cache", "MISS");
    res.status(200).json(body);
  } catch (error) {
    const body = {
      query: { name, number, set_name: setName, keywords },
      sold: [],
      summary: summarize([]),
      total: 0,
      warning: `Failed to fetch eBay sold history: ${String(error)}`,
      source: "error",
    };
    setCachedValue(cacheKey, 200, body, 30 * 1000);
    res.setHeader("x-cache", "MISS");
    res.status(200).json(body);
  }
}
