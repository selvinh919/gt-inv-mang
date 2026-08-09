import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { useBusinessStore, type UserRole } from "@/lib/business-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { buildAuthApiUrl, getStoredAuthToken } from "@/lib/auth-session";

type CloudProfile = {
  sub: string;
  email: string;
  name: string;
  provider?: string | null;
  role?: string | null;
};

export default function SettingsPage() {
  const {
    session,
    users,
    tax,
    can,
    setTaxConfig,
    createUser,
    updateUserRole,
  } = useBusinessStore();

  const { toast } = useToast();

  const [taxRate, setTaxRate] = useState(String(tax.rate_percent));
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [userRole, setUserRole] = useState<UserRole>("clerk");
  const [cloudProfile, setCloudProfile] = useState<CloudProfile | null>(null);
  const [cloudStatus, setCloudStatus] = useState<"loading" | "connected" | "missing-token" | "error">("loading");

  useEffect(() => {
    const token = getStoredAuthToken();
    if (!token) {
      setCloudStatus("missing-token");
      setCloudProfile(null);
      return;
    }

    const run = async () => {
      try {
        const response = await fetch(buildAuthApiUrl("/me"), {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          setCloudStatus("error");
          setCloudProfile(null);
          return;
        }

        const profile = (await response.json()) as CloudProfile;
        setCloudProfile(profile);
        setCloudStatus("connected");
      } catch {
        setCloudStatus("error");
        setCloudProfile(null);
      }
    };

    void run();
  }, []);

  const saveTax = () => {
    try {
      setTaxConfig(Number(taxRate));
      toast({ title: "Tax config updated", description: `Rate set to ${Number(taxRate)}%.` });
    } catch (error) {
      toast({
        title: "Could not save tax config",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const addUser = () => {
    try {
      createUser({ name: userName, email: userEmail, password: userPassword, role: userRole });
      toast({ title: "User created", description: `${userName} added as ${userRole}.` });
      setUserName("");
      setUserEmail("");
      setUserPassword("");
      setUserRole("clerk");
    } catch (error) {
      toast({
        title: "Could not create user",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-2">Manage roles, tax configuration, and POS policies.</p>
          <p className="text-xs text-muted-foreground mt-1">Signed in as {session?.name} ({session?.role})</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Cloud Session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {cloudStatus === "connected" ? (
              <>
                <p className="text-emerald-400">Connected to cloud auth.</p>
                <p className="text-muted-foreground">Email: {cloudProfile?.email}</p>
                <p className="text-muted-foreground">Subject: {cloudProfile?.sub}</p>
              </>
            ) : null}

            {cloudStatus === "missing-token" ? (
              <p className="text-amber-300">No cloud token found. This session will not sync inventory across browsers.</p>
            ) : null}

            {cloudStatus === "error" ? (
              <p className="text-red-400">Cloud session could not be verified. Sign out and sign in again.</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tax Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 max-w-sm">
            <Input
              type="number"
              min="0"
              max="30"
              step="0.01"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
              disabled={!can("manage_tax")}
            />
            <Button onClick={saveTax} disabled={!can("manage_tax")}>Save Tax Rate</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>User Auth and Roles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-amber-300">
              This user list is browser-local and does not sync across devices. Inventory sync uses the Cloud Session above.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Name" disabled={!can("manage_users")} />
              <Input value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="Email" disabled={!can("manage_users")} />
              <Input value={userPassword} onChange={(e) => setUserPassword(e.target.value)} placeholder="Password" type="password" disabled={!can("manage_users")} />
              <Select value={userRole} onValueChange={(value) => setUserRole(value as UserRole)} disabled={!can("manage_users")}>
                <SelectTrigger><SelectValue placeholder="Role" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="clerk">Clerk</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={addUser} disabled={!can("manage_users")}>Create User</Button>

            <div className="space-y-2">
              {users.map((user) => (
                <div key={user.id} className="p-3 border rounded-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <div className="font-semibold">{user.name}</div>
                    <div className="text-xs text-muted-foreground">{user.email}</div>
                  </div>
                  <div className="w-full sm:w-40">
                    <Select
                      value={user.role}
                      onValueChange={(value) => updateUserRole(user.id, value as UserRole)}
                      disabled={!can("manage_users")}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="owner">Owner</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="clerk">Clerk</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
