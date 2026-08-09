import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Layers, Library, TrendingUp, Wallet, FolderTree } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCollectionsStore } from "@/lib/collections-store";

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

export default function Dashboard() {
  const { collections, activeCollection, setActiveCollection, summary, allSummary } = useCollectionsStore();

  return (
    <AppLayout>
      <div className="space-y-5 sm:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-2">Overview of {activeCollection.name}.</p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:hidden">
          <Link href="/search">
            <Button variant="outline" className="w-full">Add Product</Button>
          </Link>
          <Link href="/collection">
            <Button variant="outline" className="w-full">Open Inventory</Button>
          </Link>
        </div>

        <div className="w-full sm:max-w-sm">
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

        <div className="grid grid-cols-1 min-[480px]:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-6">
          <Card className="border-border bg-card shadow-md">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Portfolio Value
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-3xl sm:text-4xl font-bold text-primary foil-text break-words">
                {formatCurrency(summary.total_value)}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-md">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Wallet className="h-4 w-4" />
                Total Paid
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-3xl sm:text-4xl font-bold break-words">
                {formatCurrency(summary.total_paid)}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-md">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Total Cards
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="text-3xl sm:text-4xl font-bold">
                {summary.total_cards}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-md">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Library className="h-4 w-4" />
                Unrealized P/L
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className={`text-3xl sm:text-4xl font-bold break-words ${summary.unrealized_pl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                {formatCurrency(summary.unrealized_pl)}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-border bg-card shadow-md">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FolderTree className="h-4 w-4" />
              All Inventory Snapshot
            </CardTitle>
            <CardDescription>
              Across {collections.length} inventories: {allSummary.total_cards} cards, {formatCurrency(allSummary.total_value)} market value.
            </CardDescription>
          </CardHeader>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-8">
          <div className="lg:col-span-2 space-y-4 sm:space-y-6">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Top Cards</h2>
            {summary.top_cards && summary.top_cards.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {summary.top_cards.map((card) => (
                  <div key={card.id} className="flex gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl border border-border bg-card shadow-sm hover-elevate transition-all">
                    {card.image_url ? (
                      <div className="w-14 h-20 sm:w-16 sm:h-24 shrink-0 rounded-md overflow-hidden bg-muted">
                        <img src={card.image_url} alt={card.card_name} className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-14 h-20 sm:w-16 sm:h-24 shrink-0 rounded-md bg-muted flex items-center justify-center">
                        <Layers className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex flex-col flex-1 min-w-0 justify-center">
                      <h3 className="font-bold truncate" title={card.card_name}>{card.card_name}</h3>
                      <div className="text-xs sm:text-sm text-muted-foreground truncate">{card.set_name} • {card.game_name}</div>
                      <div className="mt-auto flex items-center justify-between">
                        <span className="text-xs bg-muted px-2 py-0.5 rounded-sm uppercase tracking-wider font-mono">{card.printing}</span>
                        <span className="font-mono font-medium text-primary">{formatCurrency(card.market_price || 0)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Card className="border-dashed bg-transparent shadow-none">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <Library className="h-12 w-12 text-muted-foreground mb-4 opacity-50" />
                  <p className="text-muted-foreground mb-4">No cards in your inventory yet.</p>
                  <Link href="/search">
                    <Button>Add your first product</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-4 sm:space-y-6">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">By Game</h2>
            {summary.by_game && summary.by_game.length > 0 ? (
              <div className="space-y-4">
                {summary.by_game.map((game) => (
                  <div key={game.game} className="flex items-center justify-between p-3 sm:p-4 rounded-xl border border-border bg-card shadow-sm gap-3">
                    <div>
                      <div className="font-bold">{game.game}</div>
                      <div className="text-xs sm:text-sm text-muted-foreground">{game.count} cards</div>
                    </div>
                    <div className="font-mono font-medium text-sm sm:text-base text-right">{formatCurrency(game.total_value)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center border border-dashed rounded-xl text-muted-foreground text-sm">
                No data available.
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}