import { AppLayout } from "@/components/layout/app-layout";
import {
  useSearchCards,
  useAddToCollection,
  useGetConditionPrices,
  useScanCard,
  getGetCollectionQueryKey,
  getGetCollectionSummaryQueryKey,
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
import { Search as SearchIcon, Plus, Loader2, ShoppingCart, TrendingDown, Package, Camera, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

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

function CardDetailModal({
  card,
  open,
  onClose,
  onAdd,
  isPending,
}: {
  card: TcgCard | null;
  open: boolean;
  onClose: () => void;
  onAdd: (card: TcgCard, condition: string) => void;
  isPending: boolean;
}) {
  const [selectedCondition, setSelectedCondition] = useState("Near Mint");

  const tcgplayerId = card?.tcgplayer_id ?? null;
  const { data: conditionData, isLoading: conditionLoading } = useGetConditionPrices(
    tcgplayerId ?? 0,
    {
      query: {
        enabled: tcgplayerId != null && open,
        staleTime: 5 * 60 * 1000,
        queryKey: ["conditionPrices", tcgplayerId],
      },
    }
  );

  useEffect(() => {
    setSelectedCondition("Near Mint");
  }, [card?.id]);

  if (!card) return null;

  const printingLabel = getPrintingLabel(card.printing);
  const isFoil = isPrintingFoil(card.printing);

  const skus = conditionData?.skus ?? [];
  const conditionNames = CONDITION_ORDER.filter((c) =>
    skus.some((s) => s.condition_name === c)
  );
  const selectedSku = skus.find((s) => s.condition_name === selectedCondition) ?? null;
  const hasConditionData = skus.length > 0;

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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold leading-snug pr-6">
            {card.name}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-4">
          {/* Card image */}
          <div className="w-36 shrink-0 rounded-lg overflow-hidden bg-black">
            {card.image_url ? (
              <img
                src={card.image_url}
                alt={card.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-48 flex items-center justify-center text-muted-foreground text-xs font-mono">
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

            {/* Condition pills — shown as soon as data loads, spinner while loading */}
            <div className="flex items-center gap-2 flex-wrap">
              {conditionLoading ? (
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

        <Button
          className="w-full mt-2"
          onClick={() => onAdd(card, selectedCondition)}
          disabled={isPending}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add — {hasConditionData ? (CONDITION_SHORT[selectedCondition] ?? selectedCondition) + " · " : ""}{printingLabel} · {fmt(displayMarket)}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export default function Search() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [game, setGame] = useState<string>("pokemon");
  const [selectedCard, setSelectedCard] = useState<TcgCard | null>(null);
  const [scanLabel, setScanLabel] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scanMutation = useScanCard();

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
      setDebouncedQuery(query);
    }, 500);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: results, isLoading } = useSearchCards(
    { q: debouncedQuery, game },
    {
      query: {
        enabled: debouncedQuery.length > 2,
        queryKey: ["searchCards", debouncedQuery, game],
      },
    }
  );

  const addMutation = useAddToCollection();

  const handleAdd = (card: TcgCard, condition: string) => {
    const printingLabel = getPrintingLabel(card.printing);
    addMutation.mutate(
      {
        data: {
          card_id: card.id,
          card_name: card.name,
          set_name: card.set_name,
          game_name: card.game_name ?? game,
          rarity: card.rarity,
          printing: printingLabel,
          market_price: card.market_price,
          low_price: card.low_price,
          image_url: card.image_url,
          quantity: 1,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Added to collection",
            description: `${card.name} (${printingLabel} · ${condition}) has been added.`,
          });
          setSelectedCard(null);
          queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getGetCollectionSummaryQueryKey(),
          });
        },
      }
    );
  };

  return (
    <AppLayout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Card Search</h1>
          <p className="text-muted-foreground mt-2">
            Find and add new cards to your binder.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
            <Input
              placeholder="Search for a card... (min 3 chars)"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setScanLabel(null); }}
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
        </div>

        {scanLabel ? (
          <p className="text-sm -mt-2 flex items-center gap-1.5 text-primary">
            <Camera className="h-3.5 w-3.5" />
            <span className="font-medium">Scanned:</span> {scanLabel}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground -mt-2">
            Search by name or include a card number — e.g. "Charizard ex 199" or
            "Pikachu 151"
          </p>
        )}

        {debouncedQuery.length > 2 && (
          <div className="pt-4">
            {isLoading ? (
              <div className="flex justify-center p-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : results && results.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {results.map((card, i) => {
                  const printingLabel = getPrintingLabel(card.printing);
                  const isFoil = isPrintingFoil(card.printing);
                  return (
                    <div
                      key={`${card.id}-${i}`}
                      className="flex flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden group cursor-pointer hover:border-primary/50 transition-colors"
                      onClick={() => setSelectedCard(card)}
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
                            handleAdd(card, "Near Mint");
                          }}
                          disabled={addMutation.isPending}
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
                  {GAMES.find((g) => g.value === game)?.label ?? game}.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <CardDetailModal
        card={selectedCard}
        open={selectedCard !== null}
        onClose={() => setSelectedCard(null)}
        onAdd={handleAdd}
        isPending={addMutation.isPending}
      />
    </AppLayout>
  );
}
