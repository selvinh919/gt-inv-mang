import { Sidebar } from "./sidebar";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Search, Layers, Library } from "lucide-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/collection", label: "My Collection", icon: Layers },
    { href: "/search", label: "Add Cards", icon: Search },
  ];

  return (
    <div className="min-h-screen flex bg-background dark text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden border-b border-border bg-card p-4 flex items-center gap-4">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-card border-r border-border dark p-0 flex flex-col">
              <div className="p-6 border-b border-border mb-4">
                <div className="flex items-center gap-3 text-primary font-bold text-xl tracking-tight">
                  <Library className="h-6 w-6" />
                  <span className="foil-text">Vault</span>
                </div>
              </div>
              <nav className="flex-1 px-4 space-y-2">
                {links.map((link) => {
                  const isActive = location === link.href;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 px-3 py-3 rounded-md transition-colors ${
                        isActive
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      <link.icon className="h-5 w-5" />
                      {link.label}
                    </Link>
                  );
                })}
              </nav>
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-2 text-primary font-bold text-lg">
            <Library className="h-5 w-5" />
            <span className="foil-text">Vault</span>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-8 lg:p-12">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}