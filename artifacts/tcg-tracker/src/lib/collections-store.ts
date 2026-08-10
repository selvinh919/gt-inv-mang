import { useEffect, useSyncExternalStore } from "react";
import { getApiBaseUrl, getStoredAuthToken } from "@/lib/auth-session";

export type UserCollection = {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
};

export type CollectionCardItem = {
  id: number;
  remote_id?: number | null;
  collection_id: number;
  sku: string;
  barcode: string | null;
  vendor_brand: string | null;
  product_category: string | null;
  card_id: number;
  card_name: string;
  set_name: string | null;
  game_name: string | null;
  rarity: string | null;
  printing: string;
  market_price: number | null;
  low_price: number | null;
  image_url: string | null;
  quantity: number;
  notes: string | null;
  price_paid: number | null;
  price_paid_input_type: "amount" | "percent" | null;
  price_paid_percent: number | null;
  sale_price_source: "custom" | "market_rule" | null;
  sale_price_rule: string | null;
  market_price_at_add: number | null;
  added_at: string;
  updated_at: string;
};

export type SaleLine = {
  item_id: number;
  sku: string;
  card_name: string;
  printing: string;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  line_total: number;
  line_profit: number;
};

export type SaleRecord = {
  id: number;
  collection_id: number;
  sold_at: string;
  notes: string | null;
  total_revenue: number;
  total_cogs: number;
  total_profit: number;
  lines: SaleLine[];
};

export type InventoryAuditLog = {
  id: number;
  created_at: string;
  action: string;
  entity_type: "collection" | "collection_item" | "sale";
  entity_id: string;
  actor_user_id: number | null;
  actor_email: string | null;
  actor_name: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
};

export type InventorySyncState = {
  status: "idle" | "syncing" | "synced" | "error";
  error: string | null;
  lastSyncedAt: string | null;
};

type StoreState = {
  version: 3;
  nextCollectionId: number;
  nextItemId: number;
  nextSaleId: number;
  nextAuditId: number;
  activeCollectionId: number;
  collections: UserCollection[];
  items: CollectionCardItem[];
  sales: SaleRecord[];
  audit_logs: InventoryAuditLog[];
};

type AddItemInput = {
  collection_id: number;
  sku?: string | null;
  barcode?: string | null;
  vendor_brand?: string | null;
  product_category?: string | null;
  card_id: number;
  card_name: string;
  set_name?: string | null;
  game_name?: string | null;
  rarity?: string | null;
  printing: string;
  market_price?: number | null;
  low_price?: number | null;
  image_url?: string | null;
  quantity?: number;
  notes?: string | null;
  price_paid?: number | null;
  price_paid_input_type?: "amount" | "percent" | null;
  price_paid_percent?: number | null;
  sale_price_source?: "custom" | "market_rule" | null;
  sale_price_rule?: string | null;
  market_price_at_add?: number | null;
};

type UpdateItemInput = {
  quantity?: number;
  notes?: string | null;
  card_name?: string;
  set_name?: string | null;
  game_name?: string | null;
  printing?: string;
  sku?: string;
  barcode?: string | null;
  vendor_brand?: string | null;
  product_category?: string | null;
  image_url?: string | null;
  market_price?: number | null;
  low_price?: number | null;
  price_paid?: number | null;
  price_paid_input_type?: "amount" | "percent" | null;
  price_paid_percent?: number | null;
  sale_price_source?: "custom" | "market_rule" | null;
  sale_price_rule?: string | null;
  market_price_at_add?: number | null;
};

const STORAGE_KEY = "cardsync.collections.v1";
const LEGACY_STORAGE_KEY = "cardsync.collections.v1";
const BUSINESS_STORAGE_KEY = "cardsync.business.v1";
const DELETE_QUEUE_STORAGE_KEY = "cardsync.inventory-delete-queue.v1";

type PendingRemoteDelete = {
  remoteId: number | null;
  fingerprint: string;
  deletedAt: string;
};

const listeners = new Set<() => void>();
let currentState: StoreState | null = null;
let currentUserScope: number | null = null;
let remoteHydrationInFlight = false;
let remoteHydrationLastAt = 0;
let remoteSyncState: InventorySyncState = {
  status: "idle",
  error: null,
  lastSyncedAt: null,
};

const REMOTE_HYDRATE_MIN_INTERVAL_MS = 3000;
const REMOTE_HYDRATE_POLL_MS = 15000;

function nowIso() {
  return new Date().toISOString();
}

function setRemoteSyncState(next: InventorySyncState) {
  remoteSyncState = next;
  listeners.forEach((listener) => listener());
}

function getRemoteSyncSnapshot() {
  return remoteSyncState;
}

function normalizeMoney(value: number): number {
  return Number(value.toFixed(2));
}

function makeItemSku(input: { collection_id: number; card_id: number; printing: string }): string {
  return `C${input.collection_id}-P${input.card_id}-${input.printing.trim().toUpperCase().replace(/\s+/g, "-")}`;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getAuthToken(): string | null {
  if (!isBrowser()) return null;
  return getStoredAuthToken();
}

function getRemoteCollectionApiBase(): string {
  const configured = String(import.meta.env.VITE_COLLECTIONS_API_BASE_URL || "").trim().replace(/\/+$/, "");
  const base = configured || getApiBaseUrl();
  return `${base}/api/auth/collection`;
}

function itemFingerprint(item: Pick<CollectionCardItem, "collection_id" | "sku" | "card_id" | "printing">): string {
  return `${item.collection_id}::${item.sku}::${item.card_id}::${item.printing}`;
}

function deleteQueueStorageKey(): string {
  return `${DELETE_QUEUE_STORAGE_KEY}:${getActiveBusinessUserId() ?? "guest"}`;
}

function loadPendingRemoteDeletes(): PendingRemoteDelete[] {
  if (!isBrowser()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(deleteQueueStorageKey()) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingRemoteDelete =>
      entry && typeof entry.fingerprint === "string" && entry.fingerprint.length > 0,
    );
  } catch {
    return [];
  }
}

function savePendingRemoteDeletes(entries: PendingRemoteDelete[]): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(deleteQueueStorageKey(), JSON.stringify(entries));
}

function queueRemoteDelete(item: CollectionCardItem): void {
  const fingerprint = itemFingerprint(item);
  const existing = loadPendingRemoteDeletes();
  const remoteId = Number(item.remote_id || 0);
  const next: PendingRemoteDelete = {
    remoteId: Number.isInteger(remoteId) && remoteId > 0 ? remoteId : null,
    fingerprint,
    deletedAt: nowIso(),
  };
  savePendingRemoteDeletes([
    next,
    ...existing.filter((entry) => entry.fingerprint !== fingerprint),
  ]);
}

function clearPendingRemoteDelete(entry: PendingRemoteDelete): void {
  savePendingRemoteDeletes(loadPendingRemoteDeletes().filter((candidate) =>
    candidate.fingerprint !== entry.fingerprint,
  ));
}

async function deleteRemoteItemById(remoteId: number): Promise<void> {
  const token = getAuthToken();
  if (!token || !remoteId) return;
  const response = await fetch(`${getRemoteCollectionApiBase()}/${remoteId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Remote inventory delete failed: ${response.status}`);
  }
}

async function flushPendingRemoteDeletes(remoteItems?: CollectionCardItem[]): Promise<void> {
  if (!getAuthToken()) return;
  const pending = loadPendingRemoteDeletes();
  if (pending.length === 0) return;

  const availableRemoteItems = remoteItems ?? await fetchRemoteItems() ?? [];
  for (const entry of pending) {
    const matchingRemote = availableRemoteItems.find((item) =>
      (entry.remoteId != null && Number(item.id) === entry.remoteId) ||
      itemFingerprint(item) === entry.fingerprint,
    );
    const remoteId = entry.remoteId ?? (matchingRemote ? Number(matchingRemote.id) : null);

    if (!remoteId) {
      clearPendingRemoteDelete(entry);
      continue;
    }

    await deleteRemoteItemById(remoteId);
    clearPendingRemoteDelete(entry);
  }
}

function mapRemoteItemToLocal(remote: any): CollectionCardItem {
  const collectionId = Number(remote?.collection_id || 1);
  const cardId = Number(remote?.card_id || 0);
  const printing = String(remote?.printing || "Normal");
  return {
    id: Number(remote?.id || 0),
    remote_id: Number(remote?.id || 0),
    collection_id: collectionId,
    sku: String(remote?.sku || "").trim() || makeItemSku({ collection_id: collectionId, card_id: cardId, printing }),
    barcode: remote?.barcode ? String(remote.barcode) : null,
    vendor_brand: remote?.vendor_brand ? String(remote.vendor_brand) : null,
    product_category: remote?.product_category ? String(remote.product_category) : null,
    card_id: cardId,
    card_name: String(remote?.card_name || "Unknown"),
    set_name: remote?.set_name ? String(remote.set_name) : null,
    game_name: remote?.game_name ? String(remote.game_name) : null,
    rarity: remote?.rarity ? String(remote.rarity) : null,
    printing,
    market_price: toNullableNumber(remote?.market_price),
    low_price: toNullableNumber(remote?.low_price),
    image_url: remote?.image_url ? String(remote.image_url) : null,
    quantity: Math.max(1, Number(remote?.quantity || 1)),
    notes: remote?.notes ? String(remote.notes) : null,
    price_paid: toNullableNumber(remote?.price_paid),
    price_paid_input_type:
      remote?.price_paid_input_type === "amount" || remote?.price_paid_input_type === "percent"
        ? remote.price_paid_input_type
        : null,
    price_paid_percent: toNullableNumber(remote?.price_paid_percent),
    sale_price_source:
      remote?.sale_price_source === "custom" || remote?.sale_price_source === "market_rule"
        ? remote.sale_price_source
        : null,
    sale_price_rule: remote?.sale_price_rule ? String(remote.sale_price_rule) : null,
    market_price_at_add: toNullableNumber(remote?.market_price_at_add),
    added_at: typeof remote?.added_at === "string" ? remote.added_at : nowIso(),
    updated_at: typeof remote?.updated_at === "string" ? remote.updated_at : nowIso(),
  };
}

function ensureCollectionsForItems(state: StoreState, items: CollectionCardItem[]): UserCollection[] {
  const byId = new Map(state.collections.map((collection) => [collection.id, collection]));
  for (const item of items) {
    if (!byId.has(item.collection_id)) {
      byId.set(item.collection_id, {
        id: item.collection_id,
        name: item.collection_id === 1 ? "Main Inventory" : `Inventory ${item.collection_id}`,
        description: item.collection_id === 1 ? "Default inventory" : "Synced inventory",
        created_at: nowIso(),
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

async function fetchRemoteItems(): Promise<CollectionCardItem[] | null> {
  const token = getAuthToken();
  if (!token) return null;

  const response = await fetch(getRemoteCollectionApiBase(), {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Remote inventory fetch failed: ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) return [];
  return payload.map(mapRemoteItemToLocal);
}

function toRemotePayload(item: CollectionCardItem): Record<string, unknown> {
  return {
    collection_id: item.collection_id,
    sku: item.sku,
    barcode: item.barcode,
    vendor_brand: item.vendor_brand,
    product_category: item.product_category,
    card_id: item.card_id,
    card_name: item.card_name,
    set_name: item.set_name,
    game_name: item.game_name,
    rarity: item.rarity,
    printing: item.printing,
    market_price: item.market_price,
    low_price: item.low_price,
    image_url: item.image_url,
    quantity: item.quantity,
    notes: item.notes,
    price_paid: item.price_paid,
    price_paid_input_type: item.price_paid_input_type,
    price_paid_percent: item.price_paid_percent,
    sale_price_source: item.sale_price_source,
    sale_price_rule: item.sale_price_rule,
    market_price_at_add: item.market_price_at_add,
  };
}

async function performRemoteUpsertItem(item: CollectionCardItem): Promise<number | null> {
  const token = getAuthToken();
  if (!token) return null;

  const hasRemoteId = Number.isInteger(item.remote_id) && Number(item.remote_id) > 0;
  const url = hasRemoteId
    ? `${getRemoteCollectionApiBase()}/${item.remote_id}`
    : getRemoteCollectionApiBase();
  const method = hasRemoteId ? "PATCH" : "POST";

  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(toRemotePayload(item)),
  });

  if (hasRemoteId && response.status === 404) {
    const fallbackResponse = await fetch(getRemoteCollectionApiBase(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(toRemotePayload(item)),
    });

    if (!fallbackResponse.ok) {
      throw new Error(`Remote inventory POST fallback failed: ${fallbackResponse.status}`);
    }

    const created = await fallbackResponse.json();
    return Number(created?.id || 0) || null;
  }

  if (!response.ok) {
    throw new Error(`Remote inventory ${method} failed: ${response.status}`);
  }

  if (hasRemoteId) {
    return item.remote_id ?? null;
  }

  const created = await response.json();
  return Number(created?.id || 0) || null;
}

async function syncRemoteUpsertItem(item: CollectionCardItem): Promise<number | null> {
  if (!getAuthToken()) return null;
  setRemoteSyncState({ status: "syncing", error: null, lastSyncedAt: remoteSyncState.lastSyncedAt });
  try {
    const remoteId = await performRemoteUpsertItem(item);
    setRemoteSyncState({ status: "synced", error: null, lastSyncedAt: nowIso() });
    return remoteId;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inventory could not be saved to the server";
    setRemoteSyncState({ status: "error", error: message, lastSyncedAt: remoteSyncState.lastSyncedAt });
    throw error;
  }
}

async function syncRemoteDeleteItem(item: CollectionCardItem | null): Promise<void> {
  if (!item) return;
  queueRemoteDelete(item);
  await flushPendingRemoteDeletes();
}

function attachRemoteIdToLocalItem(localItemId: number, remoteId: number): void {
  const state = getSnapshot();
  const nextItems = state.items.map((item) => {
    if (item.id !== localItemId) return item;
    return {
      ...item,
      remote_id: remoteId,
    };
  });

  saveState({
    ...state,
    items: nextItems,
  });
}

async function hydrateRemoteIntoStore(force = false): Promise<void> {
  const token = getAuthToken();
  if (!token || remoteHydrationInFlight) return;

  const now = Date.now();
  if (!force && now - remoteHydrationLastAt < REMOTE_HYDRATE_MIN_INTERVAL_MS) {
    return;
  }

  remoteHydrationInFlight = true;
  setRemoteSyncState({ status: "syncing", error: null, lastSyncedAt: remoteSyncState.lastSyncedAt });
  try {
    const fetchedRemoteItems = await fetchRemoteItems();
    if (!fetchedRemoteItems) return;

    const pendingDeletesAtFetch = loadPendingRemoteDeletes();
    try {
      await flushPendingRemoteDeletes(fetchedRemoteItems);
    } catch (error) {
      console.warn("Remote inventory delete retry failed", error);
    }

    const pendingDeletes = [...pendingDeletesAtFetch, ...loadPendingRemoteDeletes()];
    const remoteItems = fetchedRemoteItems.filter((item) => !pendingDeletes.some((entry) =>
      (entry.remoteId != null && Number(item.id) === entry.remoteId) ||
      itemFingerprint(item) === entry.fingerprint,
    ));

    const state = getSnapshot();
    const remoteIds = new Set(
      remoteItems
        .map((item) => Number(item.id))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    const remoteFingerprints = new Set(remoteItems.map((item) => itemFingerprint(item)));
    const unsyncedLocalItems = state.items.filter((item) => {
      const remoteId = Number(item.remote_id || 0);
      const representedByRemoteId = Number.isInteger(remoteId) && remoteId > 0 && remoteIds.has(remoteId);
      const representedByFingerprint = remoteFingerprints.has(itemFingerprint(item));
      return !representedByRemoteId && !representedByFingerprint;
    });

    const maxRemoteItemId = remoteItems.reduce((max, item) => Math.max(max, item.id), 0);
    let nextSyntheticId = maxRemoteItemId + 1;
    const carriedUnsyncedItems = unsyncedLocalItems.map((item) => ({
      ...item,
      id: nextSyntheticId++,
      remote_id: null,
    }));

    const mergedItems = [...remoteItems, ...carriedUnsyncedItems];
    const collections = ensureCollectionsForItems(state, mergedItems);
    const maxItemId = mergedItems.reduce((max, item) => Math.max(max, item.id), 0);

    saveState({
      ...state,
      collections,
      items: mergedItems,
      nextItemId: Math.max(state.nextItemId, maxItemId + 1),
      activeCollectionId: collections.some((c) => c.id === state.activeCollectionId)
        ? state.activeCollectionId
        : collections[0]?.id ?? 1,
    });

    let backfillError: unknown = null;
    for (const unsynced of carriedUnsyncedItems) {
      try {
        const remoteId = await syncRemoteUpsertItem(unsynced);
        if (remoteId) {
          attachRemoteIdToLocalItem(unsynced.id, remoteId);
        }
      } catch (error) {
        backfillError = error;
        console.warn("Remote inventory backfill failed", error);
      }
    }

    if (backfillError) {
      throw backfillError;
    }

    remoteHydrationLastAt = Date.now();
    setRemoteSyncState({ status: "synced", error: null, lastSyncedAt: nowIso() });
  } catch (error) {
    console.warn("Remote inventory hydration failed", error);
    const message = error instanceof Error ? error.message : "Inventory could not be loaded from the server";
    setRemoteSyncState({ status: "error", error: message, lastSyncedAt: remoteSyncState.lastSyncedAt });
  } finally {
    remoteHydrationInFlight = false;
  }
}

function defaultState(): StoreState {
  return {
    version: 3,
    nextCollectionId: 2,
    nextItemId: 1,
    nextSaleId: 1,
    nextAuditId: 1,
    activeCollectionId: 1,
    collections: [
      {
        id: 1,
        name: "Main Inventory",
        description: "Default inventory",
        created_at: nowIso(),
      },
    ],
    items: [],
    sales: [],
    audit_logs: [],
  };
}

function isBrowser() {
  return typeof window !== "undefined";
}

function getActiveBusinessUserId(): number | null {
  if (!isBrowser()) return null;

  try {
    const raw = window.localStorage.getItem(BUSINESS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { session?: { user_id?: unknown } };
    const userId = Number(parsed?.session?.user_id);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

function scopedStorageKey(userId: number | null): string {
  return userId ? `${STORAGE_KEY}:${userId}` : `${STORAGE_KEY}:guest`;
}

function getActiveBusinessActor(): {
  userId: number | null;
  email: string | null;
  name: string | null;
} {
  if (!isBrowser()) {
    return { userId: null, email: null, name: null };
  }

  try {
    const raw = window.localStorage.getItem(BUSINESS_STORAGE_KEY);
    if (!raw) {
      return { userId: null, email: null, name: null };
    }

    const parsed = JSON.parse(raw) as {
      session?: { user_id?: unknown; email?: unknown; name?: unknown };
    };

    return {
      userId: Number.isFinite(Number(parsed?.session?.user_id)) ? Number(parsed?.session?.user_id) : null,
      email: typeof parsed?.session?.email === "string" ? parsed.session.email : null,
      name: typeof parsed?.session?.name === "string" ? parsed.session.name : null,
    };
  } catch {
    return { userId: null, email: null, name: null };
  }
}

function withAudit(
  state: StoreState,
  input: {
    action: string;
    entityType: "collection" | "collection_item" | "sale";
    entityId: string;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown> | null;
  },
): StoreState {
  const actor = getActiveBusinessActor();
  const entry: InventoryAuditLog = {
    id: state.nextAuditId,
    created_at: nowIso(),
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    actor_user_id: actor.userId,
    actor_email: actor.email,
    actor_name: actor.name,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? null,
  };

  return {
    ...state,
    nextAuditId: state.nextAuditId + 1,
    audit_logs: [entry, ...state.audit_logs].slice(0, 2000),
  };
}

function loadState(): StoreState {
  if (!isBrowser()) return defaultState();

  const activeUserId = getActiveBusinessUserId();
  const userStorageKey = scopedStorageKey(activeUserId);

  let raw = window.localStorage.getItem(userStorageKey);

  if (!raw) {
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      raw = legacyRaw;
      window.localStorage.setItem(userStorageKey, legacyRaw);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }

  if (!raw) {
    const initial = defaultState();
    window.localStorage.setItem(userStorageKey, JSON.stringify(initial));
    return initial;
  }

  try {
    const parsed = JSON.parse(raw) as any;
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3)) return defaultState();

    const collections = Array.isArray(parsed.collections)
      ? parsed.collections.map((collection: any) => ({
          ...collection,
          name:
            String(collection?.name || "").trim().toLowerCase() === "main collection"
              ? "Main Inventory"
              : collection?.name,
          description:
            String(collection?.description || "").trim().toLowerCase() === "default collection"
              ? "Default inventory"
              : collection?.description,
        }))
      : [];
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item: any) => {
            const collection_id = Number(item.collection_id);
            const card_id = Number(item.card_id);
            const printing = typeof item.printing === "string" ? item.printing : "Normal";
            const parsedRemoteId = Number(item.remote_id);
            return {
              ...item,
              remote_id: Number.isInteger(parsedRemoteId) && parsedRemoteId > 0 ? parsedRemoteId : null,
              barcode: item.barcode ? String(item.barcode) : null,
              vendor_brand: item.vendor_brand ? String(item.vendor_brand) : null,
              product_category: item.product_category ? String(item.product_category) : null,
              sale_price_source:
                item.sale_price_source === "custom" || item.sale_price_source === "market_rule"
                  ? item.sale_price_source
                  : null,
              sale_price_rule: item.sale_price_rule ? String(item.sale_price_rule) : null,
              sku:
                typeof item.sku === "string" && item.sku.trim().length > 0
                  ? item.sku
                  : makeItemSku({ collection_id, card_id, printing }),
              updated_at:
                typeof item.updated_at === "string" && item.updated_at
                  ? item.updated_at
                  : typeof item.added_at === "string" && item.added_at
                    ? item.added_at
                    : nowIso(),
            } as CollectionCardItem;
          })
            .filter((item: CollectionCardItem) => Number.isFinite(item.collection_id) && Number.isFinite(item.card_id))
      : [];

    const sales = Array.isArray(parsed.sales) ? parsed.sales : [];
    const auditLogs = Array.isArray(parsed.audit_logs) ? parsed.audit_logs : [];

    if (collections.length === 0) {
      return defaultState();
    }

    return {
      version: 3,
      nextCollectionId: Number(parsed.nextCollectionId || 1),
      nextItemId: Number(parsed.nextItemId || 1),
      nextSaleId:
        parsed.version === 1
          ? 1
          : Number(parsed.nextSaleId || (sales.length > 0 ? Math.max(...sales.map((s: SaleRecord) => s.id)) + 1 : 1)),
      nextAuditId: Number(parsed.nextAuditId || (auditLogs.length > 0 ? Math.max(...auditLogs.map((log: InventoryAuditLog) => Number(log.id || 0))) + 1 : 1)),
      activeCollectionId: Number(parsed.activeCollectionId || collections[0].id),
      collections,
      items,
      sales,
      audit_logs: auditLogs,
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: StoreState) {
  currentState = state;
  if (!isBrowser()) return;

  const activeUserId = getActiveBusinessUserId();
  window.localStorage.setItem(scopedStorageKey(activeUserId), JSON.stringify(state));
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  const activeUserId = getActiveBusinessUserId();
  if (currentState && currentUserScope === activeUserId) return currentState;

  currentUserScope = activeUserId;
  currentState = loadState();
  return currentState;
}

function ensureActiveCollection(state: StoreState): StoreState {
  if (state.collections.some((c) => c.id === state.activeCollectionId)) {
    return state;
  }

  return {
    ...state,
    activeCollectionId: state.collections[0]?.id ?? 1,
  };
}

function createCollection(name: string, description?: string | null): UserCollection {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Inventory name is required");

  const state = getSnapshot();
  const exists = state.collections.some((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (exists) throw new Error("An inventory list with this name already exists");

  const created: UserCollection = {
    id: state.nextCollectionId,
    name: trimmed,
    description: description?.trim() || null,
    created_at: nowIso(),
  };

  const next = {
    ...state,
    nextCollectionId: state.nextCollectionId + 1,
    collections: [
      created,
      ...state.collections,
    ],
    activeCollectionId: state.nextCollectionId,
  };

  saveState(withAudit(next, {
    action: "collection.create",
    entityType: "collection",
    entityId: String(created.id),
    after: created,
  }));
  return created;
}

function setActiveCollection(collectionId: number) {
  const state = getSnapshot();
  if (!state.collections.some((c) => c.id === collectionId)) return;

  saveState({ ...state, activeCollectionId: collectionId });
}

function deleteCollection(collectionId: number) {
  const state = getSnapshot();
  if (state.collections.length <= 1) return;

  const collections = state.collections.filter((c) => c.id !== collectionId);
  const removedItems = state.items.filter((item) => item.collection_id === collectionId);
  const items = state.items.filter((item) => item.collection_id !== collectionId);
  removedItems.forEach(queueRemoteDelete);
  const next = ensureActiveCollection({ ...state, collections, items });
  saveState(withAudit(next, {
    action: "collection.delete",
    entityType: "collection",
    entityId: String(collectionId),
    metadata: { removed_item_count: state.items.length - items.length },
  }));
  void flushPendingRemoteDeletes().catch((error) => {
    console.warn("Remote inventory collection delete failed", error);
  });
}

function addItem(input: AddItemInput): CollectionCardItem {
  const state = getSnapshot();
  const qty = Math.max(1, Number(input.quantity || 1));
  const nextMarket = input.market_price ?? null;
  const nextLow = input.low_price ?? null;
  const now = nowIso();
  const sku = String(input.sku || "").trim() || makeItemSku({
    collection_id: input.collection_id,
    card_id: input.card_id,
    printing: input.printing,
  });

  const existing = state.items.find(
    (item) =>
      item.collection_id === input.collection_id &&
      item.sku === sku &&
      item.card_id === input.card_id &&
      item.printing === input.printing,
  );

  if (existing) {
    const existingQty = existing.quantity;
    const existingPricePaid = existing.price_paid ?? 0;
    const incomingPricePaid = input.price_paid ?? null;
    const mergedPricePaid =
      incomingPricePaid == null
        ? existing.price_paid
        : normalizeMoney(((existingPricePaid * existingQty) + (incomingPricePaid * qty)) / (existingQty + qty));

    const nextItems = state.items.map((item) => {
      if (item.id !== existing.id) return item;
      return {
        ...item,
        sku,
        quantity: item.quantity + qty,
        market_price: nextMarket ?? item.market_price,
        low_price: nextLow ?? item.low_price,
        image_url: input.image_url ?? item.image_url,
        barcode: input.barcode !== undefined ? (input.barcode || null) : item.barcode,
        vendor_brand: input.vendor_brand !== undefined ? (input.vendor_brand || null) : item.vendor_brand,
        product_category: input.product_category !== undefined ? (input.product_category || null) : item.product_category,
        notes: input.notes ?? item.notes,
        price_paid: mergedPricePaid,
        price_paid_input_type: incomingPricePaid == null ? item.price_paid_input_type : "amount",
        price_paid_percent: incomingPricePaid == null ? item.price_paid_percent : null,
        sale_price_source: input.sale_price_source ?? item.sale_price_source,
        sale_price_rule: input.sale_price_rule ?? item.sale_price_rule,
        updated_at: now,
      };
    });

    const nextState = withAudit({ ...state, items: nextItems }, {
      action: "collection_item.merge",
      entityType: "collection_item",
      entityId: String(existing.id),
      before: existing,
      after: nextItems.find((i) => i.id === existing.id) ?? existing,
      metadata: { added_quantity: qty },
    });
    saveState(nextState);
    void syncRemoteUpsertItem(nextItems.find((i) => i.id === existing.id) || existing).catch((error) => {
      console.warn("Remote inventory sync failed", error);
    });
    return nextItems.find((i) => i.id === existing.id) || existing;
  }

  const created: CollectionCardItem = {
    id: state.nextItemId,
    collection_id: input.collection_id,
    sku,
    barcode: input.barcode ?? null,
    vendor_brand: input.vendor_brand ?? null,
    product_category: input.product_category ?? null,
    card_id: input.card_id,
    card_name: input.card_name,
    set_name: input.set_name ?? null,
    game_name: input.game_name ?? null,
    rarity: input.rarity ?? null,
    printing: input.printing,
    market_price: input.market_price ?? null,
    low_price: input.low_price ?? null,
    image_url: input.image_url ?? null,
    quantity: qty,
    notes: input.notes ?? null,
    price_paid: input.price_paid ?? null,
    price_paid_input_type: input.price_paid_input_type ?? null,
    price_paid_percent: input.price_paid_percent ?? null,
    sale_price_source: input.sale_price_source ?? null,
    sale_price_rule: input.sale_price_rule ?? null,
    market_price_at_add: input.market_price_at_add ?? input.market_price ?? null,
    added_at: now,
    updated_at: now,
  };

  const nextState = withAudit({
    ...state,
    nextItemId: state.nextItemId + 1,
    items: [created, ...state.items],
  }, {
    action: "collection_item.create",
    entityType: "collection_item",
    entityId: String(created.id),
    after: created,
  });

  saveState(nextState);
  void syncRemoteUpsertItem(created)
    .then((remoteId) => {
      if (remoteId) {
        attachRemoteIdToLocalItem(created.id, remoteId);
      }
    })
    .catch((error) => {
      console.warn("Remote inventory sync failed", error);
    });

  return created;
}

function updateItem(id: number, updates: UpdateItemInput) {
  const state = getSnapshot();
  const now = nowIso();
  const existing = state.items.find((item) => item.id === id);
  if (!existing) return;

  const nextItems = state.items.map((item) => {
    if (item.id !== id) return item;

    return {
      ...item,
      card_name: updates.card_name !== undefined ? updates.card_name.trim() || item.card_name : item.card_name,
      set_name: updates.set_name !== undefined ? updates.set_name : item.set_name,
      game_name: updates.game_name !== undefined ? updates.game_name : item.game_name,
      printing: updates.printing !== undefined ? updates.printing.trim() || item.printing : item.printing,
      sku: updates.sku !== undefined ? (updates.sku.trim() || item.sku) : item.sku,
      barcode: updates.barcode !== undefined ? (updates.barcode || null) : item.barcode,
      vendor_brand: updates.vendor_brand !== undefined ? (updates.vendor_brand || null) : item.vendor_brand,
      product_category: updates.product_category !== undefined ? (updates.product_category || null) : item.product_category,
      image_url: updates.image_url !== undefined ? (updates.image_url || null) : item.image_url,
      quantity: updates.quantity !== undefined ? Math.max(1, updates.quantity) : item.quantity,
      notes: updates.notes !== undefined ? updates.notes : item.notes,
      market_price: updates.market_price !== undefined ? updates.market_price : item.market_price,
      low_price: updates.low_price !== undefined ? updates.low_price : item.low_price,
      price_paid: updates.price_paid !== undefined ? updates.price_paid : item.price_paid,
      price_paid_input_type: updates.price_paid_input_type !== undefined ? updates.price_paid_input_type : item.price_paid_input_type,
      price_paid_percent: updates.price_paid_percent !== undefined ? updates.price_paid_percent : item.price_paid_percent,
      sale_price_source: updates.sale_price_source !== undefined ? updates.sale_price_source : item.sale_price_source,
      sale_price_rule: updates.sale_price_rule !== undefined ? updates.sale_price_rule : item.sale_price_rule,
      market_price_at_add: updates.market_price_at_add !== undefined ? updates.market_price_at_add : item.market_price_at_add,
      updated_at: now,
    };
  });

  const updatedItem = nextItems.find((item) => item.id === id) ?? existing;
  saveState(withAudit({ ...state, items: nextItems }, {
    action: "collection_item.update",
    entityType: "collection_item",
    entityId: String(id),
    before: existing,
    after: updatedItem,
  }));

  void syncRemoteUpsertItem(updatedItem)
    .then((remoteId) => {
      if (remoteId && !updatedItem.remote_id) {
        attachRemoteIdToLocalItem(updatedItem.id, remoteId);
      }
    })
    .catch((error) => {
      console.warn("Remote inventory sync failed", error);
    });
}

function removeItem(id: number) {
  const state = getSnapshot();
  const existing = state.items.find((item) => item.id === id);
  const nextItems = state.items.filter((item) => item.id !== id);
  if (existing) queueRemoteDelete(existing);
  saveState(withAudit({ ...state, items: nextItems }, {
    action: "collection_item.delete",
    entityType: "collection_item",
    entityId: String(id),
    before: existing ?? null,
  }));
  void flushPendingRemoteDeletes().catch((error) => {
    console.warn("Remote inventory delete failed", error);
  });
}

function checkoutSale(
  collectionId: number,
  lines: Array<{ item_id: number; quantity: number; unit_price: number }>,
  notes?: string | null,
): SaleRecord {
  const state = getSnapshot();
  const byId = new Map(state.items.map((item) => [item.id, item]));

  if (lines.length === 0) {
    throw new Error("At least one line item is required");
  }

  let totalRevenue = 0;
  let totalCogs = 0;
  const saleLines: SaleLine[] = [];
  const nextItems = [...state.items];

  for (const inputLine of lines) {
    const qty = Math.floor(Number(inputLine.quantity));
    const unitPrice = Number(inputLine.unit_price);
    if (!Number.isFinite(qty) || qty < 1) {
      throw new Error("Invalid quantity in sale line");
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error("Invalid sale price in sale line");
    }

    const item = byId.get(inputLine.item_id);
    if (!item || item.collection_id !== collectionId) {
      throw new Error("Sale item not found in selected collection");
    }
    if (item.quantity < qty) {
      throw new Error(`${item.card_name} is out of stock for requested quantity`);
    }

    const unitCost = Number(item.price_paid ?? 0);
    const lineTotal = normalizeMoney(unitPrice * qty);
    const lineCost = normalizeMoney(unitCost * qty);
    const lineProfit = normalizeMoney(lineTotal - lineCost);

    totalRevenue += lineTotal;
    totalCogs += lineCost;

    saleLines.push({
      item_id: item.id,
      sku: item.sku,
      card_name: item.card_name,
      printing: item.printing,
      quantity: qty,
      unit_price: normalizeMoney(unitPrice),
      unit_cost: normalizeMoney(unitCost),
      line_total: lineTotal,
      line_profit: lineProfit,
    });

    const idx = nextItems.findIndex((existing) => existing.id === item.id);
    if (idx >= 0) {
      const remaining = nextItems[idx].quantity - qty;
      if (remaining <= 0) {
        nextItems.splice(idx, 1);
      } else {
        nextItems[idx] = {
          ...nextItems[idx],
          quantity: remaining,
          updated_at: nowIso(),
        };
      }
    }
  }

  const totalProfit = normalizeMoney(totalRevenue - totalCogs);
  const sale: SaleRecord = {
    id: state.nextSaleId,
    collection_id: collectionId,
    sold_at: nowIso(),
    notes: notes?.trim() || null,
    total_revenue: normalizeMoney(totalRevenue),
    total_cogs: normalizeMoney(totalCogs),
    total_profit: totalProfit,
    lines: saleLines,
  };

  saveState(withAudit({
    ...state,
    items: nextItems,
    nextSaleId: state.nextSaleId + 1,
    sales: [sale, ...state.sales],
  }, {
    action: "sale.create",
    entityType: "sale",
    entityId: String(sale.id),
    after: sale,
  }));

  for (const line of saleLines) {
    const before = state.items.find((item) => item.id === line.item_id);
    const after = nextItems.find((item) => item.id === line.item_id);
    if (!before) continue;
    if (!after) {
      queueRemoteDelete(before);
      continue;
    }
    void syncRemoteUpsertItem(after).catch((error) => {
      console.warn("Remote inventory checkout sync failed", error);
    });
  }
  void flushPendingRemoteDeletes().catch((error) => {
    console.warn("Remote inventory checkout delete failed", error);
  });

  return sale;
}

function getCollectionItems(state: StoreState, collectionId: number) {
  return state.items
    .filter((item) => item.collection_id === collectionId)
    .sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
}

function getCollectionSales(state: StoreState, collectionId: number) {
  return state.sales
    .filter((sale) => sale.collection_id === collectionId)
    .sort((a, b) => Date.parse(b.sold_at) - Date.parse(a.sold_at));
}

function getSummary(items: CollectionCardItem[]) {
  const total_cards = items.reduce((acc, item) => acc + item.quantity, 0);
  const unique_cards = items.length;
  const total_value = items.reduce((acc, item) => acc + (item.market_price || 0) * item.quantity, 0);
  const total_paid = items.reduce((acc, item) => acc + (item.price_paid || 0) * item.quantity, 0);

  const byGameMap = new Map<string, { count: number; total_value: number }>();
  for (const item of items) {
    const game = item.game_name || "Unknown";
    const current = byGameMap.get(game) || { count: 0, total_value: 0 };
    current.count += item.quantity;
    current.total_value += (item.market_price || 0) * item.quantity;
    byGameMap.set(game, current);
  }

  const by_game = Array.from(byGameMap.entries()).map(([game, data]) => ({
    game,
    count: data.count,
    total_value: Number(data.total_value.toFixed(2)),
  }));

  const top_cards = [...items]
    .sort((a, b) => (b.market_price || 0) * b.quantity - (a.market_price || 0) * a.quantity)
    .slice(0, 5);

  return {
    total_cards,
    unique_cards,
    total_value: Number(total_value.toFixed(2)),
    total_paid: Number(total_paid.toFixed(2)),
    unrealized_pl: Number((total_value - total_paid).toFixed(2)),
    by_game,
    top_cards,
  };
}

function getPosSummary(items: CollectionCardItem[], sales: SaleRecord[]) {
  const inStockUnits = items.reduce((sum, item) => sum + item.quantity, 0);
  const inventoryCostBasis = normalizeMoney(
    items.reduce((sum, item) => sum + (item.price_paid ?? 0) * item.quantity, 0),
  );
  const inventoryMarketValue = normalizeMoney(
    items.reduce((sum, item) => sum + (item.market_price ?? 0) * item.quantity, 0),
  );

  const grossRevenue = normalizeMoney(sales.reduce((sum, sale) => sum + sale.total_revenue, 0));
  const cogs = normalizeMoney(sales.reduce((sum, sale) => sum + sale.total_cogs, 0));
  const realizedProfit = normalizeMoney(grossRevenue - cogs);

  return {
    in_stock_units: inStockUnits,
    inventory_cost_basis: inventoryCostBasis,
    inventory_market_value: inventoryMarketValue,
    gross_revenue: grossRevenue,
    cogs,
    realized_profit: realizedProfit,
    orders_count: sales.length,
  };
}

export function useCollectionsStore() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const syncState = useSyncExternalStore(subscribe, getRemoteSyncSnapshot, getRemoteSyncSnapshot);

  useEffect(() => {
    void hydrateRemoteIntoStore(true);

    if (!isBrowser()) return;

    const onFocus = () => {
      void hydrateRemoteIntoStore(true);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void hydrateRemoteIntoStore(true);
      }
    };

    const interval = window.setInterval(() => {
      void hydrateRemoteIntoStore();
    }, REMOTE_HYDRATE_POLL_MS);

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const safeState = ensureActiveCollection(state);
  const activeCollection =
    safeState.collections.find((c) => c.id === safeState.activeCollectionId) || safeState.collections[0];
  const activeItems = getCollectionItems(safeState, activeCollection.id);
  const activeSales = getCollectionSales(safeState, activeCollection.id);

  return {
    syncState,
    state: safeState,
    collections: safeState.collections,
    activeCollection,
    activeItems,
    activeSales,
    summary: getSummary(activeItems),
    allSummary: getSummary(safeState.items),
    posSummary: getPosSummary(activeItems, activeSales),
    auditLogs: safeState.audit_logs,
    createCollection,
    setActiveCollection,
    deleteCollection,
    addItem,
    updateItem,
    removeItem,
    checkoutSale,
  };
}
