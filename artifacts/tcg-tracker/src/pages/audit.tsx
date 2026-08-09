import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { useCollectionsStore } from "@/lib/collections-store";
import { getApiBaseUrl, getStoredAuthToken } from "@/lib/auth-session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Download, RefreshCcw } from "lucide-react";

type RemoteAuditLog = {
  id: number;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function toCsvValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const escaped = String(text).replace(/"/g, '""');
  return `"${escaped}"`;
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AuditPage() {
  const { auditLogs: localAuditLogs } = useCollectionsStore();
  const { toast } = useToast();

  const [remoteLogs, setRemoteLogs] = useState<RemoteAuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");

  const fetchRemoteLogs = async () => {
    const token = getStoredAuthToken();
    if (!token) {
      setRemoteLogs([]);
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (actionFilter.trim()) params.set("action", actionFilter.trim());
      if (entityFilter.trim()) params.set("entity_type", entityFilter.trim());
      if (actorFilter.trim()) params.set("actor_email", actorFilter.trim());
      if (fromFilter.trim()) params.set("from", fromFilter.trim());
      if (toFilter.trim()) params.set("to", toFilter.trim());

      const response = await fetch(`${getApiBaseUrl()}/api/audit/logs?${params.toString()}`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Audit logs request failed: ${response.status}`);
      }

      const payload = await response.json();
      setRemoteLogs(Array.isArray(payload) ? payload : []);
    } catch (error) {
      toast({
        title: "Could not load remote audit logs",
        description: error instanceof Error ? error.message : "Unknown audit API error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRemoteLogs();
  }, []);

  const localFiltered = useMemo(() => {
    return localAuditLogs.filter((entry) => {
      if (actionFilter && !entry.action.toLowerCase().includes(actionFilter.toLowerCase())) return false;
      if (entityFilter && !entry.entity_type.toLowerCase().includes(entityFilter.toLowerCase())) return false;
      if (actorFilter) {
        const actor = `${entry.actor_name || ""} ${entry.actor_email || ""}`.toLowerCase();
        if (!actor.includes(actorFilter.toLowerCase())) return false;
      }
      if (fromFilter && Date.parse(entry.created_at) < Date.parse(fromFilter)) return false;
      if (toFilter && Date.parse(entry.created_at) > Date.parse(toFilter)) return false;
      return true;
    });
  }, [localAuditLogs, actionFilter, entityFilter, actorFilter, fromFilter, toFilter]);

  const mergedRows = useMemo(() => {
    const localRows = localFiltered.map((entry) => ({
      source: "local",
      id: entry.id,
      created_at: entry.created_at,
      actor: entry.actor_email || entry.actor_name || "local-user",
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      before: entry.before,
      after: entry.after,
      metadata: entry.metadata,
    }));

    const remoteRows = remoteLogs.map((entry) => ({
      source: "remote",
      id: entry.id,
      created_at: entry.created_at,
      actor: entry.user_id,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      before: entry.before,
      after: entry.after,
      metadata: entry.metadata,
    }));

    return [...remoteRows, ...localRows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [localFiltered, remoteLogs]);

  const exportCsv = () => {
    const header = [
      "source",
      "id",
      "created_at",
      "actor",
      "action",
      "entity_type",
      "entity_id",
      "before",
      "after",
      "metadata",
    ];

    const rows = mergedRows.map((row) => [
      toCsvValue(row.source),
      toCsvValue(row.id),
      toCsvValue(row.created_at),
      toCsvValue(row.actor),
      toCsvValue(row.action),
      toCsvValue(row.entity_type),
      toCsvValue(row.entity_id),
      toCsvValue(row.before),
      toCsvValue(row.after),
      toCsvValue(row.metadata),
    ].join(","));

    const csv = `${header.join(",")}\n${rows.join("\n")}`;
    downloadCsv(`audit-logs-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-muted-foreground mt-2">Filter and export change history for inventory actions.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <Input value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} placeholder="Action" />
              <Input value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} placeholder="Entity type" />
              <Input value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} placeholder="Actor" />
              <Input type="date" value={fromFilter} onChange={(e) => setFromFilter(e.target.value)} />
              <Input type="date" value={toFilter} onChange={(e) => setToFilter(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void fetchRemoteLogs()} disabled={loading}>
                <RefreshCcw className="h-4 w-4 mr-2" />
                {loading ? "Refreshing..." : "Refresh"}
              </Button>
              <Button variant="outline" onClick={exportCsv} disabled={mergedRows.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Entries ({mergedRows.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[65vh] overflow-auto pr-1">
              {mergedRows.map((row) => (
                <div key={`${row.source}-${row.id}-${row.created_at}`} className="border rounded-md p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">{row.action}</div>
                    <div className="text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString()}</div>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    source: {row.source} • actor: {row.actor} • {row.entity_type} #{row.entity_id}
                  </div>
                </div>
              ))}
              {mergedRows.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-10 border border-dashed rounded-md">
                  No audit entries match current filters.
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
