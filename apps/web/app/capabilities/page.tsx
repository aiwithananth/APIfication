"use client";

import { Sparkles, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ProjectionStrip } from "@/components/ProjectionStrip";
import { Badge, Button, Empty, PageHeader, Spinner, statusTone } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/api";

export default function Capabilities() {
  const { data, isLoading } = useApi<any[]>("/v1/capabilities");
  const [q, setQ] = useState("");
  const router = useRouter();
  const rows = (data || []).filter((c) => (c.name + c.project_name).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title="Capabilities" description="Each capability is one canonical specification projected to REST, GraphQL and MCP."
        actions={<Link href="/build"><Button variant="primary" icon={<Sparkles className="h-3.5 w-3.5" />}>Create capability</Button></Link>} />
      <div className="panel">
        <div className="p-3 border-b border-line"><input className="input max-w-sm" placeholder="Filter by name or project" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {isLoading ? <Spinner /> : !rows.length ? (
          <Empty icon={<Workflow className="h-6 w-6" />} title={q ? "No matches" : "No capabilities yet"}
            action={!q && <Link href="/build"><Button variant="primary">Open API Builder</Button></Link>} />
        ) : (
          <table className="tbl">
            <thead><tr><th>Capability</th><th>Project</th><th>Interfaces</th><th>Ops</th><th>Latest revision</th><th>Live in</th><th className="text-right">Updated</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="cursor-pointer" onClick={() => router.push(`/capabilities/${c.id}`)}>
                  <td><div className="font-medium">{c.name}</div><div className="text-2xs text-ink-4 line-clamp-1 max-w-[46ch]">{c.description}</div></td>
                  <td className="text-ink-3">{c.project_name}</td>
                  <td><ProjectionStrip interfaces={c.interfaces} size="sm" /></td>
                  <td className="tabular-nums">{c.operation_count}</td>
                  <td><Badge tone={statusTone(c.revision_status)}>r{c.latest_revision} · {c.revision_status}</Badge></td>
                  <td className="text-xs">{c.environments.length ? c.environments.map((e: string) => <Badge key={e} className="mr-1">{e}</Badge>) : <span className="text-ink-4">—</span>}</td>
                  <td className="text-right text-2xs text-ink-4">{timeAgo(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
