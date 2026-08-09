import { AppLayout } from "@/components/layout/app-layout";
import {
  useGetConditionPrices,
  useScanCard,
} from "@workspace/api-client-react";
import type { TcgCard } from "@workspace/api-client-react";
import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search as SearchIcon, Plus, Loader2, ShoppingCart, TrendingDown, TrendingUp, Package, Camera, X, ExternalLink, Clock3, BarChart3 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCollectionsStore, type UserCollection } from "@/lib/collections-store";

type SearchProductType = "cards" | "sealed" | "all";

type SearchCard = TcgCard & {
  product_type?: string | null;
  tcgplayer_url?: string | null;
  pricing?: unknown;
};

type SmartSuggestionItem = {
  term: string;
  gameLabel: string;
  source: "history" | "trending" | "query";
};

const SEARCH_HISTORY_KEY = "cardsync.search-history.v1";
const SEARCH_RESULTS_CACHE_KEY = "cardsync.search-results.v2";
const SEARCH_RESULTS_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_DB_INT = 2147483647;
const BARCODE_SCAN_MIN_LENGTH = 6;
const BARCODE_SCAN_GAP_MS = 80;
const BARCODE_SCAN_IDLE_COMMIT_MS = 120;

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return true;
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function normalizeScannedBarcode(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function useBarcodeScanner(enabled: boolean, onScan: (barcode: string) => void): void {
  const onScanRef = useRef(onScan);
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);
  const commitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const commit = () => {
      const barcode = normalizeScannedBarcode(bufferRef.current);
      bufferRef.current = "";
      if (commitTimerRef.current != null) {
        window.clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      if (barcode.length >= BARCODE_SCAN_MIN_LENGTH) {
        onScanRef.current(barcode);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // If the user is typing in an input, let native input behavior handle scanner text.
      if (isTextEntryElement(document.activeElement)) {
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        commit();
        return;
      }

      if (event.key.length !== 1) {
        return;
      }

      const now = performance.now();
      if (now - lastKeyAtRef.current > BARCODE_SCAN_GAP_MS) {
        bufferRef.current = "";
      }

      bufferRef.current += event.key;
      lastKeyAtRef.current = now;

      if (commitTimerRef.current != null) {
        window.clearTimeout(commitTimerRef.current);
      }

      commitTimerRef.current = window.setTimeout(() => {
        commit();
      }, BARCODE_SCAN_IDLE_COMMIT_MS);
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (commitTimerRef.current != null) {
        window.clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      bufferRef.current = "";
    };
  }, [enabled]);
}

function makeSearchResultsCacheKey(q: string, game: string, productType: SearchProductType): string {
  return `${game}::${productType}::${q.trim().toLowerCase()}`;
}

function readSearchResultsCache(cacheKey: string): SearchCard[] | null {
  try {
    const raw = window.localStorage.getItem(SEARCH_RESULTS_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Record<string, { expiresAt: number; data: SearchCard[] }>;
    const entry = parsed?.[cacheKey];
    if (!entry) return null;
    if (Date.now() > Number(entry.expiresAt || 0)) return null;
    return Array.isArray(entry.data) ? entry.data : null;
  } catch {
    return null;
  }
}

function writeSearchResultsCache(cacheKey: string, data: SearchCard[]): void {
  try {
    const now = Date.now();
    const raw = window.localStorage.getItem(SEARCH_RESULTS_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, { expiresAt: number; data: SearchCard[] }>) : {};

    // Prune expired entries.
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || now > Number(value.expiresAt || 0)) {
        delete parsed[key];
      }
    }

    parsed[cacheKey] = {
      expiresAt: now + SEARCH_RESULTS_CACHE_TTL_MS,
      data,
    };

    const keys = Object.keys(parsed);
    if (keys.length > 80) {
      keys
        .sort((a, b) => Number(parsed[a]?.expiresAt || 0) - Number(parsed[b]?.expiresAt || 0))
        .slice(0, keys.length - 80)
        .forEach((key) => delete parsed[key]);
    }

    window.localStorage.setItem(SEARCH_RESULTS_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore localStorage write issues.
  }
}

function apiBaseUrl(): string {
  const normalizeAbsolute = (raw: string): string => {
    const value = String(raw || "").trim().replace(/\/+$/, "");
    if (!value) return "";

    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return value;
    } catch {
      return "";
    }
  };

  const cardsyncBase = normalizeAbsolute(import.meta.env.VITE_CARDSYNC_API_BASE_URL?.trim() ?? "");
  const configuredBase = normalizeAbsolute(import.meta.env.VITE_API_BASE_URL?.trim() ?? "");
  return cardsyncBase || configuredBase || "https://cardsync-api.vercel.app";
}

function getGameLabel(value: string): string {
  return GAMES.find((game) => game.value === value)?.label ?? value;
}

function hashToPositiveInt(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.max(1, (hash >>> 0) % MAX_DB_INT);
}

function clampCardIdToDbInt(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 1;
  if (value <= MAX_DB_INT) return value;
  return value % MAX_DB_INT || 1;
}

function resolveNumericCardId(card: SearchCard, printingLabel: string): number {
  const tcgPlayerId = Number((card as { tcgplayer_id?: unknown }).tcgplayer_id);
  if (Number.isInteger(tcgPlayerId) && tcgPlayerId > 0) {
    return clampCardIdToDbInt(tcgPlayerId);
  }

  const directId = Number((card as { id?: unknown }).id);
  if (Number.isInteger(directId) && directId > 0) {
    return clampCardIdToDbInt(directId);
  }

  // Stable fallback for providers that use non-numeric IDs.
  const fingerprint = [card.name, card.set_name || "", card.number || "", printingLabel].join("|");
  return hashToPositiveInt(fingerprint);
}

function getSmartSearchSuggestions(query: string, game: string, history: string[]): SmartSuggestionItem[] {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const defaultsByGame: Record<string, string[]> = {
    pokemon: ["pikachu", "charizard", "dark kadabra", "base set charizard"],
    magic: ["lightning bolt", "black lotus", "sol ring"],
    yugioh: ["dark magician", "blue-eyes white dragon"],
    lorcana: ["elsa", "mickey"],
    "flesh-and-blood": ["fyendal's spring tunic"],
    "one-piece-card-game": ["luffy", "zoro"],
  };

  const historyMatches = history
    .filter((item) => !trimmed || item.toLowerCase().includes(lower))
    .map((term) => ({ term, gameLabel: getGameLabel(game), source: "history" as const }));

  const trending = (defaultsByGame[game] || []).map((term) => ({
    term,
    gameLabel: getGameLabel(game),
    source: "trending" as const,
  }));

  const queryDriven: SmartSuggestionItem[] = [];
  if (trimmed.includes(" ")) {
    queryDriven.push({
      term: `\"${trimmed}\"`,
      gameLabel: getGameLabel(game),
      source: "query",
    });
  }

  const combined = [...queryDriven, ...historyMatches, ...trending];
  const deduped: SmartSuggestionItem[] = [];
  const seen = new Set<string>();
  for (const item of combined) {
    const key = item.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.slice(0, 8);
}

async function fetchSearchCards(q: string, game: string, productType: SearchProductType): Promise<SearchCard[]> {
  const cacheKey = makeSearchResultsCacheKey(q, game, productType);
  const cached = readSearchResultsCache(cacheKey);
  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({ q, game, product_type: productType });
  const url = `${apiBaseUrl()}/api/cards/search?${params.toString()}`;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  const response = await fetch(url, { signal: controller.signal }).finally(() => {
    window.clearTimeout(timeout);
  });
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }

  // Static SPA hosting can return index.html with 200 for unknown routes.
  if (!contentType.includes("application/json")) {
    throw new Error("Search endpoint returned non-JSON response");
  }

  const cards = (await response.json()) as SearchCard[];
  if (cards.length > 0 || game !== "pokemon" || productType !== "cards") {
    writeSearchResultsCache(cacheKey, cards);
    return cards;
  }

  const escaped = q.replace(/"/g, '\\"');
  const tokens = q.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  const fallbackQueries = [
    `name:\"${escaped}\"`,
    tokens.length ? tokens.map((token) => `name:*${token}*`).join(" ") : "",
  ].filter(Boolean);

  let payload: {
    data?: Array<{
      id?: string;
      name?: string;
      number?: string;
      rarity?: string;
      set?: { name?: string };
      images?: { large?: string; small?: string };
      tcgplayer?: {
        url?: string;
        updatedAt?: string;
        prices?: Record<string, { market?: number; low?: number }>;
      };
    }>;
  } = { data: [] };

  for (const fallbackQuery of fallbackQueries) {
    const fallbackResponse = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(fallbackQuery)}&pageSize=20`,
    );
    if (!fallbackResponse.ok) continue;
    payload = (await fallbackResponse.json()) as typeof payload;
    if ((payload.data || []).length > 0) break;
  }

  const fallbackCards = (payload.data || []).map((card, index) => {
    const prices = card.tcgplayer?.prices || {};
    const [printing, price] = Object.entries(prices)[0] || ["Normal", {}];
    const tcgplayerUrl = String(card.tcgplayer?.url || "");
    const idMatch = tcgplayerUrl.match(/\/product\/(\d+)/i);

    return {
      id: Number(idMatch?.[1] || index + 1),
      name: card.name || "Unknown",
      number: card.number || null,
      set_name: card.set?.name || null,
      game_name: "pokemon",
      rarity: card.rarity || null,
      printing,
      market_price: price?.market ?? null,
      low_price: price?.low ?? null,
      image_url: card.images?.large || card.images?.small || null,
      total_listings: null,
      price_updated_at: card.tcgplayer?.updatedAt || null,
      tcgplayer_id: idMatch ? Number(idMatch[1]) : null,
      product_type: "cards",
    } as SearchCard;
  });

  writeSearchResultsCache(cacheKey, fallbackCards);
  return fallbackCards;
}

async function fetchResolvedConditionPrices(card: SearchCard): Promise<{ product_id?: number | null; pricing?: unknown; sku_details?: Record<string, unknown> | null; skus: Array<{ condition_name: string; variant_name: string; market_price?: number | null; lowest_price?: number | null; highest_price?: number | null; price_count?: number | null; price_updated_at?: string | null }> }> {
  const params = new URLSearchParams({
    name: card.name,
    game: card.game_name ?? "pokemon",
  });

  if (card.number) params.set("number", card.number);
  if (card.set_name) params.set("set_name", card.set_name);

  const response = await fetch(`${apiBaseUrl()}/api/cards/resolve-condition-prices?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Resolve condition prices failed: ${response.status}`);
  }

  return (await response.json()) as {
    product_id?: number | null;
    pricing?: unknown;
    sku_details?: Record<string, unknown> | null;
    skus: Array<{
      condition_name: string;
      variant_name: string;
      market_price?: number | null;
      lowest_price?: number | null;
      highest_price?: number | null;
      price_count?: number | null;
      price_updated_at?: string | null;
    }>;
  };
}

type EbayListing = {
  item_id: string | null;
  title: string | null;
  url: string | null;
  image_url: string | null;
  condition: string | null;
  listing_type: string | null;
  buy_it_now: boolean;
  price: number | null;
  currency: string;
  shipping: number | null;
  location: string | null;
  seller: string | null;
  end_time: string | null;
};

type EbaySold = {
  item_id: string | null;
  title: string | null;
  url: string | null;
  image_url: string | null;
  condition: string | null;
  sold_price: number | null;
  currency: string;
  shipping: number | null;
  total_price: number | null;
  bid_count: number | null;
  sold_at: string | null;
};

type EbaySoldSummary = {
  count: number;
  avg_price: number | null;
  median_price: number | null;
  min_price: number | null;
  max_price: number | null;
  latest_sold_at: string | null;
};

type ProductIntake = {
  productName: string;
  imageUrl?: string | null;
  sku?: string | null;
  barcode?: string | null;
  vendorBrand?: string | null;
  productCategory?: string | null;
  quantity: number;
  cost: number;
  salePrice: number;
  salePriceSource: "custom" | "market_rule";
  salePriceRule: string | null;
};

async function fetchEbayListings(card: TcgCard): Promise<{ listings: EbayListing[]; warning?: string }> {
  const params = new URLSearchParams({
    name: card.name,
    limit: "12",
  });

  if (card.number) params.set("number", card.number);
  if (card.set_name) params.set("set_name", card.set_name);

  const response = await fetch(`${apiBaseUrl()}/api/ebay/listings?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`eBay listings failed: ${response.status}`);
  }

  return (await response.json()) as { listings: EbayListing[]; warning?: string };
}

async function fetchEbaySold(card: TcgCard): Promise<{ sold: EbaySold[]; summary: EbaySoldSummary; warning?: string }> {
  const params = new URLSearchParams({
    name: card.name,
    limit: "24",
  });

  if (card.number) params.set("number", card.number);
  if (card.set_name) params.set("set_name", card.set_name);

  const response = await fetch(`${apiBaseUrl()}/api/ebay/sold?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`eBay sold failed: ${response.status}`);
  }

  return (await response.json()) as { sold: EbaySold[]; summary: EbaySoldSummary; warning?: string };
}

async function resizeImageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX_B64_LEN = 70000;
      const maxW = 400;
      const maxH = 560;
      let scale = 1;
      if (img.width > maxW || img.height > maxH) {
        scale = Math.min(maxW / img.width, maxH / img.height);
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const tryQuality = (q: number) => {
        const dataUrl = canvas.toDataURL("image/jpeg", q);
        const b64 = dataUrl.split(",")[1];
        if (b64.length <= MAX_B64_LEN || q <= 0.2) {
          resolve(b64);
        } else {
          tryQuality(Math.round((q - 0.1) * 10) / 10);
        }
      };
      tryQuality(0.85);
    };
    img.onerror = reject;
    img.src = url;
  });
}

const GAMES = [
  { label: "Pokemon", value: "pokemon" },
  { label: "Magic: The Gathering", value: "magic" },
  { label: "Yu-Gi-Oh!", value: "yugioh" },
  { label: "Lorcana", value: "lorcana" },
  { label: "Flesh & Blood", value: "flesh-and-blood" },
  { label: "One Piece", value: "one-piece-card-game" },
];

const CONDITION_ORDER = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
];

const CONDITION_SHORT: Record<string, string> = {
  "Near Mint": "NM",
  "Lightly Played": "LP",
  "Moderately Played": "MP",
  "Heavily Played": "HP",
  "Damaged": "DMG",
};

const fmt = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
};

function getPrintingLabel(printing: string | null | undefined): string {
  if (!printing) return "Normal";
  const p = printing.toLowerCase();
  if (p.includes("holo") || p.includes("foil")) return "Holofoil";
  if (p.includes("foil")) return "Foil";
  return printing;
}

function isPrintingFoil(printing: string | null | undefined): boolean {
  if (!printing) return false;
  const p = printing.toLowerCase();
  return p.includes("holo") || p.includes("foil");
}

function getTcgplayerUrl(
  card: TcgCard,
  selectedCondition?: string,
  selectedVariant?: string,
  resolvedProductId?: number | null,
): string | null {
  const name = String(card.name || "").trim();
  if (!name) return null;

  const conditionFilter = selectedCondition?.trim();
  const printingFilter = selectedVariant?.trim();
  const directUrl = String((card as SearchCard).tcgplayer_url || "").trim();
  const directMatch = directUrl.match(/\/product\/(\d+)/i);
  const directProductId = directMatch ? Number(directMatch[1]) : null;
  const productId = directProductId ?? card.tcgplayer_id ?? resolvedProductId ?? null;

  // Prefer product URL and preserve user-selected filters for condition/printing view.
  if (productId) {
    const params = new URLSearchParams({
      Language: "English",
      page: "1",
    });
    if (conditionFilter) params.set("Condition", conditionFilter);
    if (printingFilter) params.set("Printing", printingFilter);
    return `https://www.tcgplayer.com/product/${productId}?${params.toString()}`;
  }

  // If upstream already provided a direct TCGplayer URL but no product id could be parsed,
  // use it as-is instead of constructing a potentially misleading search URL.
  if (directUrl) {
    try {
      const direct = new URL(directUrl);
      direct.searchParams.set("Language", "English");
      direct.searchParams.set("page", "1");
      if (conditionFilter) direct.searchParams.set("Condition", conditionFilter);
      if (printingFilter) direct.searchParams.set("Printing", printingFilter);
      return direct.toString();
    } catch {
      return directUrl;
    }
  }

  // Last-resort fallback when no product URL is known.
  // Keep this broad and game-scoped; avoid condition/printing filters that can mis-route.
  const gameToTcgPath: Record<string, string> = {
    pokemon: "pokemon",
    magic: "magic",
    yugioh: "yugioh",
    lorcana: "lorcana",
  };
  const gamePath = gameToTcgPath[String(card.game_name || "").toLowerCase()] || "all";

  const searchTokens = [
    name,
    card.number || "",
    card.set_name || "",
  ].filter(Boolean);
  const params = new URLSearchParams({
    q: searchTokens.join(" "),
    view: "grid",
  });

  return `https://www.tcgplayer.com/search/${gamePath}/product?${params.toString()}`;
}

function getEbaySoldSearchUrl(card: TcgCard): string {
  const tokens = [card.name, card.number, card.set_name].filter(Boolean).join(" ");
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(tokens)}&LH_Sold=1&LH_Complete=1`;
}

function buildDefaultSku(card: SearchCard, printing: string): string {
  const game = String(card.game_name || "tcg").replace(/[^a-z0-9]+/gi, "-").toUpperCase();
  const number = String(card.number || "GEN").replace(/[^a-z0-9]+/gi, "").toUpperCase();
  const print = String(printing || "NORMAL").replace(/[^a-z0-9]+/gi, "-").toUpperCase();
  const id = Number(card.tcgplayer_id || card.id || 0) || Date.now();
  return `${game}-${number}-${print}-${id}`;
}

function CardDetailModal({
  card,
  open,
  onClose,
  onAdd,
  onCreateCollection,
  collections,
  defaultCollectionId,
  startInAddMode,
  isPending,
}: {
  card: SearchCard | null;
  open: boolean;
  onClose: () => void;
  onAdd: (
    card: SearchCard,
    condition: string,
    selectedPricing?: { market: number | null; low: number | null },
    selectedPrinting?: string,
    selectedCollectionId?: number,
    intake?: ProductIntake,
  ) => void;
  onCreateCollection: (name: string) => UserCollection | null;
  collections: UserCollection[];
  defaultCollectionId: number;
  startInAddMode: boolean;
  isPending: boolean;
}) {
  const [selectedCondition, setSelectedCondition] = useState("Near Mint");
  const [selectedVariant, setSelectedVariant] = useState<string>("");
  const [ebayView, setEbayView] = useState<"listings" | "sold">("listings");
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(String(defaultCollectionId));
  const [productName, setProductName] = useState<string>("");
  const [productImageUrl, setProductImageUrl] = useState<string>("");
  const [productSku, setProductSku] = useState<string>("");
  const [productBarcode, setProductBarcode] = useState<string>("");
  const [productVendorBrand, setProductVendorBrand] = useState<string>("TCGtracking");
  const [productCategory, setProductCategory] = useState<string>("");
  const [quantityInput, setQuantityInput] = useState<string>("1");
  const [costInput, setCostInput] = useState<string>("");
  const [salePriceMode, setSalePriceMode] = useState<"custom" | "market_rule">("market_rule");
  const [customSalePriceInput, setCustomSalePriceInput] = useState<string>("");
  const [saleRuleBasis, setSaleRuleBasis] = useState<"market" | "low" | "high">("market");
  const [saleRulePercentInput, setSaleRulePercentInput] = useState<string>("0");
  const [newCollectionName, setNewCollectionName] = useState<string>("");
  const [isAddMode, setIsAddMode] = useState<boolean>(startInAddMode);
  const selectedCollectionIdRef = useRef<string>(String(defaultCollectionId));
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  useBarcodeScanner(open, (barcode) => {
    setIsAddMode(true);
    setProductBarcode(barcode);
    window.setTimeout(() => {
      barcodeInputRef.current?.focus();
      barcodeInputRef.current?.select();
    }, 0);
  });

  const tcgplayerId = card?.tcgplayer_id ?? null;
  const { data: conditionData, isLoading: conditionLoading } = useGetConditionPrices(
    tcgplayerId ?? 0,
    {
      query: {
        enabled: tcgplayerId != null && open,
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        refetchOnWindowFocus: false,
        queryKey: ["conditionPrices", tcgplayerId],
      },
    }
  );

  const { data: resolvedConditionData, isLoading: resolvingCondition } = useQuery({
    queryKey: ["conditionPricesResolve", card?.id, card?.name, card?.number, card?.set_name],
    queryFn: () => fetchResolvedConditionPrices(card as SearchCard),
    enabled: open && tcgplayerId == null && !!card,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => {
    setSelectedCondition("Near Mint");
    setSelectedVariant("");
    setEbayView("listings");
    setSelectedCollectionId(String(defaultCollectionId));
    selectedCollectionIdRef.current = String(defaultCollectionId);
    const nextName = String(card?.name || "").trim();
    const nextImage = String(card?.image_url || "").trim();
    const nextPrinting = getPrintingLabel(card?.printing);
    setProductName(nextName);
    setProductImageUrl(nextImage);
    setProductSku(card ? buildDefaultSku(card, nextPrinting) : "");
    setProductBarcode(String(card?.tcgplayer_id || card?.id || ""));
    setProductVendorBrand("TCGtracking");
    setProductCategory(String(card?.game_name || "TCG").toUpperCase());
    setQuantityInput("1");
    setCostInput("");
    setSalePriceMode("market_rule");
    setCustomSalePriceInput("");
    setSaleRuleBasis("market");
    setSaleRulePercentInput("0");
    setNewCollectionName("");
    setIsAddMode(startInAddMode);
  }, [card?.id, defaultCollectionId, startInAddMode]);

  useEffect(() => {
    if (!open || !isAddMode) return;
    const timer = window.setTimeout(() => {
      barcodeInputRef.current?.focus();
      barcodeInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, isAddMode]);

  const { data: ebayListingsData, isLoading: ebayListingsLoading } = useQuery({
    queryKey: ["ebayListings", card?.id, card?.name, card?.number, card?.set_name],
    queryFn: () => fetchEbayListings(card as TcgCard),
    enabled: open && !!card,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const { data: ebaySoldData, isLoading: ebaySoldLoading } = useQuery({
    queryKey: ["ebaySold", card?.id, card?.name, card?.number, card?.set_name],
    queryFn: () => fetchEbaySold(card as TcgCard),
    enabled: open && !!card,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const printingLabel = getPrintingLabel(card?.printing);
  const isFoil = isPrintingFoil(card?.printing);

  const effectiveConditionData = conditionData ?? resolvedConditionData;
  const skus = effectiveConditionData?.skus ?? [];
  const variantNames = Array.from(
    new Set(skus.map((s) => s.variant_name).filter(Boolean))
  );
  const activeVariant = selectedVariant || variantNames[0] || "";
  const skusForVariant = activeVariant
    ? skus.filter((s) => s.variant_name === activeVariant)
    : skus;
  const conditionNames = CONDITION_ORDER.filter((c) =>
    skusForVariant.some((s) => s.condition_name === c)
  );
  const selectedSku =
    skusForVariant.find((s) => s.condition_name === selectedCondition) ??
    skusForVariant[0] ??
    null;
  const hasConditionData = skus.length > 0;
  const resolvedProductId = resolvedConditionData?.product_id ?? null;
  const tcgplayerProductId = card?.tcgplayer_id ?? resolvedProductId;
  const shouldDeferSearchLink = !tcgplayerProductId && (conditionLoading || resolvingCondition);
  const tcgplayerUrl = card
    ? shouldDeferSearchLink
      ? null
      : getTcgplayerUrl(
        card,
        selectedCondition,
        activeVariant || selectedSku?.variant_name,
        tcgplayerProductId,
      )
    : null;

  useEffect(() => {
    if (!hasConditionData || !card || variantNames.length === 0) return;
    if (selectedVariant && variantNames.includes(selectedVariant)) return;

    const desiredPrinting = getPrintingLabel(card.printing).toLowerCase();
    const preferredVariant = variantNames.find((variantName) => {
      const normalizedVariant = String(variantName).toLowerCase();
      if (!normalizedVariant) return false;
      if (normalizedVariant.includes(desiredPrinting) || desiredPrinting.includes(normalizedVariant)) return true;
      if (desiredPrinting.includes("holo") && normalizedVariant.includes("holo")) return true;
      if (desiredPrinting.includes("foil") && normalizedVariant.includes("foil")) return true;
      if (desiredPrinting.includes("normal") && normalizedVariant.includes("normal")) return true;
      return false;
    });

    const nextVariant = preferredVariant || variantNames[0] || "";
    if (nextVariant) {
      setSelectedVariant(nextVariant);
    }
  }, [hasConditionData, card, variantNames, selectedVariant]);

  useEffect(() => {
    if (!hasConditionData) return;
    if (conditionNames.length === 0) return;
    if (!conditionNames.includes(selectedCondition)) {
      setSelectedCondition(conditionNames[0]);
    }
  }, [hasConditionData, conditionNames, selectedCondition]);

  const displayPrinting = selectedSku?.variant_name || printingLabel;

  if (!card) return null;

  // Prices: use selected condition's raw tcgtracking data; fall back to TCGApi only if unavailable
  const displayMarket = hasConditionData ? selectedSku?.market_price ?? null : card.market_price;
  const displayLow    = hasConditionData ? selectedSku?.lowest_price ?? null : card.low_price;
  const displayHigh   = hasConditionData ? selectedSku?.highest_price ?? null : null;
  const displayCount  = hasConditionData ? selectedSku?.price_count ?? null : card.total_listings;
  const displayUpdated = hasConditionData && selectedSku?.price_updated_at
    ? new Date(selectedSku.price_updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : card.price_updated_at
      ? new Date(card.price_updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;

  const ebayLoading = ebayView === "listings" ? ebayListingsLoading : ebaySoldLoading;
  const ebayWarning = ebayListingsData?.warning || ebaySoldData?.warning;
  const soldSummary = ebaySoldData?.summary;
  const ebaySoldSearchUrl = getEbaySoldSearchUrl(card);
  const parsedQuantity = Math.floor(Number(quantityInput));
  const parsedCost = Number(costInput);
  const parsedCustomSale = Number(customSalePriceInput);
  const parsedRulePercent = Number(saleRulePercentInput);
  const saleRuleBasePrice =
    saleRuleBasis === "market"
      ? displayMarket
      : saleRuleBasis === "low"
        ? displayLow
        : displayHigh;
  const salePriceFromRule =
    saleRuleBasePrice == null || Number.isNaN(parsedRulePercent)
      ? null
      : Number((saleRuleBasePrice * (1 + parsedRulePercent / 100)).toFixed(2));
  const finalSalePrice =
    salePriceMode === "custom"
      ? (Number.isFinite(parsedCustomSale) ? parsedCustomSale : null)
      : salePriceFromRule;
  const canSubmitIntake =
    productName.trim().length > 0 &&
    Number.isFinite(parsedQuantity) &&
    parsedQuantity > 0 &&
    Number.isFinite(parsedCost) &&
    parsedCost >= 0 &&
    finalSalePrice != null &&
    Number.isFinite(finalSalePrice) &&
    finalSalePrice >= 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-lg max-h-[90vh] overflow-y-auto bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold leading-snug pr-6">
            {card.name}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-4">
          {/* Card image */}
          <div className="w-36 aspect-[2.5/3.5] self-start shrink-0 rounded-lg overflow-hidden bg-black">
            {card.image_url ? (
              <img
                src={card.image_url}
                alt={card.name}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                No Image
              </div>
            )}
          </div>

          {/* Meta + condition selector + prices */}
          <div className="flex-1 space-y-3 min-w-0">
            {/* Badges */}
            <div className="space-y-1 text-sm">
              <div className="text-muted-foreground">{card.set_name}</div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {card.number && (
                  <Badge variant="secondary" className="font-mono text-xs">
                    #{card.number}
                  </Badge>
                )}
                {card.rarity && (
                  <Badge variant="outline" className="text-xs">
                    {card.rarity}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={isFoil ? "text-xs border-amber-500/50 text-amber-400" : "text-xs"}
                >
                  {printingLabel}
                </Badge>
              </div>
            </div>

            {/* Print/edition and condition selectors */}
            {hasConditionData && variantNames.length > 1 && (
              <div className="flex items-center gap-2 flex-wrap">
                {variantNames.map((variant) => (
                  <button
                    key={variant}
                    onClick={() => setSelectedVariant(variant)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      activeVariant === variant
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {variant}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              {conditionLoading || resolvingCondition ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : hasConditionData ? (
                conditionNames.map((cond) => (
                  <button
                    key={cond}
                    onClick={() => setSelectedCondition(cond)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      selectedCondition === cond
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {CONDITION_SHORT[cond] ?? cond}
                  </button>
                ))
              ) : null}
            </div>

            {/* Prices — always 3 columns when high is available, 2 otherwise */}
            <div className={`grid gap-2 ${displayHigh != null ? "grid-cols-3" : "grid-cols-2"}`}>
              <div className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <TrendingDown className="h-3 w-3" /> Market
                </div>
                <div className="font-mono font-bold text-primary">
                  {fmt(displayMarket)}
                </div>
              </div>
              <div className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <ShoppingCart className="h-3 w-3" /> Low
                </div>
                <div className="font-mono font-bold">
                  {fmt(displayLow)}
                </div>
              </div>
              {displayHigh != null && (
                <div className="rounded-lg bg-muted/60 px-3 py-2">
                  <div className="text-xs text-muted-foreground mb-0.5">High</div>
                  <div className="font-mono font-bold">
                    {fmt(displayHigh)}
                  </div>
                </div>
              )}
            </div>

            {/* Listing count + updated */}
            {(displayCount != null || displayUpdated) && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Package className="h-3 w-3" />
                {displayCount != null && <span>{displayCount.toLocaleString()} listings</span>}
                {displayUpdated && <span>· Updated {displayUpdated}</span>}
                {hasConditionData && selectedSku && (
                  <span>· {selectedSku.variant_name}</span>
                )}
              </div>
            )}

          </div>
        </div>

        {isAddMode ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Inventory</div>
                <Select
                  value={selectedCollectionId}
                  onValueChange={(value) => {
                    selectedCollectionIdRef.current = value;
                    setSelectedCollectionId(value);
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Choose inventory" />
                  </SelectTrigger>
                  <SelectContent>
                    {collections.map((collection) => (
                      <SelectItem key={collection.id} value={String(collection.id)}>
                        {collection.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Product Name</div>
                <Input
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Image URL</div>
                <Input
                  value={productImageUrl}
                  onChange={(e) => setProductImageUrl(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">SKU</div>
                <Input
                  value={productSku}
                  onChange={(e) => setProductSku(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Barcode</div>
                <Input
                  ref={barcodeInputRef}
                  value={productBarcode}
                  onChange={(e) => setProductBarcode(e.target.value)}
                  placeholder="Scan or type barcode"
                  autoComplete="off"
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Vendor / Brand</div>
                <Input
                  value={productVendorBrand}
                  onChange={(e) => setProductVendorBrand(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Product Category</div>
                <Input
                  value={productCategory}
                  onChange={(e) => setProductCategory(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Quantity</div>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={quantityInput}
                  onChange={(e) => setQuantityInput(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Cost</div>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>

            <div className="rounded-md border border-border p-2 space-y-2">
              <div className="text-xs text-muted-foreground">Sale Price Source</div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={salePriceMode === "custom" ? "default" : "outline"}
                  onClick={() => setSalePriceMode("custom")}
                  className="h-8"
                >
                  Custom Price
                </Button>
                <Button
                  type="button"
                  variant={salePriceMode === "market_rule" ? "default" : "outline"}
                  onClick={() => setSalePriceMode("market_rule")}
                  className="h-8"
                >
                  Market Rule
                </Button>
              </div>

              {salePriceMode === "custom" ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="Custom sale price"
                  value={customSalePriceInput}
                  onChange={(e) => setCustomSalePriceInput(e.target.value)}
                  className="h-9"
                />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Select value={saleRuleBasis} onValueChange={(value) => setSaleRuleBasis(value as "market" | "low" | "high") }>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Rule basis" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="market">Market</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="high" disabled={displayHigh == null}>High</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    placeholder="Adjust % (e.g. 10 or -5)"
                    value={saleRulePercentInput}
                    onChange={(e) => setSaleRulePercentInput(e.target.value)}
                    className="h-9"
                  />
                </div>
              )}

              <div className="text-[11px] text-muted-foreground">
                Final sale price: <span className="font-mono text-foreground">{fmt(finalSalePrice)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Input
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="Create new inventory"
                className="h-9"
              />
              <Button
                type="button"
                variant="outline"
                className="h-9"
                disabled={!newCollectionName.trim()}
                onClick={() => {
                  const created = onCreateCollection(newCollectionName);
                  if (!created) return;
                  selectedCollectionIdRef.current = String(created.id);
                  setSelectedCollectionId(String(created.id));
                  setNewCollectionName("");
                }}
              >
                Create
              </Button>
            </div>

            <Button
              className="w-full mt-2"
              onClick={() => {
                if (!canSubmitIntake || finalSalePrice == null) return;

                  const normalizedImageUrl = productImageUrl.trim();
                  const normalizedSku = productSku.trim();
                  const normalizedBarcode = productBarcode.trim();
                  const normalizedVendorBrand = productVendorBrand.trim();
                  const normalizedProductCategory = productCategory.trim();

                onAdd(card, selectedCondition, {
                  market: finalSalePrice,
                  low: displayLow ?? null,
                }, displayPrinting, Number(selectedCollectionIdRef.current), {
                  productName: productName.trim(),
                    imageUrl: normalizedImageUrl || null,
                    sku: normalizedSku || null,
                    barcode: normalizedBarcode || null,
                    vendorBrand: normalizedVendorBrand || null,
                    productCategory: normalizedProductCategory || null,
                  quantity: parsedQuantity,
                  cost: parsedCost,
                  salePrice: finalSalePrice,
                  salePriceSource: salePriceMode,
                  salePriceRule:
                    salePriceMode === "market_rule"
                      ? `${saleRuleBasis}:${saleRulePercentInput}%`
                      : null,
                });
              }}
              disabled={isPending || !canSubmitIntake}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add — {hasConditionData ? (CONDITION_SHORT[selectedCondition] ?? selectedCondition) + " · " : ""}{displayPrinting} · {fmt(finalSalePrice)}
            </Button>
          </>
        ) : (
          <Button className="w-full mt-2" onClick={() => setIsAddMode(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add to Inventory
          </Button>
        )}

        {tcgplayerUrl && (
          <Button asChild variant="outline" className="w-full">
            <a href={tcgplayerUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" />
              View on TCGplayer
            </a>
          </Button>
        )}

        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-sm">eBay Market</div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={ebayView === "listings" ? "default" : "outline"}
                onClick={() => setEbayView("listings")}
                className="h-8"
              >
                Listings
              </Button>
              <Button
                size="sm"
                variant={ebayView === "sold" ? "default" : "outline"}
                onClick={() => setEbayView("sold")}
                className="h-8"
              >
                Sold
              </Button>
            </div>
          </div>

          {ebayWarning && (
            <div className="text-xs text-amber-500 flex items-center justify-between gap-3">
              <span>{ebayWarning}</span>
              {ebayView === "sold" && (
                <a
                  href={ebaySoldSearchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 text-amber-500/90 hover:text-amber-400"
                >
                  Open sold on eBay
                </a>
              )}
            </div>
          )}

          {ebayLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : ebayView === "listings" ? (
            ebayListingsData?.listings?.length ? (
              <div className="space-y-2 max-h-56 overflow-auto pr-1">
                {ebayListingsData.listings.map((item, idx) => (
                  <a
                    key={item.item_id ?? `${item.url ?? "listing"}-${idx}`}
                    href={item.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md border border-border p-2 hover:border-primary/50 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <div className="h-12 w-12 shrink-0 rounded border border-border/50 bg-muted/40 overflow-hidden">
                        {item.image_url ? (
                          <img src={item.image_url} alt={item.title ?? "eBay listing"} className="h-full w-full object-cover" />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center text-[10px] text-muted-foreground">No Img</div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium line-clamp-2">{item.title}</div>
                        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground gap-2">
                          <span className="truncate">{item.condition ?? "Unknown"}</span>
                          <span className="font-mono text-foreground whitespace-nowrap">{fmt(item.price)}{item.shipping ? ` + ${fmt(item.shipping)} ship` : ""}</span>
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No active eBay listings found for this card query.</div>
            )
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-muted/60 p-2">
                  <div className="text-muted-foreground flex items-center gap-1"><BarChart3 className="h-3 w-3" /> Median</div>
                  <div className="font-mono font-semibold">{fmt(soldSummary?.median_price)}</div>
                </div>
                <div className="rounded-md bg-muted/60 p-2">
                  <div className="text-muted-foreground">Average</div>
                  <div className="font-mono font-semibold">{fmt(soldSummary?.avg_price)}</div>
                </div>
                <div className="rounded-md bg-muted/60 p-2">
                  <div className="text-muted-foreground">Range</div>
                  <div className="font-mono font-semibold">{fmt(soldSummary?.min_price)} - {fmt(soldSummary?.max_price)}</div>
                </div>
                <div className="rounded-md bg-muted/60 p-2">
                  <div className="text-muted-foreground flex items-center gap-1"><Clock3 className="h-3 w-3" /> Last Sold</div>
                  <div className="font-medium">{soldSummary?.latest_sold_at ? new Date(soldSummary.latest_sold_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "-"}</div>
                </div>
              </div>

              {ebaySoldData?.sold?.length ? (
                <div className="space-y-2 max-h-56 overflow-auto pr-1">
                  {ebaySoldData.sold.map((item, idx) => (
                    <a
                      key={item.item_id ?? `${item.url ?? "sold"}-${idx}`}
                      href={item.url ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-md border border-border p-2 hover:border-primary/50 transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <div className="h-12 w-12 shrink-0 rounded border border-border/50 bg-muted/40 overflow-hidden">
                          {item.image_url ? (
                            <img src={item.image_url} alt={item.title ?? "eBay sold item"} className="h-full w-full object-cover" />
                          ) : (
                            <div className="h-full w-full flex items-center justify-center text-[10px] text-muted-foreground">No Img</div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium line-clamp-2">{item.title}</div>
                          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground gap-2">
                            <span className="truncate">{item.condition ?? "Unknown"} · {item.sold_at ? new Date(item.sold_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Date n/a"}</span>
                            <span className="font-mono text-foreground whitespace-nowrap">{fmt(item.total_price ?? item.sold_price)}</span>
                          </div>
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">No sold history found for this card query.</div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Search() {
  const [entryMode, setEntryMode] = useState<"tcg" | "custom">("tcg");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [game, setGame] = useState<string>("pokemon");
  const [productType, setProductType] = useState<SearchProductType>("cards");
  const [isSuggestionOpen, setIsSuggestionOpen] = useState(false);
  const [selectedCard, setSelectedCard] = useState<SearchCard | null>(null);
  const [startInAddMode, setStartInAddMode] = useState(false);
  const [scanLabel, setScanLabel] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [customName, setCustomName] = useState("");
  const [customImageUrl, setCustomImageUrl] = useState("");
  const [customSku, setCustomSku] = useState("");
  const [customVendor, setCustomVendor] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [customBarcode, setCustomBarcode] = useState("");
  const [customQuantity, setCustomQuantity] = useState("1");
  const [customSellPrice, setCustomSellPrice] = useState("0.00");
  const [customSalePriceMode, setCustomSalePriceMode] = useState<"custom" | "market_rule">("custom");
  const [customMarketReference, setCustomMarketReference] = useState("0.00");
  const [customRulePercent, setCustomRulePercent] = useState("0");
  const [customCost, setCustomCost] = useState("0.00");
  const [customNotes, setCustomNotes] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { collections, activeCollection, createCollection, addItem } = useCollectionsStore();
  const scanMutation = useScanCard();

  useBarcodeScanner(entryMode === "custom", (barcode) => {
    setCustomBarcode(barcode);
  });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setSearchHistory(parsed.map((item) => String(item)).filter(Boolean).slice(0, 12));
      }
    } catch {
      // Ignore history parsing issues.
    }
  }, []);

  const rememberSearch = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;

    setSearchHistory((previous) => {
      const next = [trimmed, ...previous.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())].slice(0, 12);
      try {
        window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
      } catch {
        // Ignore localStorage write issues.
      }
      return next;
    });
  };

  const handleScanFile = async (file: File) => {
    setScanLabel(null);
    try {
      const image = await resizeImageToBase64(file);
      scanMutation.mutate(
        { data: { game, image } },
        {
          onSuccess: (data) => {
            const top = data.results[0];
            if (!top) {
              toast({ title: "No match found", description: "Couldn't identify the card. Try a clearer photo.", variant: "destructive" });
              return;
            }
            const label = top.number ? `${top.name} · #${top.number}` : top.name;
            setScanLabel(`${label} (${top.score}% match)`);
            const searchName = top.number
              ? `${top.name} ${top.number.split("/")[0]}`
              : top.name;
            setQuery(searchName);
            setDebouncedQuery(searchName);
            rememberSearch(searchName);
          },
          onError: () => {
            toast({ title: "Scan failed", description: "Could not reach the scan API.", variant: "destructive" });
          },
        }
      );
    } catch {
      toast({ title: "Image error", description: "Could not process the image.", variant: "destructive" });
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const {
    data: results,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["searchCards", debouncedQuery, game, productType],
    queryFn: () => fetchSearchCards(debouncedQuery, game, productType),
    enabled: entryMode === "tcg" && debouncedQuery.length > 2,
    placeholderData: (previous) => previous,
    staleTime: 10 * 60 * 1000,
    gcTime: 45 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const handleCreateCustomItem = () => {
    const name = customName.trim();
    const imageUrl = customImageUrl.trim();
    const sku = customSku.trim();
    const barcode = customBarcode.trim();
    const vendorBrand = customVendor.trim();
    const productCategory = customCategory.trim();

    if (!name) {
      toast({
        title: "Missing required fields",
        description: "Product name is required.",
        variant: "destructive",
      });
      return;
    }

    const quantity = Math.max(1, Math.floor(Number(customQuantity) || 1));
    const cost = Number(customCost);
    const customPrice = Number(customSellPrice);
    const marketReference = Number(customMarketReference);
    const rulePercent = Number(customRulePercent);
    const computedRulePrice = Number.isFinite(marketReference) && Number.isFinite(rulePercent)
      ? Number((marketReference * (1 + rulePercent / 100)).toFixed(2))
      : NaN;
    const sellPrice = customSalePriceMode === "custom" ? customPrice : computedRulePrice;

    if (!Number.isFinite(quantity) || quantity < 1) {
      toast({ title: "Invalid quantity", description: "Quantity must be at least 1.", variant: "destructive" });
      return;
    }

    if (!Number.isFinite(sellPrice) || sellPrice < 0 || !Number.isFinite(cost) || cost < 0) {
      toast({
        title: "Invalid pricing",
        description: "Cost and final sale price must be valid non-negative numbers.",
        variant: "destructive",
      });
      return;
    }

    addItem({
      collection_id: activeCollection.id,
      sku: sku || undefined,
      barcode: barcode || null,
      vendor_brand: vendorBrand || null,
      product_category: productCategory || null,
      card_id: clampCardIdToDbInt(Date.now()),
      card_name: name,
      set_name: productCategory || null,
      game_name: vendorBrand || null,
      rarity: null,
      printing: "Custom",
      market_price: sellPrice,
      low_price: sellPrice,
      image_url: imageUrl || null,
      quantity,
      notes: customNotes.trim() || null,
      price_paid: cost,
      price_paid_input_type: "amount",
      price_paid_percent: null,
      sale_price_source: customSalePriceMode,
      sale_price_rule: customSalePriceMode === "market_rule" ? `market:${marketReference};adj:${rulePercent}%` : null,
      market_price_at_add: sellPrice,
    });

    toast({ title: "Custom item created", description: `${name} added to ${activeCollection.name} inventory.` });
    setCustomName("");
    setCustomImageUrl("");
    setCustomSku("");
    setCustomVendor("");
    setCustomCategory("");
    setCustomBarcode("");
    setCustomQuantity("1");
    setCustomSellPrice("0.00");
    setCustomSalePriceMode("custom");
    setCustomMarketReference("0.00");
    setCustomRulePercent("0");
    setCustomCost("0.00");
    setCustomNotes("");
  };

  const smartSuggestions = getSmartSearchSuggestions(query, game, searchHistory);
  const suggestionTitle = query.trim().length > 0 ? "Suggestions" : "Trending Searches";

  const handleAdd = (
    card: SearchCard,
    condition: string,
    selectedPricing?: { market: number | null; low: number | null },
    selectedPrinting?: string,
    selectedCollectionId?: number,
    intake?: ProductIntake,
  ) => {
    const printingLabel = selectedPrinting || getPrintingLabel(card.printing);
    const targetCollectionId = selectedCollectionId ?? activeCollection.id;
    const quantity = intake?.quantity ?? 1;
    const cost = intake?.cost ?? 0;
    const salePrice = intake?.salePrice ?? selectedPricing?.market ?? card.market_price;
    const resolvedCardId = resolveNumericCardId(card, printingLabel);

    addItem({
      collection_id: targetCollectionId,
      sku: intake?.sku,
      barcode: intake?.barcode,
      vendor_brand: intake?.vendorBrand,
      product_category: intake?.productCategory,
      card_id: resolvedCardId,
      card_name: intake?.productName || card.name,
      set_name: card.set_name,
      game_name: card.game_name ?? game,
      rarity: card.rarity,
      printing: printingLabel,
      market_price: salePrice,
      low_price: selectedPricing?.low ?? card.low_price,
      image_url: intake?.imageUrl || card.image_url,
      quantity,
      price_paid: cost,
      price_paid_input_type: "amount",
      price_paid_percent: null,
      sale_price_source: intake?.salePriceSource ?? null,
      sale_price_rule: intake?.salePriceRule ?? null,
      market_price_at_add: selectedPricing?.market ?? card.market_price ?? null,
    });

    const collectionName =
      collections.find((c) => c.id === targetCollectionId)?.name || activeCollection.name;
    toast({
      title: "Added to inventory",
      description: `${intake?.productName || card.name} (${printingLabel} · ${condition}) added to ${collectionName} inventory at ${fmt(cost)} cost and ${fmt(salePrice)} sale price.`,
    });
    setSelectedCard(null);
  };

  return (
    <AppLayout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Add Product</h1>
          <p className="text-muted-foreground mt-2">
            Add a TCG product from market data or create a custom brick-and-mortar item.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 max-w-sm">
          <Button variant={entryMode === "tcg" ? "default" : "outline"} onClick={() => setEntryMode("tcg")}>TCG Product</Button>
          <Button variant={entryMode === "custom" ? "default" : "outline"} onClick={() => setEntryMode("custom")}>Custom Item</Button>
        </div>

        {entryMode === "tcg" ? (
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
            <Input
              placeholder="Search for a card... (min 3 chars)"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setScanLabel(null);
                setIsSuggestionOpen(true);
              }}
              onFocus={() => setIsSuggestionOpen(true)}
              onBlur={() => {
                window.setTimeout(() => setIsSuggestionOpen(false), 120);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setDebouncedQuery(query);
                  rememberSearch(query);
                  setIsSuggestionOpen(false);
                }
              }}
              className="pl-10 pr-12 h-12 text-lg bg-card border-border shadow-sm focus-visible:ring-primary"
            />
            {query && (
              <button
                onClick={() => { setQuery(""); setDebouncedQuery(""); setScanLabel(null); }}
                className="absolute right-3 top-3.5 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Clear search"
              >
                <X className="h-5 w-5" />
              </button>
            )}

            {isSuggestionOpen && smartSuggestions.length > 0 && (
              <div className="absolute z-30 mt-2 w-full rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border text-sm font-semibold">
                  {suggestionTitle}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {smartSuggestions.map((suggestion) => (
                    <button
                      key={`${suggestion.source}-${suggestion.term}`}
                      type="button"
                      className="w-full px-4 py-3 text-left hover:bg-muted/50 transition-colors border-b border-border/50 last:border-b-0"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const cleaned = suggestion.term.replace(/^\"|\"$/g, "");
                        setQuery(cleaned);
                        setDebouncedQuery(cleaned);
                        rememberSearch(cleaned);
                        setIsSuggestionOpen(false);
                      }}
                    >
                      <div className="flex items-start gap-2">
                        {suggestion.source === "history" ? (
                          <Clock3 className="h-4 w-4 mt-0.5 text-muted-foreground" />
                        ) : (
                          <TrendingUp className="h-4 w-4 mt-0.5 text-muted-foreground" />
                        )}
                        <div>
                          <div className="text-lg leading-tight font-semibold italic">{suggestion.term}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{suggestion.gameLabel}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 shrink-0 bg-card border-border shadow-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={scanMutation.isPending}
            title="Scan card from photo"
          >
            {scanMutation.isPending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Camera className="h-5 w-5" />
            )}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleScanFile(file);
              e.target.value = "";
            }}
          />
          <Select value={game} onValueChange={setGame}>
            <SelectTrigger className="w-full sm:w-[200px] h-12 text-base bg-card border-border shadow-sm">
              <SelectValue placeholder="Select Game" />
            </SelectTrigger>
            <SelectContent>
              {GAMES.map((g) => (
                <SelectItem key={g.value} value={g.value}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={productType} onValueChange={(value) => setProductType(value as SearchProductType)}>
            <SelectTrigger className="w-full sm:w-[170px] h-12 text-base bg-card border-border shadow-sm">
              <SelectValue placeholder="Product Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cards">Cards</SelectItem>
              <SelectItem value="sealed">Sealed</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-6 shadow-sm space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Product Name (required)" />
              <Input value={customImageUrl} onChange={(e) => setCustomImageUrl(e.target.value)} placeholder="Image URL (optional)" />
              <Input value={customSku} onChange={(e) => setCustomSku(e.target.value)} placeholder="SKU (optional)" />
              <Input value={customBarcode} onChange={(e) => setCustomBarcode(e.target.value)} placeholder="Barcode (optional, scanner supported)" autoComplete="off" />
              <Input value={customVendor} onChange={(e) => setCustomVendor(e.target.value)} placeholder="Vendor / Brand (optional)" />
              <Input value={customCategory} onChange={(e) => setCustomCategory(e.target.value)} placeholder="Product Category (optional)" />
              <Input value={customQuantity} type="number" min="1" onChange={(e) => setCustomQuantity(e.target.value)} placeholder="Quantity (required)" />
              <Input value={customCost} type="number" min="0" step="0.01" onChange={(e) => setCustomCost(e.target.value)} placeholder="Cost (required)" />
              <Input value={customNotes} onChange={(e) => setCustomNotes(e.target.value)} placeholder="Notes" />
            </div>

            <div className="rounded-md border border-border p-3 space-y-3">
              <div className="text-sm font-medium">Sale Price</div>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant={customSalePriceMode === "custom" ? "default" : "outline"} onClick={() => setCustomSalePriceMode("custom")}>Custom Price</Button>
                <Button type="button" variant={customSalePriceMode === "market_rule" ? "default" : "outline"} onClick={() => setCustomSalePriceMode("market_rule")}>Market Rule</Button>
              </div>

              {customSalePriceMode === "custom" ? (
                <Input value={customSellPrice} type="number" min="0" step="0.01" onChange={(e) => setCustomSellPrice(e.target.value)} placeholder="Sale Price (required)" />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input value={customMarketReference} type="number" min="0" step="0.01" onChange={(e) => setCustomMarketReference(e.target.value)} placeholder="Market Reference*" />
                  <Input value={customRulePercent} type="number" step="0.01" onChange={(e) => setCustomRulePercent(e.target.value)} placeholder="Rule % (e.g. 10 or -5)*" />
                </div>
              )}
            </div>

            <Button onClick={handleCreateCustomItem}>Create Custom Item</Button>
          </div>
        )}

        {entryMode === "tcg" && scanLabel ? (
          <p className="text-sm -mt-2 flex items-center gap-1.5 text-primary">
            <Camera className="h-3.5 w-3.5" />
            <span className="font-medium">Scanned:</span> {scanLabel}
          </p>
        ) : entryMode === "tcg" ? (
          <p className="text-sm text-muted-foreground -mt-2">
            Search by name or include a card number — e.g. "Charizard ex 199" or
            "Pikachu 151"
          </p>
        ) : null}

        {entryMode === "tcg" && debouncedQuery.length > 2 && (
          <div className="pt-4">
            {isLoading ? (
              <div className="flex justify-center p-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : isError ? (
              <div className="text-center p-12 border border-dashed rounded-xl text-muted-foreground">
                <p>Search is temporarily unavailable. Please try again in a moment.</p>
              </div>
            ) : results && results.length > 0 ? (
              <div className="grid grid-cols-1 min-[430px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {results.map((card, i) => {
                  const printingLabel = getPrintingLabel(card.printing);
                  const isFoil = isPrintingFoil(card.printing);
                  return (
                    <div
                      key={`${card.id}-${i}`}
                      className="flex flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden group cursor-pointer hover:border-primary/50 transition-colors"
                      onClick={() => {
                        rememberSearch(query);
                        setStartInAddMode(false);
                        setSelectedCard(card);
                      }}
                    >
                      <div className="aspect-[2.5/3.5] bg-black w-full overflow-hidden">
                        {card.image_url ? (
                          <img
                            src={card.image_url}
                            alt={card.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-muted-foreground font-mono text-xs">
                            No Image
                          </div>
                        )}
                      </div>

                      <div className="p-3 flex flex-col flex-1">
                        <h3
                          className="font-bold text-sm leading-tight mb-0.5 line-clamp-2"
                          title={card.name}
                        >
                          {card.name}
                        </h3>
                        <div className="text-xs text-muted-foreground truncate mb-1">
                          {card.set_name}
                        </div>
                        <div className="flex items-center gap-1 mb-3 flex-wrap">
                          {card.number && (
                            <span className="font-mono text-xs bg-muted px-1 py-0.5 rounded text-muted-foreground">
                              #{card.number}
                            </span>
                          )}
                          {card.product_type === "sealed" && (
                            <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                              SEALED
                            </span>
                          )}
                        </div>

                        <Button
                          size="sm"
                          variant="outline"
                          className={`w-full mt-auto flex justify-between items-center text-xs ${
                            isFoil
                              ? "border-amber-500/40 hover:border-amber-500/80 hover:bg-amber-500/10"
                              : "hover:border-primary/50"
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            rememberSearch(query);
                            setStartInAddMode(true);
                            setSelectedCard(card);
                          }}
                          disabled={false}
                        >
                          <span className={isFoil ? "text-amber-400" : ""}>
                            {printingLabel}
                          </span>
                          <span
                            className={`font-mono ${isFoil ? "text-amber-400" : ""}`}
                          >
                            {fmt(card.market_price)}
                          </span>
                          <Plus className="h-3 w-3 shrink-0 opacity-60" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center p-12 border border-dashed rounded-xl text-muted-foreground">
                <SearchIcon className="h-12 w-12 mx-auto mb-4 opacity-20" />
                <p>
                  No cards found matching "{debouncedQuery}" for{" "}
                  {GAMES.find((g) => g.value === game)?.label ?? game} ({productType}).
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <CardDetailModal
        card={selectedCard}
        open={selectedCard !== null}
        onClose={() => {
          setSelectedCard(null);
          setStartInAddMode(false);
        }}
        onAdd={handleAdd}
        onCreateCollection={(name) => {
          try {
            const created = createCollection(name);
            toast({ title: "Inventory created", description: `Now adding to ${created.name}.` });
            return created;
          } catch (error) {
            toast({
              title: "Could not create inventory",
              description: error instanceof Error ? error.message : "Please try a different name.",
              variant: "destructive",
            });
            return null;
          }
        }}
        collections={collections}
        defaultCollectionId={activeCollection.id}
        startInAddMode={startInAddMode}
        isPending={false}
      />
    </AppLayout>
  );
}
