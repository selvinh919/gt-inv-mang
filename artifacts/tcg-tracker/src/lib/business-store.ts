import { useEffect, useSyncExternalStore } from "react";
import type { CollectionCardItem, SaleRecord } from "@/lib/collections-store";
import { getApiBaseUrl, getStoredAuthToken } from "@/lib/auth-session";

export type UserRole = "owner" | "manager" | "clerk";
export type PaymentStatus = "paid" | "unpaid" | "partial" | "refunded";

export type AuthUser = {
  id: number;
  name: string;
  email: string;
  password: string;
  external_sub?: string | null;
  role: UserRole;
  active: boolean;
  created_at: string;
};

export type AuthSession = {
  user_id: number;
  name: string;
  email: string;
  role: UserRole;
  signed_in_at: string;
};

export type TaxConfig = {
  rate_percent: number;
};

export type CustomerProfile = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  tax_exempt: boolean;
  notes: string | null;
  created_at: string;
};

export type ReceiptRecord = {
  id: number;
  sale_id: number;
  receipt_number: string;
  customer_id: number | null;
  customer_name: string | null;
  payment_status: PaymentStatus;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  balance_due: number;
  issued_at: string;
};

export type PurchaseOrderLine = {
  id: number;
  quantity: number;
  received_quantity: number;
  unit_cost: number;
  item_template: {
    card_id: number;
    card_name: string;
    set_name: string | null;
    game_name: string | null;
    rarity: string | null;
    printing: string;
    market_price: number | null;
    low_price: number | null;
    image_url: string | null;
  };
};

export type PurchaseOrder = {
  id: number;
  collection_id: number;
  supplier_name: string;
  status: "draft" | "ordered" | "partially_received" | "received" | "canceled";
  lines: PurchaseOrderLine[];
  created_at: string;
  ordered_at: string | null;
  received_at: string | null;
  notes: string | null;
};

type BusinessState = {
  version: 1;
  nextUserId: number;
  nextCustomerId: number;
  nextReceiptId: number;
  nextPurchaseOrderId: number;
  users: AuthUser[];
  session: AuthSession | null;
  tax: TaxConfig;
  customers: CustomerProfile[];
  receipts: ReceiptRecord[];
  purchase_orders: PurchaseOrder[];
};

const STORAGE_KEY = "cardsync.business.v1";

const listeners = new Set<() => void>();
let currentState: BusinessState | null = null;
let lastServerSyncAt = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function money(value: number): number {
  return Number(value.toFixed(2));
}

function defaultState(): BusinessState {
  return {
    version: 1,
    nextUserId: 2,
    nextCustomerId: 1,
    nextReceiptId: 1,
    nextPurchaseOrderId: 1,
    users: [
      {
        id: 1,
        name: "Owner",
        email: "owner@vault.local",
        password: "admin123",
        role: "owner",
        active: true,
        created_at: nowIso(),
      },
    ],
    session: null,
    tax: { rate_percent: 8.25 },
    customers: [],
    receipts: [],
    purchase_orders: [],
  };
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function loadState(): BusinessState {
  if (!isBrowser()) return defaultState();

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = defaultState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<BusinessState>;
    if (!parsed || parsed.version !== 1) return defaultState();

    return {
      version: 1,
      nextUserId: Number(parsed.nextUserId || 2),
      nextCustomerId: Number(parsed.nextCustomerId || 1),
      nextReceiptId: Number(parsed.nextReceiptId || 1),
      nextPurchaseOrderId: Number(parsed.nextPurchaseOrderId || 1),
      users: Array.isArray(parsed.users) ? parsed.users : defaultState().users,
      session: parsed.session ?? null,
      tax: parsed.tax ?? { rate_percent: 8.25 },
      customers: Array.isArray(parsed.customers) ? parsed.customers : [],
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
      purchase_orders: Array.isArray(parsed.purchase_orders) ? parsed.purchase_orders : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: BusinessState): void {
  currentState = state;
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  listeners.forEach((listener) => listener());
}

function getSnapshot(): BusinessState {
  if (currentState) return currentState;
  currentState = loadState();
  return currentState;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function posRequest(path: string, init?: RequestInit): Promise<unknown> {
  const token = getStoredAuthToken();
  if (!token) throw new Error("Authentication required");
  const response = await fetch(`${getApiBaseUrl()}/api/pos/${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Server request failed");
  return payload;
}

async function hydrateBusinessState(force = false): Promise<void> {
  if (!getStoredAuthToken() || (!force && Date.now() - lastServerSyncAt < 30_000)) return;
  const [customers, settings, sales] = await Promise.all([
    posRequest("customers"), posRequest("settings"), posRequest("sales"),
  ]);
  const state = getSnapshot();
  const serverSales = Array.isArray(sales) ? sales : [];
  const receipts: ReceiptRecord[] = serverSales.map((sale: any) => ({
    id: Number(sale.id), sale_id: Number(sale.id), receipt_number: String(sale.receipt_number),
    customer_id: sale.customer_id == null ? null : Number(sale.customer_id), customer_name: null,
    payment_status: sale.payment_status as PaymentStatus, subtotal: Number(sale.subtotal), tax: Number(sale.tax),
    total: Number(sale.total), amount_paid: Number(sale.amount_paid), balance_due: Math.max(0, Number(sale.total) - Number(sale.amount_paid)),
    issued_at: String(sale.created_at),
  }));
  lastServerSyncAt = Date.now();
  saveState({
    ...state,
    customers: Array.isArray(customers) ? customers as CustomerProfile[] : state.customers,
    tax: { rate_percent: Number((settings as any)?.tax_rate ?? state.tax.rate_percent) },
    receipts,
  });
}

function requireSession(): AuthSession {
  const state = getSnapshot();
  if (!state.session) throw new Error("You must be signed in");
  return state.session;
}

function hasRole(role: UserRole, allowed: UserRole[]): boolean {
  return allowed.includes(role);
}

function ensureRole(allowed: UserRole[]): void {
  const session = requireSession();
  if (!hasRole(session.role, allowed)) {
    throw new Error("You do not have permission for this action");
  }
}

function signIn(email: string, password: string): AuthSession {
  const state = getSnapshot();
  const user = state.users.find(
    (candidate) =>
      candidate.active &&
      candidate.email.toLowerCase() === email.trim().toLowerCase() &&
      candidate.password === password,
  );

  if (!user) throw new Error("Invalid email or password");

  const session: AuthSession = {
    user_id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    signed_in_at: nowIso(),
  };

  saveState({ ...state, session });
  return session;
}

function registerUser(input: {
  name: string;
  email: string;
  password: string;
  role?: UserRole;
}): AuthSession {
  const state = getSnapshot();

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const password = input.password.trim();

  if (!name || !email || !password) {
    throw new Error("Name, email, and password are required");
  }

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const existing = state.users.find((user) => user.email.toLowerCase() === email);
  if (existing && !existing.active) {
    throw new Error("This user account is disabled");
  }

  const role: UserRole = input.role ?? "clerk";

  if (existing?.password?.trim()) {
    throw new Error("A user with this email already exists");
  }

  const users = existing
    ? state.users.map((user) => {
        if (user.id !== existing.id) return user;
        return {
          ...user,
          name,
          password,
          role,
        };
      })
    : [
        {
          id: state.nextUserId,
          name,
          email,
          password,
          external_sub: null,
          role,
          active: true,
          created_at: nowIso(),
        },
        ...state.users,
      ];

  const resolvedUser = existing
    ? users.find((user) => user.id === existing.id) || existing
    : users[0];

  const session: AuthSession = {
    user_id: resolvedUser.id,
    name: resolvedUser.name,
    email: resolvedUser.email,
    role: resolvedUser.role,
    signed_in_at: nowIso(),
  };

  saveState({
    ...state,
    users,
    nextUserId: existing ? state.nextUserId : state.nextUserId + 1,
    session,
  });

  return session;
}

function signInFromExternal(input: {
  email: string;
  name: string;
  external_sub?: string | null;
  adminEmails?: string[];
  role?: UserRole;
}): AuthSession {
  const state = getSnapshot();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim() || email;
  if (!email) throw new Error("Email is required");

  const adminEmails = (input.adminEmails || []).map((item) => item.trim().toLowerCase()).filter(Boolean);
  const defaultRole: UserRole = input.role ?? (adminEmails.includes(email) ? "owner" : "clerk");

  const existing = state.users.find((user) => user.email.toLowerCase() === email);

  if (existing && !existing.active) {
    throw new Error("This user account is disabled");
  }

  const user = existing ?? {
    id: state.nextUserId,
    name,
    email,
    password: "",
    external_sub: input.external_sub ?? null,
    role: defaultRole,
    active: true,
    created_at: nowIso(),
  };

  const users = existing
    ? state.users.map((candidate) => {
        if (candidate.id !== existing.id) return candidate;
        return {
          ...candidate,
          name,
          external_sub: input.external_sub ?? candidate.external_sub ?? null,
          role: input.role ?? (adminEmails.includes(email) ? "owner" : candidate.role),
        };
      })
    : [user, ...state.users];

  const resolvedUser = existing
    ? users.find((candidate) => candidate.id === existing.id) || existing
    : user;

  const session: AuthSession = {
    user_id: resolvedUser.id,
    name: resolvedUser.name,
    email: resolvedUser.email,
    role: resolvedUser.role,
    signed_in_at: nowIso(),
  };

  saveState({
    ...state,
    users,
    nextUserId: existing ? state.nextUserId : state.nextUserId + 1,
    session,
  });

  return session;
}

function signOut(): void {
  const state = getSnapshot();
  saveState({ ...state, session: null });
}

function resetPassword(email: string, newPassword: string): void {
  const state = getSnapshot();
  const normalizedEmail = email.trim().toLowerCase();
  const trimmedPassword = newPassword.trim();

  if (!normalizedEmail || !trimmedPassword) {
    throw new Error("Email and new password are required");
  }

  if (trimmedPassword.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const user = state.users.find((candidate) => candidate.email.toLowerCase() === normalizedEmail);
  if (!user || !user.active) {
    throw new Error("No active account found for this email");
  }

  const users = state.users.map((candidate) =>
    candidate.id === user.id
      ? {
          ...candidate,
          password: trimmedPassword,
        }
      : candidate,
  );

  saveState({ ...state, users });
}

function createUser(input: { name: string; email: string; password?: string; role: UserRole }): AuthUser {
  ensureRole(["owner"]);
  const state = getSnapshot();

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !email) {
    throw new Error("Name and email are required");
  }

  if (state.users.some((user) => user.email.toLowerCase() === email)) {
    throw new Error("A user with this email already exists");
  }

  const user: AuthUser = {
    id: state.nextUserId,
    name,
    email,
    password: input.password?.trim() || "",
    external_sub: null,
    role: input.role,
    active: true,
    created_at: nowIso(),
  };

  saveState({
    ...state,
    nextUserId: state.nextUserId + 1,
    users: [user, ...state.users],
  });

  return user;
}

function updateUserRole(userId: number, role: UserRole): void {
  ensureRole(["owner"]);
  const state = getSnapshot();
  const users = state.users.map((user) => (user.id === userId ? { ...user, role } : user));

  const session = state.session && state.session.user_id === userId
    ? { ...state.session, role }
    : state.session;

  saveState({ ...state, users, session });
}

function setTaxConfig(ratePercent: number): void {
  ensureRole(["owner", "manager"]);
  const state = getSnapshot();
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 30) {
    throw new Error("Tax rate must be between 0 and 30");
  }

  saveState({
    ...state,
    tax: { rate_percent: money(ratePercent) },
  });
  void posRequest("settings", { method: "PATCH", body: JSON.stringify({ tax_rate: ratePercent }) })
    .catch((error) => console.warn("Server tax update failed", error));
}

async function createCustomer(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
  tax_exempt?: boolean;
  notes?: string | null;
}): Promise<CustomerProfile> {
  ensureRole(["owner", "manager", "clerk"]);
  const state = getSnapshot();
  const name = input.name.trim();
  if (!name) throw new Error("Customer name is required");

  const customer = await posRequest("customers", { method: "POST", body: JSON.stringify(input) }) as CustomerProfile;

  saveState({
    ...state,
    nextCustomerId: Math.max(state.nextCustomerId, Number(customer.id) + 1),
    customers: [customer, ...state.customers],
  });
  return customer;
}

function issueReceipt(input: {
  sale: SaleRecord;
  customer_id?: number | null;
  payment_status: PaymentStatus;
  amount_paid: number;
}): ReceiptRecord {
  ensureRole(["owner", "manager", "clerk"]);
  const state = getSnapshot();

  const customer = input.customer_id
    ? state.customers.find((item) => item.id === input.customer_id)
    : null;

  const customerTaxExempt = Boolean(customer?.tax_exempt);
  const subtotal = money(input.sale.total_revenue);
  const tax = customerTaxExempt ? 0 : money(subtotal * (state.tax.rate_percent / 100));
  const total = money(subtotal + tax);
  const amountPaid = money(Math.max(0, input.amount_paid));
  const balanceDue = money(Math.max(0, total - amountPaid));

  const paymentStatus: PaymentStatus =
    input.payment_status === "partial"
      ? (amountPaid >= total ? "paid" : "partial")
      : input.payment_status;

  const receipt: ReceiptRecord = {
    id: state.nextReceiptId,
    sale_id: input.sale.id,
    receipt_number: `R-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(state.nextReceiptId).padStart(4, "0")}`,
    customer_id: customer?.id ?? null,
    customer_name: customer?.name ?? null,
    payment_status: paymentStatus,
    subtotal,
    tax,
    total,
    amount_paid: amountPaid,
    balance_due: paymentStatus === "unpaid" ? total : balanceDue,
    issued_at: nowIso(),
  };

  saveState({
    ...state,
    nextReceiptId: state.nextReceiptId + 1,
    receipts: [receipt, ...state.receipts],
  });

  return receipt;
}

function createPurchaseOrder(input: {
  collection_id: number;
  supplier_name: string;
  notes?: string | null;
  lines: Array<{
    quantity: number;
    unit_cost: number;
    item_template: PurchaseOrderLine["item_template"];
  }>;
}): PurchaseOrder {
  ensureRole(["owner", "manager"]);
  const state = getSnapshot();

  const supplierName = input.supplier_name.trim();
  if (!supplierName) throw new Error("Supplier name is required");
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error("At least one purchase-order line is required");
  }

  const lines: PurchaseOrderLine[] = input.lines.map((line, index) => ({
    id: index + 1,
    quantity: Math.max(1, Math.floor(line.quantity)),
    received_quantity: 0,
    unit_cost: money(Math.max(0, line.unit_cost)),
    item_template: line.item_template,
  }));

  const po: PurchaseOrder = {
    id: state.nextPurchaseOrderId,
    collection_id: input.collection_id,
    supplier_name: supplierName,
    status: "ordered",
    lines,
    created_at: nowIso(),
    ordered_at: nowIso(),
    received_at: null,
    notes: input.notes?.trim() || null,
  };

  saveState({
    ...state,
    nextPurchaseOrderId: state.nextPurchaseOrderId + 1,
    purchase_orders: [po, ...state.purchase_orders],
  });

  return po;
}

function receivePurchaseOrder(
  purchaseOrderId: number,
  receiveLines: Array<{ line_id: number; quantity: number }>,
  addItem: (input: {
    collection_id: number;
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
    market_price_at_add?: number | null;
  }) => unknown,
): PurchaseOrder {
  ensureRole(["owner", "manager"]);
  const state = getSnapshot();

  const po = state.purchase_orders.find((order) => order.id === purchaseOrderId);
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "received" || po.status === "canceled") {
    throw new Error("Purchase order cannot be received in current state");
  }

  const updates = new Map(receiveLines.map((line) => [line.line_id, Math.max(0, Math.floor(line.quantity))]));

  const nextLines = po.lines.map((line) => {
    const requestQty = updates.get(line.id) ?? 0;
    const remaining = line.quantity - line.received_quantity;
    const accepted = Math.min(remaining, requestQty);

    if (accepted > 0) {
      addItem({
        collection_id: po.collection_id,
        card_id: line.item_template.card_id,
        card_name: line.item_template.card_name,
        set_name: line.item_template.set_name,
        game_name: line.item_template.game_name,
        rarity: line.item_template.rarity,
        printing: line.item_template.printing,
        market_price: line.item_template.market_price,
        low_price: line.item_template.low_price,
        image_url: line.item_template.image_url,
        quantity: accepted,
        price_paid: line.unit_cost,
        price_paid_input_type: "amount",
        price_paid_percent: null,
        market_price_at_add: line.item_template.market_price,
      });
    }

    return {
      ...line,
      received_quantity: line.received_quantity + accepted,
    };
  });

  const totalOrdered = nextLines.reduce((sum, line) => sum + line.quantity, 0);
  const totalReceived = nextLines.reduce((sum, line) => sum + line.received_quantity, 0);

  const status: PurchaseOrder["status"] =
    totalReceived === 0
      ? "ordered"
      : totalReceived >= totalOrdered
        ? "received"
        : "partially_received";

  const updatedPo: PurchaseOrder = {
    ...po,
    lines: nextLines,
    status,
    received_at: status === "received" ? nowIso() : po.received_at,
  };

  saveState({
    ...state,
    purchase_orders: state.purchase_orders.map((order) => (order.id === po.id ? updatedPo : order)),
  });

  return updatedPo;
}

export function useBusinessStore() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void hydrateBusinessState().catch((error) => console.warn("Server business sync failed", error));
  }, []);

  return {
    state,
    session: state.session,
    users: state.users,
    tax: state.tax,
    customers: state.customers,
    receipts: state.receipts,
    purchaseOrders: state.purchase_orders,
    signIn,
    registerUser,
    resetPassword,
    signInFromExternal,
    signOut,
    createUser,
    updateUserRole,
    setTaxConfig,
    createCustomer,
    issueReceipt,
    createPurchaseOrder,
    receivePurchaseOrder,
    refreshBusiness: () => hydrateBusinessState(true),
    can(permission: "manage_users" | "manage_tax" | "manage_po" | "checkout") {
      const role = state.session?.role;
      if (!role) return false;

      if (permission === "checkout") return hasRole(role, ["owner", "manager", "clerk"]);
      if (permission === "manage_po") return hasRole(role, ["owner", "manager"]);
      if (permission === "manage_tax") return hasRole(role, ["owner", "manager"]);
      if (permission === "manage_users") return hasRole(role, ["owner"]);
      return false;
    },
  };
}
