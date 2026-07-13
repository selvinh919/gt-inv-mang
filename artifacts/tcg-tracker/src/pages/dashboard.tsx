import { AppLayout } from "@/components/layout/app-layout";
import { useGetCollectionSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, Library, TrendingUp } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

export default function Dashboard() {
  const { data: summary, isLoading } = useGetCollectionSummary();

  return (
    <AppLayout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-2">Overview of your collection.</p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : summary ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Card className="border-border bg-card shadow-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Portfolio Value
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-4xl font-bold text-primary foil-text">
                    {formatCurrency(summary.total_value)}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border bg-card shadow-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    Total Cards
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-4xl font-bold">
                    {summary.total_cards}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border bg-card shadow-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Library className="h-4 w-4" />
                    Unique Cards
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-4xl font-bold">
                    {summary.unique_cards}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-6">
                <h2 className="text-2xl font-bold tracking-tight">Top Cards</h2>
                {summary.top_cards && summary.top_cards.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {summary.top_cards.map((card, idx) => (
                      <div key={card.id} className="flex gap-4 p-4 rounded-xl border border-border bg-card shadow-sm hover-elevate transition-all">
                        {card.image_url ? (
                          <div className="w-16 h-24 shrink-0 rounded-md overflow-hidden bg-muted">
                            <img src={card.image_url} alt={card.card_name} className="w-full h-full object-cover" />
                          </div>
                        ) : (
                          <div className="w-16 h-24 shrink-0 rounded-md bg-muted flex items-center justify-center">
                            <Layers className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex flex-col flex-1 min-w-0 justify-center">
                          <h3 className="font-bold truncate" title={card.card_name}>{card.card_name}</h3>
                          <div className="text-sm text-muted-foreground truncate">{card.set_name} • {card.game_name}</div>
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
                      <p className="text-muted-foreground mb-4">No cards in your collection yet.</p>
                      <Link href="/search">
                        <Button>Add your first card</Button>
                      </Link>
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="space-y-6">
                <h2 className="text-2xl font-bold tracking-tight">By Game</h2>
                {summary.by_game && summary.by_game.length > 0 ? (
                  <div className="space-y-4">
                    {summary.by_game.map((game) => (
                      <div key={game.game} className="flex items-center justify-between p-4 rounded-xl border border-border bg-card shadow-sm">
                        <div>
                          <div className="font-bold">{game.game}</div>
                          <div className="text-sm text-muted-foreground">{game.count} cards</div>
                        </div>
                        <div className="font-mono font-medium">{formatCurrency(game.total_value)}</div>
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
          </>
        ) : null}
      </div>
    </AppLayout>
  );
}