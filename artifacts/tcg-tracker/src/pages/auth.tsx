import { useEffect, useMemo, useState } from "react";
import { useBusinessStore } from "@/lib/business-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Library } from "lucide-react";
import { buildAuthApiUrl, clearStoredAuthToken, getStoredAuthToken, setStoredAuthToken } from "@/lib/auth-session";

type ExternalProfile = {
  sub: string;
  email: string;
  name: string;
  picture?: string | null;
  provider?: string | null;
  role?: "OWNER" | "MANAGER" | "CASHIER";
};

type LocalAuthResponse = {
  token: string;
  user: {
    id: number;
    email: string;
    name: string;
    role: "owner" | "manager" | "clerk";
    provider: "local";
  };
};

function LocalAuthSection() {
  const { signInFromExternal } = useBusinessStore();
  const { toast } = useToast();

  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const adminEmails = useMemo(() => {
    const raw = import.meta.env.VITE_AUTH_ADMIN_EMAILS?.trim() ?? "";
    return raw
      .split(",")
      .map((item: string) => item.trim().toLowerCase())
      .filter(Boolean);
  }, []);

  const applyRemoteSession = (payload: LocalAuthResponse) => {
    setStoredAuthToken(payload.token);
    signInFromExternal({
      email: payload.user.email,
      name: payload.user.name,
      external_sub: `local|${payload.user.id}`,
      adminEmails,
      role: payload.user.role,
    });
  };

  const callLocalAuthEndpoint = async (
    path: "/local/login" | "/local/register",
    body: Record<string, unknown>,
    token?: string,
  ) => {
    const response = await fetch(buildAuthApiUrl(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `Request failed: ${response.status}`;
      throw new Error(message);
    }

    return payload;
  };

  const handleSubmit = () => {
    const run = async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();

    if (!trimmedEmail || !trimmedPassword) {
      toast({
        title: "Missing credentials",
        description: "Email and password are required.",
        variant: "destructive",
      });
      return;
    }

    if (mode === "create" && !name.trim()) {
      toast({
        title: "Missing name",
        description: "Name is required to create an account.",
        variant: "destructive",
      });
      return;
    }

    if (mode === "create" && trimmedPassword !== confirmPassword.trim()) {
      toast({
        title: "Password mismatch",
        description: "Password and confirmation must match.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === "signin") {
        const response = (await callLocalAuthEndpoint("/local/login", {
          email: trimmedEmail,
          password: trimmedPassword,
        })) as LocalAuthResponse;
        applyRemoteSession(response);
      } else if (mode === "create") {
        const response = (await callLocalAuthEndpoint("/local/register", {
          name: name.trim(),
          email: trimmedEmail,
          password: trimmedPassword,
        })) as LocalAuthResponse;
        applyRemoteSession(response);
      }
    } catch (error) {
      toast({
        title: mode === "signin" ? "Sign-in failed" : "Account creation failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
    };

    void run();
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Button variant={mode === "signin" ? "default" : "outline"} onClick={() => setMode("signin")}>Sign In</Button>
        <Button variant={mode === "create" ? "default" : "outline"} onClick={() => setMode("create")}>Create Account</Button>
      </div>

      {mode === "create" ? (
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Full name"
          disabled={isSubmitting}
        />
      ) : null}

      <Input
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
        type="email"
        autoComplete="email"
        disabled={isSubmitting}
      />
      <Input
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        type="password"
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        disabled={isSubmitting}
      />

      {mode === "create" ? (
        <Input
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="Confirm password"
          type="password"
          autoComplete="new-password"
          disabled={isSubmitting}
        />
      ) : null}

      <Button className="w-full" onClick={handleSubmit} disabled={isSubmitting}>
        {mode === "signin" ? "Sign In" : "Create Account"}
      </Button>
    </div>
  );
}

function SocialAuthSection() {
  const { signInFromExternal } = useBusinessStore();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const adminEmails = useMemo(() => {
    const raw = import.meta.env.VITE_AUTH_ADMIN_EMAILS?.trim() ?? "";
    return raw
      .split(",")
      .map((item: string) => item.trim().toLowerCase())
      .filter(Boolean);
  }, []);

  useEffect(() => {
    const syncSessionFromToken = async () => {
      const url = new URL(window.location.href);
      const authToken = url.searchParams.get("auth_token");
      const authError = url.searchParams.get("auth_error");

      if (authError) {
        setErrorMessage("Sign-in failed. Please try again.");
      }

      if (authToken) {
        setStoredAuthToken(authToken);
        url.searchParams.delete("auth_token");
        url.searchParams.delete("auth_error");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      }

      const token = getStoredAuthToken();
      if (!token) return;

      setIsLoading(true);
      try {
        const response = await fetch(buildAuthApiUrl("/me"), {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Session is invalid or expired");
        }

        const profile = (await response.json()) as ExternalProfile;
        if (!profile?.email || !profile?.sub) {
          throw new Error("Authenticated profile is incomplete");
        }

        signInFromExternal({
          email: profile.email,
          name: profile.name || profile.email,
          external_sub: profile.sub,
          adminEmails,
          role: profile.role === "OWNER" ? "owner" : profile.role === "MANAGER" ? "manager" : "clerk",
        });
      } catch (error) {
        clearStoredAuthToken();
        setErrorMessage(error instanceof Error ? error.message : "Could not restore session");
      } finally {
        setIsLoading(false);
      }
    };

    void syncSessionFromToken();
  }, [adminEmails, signInFromExternal]);

  const startOAuth = (provider: "google" | "discord") => {
    try {
      setIsLoading(true);
      const redirect = `${window.location.origin}/auth`;
      const startUrl = buildAuthApiUrl(`/${provider}/start`);
      const url = new URL(startUrl, window.location.origin);
      url.searchParams.set("redirect", redirect);
      window.location.assign(url.toString());
    } catch (error) {
      setIsLoading(false);
      toast({
        title: "Sign-in failed",
        description: error instanceof Error ? error.message : "Could not start social login",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Button className="w-full" onClick={() => startOAuth("google")} disabled={isLoading}>
        Continue with Google
      </Button>
      <Button variant="outline" className="w-full" onClick={() => startOAuth("discord")} disabled={isLoading}>
        Continue with Discord
      </Button>

      {errorMessage ? (
        <div className="text-xs text-red-500">
          <p>{errorMessage}</p>
        </div>
      ) : null}
    </>
  );
}

export default function AuthPage() {
  const authConfigured = useMemo(() => {
    const apiBase = import.meta.env.VITE_API_BASE_URL?.trim();
    return Boolean(apiBase);
  }, []);

  const missingVars = useMemo(() => {
    const missing: string[] = [];
    if (!import.meta.env.VITE_API_BASE_URL?.trim()) missing.push("VITE_API_BASE_URL");
    return missing;
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md border-border shadow-xl">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary mb-3">
            <Library className="h-5 w-5" />
            <span className="font-semibold tracking-wide">Vault POS</span>
          </div>
          <CardTitle>Welcome Back</CardTitle>
          <p className="text-sm text-muted-foreground">Sign in to continue to your dashboard.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <LocalAuthSection />

          <div className="border-t border-border" />

          {authConfigured ? (
            <SocialAuthSection />
          ) : (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
              <p>Social auth is not configured for this deployment. Local login still works.</p>
              <p>Missing: {missingVars.join(", ")}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
