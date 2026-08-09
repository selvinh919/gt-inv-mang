import { Link, useLocation } from "wouter";
import { LayoutDashboard, Search, Layers, Library, ShoppingCart, Settings, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBusinessStore } from "@/lib/business-store";
import { buildAuthApiUrl, clearStoredAuthToken } from "@/lib/auth-session";

function clearRemoteSession(): void {
  void fetch(buildAuthApiUrl("/logout"), { method: "POST" }).catch(() => undefined);
}

export function Sidebar() {
  const [location] = useLocation();
  const { session, signOut } = useBusinessStore();

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/collection", label: "Inventory", icon: Layers },
    { href: "/search", label: "Add Product", icon: Search },
    { href: "/pos", label: "POS", icon: ShoppingCart },
    { href: "/audit", label: "Audit", icon: ScrollText },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="w-64 border-r border-border bg-card h-screen sticky top-0 flex flex-col hidden md:flex">
      <div className="p-6">
        <Link href="/" className="flex items-center gap-3 text-primary font-bold text-xl tracking-tight">
          <Library className="h-6 w-6" />
          <span className="foil-text">Vault</span>
        </Link>
      </div>

      <nav className="flex-1 px-4 space-y-2">
        {links.map((link) => {
          const isActive = location === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
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
      
      <div className="p-6 text-xs text-muted-foreground space-y-3">
        <div>
          <div className="font-semibold text-foreground">{session?.name}</div>
          <div className="uppercase tracking-wide">{session?.role}</div>
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            signOut();
            clearStoredAuthToken();
            clearRemoteSession();
          }}
        >
          Sign Out
        </Button>
      </div>
    </div>
  );
}