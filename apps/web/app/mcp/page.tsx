"use client";

import clsx from "clsx";
import { Play, Plus, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";

import { useApp } from "@/components/AppContext";
import { callAs, ClientPicker } from "@/components/ClientPicker";
import { Badge, Button, CodeBlock, CopyButton, Empty, ErrorNote, Field, Modal, PageHeader, Panel, Select, Spinner, Toggle, useToast } from "@/components/ui";
import { patch, post, useApi } from "@/lib/api";

export default function McpStudio() {
  const { env } = useApp();
  const toast = useToast();
  const { data: servers, mutate, isLoading } = useApi<any[]>("/v1/mcp-servers");
  const { data: clients } = useApi<any[]>("/v1/api-clients");
  const [sel, setSel] = useState<string>("");
  const [open, setOpen] = useState(false);
  const s = servers?.find((x) => x.id === sel) || servers?.[0];
  useEffect(() => { if (!sel && servers?.length) setSel(servers[0].id); }, [servers, sel]);

  return (
    <>
      <PageHeader title="MCP Studio" description="Publish approved capabilities as MCP tools for AI agents. Tools invoke the same operations and policies as REST and GraphQL; read-only by default."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>New MCP server</Button>} />
      {isLoading ? <Spinner /> : !servers?.length ? (
        <div className="panel"><Empty icon={<Waypoints className="h-6 w-6" />} title="No MCP servers yet" action={<Button variant="primary" onClick={() => setOpen(true)}>Create MCP server</Button>}>
          Choose operations from a project&apos;s capabilities and restrict which agent clients may connect.</Empty></div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[260px_1fr] gap-5 items-start">
          <Panel title="Servers" bodyClass="p-2">
            <ul className="space-y-0.5">{servers.map((x) => (
              <li key={x.id}><button onClick={() => setSel(x.id)} className={clsx("w-full text-left px-2 py-1.5 rounded", x.id === s?.id ? "bg-mcp-soft" : "hover:bg-paper")}>
                <div className="text-sm font-medium">{x.name}</div>
                <div className="text-2xs text-ink-4">{x.deployed_tools[env]?.length || 0} live tool(s) in {env} · v{x.version}</div>
              </button></li>
            ))}</ul>
          </Panel>
          {s && <ServerDetail key={s.id} s={s} env={env} clients={clients || []} onSaved={() => mutate()} toast={toast} />}
        </div>
      )}
      <NewServer open={open} onClose={() => setOpen(false)} onCreated={(x) => { mutate(); setSel(x.id); }} />
    </>
  );
}

function ServerDetail({ s, env, clients, onSaved, toast }: { s: any; env: string; clients: any[]; onSaved: () => void; toast: any }) {
  const url = typeof window !== "undefined" ? `${window.location.origin}${s.urls[env]}` : s.urls[env];
  const tools = s.deployed_tools[env] || [];
  const [client, setClient] = useState(s.allowed_client_ids[0] || "");
  const [log, setLog] = useState<any[]>([]);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [busy, setBusy] = useState(false);
  const { data: candidates } = useApi<any[]>(`/v1/mcp-servers/candidates?project_id=${s.project_id}`);

  async function rpc(method: string, params?: any) {
    setBusy(true);
    try {
      const r = await callAs(client, s.urls[env], { method: "POST", json: { jsonrpc: "2.0", id: Date.now(), method, ...(params ? { params } : {}) } });
      setLog((l) => [{ method, params, ...r }, ...l].slice(0, 8));
      return r;
    } catch (e: any) { toast(e.message, "bad"); } finally { setBusy(false); }
  }
  const allowed = new Set(s.allowed_client_ids);
  const config = JSON.stringify({ mcpServers: { [s.slug]: { type: "http", url, headers: { Authorization: "Bearer <API client token>" } } } }, null, 2);

  return (
    <div className="space-y-5 min-w-0">
      <Panel title={s.name} actions={<Badge tone="mcp">v{s.version}</Badge>}>
        <p className="text-sm text-ink-3">{s.description}</p>
        <div className="mt-3 flex items-center gap-2">
          <code className="text-xs bg-paper px-2 py-1 rounded truncate">{url}</code><CopyButton text={url} />
        </div>
        <div className="mt-2 text-2xs text-ink-4">Streamable HTTP · JSON responses · protocol 2025-06-18 · discovery and invocation are separate permissions</div>
      </Panel>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-5">
        <Panel title={`Tools live in ${env}`} bodyClass="p-0">
          {!tools.length ? <div className="p-4 text-sm text-ink-3">No tools deployed in {env}. Deploy the capability, or switch environment.</div> : (
            <table className="tbl"><thead><tr><th>Tool</th><th>Effect</th><th>Scopes</th></tr></thead>
              <tbody>{tools.map((t: any) => (
                <tr key={t.name}><td><div className="font-mono text-xs">{t.name}</div><div className="text-2xs text-ink-4">{t.operation}</div></td>
                  <td><Badge tone={t.side_effect === "read" ? "neutral" : "warn"}>{t.side_effect}</Badge></td><td className="font-mono text-2xs">{t.scopes.join(", ")}</td></tr>
              ))}</tbody></table>
          )}
        </Panel>
        <Panel title="Tool selection" bodyClass="p-0" description="Operations from this project's capabilities. Only operations with an MCP interface can become tools.">
          <ul className="divide-y divide-line-2">{(candidates || []).map((c) => {
            const on = s.tool_operation_ids.includes(c.key);
            return (
              <li key={c.key} className="px-4 py-2 flex items-center gap-3">
                <Toggle checked={on} disabled={!c.has_mcp_interface} onChange={async (v) => {
                  await patch(`/v1/mcp-servers/${s.id}`, { tool_operation_ids: v ? [...s.tool_operation_ids, c.key] : s.tool_operation_ids.filter((x: string) => x !== c.key) });
                  toast(v ? "Tool added" : "Tool removed"); onSaved();
                }} />
                <div className="min-w-0"><div className="text-sm">{c.operation} <span className="text-2xs text-ink-4">· {c.capability}</span></div>
                  <div className="text-2xs text-ink-4">{c.has_mcp_interface ? <span className="font-mono">{c.tool_name}</span> : "No MCP interface — enable it on the capability's Interfaces tab"}</div></div>
                <Badge tone={c.side_effect === "read" ? "neutral" : "warn"} className="ml-auto">{c.side_effect}</Badge>
              </li>
            );
          })}</ul>
        </Panel>
      </div>

      <Panel title="Allowed clients" description="Only these API clients may discover and call tools on this server. Empty means any client with the required scopes.">
        <div className="flex flex-wrap gap-2">{clients.map((c) => {
          const on = allowed.has(c.id);
          return (
            <button key={c.id} onClick={async () => {
              await patch(`/v1/mcp-servers/${s.id}`, { allowed_client_ids: on ? s.allowed_client_ids.filter((x: string) => x !== c.id) : [...s.allowed_client_ids, c.id] });
              onSaved();
            }} className={clsx("h-7 px-2.5 rounded border text-xs", on ? "border-mcp bg-mcp-soft text-mcp" : "border-line text-ink-3")}>{c.name}</button>
          );
        })}</div>
      </Panel>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-5">
        <Panel title="Test client">
          <div className="space-y-3">
            <Field label="Connect as"><ClientPicker value={client} onChange={setClient} kind="any" /></Field>
            <div className="flex gap-2">
              <Button disabled={!client} loading={busy} onClick={() => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apification-console", version: "1" } })}>initialize</Button>
              <Button disabled={!client} loading={busy} onClick={() => rpc("tools/list")}>tools/list</Button>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
              <Field label="Tool"><Select value={tool} onChange={(v) => { setTool(v); const t = tools.find((x: any) => x.name === v); if (t) setArgs(v.startsWith("get") ? '{"customer_id": "CUS-1003"}' : v.startsWith("search") ? '{"q": "a", "limit": 3}' : "{}"); }}
                placeholder="Select tool" options={tools.map((t: any) => ({ value: t.name, label: t.name }))} /></Field>
              <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} disabled={!client || !tool} loading={busy}
                onClick={() => { try { rpc("tools/call", { name: tool, arguments: JSON.parse(args || "{}") }); } catch { toast("Arguments must be JSON", "bad"); } }}>tools/call</Button>
            </div>
            <Field label="Arguments (JSON)"><textarea className="textarea font-mono text-xs" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} /></Field>
          </div>
        </Panel>
        <Panel title="Client configuration" description="Paste into an MCP client that supports remote HTTP servers. Issue a token for an allowed client in Security.">
          <CodeBlock code={config} />
        </Panel>
      </div>

      {log.length > 0 && (
        <Panel title="Session log" bodyClass="p-0">
          <ul className="divide-y divide-line-2">{log.map((l, i) => (
            <li key={i} className="p-3">
              <div className="flex items-center gap-2 text-xs mb-1.5">
                <code className="font-semibold">{l.method}</code>
                <Badge tone={l.status >= 400 || l.body?.error || l.body?.result?.isError ? "bad" : "good"}>{l.status}{l.body?.result?.isError ? " · tool error" : ""}</Badge>
                <span className="text-ink-4">{l.ms} ms</span>
              </div>
              <CodeBlock code={JSON.stringify(l.body, null, 2)} maxHeight={240} />
            </li>
          ))}</ul>
        </Panel>
      )}
    </div>
  );
}

function NewServer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (s: any) => void }) {
  const { data: projects } = useApi<any[]>("/v1/projects");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [err, setErr] = useState<any>();
  const pid = projectId || projects?.[0]?.id || "";
  const { data: candidates } = useApi<any[]>(pid ? `/v1/mcp-servers/candidates?project_id=${pid}` : null);
  return (
    <Modal open={open} onClose={onClose} title="New MCP server" width={600}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !pid} onClick={async () => {
        try { const s = await post("/v1/mcp-servers", { name, project_id: pid, description: desc, tool_operation_ids: sel }); onCreated(s); onClose(); setName(""); setSel([]); }
        catch (e) { setErr(e); }
      }}>Create server</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing assistant" /></Field>
          <Field label="Project"><Select value={pid} onChange={setProjectId} options={(projects || []).map((p) => ({ value: p.id, label: p.name }))} /></Field>
        </div>
        <Field label="Description for agents"><textarea className="textarea" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <div className="label">Tools</div>
        <ul className="border border-line rounded divide-y divide-line-2 max-h-60 overflow-y-auto">{(candidates || []).map((c) => (
          <li key={c.key} className="px-3 py-2 flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!c.has_mcp_interface} checked={sel.includes(c.key)} onChange={(e) => setSel(e.target.checked ? [...sel, c.key] : sel.filter((x) => x !== c.key))} />
            <span>{c.operation}</span><span className="text-2xs text-ink-4">{c.capability}</span>
            <Badge tone={c.side_effect === "read" ? "neutral" : "warn"} className="ml-auto">{c.side_effect}</Badge>
          </li>
        ))}</ul>
        <ErrorNote error={err} />
      </div>
    </Modal>
  );
}
