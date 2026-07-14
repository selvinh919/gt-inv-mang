import { AppLayout } from "@/components/layout/app-layout";
import {
  useSearchCards,
  useAddToCollection,
  useGetConditionPrices,
  getGetCollectionQueryKey,
  getGetCollectionSummaryQueryKey,
} from "@workspace/api-client-react";
import type { TcgCard } from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search as SearchIcon, Plus, Loader2, ShoppingCart, TrendingDown, Package } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

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

  const updatedAt = card.price_updated_at
    ? new Date(card.price_updated_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const skus = conditionData?.skus ?? [];
  const conditionNames = CONDITION_ORDER.filter((c) =>
    skus.some((s) => s.condition_name === c)
  );

  const selectedSku = skus.find((s) => s.condition_name === selectedCondition) ?? null;

  const hasConditionData = skus.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold leading-snug pr-6">
            {card.name}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-4">
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

          <div className="flex-1 space-y-3 min-w-0">
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
                  className={
                    isFoil
                      ? "text-xs border-amber-500/50 text-amber-400"
                      : "text-xs"
                  }
                >
                  {printingLabel}
                </Badge>
              </div>
            </div>

            {/* TCGPlayer market prices (always shown) */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <TrendingDown className="h-3 w-3" /> Market
                </div>
                <div className="font-mono font-bold text-primary">
                  {fmt(card.market_price)}
                </div>
              </div>
              <div className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <ShoppingCart className="h-3 w-3" /> Low
                </div>
                <div className="font-mono font-bold">
                  {fmt(card.low_price)}
                </div>
              </div>
            </div>

            {card.total_listings != null && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Package className="h-3 w-3" />
                {card.total_listings.toLocaleString()} listings
                {updatedAt && <span className="ml-1">· Updated {updatedAt}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Condition-based pricing section */}
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Price by Condition</span>
            {conditionLoading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
            {!tcgplayerId && !conditionLoading && (
              <span className="text-xs text-muted-foreground">No TCGPlayer ID</span>
            )}
          </div>

          {hasConditionData ? (
            <>
              {/* Condition pills */}
              <div className="flex flex-wrap gap-1.5">
                {conditionNames.map((cond) => (
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
                ))}
              </div>

              {/* Selected condition price details */}
              {selectedSku && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <div className="text-xs text-muted-foreground mb-0.5">Market</div>
                    <div className="font-mono font-bold text-primary text-sm">
                      {fmt(selectedSku.market_price)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <div className="text-xs text-muted-foreground mb-0.5">Low</div>
                    <div className="font-mono font-bold text-sm">
                      {fmt(selectedSku.lowest_price)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <div className="text-xs text-muted-foreground mb-0.5">High</div>
                    <div className="font-mono font-bold text-sm">
                      {fmt(selectedSku.highest_price)}
                    </div>
                  </div>
                </div>
              )}
              {selectedSku?.price_count != null && (
                <p className="text-xs text-muted-foreground">
                  {selectedSku.price_count} listings · {selectedSku.variant_name}
                  {selectedSku.price_updated_at && (
                    <> · Updated {new Date(selectedSku.price_updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</>
                  )}
                </p>
              )}
            </>
          ) : !conditionLoading && tcgplayerId ? (
            <p className="text-xs text-muted-foreground">
              No per-condition data available for this card.
            </p>
          ) : null}
        </div>

        <Button
          className="w-full mt-1"
          onClick={() => onAdd(card, selectedCondition)}
          disabled={isPending}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add — {CONDITION_SHORT[selectedCondition] ?? selectedCondition} · {printingLabel} · {fmt(selectedSku?.market_price ?? card.market_price)}
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
  const { toast } = useToast();
  const queryClient = useQueryClient();

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
            <SearchIcon className="absolute left-3 top-3 h-5 w-5 text-muted-foreground" />
            <Input
              placeholder="Search for a card... (min 3 chars)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-10 h-12 text-lg bg-card border-border shadow-sm focus-visible:ring-primary"
            />
          </div>
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

        <p className="text-sm text-muted-foreground -mt-2">
          Search by name or include a card number — e.g. "Charizard ex 199" or
          "Pikachu 151"
        </p>

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
