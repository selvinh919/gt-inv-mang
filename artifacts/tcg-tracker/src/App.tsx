import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Search from "@/pages/search";
import Collection from "@/pages/collection";
import PosPage from "@/pages/pos";
import SettingsPage from "@/pages/settings";
import AuthPage from "@/pages/auth";
import AuditPage from "@/pages/audit";
import { useBusinessStore } from "@/lib/business-store";
import { getStoredAuthToken } from "@/lib/auth-session";

const queryClient = new QueryClient();

function Router() {
  const { session } = useBusinessStore();
  const authToken = getStoredAuthToken();

  if (!session || !authToken) {
    return (
      <Switch>
        <Route path="/" component={AuthPage} />
        <Route path="/auth" component={AuthPage} />
        <Route component={AuthPage} />
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/search" component={Search} />
      <Route path="/collection" component={Collection} />
      <Route path="/pos" component={PosPage} />
      <Route path="/audit" component={AuditPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;