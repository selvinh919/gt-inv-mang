import { AppLayout } from "@/components/layout/app-layout";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search as SearchIcon, Minus, Plus, Trash2, ArrowUpDown, FolderPlus, Wallet, TrendingUp, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";
import { type CollectionCardItem, useCollectionsStore } from "@/lib/collections-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
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

export default function Collection() {
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState("value-desc");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [editingItem, setEditingItem] = useState<CollectionCardItem | null>(null);
  const [editForm, setEditForm] = useState({
    card_name: "",
    set_name: "",
    game_name: "",
    printing: "",
    sku: "",
    barcode: "",
    vendor_brand: "",
    product_category: "",
    image_url: "",
    quantity: "1",
    market_price: "",
    low_price: "",
    price_paid: "",
    notes: "",
  });
  const filterInputRef = useRef<HTMLInputElement>(null);

  const {
    collections,
    activeCollection,
    activeItems,
    summary,
    createCollection,
    setActiveCollection,
    deleteCollection,
    updateItem,
    removeItem,
  } = useCollectionsStore();
  const { toast } = useToast();

  useBarcodeScanner(true, (barcode) => {
    setFilter(barcode);
    window.setTimeout(() => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    }, 0);
  });

  const handleUpdateQuantity = (id: number, newQuantity: number) => {
    if (newQuantity < 1) return;
    updateItem(id, { quantity: newQuantity });
  };

  const handleUpdatePricePaid = (id: number, value: string) => {
    if (!value.trim()) {
      updateItem(id, { price_paid: null, price_paid_input_type: null, price_paid_percent: null });
      return;
    }

    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < 0) return;
    updateItem(id, { price_paid: parsed, price_paid_input_type: "amount", price_paid_percent: null });
  };

  const handleCreateCollection = () => {
    try {
      createCollection(newCollectionName);
      toast({ title: "Inventory created", description: `Now viewing ${newCollectionName.trim()}.` });
      setNewCollectionName("");
    } catch (error) {
      toast({
        title: "Could not create inventory",
        description: error instanceof Error ? error.message : "Please try a different name.",
        variant: "destructive",
      });
    }
  };

  const handleRemove = (id: number, name: string) => {
    removeItem(id);
    toast({
      title: "Removed from inventory",
      description: `${name} has been removed.`,
    });
  };

  const startEdit = (item: CollectionCardItem) => {
    setEditingItem(item);
    setEditForm({
      card_name: item.card_name,
      set_name: item.set_name ?? "",
      game_name: item.game_name ?? "",
      printing: item.printing,
      sku: item.sku,
      barcode: item.barcode ?? "",
      vendor_brand: item.vendor_brand ?? "",
      product_category: item.product_category ?? "",
      image_url: item.image_url ?? "",
      quantity: String(item.quantity),
      market_price: item.market_price == null ? "" : String(item.market_price),
      low_price: item.low_price == null ? "" : String(item.low_price),
      price_paid: item.price_paid == null ? "" : String(item.price_paid),
      notes: item.notes ?? "",
    });
  };

  const saveEdit = () => {
    if (!editingItem) return;

    const quantity = Math.max(1, Math.floor(Number(editForm.quantity) || 1));
    const marketPrice = editForm.market_price.trim() === "" ? null : Number(editForm.market_price);
    const lowPrice = editForm.low_price.trim() === "" ? null : Number(editForm.low_price);
    const pricePaid = editForm.price_paid.trim() === "" ? null : Number(editForm.price_paid);

    if (Number.isNaN(marketPrice as number) || Number.isNaN(lowPrice as number) || Number.isNaN(pricePaid as number)) {
      toast({ title: "Invalid numbers", description: "Please check price fields before saving.", variant: "destructive" });
      return;
    }

    updateItem(editingItem.id, {
      card_name: editForm.card_name,
      set_name: editForm.set_name.trim() || null,
      game_name: editForm.game_name.trim() || null,
      printing: editForm.printing,
      sku: editForm.sku,
      barcode: editForm.barcode.trim() || null,
      vendor_brand: editForm.vendor_brand.trim() || null,
      product_category: editForm.product_category.trim() || null,
      image_url: editForm.image_url.trim() || null,
      quantity,
      market_price: marketPrice,
      low_price: lowPrice,
      price_paid: pricePaid,
      price_paid_input_type: pricePaid == null ? null : "amount",
      price_paid_percent: null,
      notes: editForm.notes.trim() || null,
    });

    toast({ title: "Product updated", description: `${editForm.card_name} was updated.` });
    setEditingItem(null);
  };

  let filtered = [...activeItems];
  
  if (filter) {
    const needle = filter.toLowerCase();
    filtered = filtered.filter(item => 
      item.card_name.toLowerCase().includes(needle) || 
      (item.set_name && item.set_name.toLowerCase().includes(needle)) ||
      (item.game_name && item.game_name.toLowerCase().includes(needle)) ||
      item.sku.toLowerCase().includes(needle) ||
      (item.barcode && item.barcode.toLowerCase().includes(needle))
    );
  }

  filtered.sort((a, b) => {
    if (sortBy === "value-desc") {
      const valA = (a.market_price || 0) * a.quantity;
      const valB = (b.market_price || 0) * b.quantity;
      return valB - valA;
    }
    if (sortBy === "value-asc") {
      const valA = (a.market_price || 0) * a.quantity;
      const valB = (b.market_price || 0) * b.quantity;
      return valA - valB;
    }
    if (sortBy === "name-asc") {
      return a.card_name.localeCompare(b.card_name);
    }
    if (sortBy === "game") {
      const gameA = a.game_name || "";
      const gameB = b.game_name || "";
      return gameA.localeCompare(gameB);
    }
    if (sortBy === "pl-desc") {
      const plA = ((a.market_price || 0) - (a.price_paid || 0)) * a.quantity;
      const plB = ((b.market_price || 0) - (b.price_paid || 0)) * b.quantity;
      return plB - plA;
    }
    return 0;
  });

  return (
    <AppLayout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Inventory</h1>
            <p className="text-muted-foreground mt-2">Viewing {activeCollection.name} with {activeItems.length} unique cards.</p>
          </div>
          <Link href="/search">
            <Button size="lg" className="font-bold tracking-wide">Add Product</Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground mb-1">Market Value</div>
            <div className="text-2xl font-bold text-primary">{formatCurrency(summary.total_value)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Wallet className="h-3 w-3" /> Total Paid</div>
            <div className="text-2xl font-bold">{formatCurrency(summary.total_paid)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Unrealized P/L</div>
            <div className={`text-2xl font-bold ${summary.unrealized_pl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {formatCurrency(summary.unrealized_pl)}
            </div>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-3 p-4 bg-card border border-border rounded-xl shadow-sm">
          <div className="w-full lg:w-72">
            <Select value={String(activeCollection.id)} onValueChange={(value) => setActiveCollection(Number(value))}>
              <SelectTrigger>
                <SelectValue placeholder="Select inventory" />
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
          <div className="flex-1 flex gap-2">
            <Input
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              placeholder="Create a new inventory..."
            />
            <Button onClick={handleCreateCollection} disabled={!newCollectionName.trim()}>
              <FolderPlus className="h-4 w-4 mr-2" />
              Create
            </Button>
            {collections.length > 1 && (
              <Button
                variant="outline"
                onClick={() => deleteCollection(activeCollection.id)}
              >
                Delete
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 p-4 bg-card border border-border rounded-xl shadow-sm">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-3 h-5 w-5 text-muted-foreground" />
            <Input 
              ref={filterInputRef}
              placeholder="Filter by name, set, or game..." 
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-10 bg-background border-border"
            />
          </div>
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-full sm:w-[200px] bg-background border-border">
              <div className="flex items-center gap-2">
                <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
                <SelectValue placeholder="Sort by" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="value-desc">Highest Value</SelectItem>
              <SelectItem value="value-asc">Lowest Value</SelectItem>
              <SelectItem value="pl-desc">Best P/L</SelectItem>
              <SelectItem value="name-asc">Name (A-Z)</SelectItem>
              <SelectItem value="game">Game</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {filtered.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((item) => (
              <div key={item.id} className="flex flex-col sm:flex-row gap-4 p-4 rounded-xl border border-border bg-card shadow-sm hover-elevate transition-all group">
                <div className="w-full h-44 sm:w-20 sm:h-28 shrink-0 rounded-md overflow-hidden bg-muted relative">
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.card_name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-mono">No Img</div>
                  )}
                  {item.printing === "Foil" && (
                    <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/20 via-transparent to-transparent pointer-events-none" />
                  )}
                </div>
                
                <div className="flex flex-col flex-1 min-w-0 py-1">
                  <div className="flex justify-between items-start mb-1">
                    <h3 className="font-bold truncate pr-2" title={item.card_name}>{item.card_name}</h3>
                    <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={() => startEdit(item)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemove(item.id, item.card_name)}
                        disabled={false}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <div className="text-xs text-muted-foreground truncate mb-2">
                    {item.set_name} • {item.game_name}
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <div className="text-[11px] text-muted-foreground">Market</div>
                      <div className="font-mono text-sm">{formatCurrency(item.market_price || 0)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">Paid</div>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        defaultValue={item.price_paid ?? ""}
                        placeholder="0.00"
                        className="h-8 text-xs"
                        onBlur={(e) => handleUpdatePricePaid(item.id, e.target.value)}
                      />
                      {item.price_paid_input_type === "percent" && item.price_paid_percent != null && item.market_price_at_add != null && (
                        <div className="text-[10px] text-muted-foreground mt-1">
                          Cost basis: {item.price_paid_percent}% of {formatCurrency(item.market_price_at_add)} at add time.
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="mt-auto flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-sm uppercase tracking-wider font-mono font-bold ${item.printing === 'Foil' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' : 'bg-muted border border-border'}`}>
                        {item.printing}
                      </span>
                      <span className="font-mono text-sm text-primary font-bold">
                        {formatCurrency((item.market_price || 0) * item.quantity)}
                      </span>
                    </div>
                    
                    <div className="flex items-center gap-1 bg-background rounded-md border border-border p-0.5">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 rounded-sm hover:bg-muted"
                        onClick={() => handleUpdateQuantity(item.id, item.quantity - 1)}
                        disabled={item.quantity <= 1}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="font-mono w-6 text-center text-sm font-medium">{item.quantity}</span>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 rounded-sm hover:bg-muted"
                        onClick={() => handleUpdateQuantity(item.id, item.quantity + 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center p-16 border border-dashed rounded-xl text-muted-foreground bg-card/50">
            <div className="mx-auto w-16 h-16 mb-4 rounded-full bg-muted flex items-center justify-center">
              <SearchIcon className="h-8 w-8 opacity-50" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-1">No cards found</h3>
            <p className="mb-6">We couldn't find any cards matching your filter criteria.</p>
            {filter ? (
              <Button variant="outline" onClick={() => setFilter("")}>Clear Filters</Button>
            ) : (
              <Link href="/search">
                <Button>Add Product</Button>
              </Link>
            )}
          </div>
        )}
      </div>

      <Dialog open={editingItem !== null} onOpenChange={(open) => !open && setEditingItem(null)}>
        <DialogContent className="max-w-2xl bg-card border-border max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Product</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input value={editForm.card_name} onChange={(e) => setEditForm((prev) => ({ ...prev, card_name: e.target.value }))} placeholder="Product name" />
            <Input value={editForm.printing} onChange={(e) => setEditForm((prev) => ({ ...prev, printing: e.target.value }))} placeholder="Printing" />
            <Input value={editForm.set_name} onChange={(e) => setEditForm((prev) => ({ ...prev, set_name: e.target.value }))} placeholder="Set name" />
            <Input value={editForm.game_name} onChange={(e) => setEditForm((prev) => ({ ...prev, game_name: e.target.value }))} placeholder="Game name" />
            <Input value={editForm.sku} onChange={(e) => setEditForm((prev) => ({ ...prev, sku: e.target.value }))} placeholder="SKU" />
            <Input value={editForm.barcode} onChange={(e) => setEditForm((prev) => ({ ...prev, barcode: e.target.value }))} placeholder="Barcode" />
            <Input value={editForm.vendor_brand} onChange={(e) => setEditForm((prev) => ({ ...prev, vendor_brand: e.target.value }))} placeholder="Vendor / Brand" />
            <Input value={editForm.product_category} onChange={(e) => setEditForm((prev) => ({ ...prev, product_category: e.target.value }))} placeholder="Product category" />
            <Input value={editForm.image_url} onChange={(e) => setEditForm((prev) => ({ ...prev, image_url: e.target.value }))} placeholder="Image URL" />
            <Input type="number" min="1" step="1" value={editForm.quantity} onChange={(e) => setEditForm((prev) => ({ ...prev, quantity: e.target.value }))} placeholder="Quantity" />
            <Input type="number" min="0" step="0.01" value={editForm.market_price} onChange={(e) => setEditForm((prev) => ({ ...prev, market_price: e.target.value }))} placeholder="Market price" />
            <Input type="number" min="0" step="0.01" value={editForm.low_price} onChange={(e) => setEditForm((prev) => ({ ...prev, low_price: e.target.value }))} placeholder="Low price" />
            <Input type="number" min="0" step="0.01" value={editForm.price_paid} onChange={(e) => setEditForm((prev) => ({ ...prev, price_paid: e.target.value }))} placeholder="Price paid" />
            <Input value={editForm.notes} onChange={(e) => setEditForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Notes" />
          </div>

          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setEditingItem(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save Changes</Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}