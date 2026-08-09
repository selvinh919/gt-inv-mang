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
  const { signInFromExternal, users } = useBusinessStore();
  const { toast } = useToast();

  const [mode, setMode] = useState<"signin" | "create" | "forgot">("signin");
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
    });
  };

  const callLocalAuthEndpoint = async (
    path: "/local/login" | "/local/register" | "/local/reset",
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

  const migrateMatchingLocalUser = async (email: string, passwordValue: string) => {
    const existing = users.find(
      (candidate) =>
        candidate.active &&
        candidate.email.trim().toLowerCase() === email &&
        candidate.password === passwordValue,
    );

    if (!existing) return false;

    try {
      await callLocalAuthEndpoint("/local/register", {
        name: existing.name,
        email,
        password: passwordValue,
      });
      return true;
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        return true;
      }
      throw error;
    }
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

    if ((mode === "create" || mode === "forgot") && trimmedPassword !== confirmPassword.trim()) {
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
        try {
          const response = (await callLocalAuthEndpoint("/local/login", {
            email: trimmedEmail,
            password: trimmedPassword,
          })) as LocalAuthResponse;
          applyRemoteSession(response);
        } catch (remoteError) {
          // One-time bridge: if this browser has a local account, migrate it to server auth.
          const migrated = await migrateMatchingLocalUser(trimmedEmail.toLowerCase(), trimmedPassword);
          if (migrated) {
            const response = (await callLocalAuthEndpoint("/local/login", {
              email: trimmedEmail,
              password: trimmedPassword,
            })) as LocalAuthResponse;
            applyRemoteSession(response);
            toast({
              title: "Account migrated",
              description: "Your local account has been migrated to cloud auth.",
            });
          } else {
            throw remoteError;
          }
        }
      } else if (mode === "create") {
        const response = (await callLocalAuthEndpoint("/local/register", {
          name: name.trim(),
          email: trimmedEmail,
          password: trimmedPassword,
        })) as LocalAuthResponse;
        applyRemoteSession(response);
      } else {
        const response = (await callLocalAuthEndpoint("/local/reset", {
          email: trimmedEmail,
          password: trimmedPassword,
        })) as LocalAuthResponse;
        applyRemoteSession(response);
        toast({
          title: "Password reset",
          description: "Your password was updated. You can sign in now.",
        });
        setMode("signin");
        setPassword("");
        setConfirmPassword("");
      }
    } catch (error) {
      toast({
        title:
          mode === "signin"
            ? "Sign-in failed"
            : mode === "create"
              ? "Account creation failed"
              : "Reset failed",
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

      <div>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          onClick={() => setMode("forgot")}
          disabled={isSubmitting}
        >
          Forgot password?
        </button>
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
        placeholder={mode === "forgot" ? "New password" : "Password"}
        type="password"
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        disabled={isSubmitting}
      />

      {mode === "create" || mode === "forgot" ? (
        <Input
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder={mode === "forgot" ? "Confirm new password" : "Confirm password"}
          type="password"
          autoComplete="new-password"
          disabled={isSubmitting}
        />
      ) : null}

      <Button className="w-full" onClick={handleSubmit} disabled={isSubmitting}>
        {mode === "signin" ? "Sign In" : mode === "create" ? "Create Account" : "Reset Password"}
      </Button>

      {mode === "forgot" ? (
        <p className="text-xs text-muted-foreground">Enter your account email and set a new password.</p>
      ) : null}
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
