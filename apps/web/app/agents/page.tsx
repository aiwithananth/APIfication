"use client";

import "@xyflow/react/dist/style.css";

import { Background, Handle, MarkerType, Node, NodeProps, Position, ReactFlow } from "@xyflow/react";
import clsx from "clsx";
import { Bot, Lock } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { AgentTimeline } from "@/components/SpecViews";
import { Badge, Button, Drawer, Empty, Field, PageHeader, Panel, Select, Spinner, Tabs, TagInput, Toggle, useToast } from "@/components/ui";
import { patch, timeAgo, useApi } from "@/lib/api";

function AgentNode({ data }: NodeProps<Node<any>>) {
  const a = data.agent;
  return (
    <button onClick={() => data.onOpen(a)} className={clsx("w-[170px] text-left bg-white rounded-md border px-2.5 py-2 shadow-sm hover:border-signal",
      a.enabled ? "border-line" : "border-dashed border-ink-4/50 opacity-60")}>
      <Handle type="target" position={Position.Left} style={{ background: "#7A8699" }} />
      <div className="flex items-center gap-1.5">
        <Bot className="h-3.5 w-3.5 text-signal" />
        <span className="text-xs font-medium truncate">{a.name}</span>
        {a.mandatory && <Lock className="h-3 w-3 text-ink-4 ml-auto" aria-label="Mandatory" />}
      </div>
      <div className="text-[10px] text-ink-4 mt-0.5 truncate">{data.model}</div>
      <Handle type="source" position={Position.Right} style={{ background: "#0F7B6C" }} />
    </button>
  );
}
const nodeTypes = { agent: AgentNode };

export default function Agents() {
  const { data: agents, mutate, isLoading } = useApi<any[]>("/v1/agents");
  const { data: providers } = useApi<any[]>("/v1/model-providers");
  const { data: runs } = useApi<any[]>("/v1/agent-runs");
  const [tab, setTab] = useState<"team" | "runs">("team");
  const [open, setOpen] = useState<any>(null);
  const [run, setRun] = useState<string>("");
  const toast = useToast();
  const def = providers?.find((p) => p.is_default && p.provider_type !== "builtin");
  const modelOf = (a: any) => {
    const p = providers?.find((x) => x.id === a.provider_id);
    return p ? `${p.name}${p.model ? " · " + p.model : ""}` : def ? `default · ${def.model}` : "deterministic engine";
  };

  const graph = useMemo(() => {
    if (!agents) return { nodes: [], edges: [] };
    const team = agents.filter((a) => a.key !== "assistant");
    const sup = team.find((a) => a.key === "supervisor");
    const lanes: Record<string, string[]> = {
      plan: ["requirements"], design: ["database", "api", "graphql", "workflow"], govern: ["security", "mcp"],
      verify: ["tests", "reviewer"], release: ["release", "operations"],
    };
    const nodes: Node[] = [];
    const edges: any[] = [];
    if (sup) nodes.push({ id: sup.id, type: "agent", position: { x: 0, y: 150 }, data: { agent: sup, onOpen: setOpen, model: modelOf(sup) } });
    let prevIds = sup ? [sup.id] : [];
    Object.values(lanes).forEach((keys, li) => {
      const ids: string[] = [];
      keys.forEach((k, i) => {
        const a = team.find((x) => x.key === k);
        if (!a) return;
        const y = 150 + (i - (keys.length - 1) / 2) * 78;
        nodes.push({ id: a.id, type: "agent", position: { x: 230 * (li + 1), y }, data: { agent: a, onOpen: setOpen, model: modelOf(a) } });
        ids.push(a.id);
      });
      prevIds.forEach((p) => ids.forEach((t) => edges.push({ id: `${p}-${t}`, source: p, target: t, markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 } })));
      prevIds = ids;
    });
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, providers]);

  if (isLoading || !agents) return <Spinner />;
  const selRun = runs?.find((r) => r.id === run) || runs?.[0];

  return (
    <>
      <PageHeader title="Agentic Workspace" description="A supervised team of specialist agents designs, reviews and tests each capability. Agents cannot grant themselves permissions; validators and approvers have the final word." />
      <Tabs value={tab} onChange={setTab} className="mb-5" tabs={[{ id: "team", label: "Team", count: agents.length }, { id: "runs", label: "Runs", count: runs?.length }]} />
      {tab === "team" && (
        <div className="space-y-5">
          <Panel title="Orchestration" bodyClass="p-0" description="Supervisor-to-specialist delegation. Locked agents are mandatory gates and cannot be disabled. Select an agent to configure it.">
            <div style={{ height: 360 }}>
              <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.12 }}
                nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnScroll proOptions={{ hideAttribution: true }}>
                <Background gap={18} size={1} color="#E9EDF1" />
              </ReactFlow>
            </div>
          </Panel>
          <Panel title="Agents" bodyClass="p-0">
            <table className="tbl"><thead><tr><th>Agent</th><th>Responsibility</th><th>Model</th><th>Tools</th><th>Version</th><th>Status</th></tr></thead>
              <tbody>{agents.map((a) => (
                <tr key={a.id} className="cursor-pointer" onClick={() => setOpen(a)}>
                  <td className="font-medium">{a.name}{a.mandatory && <Lock className="inline h-3 w-3 ml-1.5 text-ink-4" />}</td>
                  <td className="text-ink-3 text-xs max-w-[40ch]">{a.purpose}</td>
                  <td className="text-xs">{modelOf(a)}</td>
                  <td className="text-2xs font-mono text-ink-3">{a.tools.slice(0, 3).join(", ")}{a.tools.length > 3 ? ` +${a.tools.length - 3}` : ""}</td>
                  <td className="tabular-nums text-xs">v{a.version}</td>
                  <td>{a.enabled ? <Badge tone="good">enabled</Badge> : <Badge>disabled</Badge>}</td>
                </tr>
              ))}</tbody></table>
          </Panel>
        </div>
      )}
      {tab === "runs" && (
        !runs?.length ? <div className="panel"><Empty title="No runs yet">Generate a capability in the API Builder with the agent team switched on.</Empty></div> : (
          <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-5 items-start">
            <Panel title="Runs" bodyClass="p-2">
              <ul className="space-y-0.5">{runs.map((r) => (
                <li key={r.id}><button onClick={() => setRun(r.id)} className={clsx("w-full text-left px-2 py-1.5 rounded", r.id === selRun?.id ? "bg-signal-soft" : "hover:bg-paper")}>
                  <div className="text-sm font-medium truncate">{r.name}</div>
                  <div className="text-2xs text-ink-4">{r.steps.length} steps · {r.duration_ms} ms · {timeAgo(r.created_at)}</div>
                </button></li>
              ))}</ul>
            </Panel>
            {selRun && (
              <Panel title={selRun.name} actions={<Badge tone={selRun.validation?.valid ? "good" : "bad"}>{selRun.validation?.summary}</Badge>}>
                <p className="text-sm text-ink-3 mb-4 border-l-2 border-line pl-3">{selRun.prompt}</p>
                <AgentTimeline steps={selRun.steps} findings={selRun.findings} />
                {selRun.capability_id && <Link href={`/capabilities/${selRun.capability_id}`} className="inline-block mt-4 text-sm text-signal-2 hover:underline">Open capability</Link>}
              </Panel>
            )}
          </div>
        )
      )}
      {open && <AgentDrawer agent={open} providers={providers || []} onClose={() => setOpen(null)} onSaved={() => { mutate(); toast("Agent configuration saved as a new version"); setOpen(null); }} />}
    </>
  );
}

function AgentDrawer({ agent, providers, onClose, onSaved }: { agent: any; providers: any[]; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState({ ...agent });
  const [err, setErr] = useState("");
  const set = (k: string, v: any) => setA((x: any) => ({ ...x, [k]: v }));
  return (
    <Drawer open onClose={onClose} title={`${agent.name} · v${agent.version}`} width={520}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        try { await patch(`/v1/agents/${agent.id}`, { provider_id: a.provider_id || null, temperature: Number(a.temperature), system_prompt: a.system_prompt, tools: a.tools,
          enabled: a.enabled, max_turns: Number(a.max_turns), token_budget: Number(a.token_budget), approval_required: a.approval_required }); onSaved(); }
        catch (e: any) { setErr(e.message); }
      }}>Save new version</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-ink-3">{agent.purpose}</p>
        <div className="flex items-center justify-between">
          <Toggle checked={a.enabled} disabled={agent.mandatory} onChange={(v) => set("enabled", v)} label="Enabled" />
          {agent.mandatory && <span className="text-2xs text-ink-4 inline-flex items-center gap-1"><Lock className="h-3 w-3" /> Mandatory stage</span>}
        </div>
        <Field label="Model provider" hint="Empty uses the organisation default. Restricted data is only sent to providers approved for it.">
          <Select value={a.provider_id || ""} onChange={(v) => set("provider_id", v)} placeholder="Organisation default"
            options={providers.filter((p) => p.status === "active").map((p) => ({ value: p.id, label: `${p.name}${p.model ? " · " + p.model : ""}` }))} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Temperature"><input type="number" step="0.1" min="0" max="1" className="input" value={a.temperature} onChange={(e) => set("temperature", e.target.value)} /></Field>
          <Field label="Max turns"><input type="number" className="input" value={a.max_turns} onChange={(e) => set("max_turns", e.target.value)} /></Field>
          <Field label="Token budget"><input type="number" className="input" value={a.token_budget} onChange={(e) => set("token_budget", e.target.value)} /></Field>
        </div>
        <Field label="Role instructions" hint="Appended to the platform's built-in role prompt. Versioned on save.">
          <textarea className="textarea text-xs font-mono" rows={7} value={a.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} placeholder="e.g. Prefer narrow, action-oriented scopes. Flag any field that looks like PII." />
        </Field>
        <Field label="Tool allowlist"><TagInput value={a.tools} onChange={(v) => set("tools", v)} /></Field>
        <Toggle checked={!!a.approval_required} onChange={(v) => set("approval_required", v)} label="Require human approval for this agent's outputs" />
        <div className="rounded bg-paper p-3 text-2xs text-ink-3">Identity <code>{agent.identity}</code> · separate workload identity with explicit tool permissions.</div>
        {agent.history?.length > 0 && (
          <div><div className="label mb-1">History</div>
            <ul className="text-2xs text-ink-3 space-y-0.5">{agent.history.slice().reverse().map((h: any) => <li key={h.version}>v{h.version} by {h.by}: {h.changes.join(", ")}</li>)}</ul></div>
        )}
        {err && <p className="text-sm text-danger">{err}</p>}
      </div>
    </Drawer>
  );
}
