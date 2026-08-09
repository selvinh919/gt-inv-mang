import { buildCacheKey, getCachedValue, setCachedValue, setResponseCacheHeaders } from "../_lib/cache.js";
import { fetchTcgtrackingJson } from "../_lib/tcgtracking.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const REQUEST_TIMEOUT_MS = 8000;
const GAME_TO_CATEGORY = {
  magic: 1,
  yugioh: 2,
  pokemon: 3,
  "one-piece-card-game": 58,
  "flesh-and-blood": 62,
  lorcana: 77,
};

const SEALED_INTENT_ALIASES = {
  etb: ["etb", "elite trainer box", "elite trainer"],
  booster_box: ["booster box", "booster display", "display box"],
  collection_box: ["collection box", "premium collection", "special collection"],
  booster_pack: ["booster pack", "pack"],
  pin_collection: ["pin collection", "deluxe pin", "pin"],
  tin: ["tin"],
  bundle: ["bundle", "blister"],
};

const POKEMON_DEEP_FALLBACK_SET_IDS = [
  1539, // League & Championship Cards
  1418, // WoTC Promo
  1423, // Nintendo Promos
  1938, // Alternate Art Promos
  2205, // Pikachu World Collection Promos
  2332, // Professor Program Promos
  22872, // SV Promo
  2545, // SWSH Promo
  1861, // SM Promos
  1451, // XY Promos
  1407, // Black and White Promos
];

const POKEMON_SEALED_FALLBACK_SET_IDS = [
  22872, // SV Promo
  2545, // SWSH Promo
  1861, // SM Promos
  1451, // XY Promos
  1407, // Black and White Promos
  1938, // Alternate Art Promos
  2332, // Professor Program Promos
  2205, // Pikachu World Collection Promos
  1418, // WoTC Promo
  1423, // Nintendo Promos
];

const DEEP_SEARCH_TERMS = [
  "league",
  "championship",
  "promo",
  "staff",
  "prerelease",
  "stamped",
  "black star",
  "wotc",
];

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseQuery(raw) {
  const tokens = raw.trim().split(/\s+/);
  const numberTokens = [];
  const nameTokens = [];

  for (const token of tokens) {
    if (/^\d+(\/\d+)?$/.test(token)) {
      numberTokens.push(token);
    } else {
      nameTokens.push(token);
    }
  }

  const name = nameTokens.join(" ").trim() || raw.trim();
  const numberFilter = numberTokens.length > 0 ? numberTokens.join("/") : null;

  return { name, numberFilter };
}

async function fetchJsonWithFallback(path) {
  return fetchTcgtrackingJson(path, REQUEST_TIMEOUT_MS);
}

function pickPrice(tcgPrices) {
  if (!tcgPrices || typeof tcgPrices !== "object") {
    return { printing: null, market: null, low: null };
  }

  const [subtype, value] = Object.entries(tcgPrices)[0] || [null, null];
  return {
    printing: subtype,
    market: value?.market != null ? Number(value.market) : null,
    low: value?.low != null ? Number(value.low) : null,
  };
}

function normalizeCard(card, gameName, priceEntry, setName, productType = "cards") {
  const { printing, market, low } = pickPrice(priceEntry?.tcg);

  return {
    id: String(card?.id || ""),
    name: card?.name || "Unknown",
    set_name: setName || null,
    game_name: gameName,
    rarity: card?.rarity || null,
    printing: printing || null,
    market_price: market,
    low_price: low,
    image_url: card?.image_url || null,
    number: card?.number || null,
    tcgplayer_id: Number(card?.id) || null,
    tcgplayer_url: card?.tcgplayer_url || null,
    total_listings: null,
    price_updated_at: null,
    product_type: productType,
    pricing: priceEntry || null,
  };
}

function normalizePokemonFallback(card) {
  const tcg = card?.tcgplayer?.prices || {};
  const [printing, pricing] = Object.entries(tcg)[0] || [null, null];
  const tcgplayerUrl = String(card?.tcgplayer?.url || "");
  const tcgplayerIdMatch = tcgplayerUrl.match(/\/product\/(\d+)/i);
  const tcgplayerId = tcgplayerIdMatch ? Number(tcgplayerIdMatch[1]) : null;
  return {
    id: String(card?.id || ""),
    name: card?.name || "Unknown",
    set_name: card?.set?.name || null,
    game_name: "pokemon",
    rarity: card?.rarity || null,
    printing,
    market_price: pricing?.market != null ? Number(pricing.market) : null,
    low_price: pricing?.low != null ? Number(pricing.low) : null,
    image_url: card?.images?.large || card?.images?.small || null,
    number: card?.number || null,
    tcgplayer_id: Number.isFinite(tcgplayerId) ? tcgplayerId : null,
    total_listings: null,
    price_updated_at: card?.tcgplayer?.updatedAt || null,
  };
}

function normalizeMtgFallback(card) {
  return {
    id: String(card?.id || ""),
    name: card?.name || "Unknown",
    set_name: card?.set_name || null,
    game_name: "magic",
    rarity: card?.rarity || null,
    printing: card?.foil ? "Foil" : "Normal",
    market_price: Number(card?.prices?.usd || card?.prices?.usd_foil || 0) || null,
    low_price: Number(card?.prices?.usd || card?.prices?.usd_foil || 0) || null,
    image_url: card?.image_uris?.large || card?.image_uris?.normal || null,
    number: card?.collector_number || null,
    tcgplayer_id: null,
    total_listings: null,
    price_updated_at: null,
  };
}

function normalizeYugiohFallback(card) {
  const prices = card?.card_prices?.[0] || {};
  return {
    id: String(card?.id || ""),
    name: card?.name || "Unknown",
    set_name: card?.archetype || null,
    game_name: "yugioh",
    rarity: null,
    printing: "Normal",
    market_price: Number(prices?.cardmarket_price || prices?.tcgplayer_price || 0) || null,
    low_price: Number(prices?.tcgplayer_price || prices?.cardmarket_price || 0) || null,
    image_url: card?.card_images?.[0]?.image_url || null,
    number: null,
    tcgplayer_id: null,
    total_listings: null,
    price_updated_at: null,
  };
}

function rankPokemonFallback(cards, queryName, numberNeedle = null) {
  const queryWords = uniqueWords(queryName);
  const primaryToken = queryWords
    .filter((word) => word.length >= 3)
    .sort((a, b) => b.length - a.length)[0] || null;

  const scored = cards
    .map((card) => {
      const cardName = normalizeText(card?.name || "");
      const setName = normalizeText(card?.set_name || "");
      const cardNumber = normalizeCollectorNumber(card?.number);

      const nameMatches = queryWords.filter((word) => cardName.includes(word));
      const setMatches = queryWords.filter((word) => setName.includes(word));
      const totalMatches = new Set([...nameMatches, ...setMatches]).size;

      if (nameMatches.length === 0 && totalMatches < 2) {
        return { card, score: 0 };
      }

      let score = 0;
      score += nameMatches.length * 50;
      score += setMatches.length * 20;

      if (primaryToken && cardName.includes(primaryToken)) {
        score += 90;
      }

      if (numberNeedle && cardNumber) {
        const [lhs] = cardNumber.split("/");
        if (lhs === numberNeedle) score += 60;
      }

      return { card, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.card);
}

async function fallbackSearch(queryName, game, numberFilter = null) {
  if (game === "pokemon") {
    const numberNeedle = numberFilter
      ? normalizeCollectorNumber(numberFilter.split("/")[0])
      : null;
    const escapedName = queryName.replace(/"/g, '\\"');
    const nameTokens = queryName
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const tokenPairs = [];
    if (nameTokens.length >= 2) {
      const unique = Array.from(new Set(nameTokens.map((token) => token.toLowerCase())));
      const candidates = unique
        .filter((token) => token.length >= 3)
        .slice(0, 4);

      for (let i = 0; i < candidates.length; i += 1) {
        for (let k = 0; k < candidates.length; k += 1) {
          if (i === k) continue;
          tokenPairs.push([candidates[i], candidates[k]]);
        }
      }
    }

    const queryCandidates = [
      numberNeedle
        ? `name:"${escapedName}" number:${numberNeedle}`
        : `name:"${escapedName}"`,
      nameTokens.length > 0
        ? `${nameTokens.map((token) => `name:*${token}*`).join(" ")}${numberNeedle ? ` number:${numberNeedle}` : ""}`
        : null,
      ...tokenPairs.map(
        ([nameToken, setToken]) =>
          `name:*${nameToken}* set.name:*${setToken}*${numberNeedle ? ` number:${numberNeedle}` : ""}`,
      ),
    ].filter(Boolean);

    const merged = [];
    const seen = new Set();

    for (const pokemonQuery of queryCandidates.slice(0, 8)) {
      let response;
      try {
        response = await fetchWithTimeout(
          `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(pokemonQuery)}&pageSize=30`,
        );
      } catch {
        continue;
      }

      if (!response.ok) continue;

      const payload = await response.json();
      const cards = (payload?.data || []).map(normalizePokemonFallback);
      for (const card of cards) {
        const key = String(card?.id || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(card);
      }

      if (merged.length >= 30) break;
    }

    if (merged.length > 0) {
      return rankPokemonFallback(merged, queryName, numberNeedle).slice(0, 30);
    }

    return [];
  }

  if (game === "magic") {
    const response = await fetchWithTimeout(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(queryName)}&order=released`,
    );
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload?.data || []).map(normalizeMtgFallback);
  }

  if (game === "yugioh") {
    const response = await fetchWithTimeout(
      `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(queryName)}`,
    );
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload?.data || []).map(normalizeYugiohFallback);
  }

  return [];
}

function byNameMatch(cards, queryName) {
  const queryNormalized = normalizeText(queryName);
  const queryWords = uniqueWords(queryName);

  if (!queryWords.length) return cards;

  const scored = cards
    .map((card) => {
      const cardName = normalizeText(card?.name || "");
      if (!cardName) return { card, score: 0 };

      let score = 0;
      if (cardName.includes(queryNormalized)) {
        score += 120;
      }

      const tokenMatches = queryWords.filter((word) => cardName.includes(word));
      if (tokenMatches.length === 0) return { card, score: 0 };

      const minimumTokenMatches = queryWords.length >= 3 ? 2 : 1;
      if (!cardName.includes(queryNormalized) && tokenMatches.length < minimumTokenMatches) {
        return { card, score: 0 };
      }

      score += tokenMatches.length * 30;
      score += tokenMatches.reduce((acc, word) => acc + Math.min(word.length, 8), 0);
      return { card, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.card);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCollectorNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const cleaned = raw.replace(/[^0-9/]/g, "");
  if (!cleaned) return "";

  return cleaned
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      const asNumber = Number(segment);
      return Number.isFinite(asNumber) ? String(asNumber) : segment;
    })
    .join("/");
}

function uniqueWords(value) {
  return Array.from(new Set(normalizeText(value).split(/\s+/).filter(Boolean)));
}

function parseSealedIntent(queryName) {
  const normalized = normalizeText(queryName);
  const words = uniqueWords(queryName);
  const matchedIntentKeys = Object.entries(SEALED_INTENT_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => normalized.includes(alias)))
    .map(([key]) => key);

  const stopWords = new Set([
    "pokemon",
    "sv",
    "scarlet",
    "violet",
    "magic",
    "mtg",
    "yugioh",
    "yu",
    "gi",
    "oh",
    "lorcana",
    "one",
    "piece",
    "flesh",
    "blood",
    "etb",
    "elite",
    "trainer",
    "box",
    "booster",
    "display",
    "collection",
    "premium",
    "special",
    "pack",
    "packs",
    "tin",
    "bundle",
    "blister",
  ]);

  const setWords = words.filter((word) => !stopWords.has(word));
  const setQuery = setWords.join(" ").trim();

  return {
    matchedIntentKeys,
    setQuery,
    isGenericIntentOnly: setWords.length === 0 && matchedIntentKeys.length > 0,
  };
}

function scoreSealedProductMatch(product, queryName, sealedIntent) {
  const productName = normalizeText(product?.name || "");
  const productSetName = normalizeText(product?.set_name || product?.__setName || "");
  const queryNormalized = normalizeText(queryName);
  const queryWords = uniqueWords(queryName);

  let score = 0;

  if (productName.includes(queryNormalized)) {
    score += 80;
  }

  const overlapCount = queryWords.filter((word) => productName.includes(word)).length;
  score += overlapCount * 10;

  const setOverlapCount = queryWords.filter((word) => productSetName.includes(word)).length;
  score += setOverlapCount * 14;

  for (const intentKey of sealedIntent.matchedIntentKeys) {
    const aliases = SEALED_INTENT_ALIASES[intentKey] || [];
    if (aliases.some((alias) => productName.includes(alias))) {
      score += 30;
    }
  }

  if (sealedIntent.setQuery) {
    const setWords = uniqueWords(sealedIntent.setQuery);
    const setOverlapName = setWords.filter((word) => productName.includes(word)).length;
    const setOverlapSet = setWords.filter((word) => productSetName.includes(word)).length;
    score += setOverlapName * 8;
    score += setOverlapSet * 24;
  }

  return score;
}

function rankProducts(products, queryName, productType, sealedIntent) {
  if (productType === "cards") {
    return byNameMatch(products, queryName);
  }

  if (productType === "all") {
    const cardProducts = products.filter((product) => String(product?.__productType || "cards") === "cards");
    const sealedProducts = products.filter((product) => String(product?.__productType || "cards") === "sealed");
    const rankedCards = byNameMatch(cardProducts, queryName);
    const rankedSealed = sealedProducts
      .map((product) => ({
        product,
        score: scoreSealedProductMatch(product, queryName, sealedIntent),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.product);

    if (sealedIntent.matchedIntentKeys.length > 0) {
      return [...rankedSealed, ...rankedCards];
    }

    return [...rankedCards, ...rankedSealed];
  }

  const scored = products
    .map((product) => ({
      product,
      score: scoreSealedProductMatch(product, queryName, sealedIntent),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.product);
}

async function getCandidateSets(categoryId, queryName, productType, sealedIntent) {
  const primarySetQuery = productType !== "cards" && sealedIntent.setQuery
    ? sealedIntent.setQuery
    : queryName;

  let searchPayload = await fetchJsonWithFallback(`${categoryId}/search?q=${encodeURIComponent(primarySetQuery)}`);
  let sets = Array.isArray(searchPayload?.sets)
    ? searchPayload.sets.filter((s) => Number(s?.product_count || 0) > 0)
    : [];

  if (sets.length === 0 && productType !== "cards" && primarySetQuery !== queryName) {
    searchPayload = await fetchJsonWithFallback(`${categoryId}/search?q=${encodeURIComponent(queryName)}`);
    sets = Array.isArray(searchPayload?.sets)
      ? searchPayload.sets.filter((s) => Number(s?.product_count || 0) > 0)
      : [];
  }

  if (sets.length === 0 && productType !== "cards" && sealedIntent.isGenericIntentOnly) {
    const allSetsPayload = await fetchJsonWithFallback(`${categoryId}/sets`).catch(() => null);
    const allSets = Array.isArray(allSetsPayload?.sets) ? allSetsPayload.sets : [];
    sets = allSets
      .filter((setInfo) => Number(setInfo?.product_count || 0) > 0)
      .slice(0, 24);
  }

  // Product queries like "deluxe pin" often match product names but not set names.
  // Fall back to promo-heavy + recent sets for Pokemon sealed/all searches.
  if (sets.length === 0 && productType !== "cards" && Number(categoryId) === 3) {
    const allSetsPayload = await fetchJsonWithFallback(`${categoryId}/sets`).catch(() => null);
    const allSets = Array.isArray(allSetsPayload?.sets) ? allSetsPayload.sets : [];
    if (allSets.length > 0) {
      const priorityMap = new Map(allSets.map((setInfo) => [Number(setInfo?.id || 0), setInfo]));
      const prioritized = POKEMON_SEALED_FALLBACK_SET_IDS
        .map((id) => priorityMap.get(id))
        .filter((setInfo) => setInfo && Number(setInfo?.product_count || 0) > 0);

      const recent = allSets
        .filter((setInfo) => Number(setInfo?.product_count || 0) > 0)
        .slice(0, 60);

      const deduped = [];
      const seenIds = new Set();
      for (const setInfo of [...recent, ...prioritized]) {
        const id = Number(setInfo?.id || 0);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        deduped.push(setInfo);
      }

      sets = deduped;
    }
  }

  // Deep fallback for Pokemon card queries that include promo/league intent.
  if (sets.length === 0 && productType === "cards" && Number(categoryId) === 3) {
    const normalizedQuery = normalizeText(queryName);
    const shouldDeepScan = DEEP_SEARCH_TERMS.some((term) => normalizedQuery.includes(term));

    if (shouldDeepScan) {
      const allSetsPayload = await fetchJsonWithFallback(`${categoryId}/sets`).catch(() => null);
      const allSets = Array.isArray(allSetsPayload?.sets) ? allSetsPayload.sets : [];
      const priorityMap = new Map(allSets.map((setInfo) => [Number(setInfo?.id || 0), setInfo]));
      sets = POKEMON_DEEP_FALLBACK_SET_IDS
        .map((id) => priorityMap.get(id))
        .filter((setInfo) => setInfo && Number(setInfo?.product_count || 0) > 0);
    }
  }

  return sets.slice(0, productType === "cards" ? 10 : 24);
}

async function searchViaTcgtracking(queryName, game, productType = "cards") {
  const categoryId = GAME_TO_CATEGORY[game] || GAME_TO_CATEGORY.pokemon;
  const sealedIntent = productType === "cards"
    ? { matchedIntentKeys: [], setQuery: "", isGenericIntentOnly: false }
    : parseSealedIntent(queryName);
  const sets = await getCandidateSets(categoryId, queryName, productType, sealedIntent);

  if (sets.length === 0) return [];

  const setResults = await Promise.all(
    sets.map(async (setInfo) => {
      const setId = setInfo?.id;
      if (!setId) return { products: [], prices: {}, setName: null };

      try {
        const cardsPromise = productType !== "sealed"
          ? fetchJsonWithFallback(`${categoryId}/sets/${setId}/cards`).catch(() => ({ products: [] }))
          : Promise.resolve({ products: [] });
        const sealedPromise = productType !== "cards"
          ? fetchJsonWithFallback(`${categoryId}/sets/${setId}/sealed`).catch(() => ({ products: [] }))
          : Promise.resolve({ products: [] });
        const [cardsPayload, sealedPayload] = await Promise.all([cardsPromise, sealedPromise]);

        const pricingPayload = await fetchJsonWithFallback(`${categoryId}/sets/${setId}/pricing`).catch(
          () => ({ prices: {} }),
        );

        const cardProducts = Array.isArray(cardsPayload?.products) ? cardsPayload.products : [];
        const sealedProducts = Array.isArray(sealedPayload?.products) ? sealedPayload.products : [];
        const derivedSetName = cardsPayload?.set_name || sealedPayload?.set_name || setInfo?.name || null;
        const taggedCards = cardProducts.map((product) => ({ ...product, __productType: "cards", __setName: derivedSetName }));
        const taggedSealed = sealedProducts.map((product) => ({ ...product, __productType: "sealed", __setName: derivedSetName }));

        return {
          products: [...taggedCards, ...taggedSealed],
          prices: pricingPayload?.prices || {},
          setName: derivedSetName,
        };
      } catch {
        return { products: [], prices: {}, setName: null };
      }
    }),
  );

  const merged = [];
  const seen = new Set();

  for (const setResult of setResults) {
    const filteredByName = rankProducts(setResult.products, queryName, productType, sealedIntent);
    for (const product of filteredByName) {
      const id = String(product?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);

      merged.push(
        normalizeCard(
          product,
          game,
          setResult.prices[id],
          setResult.setName,
          product?.__productType || "cards",
        ),
      );
    }
  }

  return merged;
}

export default async function handler(req, res) {
  setCors(res);
  setResponseCacheHeaders(res, { sMaxAge: 120, staleWhileRevalidate: 900 });

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawQ = String(req.query?.q ?? "").trim();
  if (rawQ.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const game = req.query?.game ? String(req.query.game) : "pokemon";
  const productTypeRaw = req.query?.product_type ? String(req.query.product_type) : "cards";
  const productType = ["cards", "sealed", "all"].includes(productTypeRaw) ? productTypeRaw : "cards";
  const requestedPerPage = req.query?.per_page ? Number(req.query.per_page) : undefined;

  const cacheKey = buildCacheKey("cards-search", {
    q: rawQ,
    game,
    product_type: productType,
    per_page: Number.isFinite(requestedPerPage) ? requestedPerPage : null,
  });
  const cached = getCachedValue(cacheKey);
  if (cached) {
    res.setHeader("x-cache", "HIT");
    res.status(cached.status).json(cached.body);
    return;
  }

  const { name, numberFilter } = parseQuery(rawQ);
  const effectiveName = productType === "sealed" ? rawQ : name;
  const effectiveNumberFilter = productType === "sealed" ? null : numberFilter;

  try {
    let cards = [];

    // Keep Pokemon fallback-first for card searches, then try TCGtracking as backup.
    if (game === "pokemon") {
      if (productType === "cards") {
        cards = await fallbackSearch(effectiveName, game, effectiveNumberFilter);
        if (cards.length === 0) {
          cards = await searchViaTcgtracking(effectiveName, game, productType);
        }
      } else {
        cards = await searchViaTcgtracking(effectiveName, game, productType);
      }
    } else {
      cards = await searchViaTcgtracking(effectiveName, game, productType);
      if (cards.length === 0 && productType === "cards") {
        cards = await fallbackSearch(effectiveName, game);
      }
    }

    if (effectiveNumberFilter && productType !== "sealed") {
      const needle = normalizeCollectorNumber(effectiveNumberFilter.split("/")[0]);
      cards = cards.filter((card) => {
        const itemType = String(card?.product_type || "cards").toLowerCase();
        if (itemType !== "cards") {
          // Sealed products don't have collector numbers; keep them in mixed/all results.
          return true;
        }

        const number = normalizeCollectorNumber(card?.number);
        if (!number || typeof number !== "string") return false;

        if (number === needle) return true;
        const [lhs] = number.split("/");
        return lhs === needle;
      });
    }

    if (requestedPerPage && Number.isFinite(requestedPerPage)) {
      cards = cards.slice(0, Math.max(1, Math.min(100, requestedPerPage)));
    }

    setCachedValue(cacheKey, 200, cards, 5 * 60 * 1000);
    res.setHeader("x-cache", "MISS");
    res.status(200).json(cards);
  } catch (error) {
    res.setHeader("x-cache", "MISS");
    res.status(502).json({ error: "TCGtracking search failure", detail: String(error) });
  }
}
