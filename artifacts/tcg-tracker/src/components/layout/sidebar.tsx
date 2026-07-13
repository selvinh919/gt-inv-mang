import { Link, useLocation } from "wouter";
import { LayoutDashboard, Search, Layers, Library } from "lucide-react";

export function Sidebar() {
  const [location] = useLocation();

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/collection", label: "My Collection", icon: Layers },
    { href: "/search", label: "Add Cards", icon: Search },
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
      
      <div className="p-6 text-xs text-muted-foreground">
        Personal TCG Tracker
      </div>
    </div>
  );
}