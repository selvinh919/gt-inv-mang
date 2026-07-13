import { AppLayout } from "@/components/layout/app-layout";
import { useGetCollection, useUpdateCollectionItem, useRemoveFromCollection, getGetCollectionQueryKey, getGetCollectionSummaryQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search as SearchIcon, Loader2, Minus, Plus, Trash2, ArrowUpDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

export default function Collection() {
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState("value-desc");
  
  const { data: collection, isLoading } = useGetCollection();
  const updateMutation = useUpdateCollectionItem();
  const removeMutation = useRemoveFromCollection();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleUpdateQuantity = (id: number, newQuantity: number) => {
    if (newQuantity < 1) return;
    updateMutation.mutate({
      id,
      data: { quantity: newQuantity }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCollectionSummaryQueryKey() });
      }
    });
  };

  const handleRemove = (id: number, name: string) => {
    removeMutation.mutate({ id }, {
      onSuccess: () => {
        toast({
          title: "Removed from collection",
          description: `${name} has been removed.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetCollectionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCollectionSummaryQueryKey() });
      }
    });
  };

  let filtered = collection ? [...collection] : [];
  
  if (filter) {
    filtered = filtered.filter(item => 
      item.card_name.toLowerCase().includes(filter.toLowerCase()) || 
      (item.set_name && item.set_name.toLowerCase().includes(filter.toLowerCase())) ||
      (item.game_name && item.game_name.toLowerCase().includes(filter.toLowerCase()))
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
    return 0;
  });

  return (
    <AppLayout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">My Collection</h1>
            <p className="text-muted-foreground mt-2">Browse your catalog of {collection?.length || 0} unique cards.</p>
          </div>
          <Link href="/search">
            <Button size="lg" className="font-bold tracking-wide">Add Cards</Button>
          </Link>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 p-4 bg-card border border-border rounded-xl shadow-sm">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-3 h-5 w-5 text-muted-foreground" />
            <Input 
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
              <SelectItem value="name-asc">Name (A-Z)</SelectItem>
              <SelectItem value="game">Game</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex justify-center p-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((item) => (
              <div key={item.id} className="flex gap-4 p-4 rounded-xl border border-border bg-card shadow-sm hover-elevate transition-all group">
                <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden bg-muted relative">
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
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleRemove(item.id, item.card_name)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  
                  <div className="text-xs text-muted-foreground truncate mb-2">
                    {item.set_name} • {item.game_name}
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
                        disabled={item.quantity <= 1 || updateMutation.isPending}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="font-mono w-6 text-center text-sm font-medium">{item.quantity}</span>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 rounded-sm hover:bg-muted"
                        onClick={() => handleUpdateQuantity(item.id, item.quantity + 1)}
                        disabled={updateMutation.isPending}
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
                <Button>Browse Database</Button>
              </Link>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}