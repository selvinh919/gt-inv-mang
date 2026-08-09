import { buildCacheKey, getCachedValue, setCachedValue, setResponseCacheHeaders } from "../_lib/cache.js";
import { fetchTcgtrackingJson } from "../_lib/tcgtracking.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const GAME_TO_CATEGORY = {
  magic: 1,
  yugioh: 2,
  pokemon: 3,
  "one-piece-card-game": 58,
  "flesh-and-blood": 62,
  lorcana: 77,
};

const SET_ALIASES = {
  pokemon: {
    "wizards black star promos": ["wotc promo", "wizards black star"],
    "wotc promo": ["wizards black star promos"],
  },
};

async function fetchJsonWithFallback(path) {
  return fetchTcgtrackingJson(path);
}

function normalizeSku(sku) {
  return {
    sku_id: sku.sku_id,
    condition_name: sku.condition_name,
    variant_name: sku.variant_name,
    language_name: sku.language_name,
    market_price: sku.market_price ? Number(sku.market_price) : null,
    lowest_price: sku.lowest_price ? Number(sku.lowest_price) : null,
    highest_price: sku.highest_price ? Number(sku.highest_price) : null,
    price_count: sku.price_count ?? null,
    price_updated_at: sku.price_updated_at ?? null,
  };
}

function getProductMapEntry(payload, productId) {
  const products = payload?.products;
  if (!products || typeof products !== "object") return null;
  return products[String(productId)] ?? products[productId] ?? null;
}

function normalizeStr(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeCollectorNumber(value) {
  const raw = normalizeStr(value);
  if (!raw) return "";
  const [first] = raw.split("/");
  if (/^\d+$/.test(first)) {
    return String(Number(first));
  }
  return first;
}

function numberMatches(productNumber, targetNumber) {
  const normalizedProduct = normalizeStr(productNumber);
  const normalizedTarget = normalizeStr(targetNumber).split("/")[0];
  if (!normalizedTarget) return false;

  const compactProduct = normalizeCollectorNumber(productNumber);
  const compactTarget = normalizeCollectorNumber(targetNumber);

  return (
    normalizedProduct === normalizedTarget ||
    normalizedProduct.startsWith(`${normalizedTarget}/`) ||
    normalizedProduct.endsWith(`/${normalizedTarget}`) ||
    (compactProduct && compactTarget && compactProduct === compactTarget)
  );
}

function scoreProductMatch(product, name, number, setName) {
  const nName = normalizeStr(name);
  const nNumber = normalizeStr(number).split("/")[0];
  const pName = normalizeStr(product?.name);
  const pSetName = normalizeStr(product?.set_name);

  let score = 0;

  if (pName === nName) {
    score += 60;
  } else if (pName.startsWith(nName)) {
    score += 40;
  } else if (pName.includes(nName)) {
    score += 20;
  } else {
    const nTokens = nName.split(/\s+/).filter(Boolean);
    const overlap = nTokens.filter((token) => pName.includes(token)).length;
    if (overlap > 0) {
      score += overlap * 12;
    } else {
      score -= 80;
    }
  }

  if (nNumber) {
    if (numberMatches(product?.number, nNumber)) {
      score += 45;
    } else {
      score -= 35;
    }
  }

  const nSet = normalizeStr(setName);
  if (nSet && pSetName) {
    if (pSetName === nSet) {
      score += 20;
    } else if (pSetName.includes(nSet) || nSet.includes(pSetName)) {
      score += 10;
    }
  }

  return score;
}

function findMatchingProduct(products, name, number, setName) {
  const nNumber = normalizeStr(number).split("/")[0];
  const scored = products
    .map((product) => ({
      product,
      score: scoreProductMatch(product, name, number, setName),
      numberOk: nNumber ? numberMatches(product?.number, nNumber) : true,
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  // If a collector number is provided, avoid falling back to wrong-number products.
  if (nNumber) {
    const numbered = scored.find((entry) => entry.numberOk && entry.score >= 20);
    return numbered?.product ?? null;
  }

  const top = scored[0];
  return top.score >= 20 ? top.product : null;
}

function expandSetSearchTerms(game, setName) {
  const normalized = normalizeStr(setName);
  if (!normalized) return [];

  const terms = new Set([normalized]);
  const gameAliases = SET_ALIASES[game] || {};
  const aliases = gameAliases[normalized] || [];
  for (const alias of aliases) {
    terms.add(normalizeStr(alias));
  }

  return Array.from(terms).filter(Boolean);
}

async function getCandidateSets(categoryId, setName, name) {
  const nSetName = normalizeStr(setName);
  if (nSetName) {
    try {
      const allSetsPayload = await fetchJsonWithFallback(`${categoryId}/sets`);
      const allSets = Array.isArray(allSetsPayload?.sets) ? allSetsPayload.sets : [];
      const setTerms = expandSetSearchTerms(categoryId === 3 ? "pokemon" : "", setName);
      if (setTerms.length > 0) {
        const matched = allSets
          .filter((s) => {
            const setLower = normalizeStr(s?.name);
            return setTerms.some((term) => setLower.includes(term));
          })
          .slice(0, 8);
        if (matched.length > 0) {
          return matched;
        }
      }
    } catch {
      // Continue to name search fallback.
    }

    // If direct set name misses, try aliases through set-search endpoint.
    const setTerms = expandSetSearchTerms(categoryId === 3 ? "pokemon" : "", setName);
    for (const term of setTerms) {
      try {
        const searchBySet = await fetchJsonWithFallback(`${categoryId}/search?q=${encodeURIComponent(term)}`);
        const setMatches = Array.isArray(searchBySet?.sets) ? searchBySet.sets.slice(0, 10) : [];
        if (setMatches.length > 0) return setMatches;
      } catch {
        // Continue through terms.
      }
    }
  }

  const search = await fetchJsonWithFallback(`${categoryId}/search?q=${encodeURIComponent(name)}`);
  return Array.isArray(search?.sets) ? search.sets.slice(0, 10) : [];
}

export default async function handler(req, res) {
  setCors(res);
  setResponseCacheHeaders(res, { sMaxAge: 180, staleWhileRevalidate: 1800 });

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const name = String(req.query?.name || "").trim();
  const game = String(req.query?.game || "pokemon").trim();
  const setName = String(req.query?.set_name || "").trim();
  const number = String(req.query?.number || "").trim();

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const cacheKey = buildCacheKey("resolve-condition-prices", {
    name,
    game,
    set_name: setName,
    number,
  });
  const cached = getCachedValue(cacheKey);
  if (cached) {
    res.setHeader("x-cache", "HIT");
    res.status(cached.status).json(cached.body);
    return;
  }

  const categoryId = GAME_TO_CATEGORY[game] || GAME_TO_CATEGORY.pokemon;

  try {
    const sets = await getCandidateSets(categoryId, setName, name);

    const orderedSets = sets.sort((a, b) => {
      const aMatch = normalizeStr(a?.name).includes(normalizeStr(setName)) ? 1 : 0;
      const bMatch = normalizeStr(b?.name).includes(normalizeStr(setName)) ? 1 : 0;
      return bMatch - aMatch;
    });

    for (const setInfo of orderedSets) {
      const setId = setInfo?.id;
      if (!setId) continue;

      let cardsPayload;
      try {
        cardsPayload = await fetchJsonWithFallback(`${categoryId}/sets/${setId}/cards`);
      } catch {
        continue;
      }

      const products = Array.isArray(cardsPayload?.products) ? cardsPayload.products : [];
      const matched = findMatchingProduct(products, name, number, setName);
      if (!matched?.id) continue;

      let productData;
      try {
        productData = await fetchJsonWithFallback(`products/${matched.id}`);
      } catch {
        continue;
      }

      const resolvedProductId = productData?.product_id ?? matched.id;
      const skus = (productData?.skus || [])
        .filter((sku) => sku.language_name === "English")
        .map(normalizeSku);

      const [pricingPayload, skuPayload] = await Promise.all([
        fetchJsonWithFallback(`${categoryId}/sets/${setId}/pricing`).catch(() => null),
        fetchJsonWithFallback(`${categoryId}/sets/${setId}/skus`).catch(() => null),
      ]);

      const prices = pricingPayload?.prices || {};
      const pricing = prices[String(resolvedProductId)] ?? prices[resolvedProductId] ?? null;
      const sku_details = getProductMapEntry(skuPayload, resolvedProductId);

      const body = {
        product_id: resolvedProductId,
        product_name: productData?.product?.name ?? matched?.name ?? null,
        skus,
        pricing,
        sku_details,
      };
      setCachedValue(cacheKey, 200, body, 10 * 60 * 1000);
      res.setHeader("x-cache", "MISS");
      res.status(200).json(body);
      return;
    }

    const notFoundBody = { error: "No matching product found for condition pricing" };
    setCachedValue(cacheKey, 404, notFoundBody, 2 * 60 * 1000);
    res.setHeader("x-cache", "MISS");
    res.status(404).json(notFoundBody);
  } catch (error) {
    res.setHeader("x-cache", "MISS");
    res.status(502).json({ error: "Failed to resolve condition pricing", detail: String(error) });
  }
}
