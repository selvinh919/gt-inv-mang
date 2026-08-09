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

function getBrowseCredentials() {
  const clientId = process.env.EBAY_CLIENT_ID || process.env.EBAY_BROWSE_CLIENT_ID || null;
  const clientSecret = process.env.EBAY_CLIENT_SECRET || process.env.EBAY_BROWSE_CLIENT_SECRET || null;
  return { clientId, clientSecret };
}

function isSandbox(clientId) {
  const env = String(process.env.EBAY_ENV || "").toLowerCase();
  if (env === "sandbox") return true;
  return String(clientId || "").startsWith("SBX-") || String(clientId || "").includes("-SBX-");
}

async function getBrowseAccessToken() {
  const { clientId, clientSecret } = getBrowseCredentials();
  if (!clientId || !clientSecret) {
    return {
      error:
        "Missing eBay Browse credentials. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET on cardsync-api.",
      token: null,
    };
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const sandbox = isSandbox(clientId);
  const identityBase = sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

  const response = await fetch(`${identityBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`eBay OAuth failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  return { token: payload?.access_token ?? null, sandbox };
}

function normalizeItem(item) {
  const price = item?.price;
  const shipping = item?.shippingOptions?.[0]?.shippingCost;
  const buyingOptions = Array.isArray(item?.buyingOptions) ? item.buyingOptions : [];

  return {
    item_id: item?.itemId ?? null,
    title: item?.title ?? null,
    url: item?.itemWebUrl ?? null,
    image_url: item?.image?.imageUrl ?? null,
    condition: item?.condition ?? null,
    listing_type: buyingOptions.join(",") || null,
    buy_it_now: buyingOptions.includes("FIXED_PRICE"),
    price: toNumber(price?.value),
    currency: price?.currency ?? "USD",
    shipping: toNumber(shipping?.value),
    location: item?.itemLocation?.country ?? null,
    seller: item?.seller?.username ?? null,
    seller_feedback: toNumber(item?.seller?.feedbackPercentage),
    end_time: item?.itemEndDate ?? null,
  };
}

function normalizeFindingItem(item) {
  const price = item?.sellingStatus?.[0]?.currentPrice?.[0];
  const shipping = item?.shippingInfo?.[0]?.shippingServiceCost?.[0];
  const condition = item?.condition?.[0]?.conditionDisplayName?.[0] ?? null;

  return {
    item_id: item?.itemId?.[0] ?? null,
    title: item?.title?.[0] ?? null,
    url: item?.viewItemURL?.[0] ?? null,
    image_url: item?.galleryURL?.[0] ?? null,
    condition,
    listing_type: item?.listingInfo?.[0]?.listingType?.[0] ?? null,
    buy_it_now: item?.listingInfo?.[0]?.buyItNowAvailable?.[0] === "true",
    price: toNumber(price?.__value__),
    currency: price?.["@currencyId"] ?? "USD",
    shipping: toNumber(shipping?.__value__),
    location: item?.location?.[0] ?? null,
    seller: item?.sellerInfo?.[0]?.sellerUserName?.[0] ?? null,
    seller_feedback: toNumber(item?.sellerInfo?.[0]?.feedbackScore?.[0]),
    end_time: item?.listingInfo?.[0]?.endTime?.[0] ?? null,
  };
}

async function browseSearch(params) {
  const tokenResult = await getBrowseAccessToken();
  if (tokenResult.error) {
    return { error: tokenResult.error, items: [] };
  }

  const browseBase = tokenResult.sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const url = `${browseBase}/buy/browse/v1/item_summary/search?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenResult.token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`eBay Browse request failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  const items = payload?.itemSummaries ?? [];
  return { items };
}

async function findingSearch(params) {
  const appId = process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID || null;
  if (!appId) {
    return { error: "Missing EBAY_APP_ID for Finding API fallback", items: [] };
  }

  const base = isSandbox(appId)
    ? "https://svcs.sandbox.ebay.com/services/search/FindingService/v1"
    : "https://svcs.ebay.com/services/search/FindingService/v1";

  const qs = new URLSearchParams({
    "OPERATION-NAME": "findItemsAdvanced",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": appId,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "",
    "GLOBAL-ID": "EBAY-US",
    ...params,
  });

  const response = await fetch(`${base}?${qs.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`eBay Finding fallback failed: ${response.status}`);
  }

  const payload = await response.json();
  const body = payload?.findItemsAdvancedResponse?.[0];
  const ack = body?.ack?.[0];
  if (ack !== "Success" && ack !== "Warning") {
    const apiError = body?.errorMessage?.[0]?.error?.[0]?.message?.[0] ?? "Unknown Finding API error";
    throw new Error(apiError);
  }

  const items = body?.searchResult?.[0]?.item ?? [];
  return { items };
}

export default async function handler(req, res) {
  setCors(res);
  setResponseCacheHeaders(res, { sMaxAge: 60, staleWhileRevalidate: 300 });

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
  const limit = Math.max(1, Math.min(30, Number(req.query?.limit || 12)));

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const cacheKey = buildCacheKey("ebay-listings", {
    name,
    number,
    set_name: setName,
    limit,
  });
  const cached = getCachedValue(cacheKey);
  if (cached) {
    res.setHeader("x-cache", "HIT");
    res.status(cached.status).json(cached.body);
    return;
  }

  const keywords = buildKeywords({ name, number, setName });
  const keywordCandidates = buildKeywordCandidates({ name, number, setName });

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
    let browseError = null;
    let fallbackError = null;
    let listings = [];

    for (const q of keywordCandidates) {
      const browseResult = await browseSearch({
        q,
        limit: String(limit),
        sort: "best_match",
      });

      if (!browseResult.error) {
        listings = uniqueById([...listings, ...browseResult.items.map(normalizeItem)]);
        if (listings.length >= Math.min(6, limit)) break;
      } else {
        browseError = browseResult.error;
      }
    }

    if (listings.length === 0) {
      for (const q of keywordCandidates) {
        const fallback = await findingSearch({
          keywords: q,
          "paginationInput.entriesPerPage": String(limit),
          "paginationInput.pageNumber": "1",
          sortOrder: "BestMatch",
        });

        if (!fallback.error) {
          listings = uniqueById([...listings, ...fallback.items.map(normalizeFindingItem)]);
          if (listings.length >= Math.min(6, limit)) break;
        } else {
          fallbackError = fallback.error;
        }
      }
    }

    const warning = listings.length === 0
      ? (browseError || fallbackError || "No eBay listings found for card query")
      : (browseError ? `Browse API issue detected, fallback matching used: ${browseError}` : undefined);

    const body = {
      query: { name, number, set_name: setName, keywords },
      listings,
      total: listings.length,
      warning,
    };
    setCachedValue(cacheKey, 200, body, 2 * 60 * 1000);
    res.setHeader("x-cache", "MISS");
    res.status(200).json(body);
  } catch (error) {
    const body = {
      query: { name, number, set_name: setName, keywords },
      listings: [],
      total: 0,
      warning: `Failed to fetch eBay listings: ${String(error)}`,
    };
    setCachedValue(cacheKey, 200, body, 30 * 1000);
    res.setHeader("x-cache", "MISS");
    res.status(200).json(body);
  }
}
