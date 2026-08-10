import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { useCollectionsStore } from "@/lib/collections-store";
import { useBusinessStore, type PaymentStatus } from "@/lib/business-store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Minus, Plus, ShoppingCart, CreditCard, DollarSign, TrendingUp, Package } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getStoredAuthToken } from "@/lib/auth-session";

type CartLine = {
  item_id: number;
  quantity: number;
  unit_price: number;
};

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

function money(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value ?? 0);
}

function apiBaseUrl(): string {
  const cardsyncBase = import.meta.env.VITE_CARDSYNC_API_BASE_URL?.trim() ?? "";
  const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
  const base = cardsyncBase || configuredBase || "https://cardsync-api.vercel.app";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `checkout-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export default function PosPage() {
  const {
    activeCollection,
    activeItems,
    activeSales,
    posSummary,
    applyServerSale,
    refreshRemote,
    addItem,
  } = useCollectionsStore();

  const {
    customers,
    tax,
    receipts,
    purchaseOrders,
    createCustomer,
    refreshBusiness,
    createPurchaseOrder,
    receivePurchaseOrder,
    can,
  } = useBusinessStore();

  const { toast } = useToast();

  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<number, CartLine>>({});
  const [notes, setNotes] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("none");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("paid");
  const [amountPaidInput, setAmountPaidInput] = useState("");

  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  const [poSupplier, setPoSupplier] = useState("");
  const [poItemId, setPoItemId] = useState("");
  const [poQty, setPoQty] = useState("1");
  const [poUnitCost, setPoUnitCost] = useState("0");
  const [stripeLoading, setStripeLoading] = useState(false);
  const queryInputRef = useRef<HTMLInputElement>(null);

  useBarcodeScanner(true, (barcode) => {
    setQuery(barcode);
    window.setTimeout(() => {
      queryInputRef.current?.focus();
      queryInputRef.current?.select();
    }, 0);
  });

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = activeItems.filter((item) => item.quantity > 0);
    if (!needle) return list;

    return list.filter((item) => {
      return (
        item.card_name.toLowerCase().includes(needle) ||
        (item.set_name ?? "").toLowerCase().includes(needle) ||
        item.sku.toLowerCase().includes(needle) ||
        (item.barcode ?? "").toLowerCase().includes(needle)
      );
    });
  }, [activeItems, query]);

  const cartLines = Object.values(cart).filter((line) => line.quantity > 0);
  const cartTotal = cartLines.reduce((sum, line) => sum + line.unit_price * line.quantity, 0);
  const selectedCustomer = selectedCustomerId === "none"
    ? null
    : customers.find((customer) => customer.id === Number(selectedCustomerId)) ?? null;
  const taxAmount = selectedCustomer?.tax_exempt
    ? 0
    : Number((cartTotal * (tax.rate_percent / 100)).toFixed(2));
  const checkoutTotal = Number((cartTotal + taxAmount).toFixed(2));

  const addToCart = (itemId: number, defaultPrice: number) => {
    setCart((current) => {
      const existing = current[itemId];
      if (existing) {
        return {
          ...current,
          [itemId]: {
            ...existing,
            quantity: existing.quantity + 1,
          },
        };
      }

      return {
        ...current,
        [itemId]: {
          item_id: itemId,
          quantity: 1,
          unit_price: defaultPrice,
        },
      };
    });
  };

  const updateQty = (itemId: number, qty: number) => {
    setCart((current) => {
      const line = current[itemId];
      if (!line) return current;
      if (qty <= 0) {
        const next = { ...current };
        delete next[itemId];
        return next;
      }
      return { ...current, [itemId]: { ...line, quantity: qty } };
    });
  };

  const updateUnitPrice = (itemId: number, value: string) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < 0) return;
    setCart((current) => {
      const line = current[itemId];
      if (!line) return current;
      return { ...current, [itemId]: { ...line, unit_price: parsed } };
    });
  };

  const runCheckout = async () => {
    if (!can("checkout")) {
      toast({
        title: "Permission denied",
        description: "Your role cannot perform checkout.",
        variant: "destructive",
      });
      return;
    }

    try {
      const parsedAmount = Number(amountPaidInput);
      const amountPaid = Number.isFinite(parsedAmount)
        ? Math.max(0, parsedAmount)
        : paymentStatus === "paid"
          ? checkoutTotal
          : 0;

      const token = getStoredAuthToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      const response = await fetch(`${apiBaseUrl()}/api/pos/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          collection_id: activeCollection.id,
          lines: cartLines,
          notes: notes || null,
          customer_id: selectedCustomer?.id ?? null,
          payment_status: paymentStatus,
          amount_paid: amountPaid,
          idempotency_key: makeIdempotencyKey(),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Checkout failed");
      const sale = {
        id: Number(payload.id), collection_id: Number(payload.collection_id), sold_at: String(payload.created_at),
        notes: payload.notes ?? null, total_revenue: Number(payload.subtotal), total_cogs: Number(payload.total_cogs),
        total_profit: Number(payload.total_profit), lines: payload.lines,
      };
      applyServerSale(sale);
      await refreshRemote();
      await refreshBusiness();

      setCart({});
      setNotes("");
      setAmountPaidInput("");
      toast({
        title: "Sale completed",
        description: `Receipt ${String(payload.receipt_number)} created for ${money(Number(payload.total))}.`,
      });
    } catch (error) {
      toast({
        title: "Checkout failed",
        description: error instanceof Error ? error.message : "Unknown checkout error",
        variant: "destructive",
      });
    }
  };

  const addCustomer = async () => {
    try {
      const customer = await createCustomer({
        name: newCustomerName,
        email: newCustomerEmail,
        phone: newCustomerPhone,
      });
      setSelectedCustomerId(String(customer.id));
      setNewCustomerName("");
      setNewCustomerEmail("");
      setNewCustomerPhone("");
      toast({ title: "Customer created", description: `${customer.name} added.` });
    } catch (error) {
      toast({
        title: "Could not create customer",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const addPurchaseOrder = () => {
    if (!can("manage_po")) {
      toast({
        title: "Permission denied",
        description: "Your role cannot create purchase orders.",
        variant: "destructive",
      });
      return;
    }

    const sourceItem = activeItems.find((item) => item.id === Number(poItemId));
    if (!sourceItem) {
      toast({
        title: "Missing inventory selection",
        description: "Choose an inventory item for this purchase order.",
        variant: "destructive",
      });
      return;
    }

    try {
      const quantity = Math.max(1, Math.floor(Number(poQty)));
      const unitCost = Math.max(0, Number(poUnitCost));
      const po = createPurchaseOrder({
        collection_id: activeCollection.id,
        supplier_name: poSupplier,
        lines: [
          {
            quantity,
            unit_cost: unitCost,
            item_template: {
              card_id: sourceItem.card_id,
              card_name: sourceItem.card_name,
              set_name: sourceItem.set_name,
              game_name: sourceItem.game_name,
              rarity: sourceItem.rarity,
              printing: sourceItem.printing,
              market_price: sourceItem.market_price,
              low_price: sourceItem.low_price,
              image_url: sourceItem.image_url,
            },
          },
        ],
      });

      setPoSupplier("");
      setPoItemId("");
      setPoQty("1");
      setPoUnitCost("0");
      toast({ title: "Purchase order created", description: `PO #${po.id} created.` });
    } catch (error) {
      toast({
        title: "Could not create purchase order",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const receivePurchaseOrderNow = (purchaseOrderId: number) => {
    try {
      const target = purchaseOrders.find((order) => order.id === purchaseOrderId);
      if (!target) return;

      const receiveLines = target.lines.map((line) => ({
        line_id: line.id,
        quantity: line.quantity - line.received_quantity,
      }));

      const updated = receivePurchaseOrder(purchaseOrderId, receiveLines, addItem);
      toast({
        title: "PO received",
        description: `PO #${updated.id} is now ${updated.status.replace("_", " ")}.`,
      });
    } catch (error) {
      toast({
        title: "Could not receive PO",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const launchStripeCheckout = async () => {
    if (cartLines.length === 0) {
      toast({ title: "Cart is empty", description: "Add items before Stripe checkout.", variant: "destructive" });
      return;
    }

    setStripeLoading(true);
    try {
      const idempotencyKey = makeIdempotencyKey();
      const token = getStoredAuthToken();
      if (!token) throw new Error("Your session expired. Sign in again.");

      const response = await fetch(`${apiBaseUrl()}/api/payments/create-checkout-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          collection_id: activeCollection.id,
          lines: cartLines.map(({ item_id, quantity }) => ({ item_id, quantity })),
          customer_id: selectedCustomer?.id ?? null,
          notes: notes || null,
          customer_email: selectedCustomer?.email ?? null,
          idempotency_key: idempotencyKey,
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Stripe session error (${response.status})`);
      }

      const payload = (await response.json()) as { url?: string };
      if (!payload.url) {
        throw new Error("Stripe session URL was not returned");
      }

      window.location.href = payload.url;
    } catch (error) {
      toast({
        title: "Stripe checkout failed",
        description: error instanceof Error ? error.message : "Unknown Stripe checkout error",
        variant: "destructive",
      });
    } finally {
      setStripeLoading(false);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">POS Terminal</h1>
          <p className="text-muted-foreground mt-2">Sell from {activeCollection.name} inventory and track realized profit.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><Package className="h-4 w-4" /> In Stock Units</CardTitle>
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{posSummary.in_stock_units}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><DollarSign className="h-4 w-4" /> Revenue</CardTitle>
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{money(posSummary.gross_revenue)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><CreditCard className="h-4 w-4" /> COGS</CardTitle>
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{money(posSummary.cogs)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Realized Profit</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${posSummary.realized_profit >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                {money(posSummary.realized_profit)}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Inventory Catalog</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  ref={queryInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, set, SKU, or barcode..."
                />
                <div className="space-y-3 max-h-[520px] overflow-auto pr-1">
                  {filteredItems.map((item) => (
                    <div key={item.id} className="p-3 rounded-lg border border-border bg-card flex items-center gap-3">
                      <div className="h-16 w-12 rounded overflow-hidden bg-muted shrink-0">
                        {item.image_url ? (
                          <img src={item.image_url} alt={item.card_name} className="h-full w-full object-cover" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{item.card_name}</div>
                        <div className="text-xs text-muted-foreground truncate">{item.set_name} • {item.sku}</div>
                        {item.barcode ? (
                          <div className="text-xs text-muted-foreground truncate">Barcode: {item.barcode}</div>
                        ) : null}
                        <div className="text-sm mt-1">Stock: <strong>{item.quantity}</strong> • Market: {money(item.market_price)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{item.printing}</Badge>
                        <Button onClick={() => addToCart(item.id, Number(item.market_price ?? 0))}>
                          <ShoppingCart className="h-4 w-4 mr-2" />
                          Add
                        </Button>
                      </div>
                    </div>
                  ))}
                  {filteredItems.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-10 border border-dashed rounded-lg">
                      No in-stock inventory found.
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Current Sale</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {cartLines.length === 0 ? (
                  <div className="text-sm text-muted-foreground">Add inventory items to start checkout.</div>
                ) : (
                  cartLines.map((line) => {
                    const item = activeItems.find((it) => it.id === line.item_id);
                    if (!item) return null;
                    return (
                      <div key={line.item_id} className="border rounded-lg p-3 space-y-2">
                        <div className="text-sm font-semibold truncate">{item.card_name}</div>
                        <div className="text-xs text-muted-foreground">{item.sku}</div>
                        <div className="flex items-center gap-1">
                          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => updateQty(line.item_id, line.quantity - 1)}>
                            <Minus className="h-3 w-3" />
                          </Button>
                          <span className="w-6 text-center text-sm">{line.quantity}</span>
                          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => updateQty(line.item_id, Math.min(item.quantity, line.quantity + 1))}>
                            <Plus className="h-3 w-3" />
                          </Button>
                          <Input
                            className="h-8 ml-2"
                            type="number"
                            min="0"
                            step="0.01"
                            value={String(line.unit_price)}
                            onChange={(e) => updateUnitPrice(line.item_id, e.target.value)}
                          />
                        </div>
                        <div className="text-sm text-right">Line Total: {money(line.unit_price * line.quantity)}</div>
                      </div>
                    );
                  })
                )}

                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional order notes"
                />

                <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Assign customer (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Walk-in customer</SelectItem>
                    {customers.map((customer) => (
                      <SelectItem key={customer.id} value={String(customer.id)}>
                        {customer.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={paymentStatus} onValueChange={(value) => setPaymentStatus(value as PaymentStatus)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Payment status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="partial">Partial</SelectItem>
                    <SelectItem value="unpaid">Unpaid</SelectItem>
                    <SelectItem value="refunded">Refunded</SelectItem>
                  </SelectContent>
                </Select>

                <Input
                  value={amountPaidInput}
                  onChange={(e) => setAmountPaidInput(e.target.value)}
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Amount paid (optional)"
                />

                <div className="rounded-lg border border-border p-3 text-sm space-y-1 bg-muted/20">
                  <div className="flex items-center justify-between"><span>Subtotal</span><span>{money(cartTotal)}</span></div>
                  <div className="flex items-center justify-between"><span>Tax ({tax.rate_percent}%)</span><span>{money(taxAmount)}</span></div>
                  <div className="flex items-center justify-between font-semibold"><span>Total</span><span>{money(checkoutTotal)}</span></div>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span>Total</span>
                  <strong>{money(checkoutTotal)}</strong>
                </div>
                <Button className="w-full" disabled={cartLines.length === 0 || !can("checkout")} onClick={() => void runCheckout()}>
                  Complete Checkout
                </Button>
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={cartLines.length === 0 || stripeLoading}
                  onClick={launchStripeCheckout}
                >
                  {stripeLoading ? "Redirecting to Stripe..." : "Pay with Stripe"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Sales</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 max-h-[300px] overflow-auto">
                {activeSales.slice(0, 8).map((sale) => (
                  <div key={sale.id} className="text-sm border rounded-lg p-3">
                    <div className="flex justify-between">
                      <span>Order #{sale.id}</span>
                      <span className="font-semibold">{money(sale.total_revenue)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">Profit: {money(sale.total_profit)}</div>
                  </div>
                ))}
                {activeSales.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No sales recorded yet.</div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Receipts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[260px] overflow-auto">
                {receipts.slice(0, 8).map((receipt) => (
                  <div key={receipt.id} className="border rounded-lg p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{receipt.receipt_number}</span>
                      <span>{money(receipt.total)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {receipt.customer_name ?? "Walk-in"} • {receipt.payment_status.toUpperCase()}
                    </div>
                  </div>
                ))}
                {receipts.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No receipts yet.</div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Customer Profiles</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Input value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} placeholder="Customer name" />
                <Input value={newCustomerEmail} onChange={(e) => setNewCustomerEmail(e.target.value)} placeholder="Email (optional)" />
                <Input value={newCustomerPhone} onChange={(e) => setNewCustomerPhone(e.target.value)} placeholder="Phone (optional)" />
              </div>
                <Button onClick={() => void addCustomer()}>Add Customer</Button>

              <div className="space-y-2 max-h-52 overflow-auto">
                {customers.map((customer) => (
                  <div key={customer.id} className="border rounded-lg p-2 text-sm">
                    <div className="font-semibold">{customer.name}</div>
                    <div className="text-xs text-muted-foreground">{customer.email ?? "No email"} • {customer.phone ?? "No phone"}</div>
                  </div>
                ))}
                {customers.length === 0 ? <div className="text-sm text-muted-foreground">No customers yet.</div> : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Purchase Orders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <Input value={poSupplier} onChange={(e) => setPoSupplier(e.target.value)} placeholder="Supplier" disabled={!can("manage_po")} />
                <Select value={poItemId} onValueChange={setPoItemId} disabled={!can("manage_po")}>
                  <SelectTrigger><SelectValue placeholder="Inventory item" /></SelectTrigger>
                  <SelectContent>
                    {activeItems.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>{item.card_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input type="number" min="1" value={poQty} onChange={(e) => setPoQty(e.target.value)} placeholder="Qty" disabled={!can("manage_po")} />
                <Input type="number" min="0" step="0.01" value={poUnitCost} onChange={(e) => setPoUnitCost(e.target.value)} placeholder="Unit cost" disabled={!can("manage_po")} />
              </div>
              <Button onClick={addPurchaseOrder} disabled={!can("manage_po")}>Create Purchase Order</Button>

              <div className="space-y-2 max-h-52 overflow-auto">
                {purchaseOrders.slice(0, 10).map((order) => (
                  <div key={order.id} className="border rounded-lg p-2 text-sm space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">PO #{order.id} • {order.supplier_name}</div>
                      <Badge variant="outline">{order.status.replace("_", " ")}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {order.lines.reduce((sum, line) => sum + line.received_quantity, 0)} / {order.lines.reduce((sum, line) => sum + line.quantity, 0)} received
                    </div>
                    <Button size="sm" variant="outline" onClick={() => receivePurchaseOrderNow(order.id)} disabled={!can("manage_po") || order.status === "received" || order.status === "canceled"}>
                      Receive Remaining
                    </Button>
                  </div>
                ))}
                {purchaseOrders.length === 0 ? <div className="text-sm text-muted-foreground">No purchase orders yet.</div> : null}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
