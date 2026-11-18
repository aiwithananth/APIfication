"use client";

import { Badge, PageHeader, Panel } from "@/components/ui";
import { useApi } from "@/lib/api";

export default function OrgSettings() {
  const { data: me } = useApi<any>("/v1/me");
  const { data: health } = useApi<any>("/health");
  return (
    <>
      <PageHeader title="Organisation" description="Platform-wide defaults. These apply to every project." />
      <div className="space-y-5">
        <Panel title="Safe defaults" description="Enforced by the platform. They protect every project and cannot be weakened per request.">
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {["New connectors are read-only until write access is granted", "New APIs are private by default", "MCP tools are read-only and not publicly discoverable",
              "No wildcard scopes in production", "GraphQL introspection off and depth-limited in production", "No automatic destructive migrations",
              "Production releases require an approver", "Secrets never appear in specs, prompts, logs or exports"].map((x) => (
              <li key={x} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-signal shrink-0" />{x}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="Signed in as">
          {me && <div className="text-sm"><div className="font-medium">{me.name}</div><div className="text-ink-3">{me.email}</div>
            <div className="mt-2 flex flex-wrap gap-1">{me.roles.map((r: string) => <Badge key={r}>{r}</Badge>)}</div></div>}
        </Panel>
        <Panel title="Platform">
          <dl className="grid grid-cols-[180px_1fr] gap-y-1.5 text-sm">
            <dt className="text-ink-3">Control plane</dt><dd>{health ? `v${health.version} · ${health.status}` : "unreachable"}</dd>
            <dt className="text-ink-3">Deployment model</dt><dd>Single-process development (control plane + data plane)</dd>
            <dt className="text-ink-3">Registry</dt><dd>SQLite by default; set <code className="text-xs">APF_DATABASE_URL</code> for PostgreSQL</dd>
          </dl>
        </Panel>
      </div>
    </>
  );
}
