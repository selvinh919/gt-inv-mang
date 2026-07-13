import { AppLayout } from "@/components/layout/app-layout";
import { useSearchCards, useAddToCollection, getGetCollectionQueryKey, getGetCollectionSummaryQueryKey } from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search as SearchIcon, Plus, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "N/A";
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

export default function Search() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [game, setGame] = useState<string>("pokemon");
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
    { query: { enabled: debouncedQuery.length > 2, queryKey: ["searchCards", debouncedQuery, game] } }
  );

  const addMutation = useAddToCollection();

  const handleAdd = (card: any, printing: string, price: number | null | undefined) => {
    addMutation.mutate({
      data: {
        card_id: card.id,
        card_name: card.name,
        set_name: card.set_name,
        game_name: card.game_name || game,
        rarity: card.rarity,
        printing,
        market_price: price,
        low_price: card.low_price,
        image_url: card.image_url,
        quantity: 1
      }
    }, {
      onSuccess: () => {
        toast({
          title: "Added to collection",
          description: `${card.name} (${printing}) has been added.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCollectionSummaryQueryKey() });
      }
    });
  };

  return (
    <AppLayout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Card Search</h1>
          <p className="text-muted-foreground mt-2">Find and add new cards to your binder.</p>
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
              {GAMES.map(g => (
                <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-sm text-muted-foreground -mt-2">
          Search by card name. Card numbers (like "199") are stripped automatically.
        </p>

        {debouncedQuery.length > 2 && (
          <div className="pt-4">
            {isLoading ? (
              <div className="flex justify-center p-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : results && results.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {results.map((card, i) => (
                  <div key={`${card.id}-${i}`} className="flex flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden group">
                    <div className="aspect-[2.5/3.5] bg-muted w-full relative overflow-hidden flex items-center justify-center p-4">
                      {card.image_url ? (
                        <img src={card.image_url} alt={card.name} className="w-full h-full object-contain filter drop-shadow-lg group-hover:scale-105 transition-transform duration-500" />
                      ) : (
                        <div className="text-muted-foreground font-mono text-sm">No Image</div>
                      )}
                    </div>
                    <div className="p-4 flex flex-col flex-1">
                      <h3 className="font-bold text-lg leading-tight mb-1 truncate" title={card.name}>{card.name}</h3>
                      <div className="text-sm text-muted-foreground truncate mb-4">{card.set_name} • {card.rarity || 'Common'}</div>
                      
                      <div className="mt-auto space-y-2">
                        <Button 
                          variant="outline" 
                          className="w-full flex justify-between items-center group-hover:border-primary/50 transition-colors"
                          onClick={() => handleAdd(card, "Normal", card.market_price)}
                          disabled={addMutation.isPending}
                        >
                          <span>Normal</span>
                          <span className="font-mono">{formatCurrency(card.market_price)}</span>
                          <Plus className="h-4 w-4 opacity-50 group-hover:opacity-100" />
                        </Button>
                        <Button 
                          variant="outline" 
                          className="w-full flex justify-between items-center border-amber-500/30 hover:border-amber-500/80 hover:bg-amber-500/10 transition-colors"
                          onClick={() => handleAdd(card, "Foil", card.market_price ? card.market_price * 1.5 : null)}
                          disabled={addMutation.isPending}
                        >
                          <span className="foil-text">Foil</span>
                          <span className="font-mono text-amber-500">{formatCurrency(card.market_price ? card.market_price * 1.5 : null)}</span>
                          <Plus className="h-4 w-4 text-amber-500 opacity-50" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center p-12 border border-dashed rounded-xl text-muted-foreground">
                <SearchIcon className="h-12 w-12 mx-auto mb-4 opacity-20" />
                <p>No cards found matching "{debouncedQuery}" for {game}.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}