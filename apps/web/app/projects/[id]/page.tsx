"use client";

import { Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { usePageContext } from "@/components/AppContext";
import { ProjectionStrip } from "@/components/ProjectionStrip";
import { Badge, Button, Empty, PageHeader, Panel, Spinner, statusTone, useToast } from "@/components/ui";
import { del, timeAgo, useApi } from "@/lib/api";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data: p, isLoading } = useApi<any>(`/v1/projects/${id}`);
  const { data: caps } = useApi<any[]>(`/v1/capabilities?project_id=${id}`);
  usePageContext({ project_id: id, project_name: p?.name }, [id, p?.name]);
  if (isLoading || !p) return <Spinner />;

  return (
    <>
      <PageHeader title={p.name} description={p.description}
        meta={<><Badge>/{p.slug}</Badge><span className="text-2xs text-ink-4">Owner {p.owner}</span></>}
        actions={<>
          <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
            if (!confirm(`Delete project ${p.name}?`)) return;
            try { await del(`/v1/projects/${id}`); toast("Project deleted"); router.push("/projects"); } catch (e: any) { toast(e.message, "bad"); }
          }}>Delete</Button>
          <Link href={`/build?project=${id}`}><Button variant="primary" icon={<Sparkles className="h-3.5 w-3.5" />}>New capability</Button></Link>
        </>} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Panel title="Capabilities" className="xl:col-span-2" bodyClass="p-0">
          {!caps?.length ? (
            <Empty title="No capabilities yet" action={<Link href={`/build?project=${id}`}><Button variant="primary">Describe your first API</Button></Link>}>
              Describe what you need in one sentence; the platform generates the spec, workflow, policies and tests.
            </Empty>
          ) : (
            <table className="tbl">
              <thead><tr><th>Name</th><th>Interfaces</th><th>Operations</th><th>Revision</th><th>Environments</th></tr></thead>
              <tbody>
                {caps.map((c) => (
                  <tr key={c.id} className="cursor-pointer" onClick={() => router.push(`/capabilities/${c.id}`)}>
                    <td className="font-medium">{c.name}</td>
                    <td><ProjectionStrip interfaces={c.interfaces} size="sm" /></td>
                    <td className="tabular-nums">{c.operation_count}</td>
                    <td><Badge tone={statusTone(c.revision_status)}>r{c.latest_revision} · {c.revision_status}</Badge></td>
                    <td className="text-xs text-ink-3">{c.environments.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div className="space-y-5">
          <Panel title="Gateway base URLs">
            <ul className="space-y-2 text-xs font-mono">
              {["development", "staging", "production"].map((e) => (
                <li key={e}><div className="text-2xs text-ink-4 font-sans">{e}</div>/gw/{e}/{p.slug}/api</li>
              ))}
            </ul>
          </Panel>
          <Panel title="MCP servers" bodyClass="p-0" actions={<Link href="/mcp" className="text-xs text-signal-2 hover:underline">MCP Studio</Link>}>
            {!p.mcp_servers.length ? <div className="px-4 py-4 text-sm text-ink-3">None yet.</div> : (
              <ul>{p.mcp_servers.map((s: any) => (
                <li key={s.id} className="px-4 py-2.5 border-b border-line-2 last:border-0">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-2xs text-ink-4">{s.tool_operation_ids.length} tool(s) · v{s.version}</div>
                </li>))}</ul>
            )}
          </Panel>
          <Panel title="Deployments" bodyClass="p-0">
            {!p.deployments.length ? <div className="px-4 py-4 text-sm text-ink-3">None yet.</div> : (
              <ul>{p.deployments.slice(0, 8).map((d: any) => (
                <li key={d.id} className="px-4 py-2 border-b border-line-2 last:border-0 flex items-center gap-2 text-sm">
                  <span className="truncate">{d.capability_name}</span>
                  <Badge tone={statusTone(d.status)}>{d.environment}</Badge>
                  <span className="ml-auto text-2xs text-ink-4">r{d.revision_number} · {timeAgo(d.created_at)}</span>
                </li>))}</ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
