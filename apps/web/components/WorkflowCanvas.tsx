"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge, Background, Connection, Controls, Edge, Handle, MarkerType, MiniMap, Node, NodeProps, Position, ReactFlow,
  ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
} from "@xyflow/react";
import clsx from "clsx";
import * as Icons from "lucide-react";
import { AlertTriangle, Search, Trash2, XCircle } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Field, Select, TagInput, Toggle } from "./ui";

import { CAT_COLORS } from "@/lib/colors";

export { CAT_COLORS };

type NodeDef = { type: string; label: string; category: string; icon: string; description: string; inputs: string[]; outputs: string[]; config: any[] };
type Catalogue = { categories: { id: string; label: string }[]; nodes: NodeDef[] };

function iconFor(name: string): React.ElementType {
  const key = name.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return (Icons as any)[key] || Icons.Box;
}

/* ------------------------------------------------------------------ node renderer */
function ApfNode({ data, selected }: NodeProps<Node<any>>) {
  const def: NodeDef | undefined = data.def;
  const n = data.node;
  const issues: any[] = data.issues || [];
  const color = CAT_COLORS[def?.category || "logic"];
  const Icon = iconFor(def?.icon || "box");
  const hasErr = issues.some((i) => i.level === "error");
  const outs = def?.outputs || [];
  const ins = def?.inputs || [];
  const summary = nodeSummary(n);
  return (
    <div className={clsx("bg-white rounded-md border w-[196px] shadow-sm", selected ? "border-signal ring-2 ring-signal/20" : hasErr ? "border-danger" : "border-line")}>
      <div className="flex items-center gap-2 px-2.5 h-8 border-b border-line-2" style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <div className="text-xs font-medium truncate">{n.label || def?.label || n.type}</div>
        {issues.length > 0 && (hasErr ? <XCircle className="ml-auto h-3.5 w-3.5 text-danger" /> : <AlertTriangle className="ml-auto h-3.5 w-3.5 text-warn" />)}
      </div>
      <div className="px-2.5 py-1.5">
        <div className="text-[10px] text-ink-4 font-mono truncate">{n.type}</div>
        {summary && <div className="text-[11px] text-ink-2 truncate mt-0.5" title={summary}>{summary}</div>}
      </div>
      {ins.map((p, i) => (
        <Handle key={p} id={p} type="target" position={Position.Left} style={{ top: 16 + i * 14, background: "#7A8699" }} />
      ))}
      {outs.map((p, i) => (
        <React.Fragment key={p}>
          <Handle id={p} type="source" position={Position.Right}
            style={{ top: outs.length === 1 ? "50%" : 18 + i * 22, background: p === "denied" || p === "invalid" || p === "error" ? "#B42318" : p === "empty" || p === "false" ? "#9A6212" : color }} />
          {outs.length > 1 && (
            <span className="absolute -right-1 translate-x-full text-[9px] text-ink-4 pl-1.5" style={{ top: 18 + i * 22 - 7 }}>{p}</span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function nodeSummary(n: any): string {
  const c = n.config || {};
  switch (n.type) {
    case "security.authorize": return `${c.policy_ref || "no policy"}${c.required_scopes?.length ? " · " + c.required_scopes.join(", ") : ""}`;
    case "database.select": return `${c.entity || "?"} · ${c.mode || "many"}${c.key_param ? " by " + c.key_param : ""}`;
    case "database.update": return `${c.entity || "?"} · ${c.set_values ? Object.entries(c.set_values).map(([k, v]) => `${k}=${v}`).join(", ") : (c.allowed_fields || []).length + " field(s)"}`;
    case "database.insert": return `${c.entity || "?"} · ${(c.allowed_fields || []).length} field(s)`;
    case "data.redact": return `${c.entity || "?"} classification rules`;
    case "security.approval": return `approver: ${c.approver_role || "?"}`;
    case "output.error": return `${c.status || ""} ${c.message || ""}`;
    case "output.response": return c.status ? `status ${c.status}` : "";
    case "http.request": return `${c.method || "GET"} ${c.url || ""}`;
    case "logic.condition": return `${c.field || "?"} ${c.op || "eq"} ${c.value ?? ""}`;
    default: return "";
  }
}

const nodeTypes = { apf: ApfNode };

/* ------------------------------------------------------------------ conversions */
function toFlow(wf: any, defs: Record<string, NodeDef>, issues: any[]): { nodes: Node[]; edges: Edge[] } {
  const layout = wf.layout || {};
  const nodes: Node[] = wf.nodes.map((n: any, i: number) => ({
    id: n.id, type: "apf", position: layout[n.id] || { x: 40 + i * 240, y: 120 },
    data: { node: n, def: defs[n.type], issues: issues.filter((x) => x.node_id === n.id) },
  }));
  const edges: Edge[] = wf.edges.map((e: any, i: number) => edgeOf(e, i));
  return { nodes, edges };
}

function edgeOf(e: any, i: number): Edge {
  const bad = ["denied", "invalid", "error"].includes(e.source_port);
  return {
    id: e.id || `e${i}-${e.source}-${e.target}`, source: e.source, target: e.target,
    sourceHandle: e.source_port || "out", targetHandle: e.target_port || "in",
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: bad ? "#B42318" : "#9AA6B5" },
    style: bad ? { stroke: "#E3A5A0", strokeDasharray: "4 3" } : undefined,
    animated: false,
  };
}

function toIR(nodes: Node[], edges: Edge[], prev: any) {
  return {
    ...prev,
    nodes: nodes.map((n) => (n.data as any).node),
    edges: edges.map((e) => ({ id: e.id, source: e.source, source_port: e.sourceHandle || "out", target: e.target, target_port: e.targetHandle || "in" })),
    layout: Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])),
  };
}

/* ------------------------------------------------------------------ main component */
export function WorkflowCanvas(props: {
  workflow: any; catalogue: Catalogue; spec: any; providers: any[]; issues: any[]; onChange: (wf: any) => void; height?: number;
}) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ workflow, catalogue, spec, providers, issues, onChange, height = 560 }: {
  workflow: any; catalogue: Catalogue; spec: any; providers: any[]; issues: any[]; onChange: (wf: any) => void; height?: number;
}) {
  const defs = useMemo(() => Object.fromEntries(catalogue.nodes.map((n) => [n.type, n])), [catalogue]);
  const init = useMemo(() => toFlow(workflow, defs, issues), [workflow, defs, issues]);
  const [nodes, setNodes, onNodesChange] = useNodesState(init.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(init.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const wrapper = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const wfRef = useRef(workflow);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // reset when a different workflow is loaded
  useEffect(() => {
    if (wfRef.current !== workflow) {
      wfRef.current = workflow;
      const f = toFlow(workflow, defs, issues);
      setNodes(f.nodes); setEdges(f.edges); setSelected(null);
    }
  }, [workflow, defs, issues, setNodes, setEdges]);
  // refresh issue markers without resetting positions
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...(n.data as any), issues: issues.filter((x) => x.node_id === n.id) } })));
  }, [issues, setNodes]);

  const emit = useCallback((ns: Node[], es: Edge[]) => {
    const ir = toIR(ns, es, wfRef.current);
    wfRef.current = ir;
    onChange(ir);
  }, [onChange]);

  const isValidConnection = useCallback((c: Connection | Edge) => {
    const s = nodes.find((n) => n.id === c.source);
    const t = nodes.find((n) => n.id === c.target);
    if (!s || !t || s.id === t.id) return false;
    const sd = defs[(s.data as any).node.type];
    const td = defs[(t.data as any).node.type];
    return !!sd?.outputs.includes(c.sourceHandle || "") && !!td?.inputs.includes(c.targetHandle || "");
  }, [nodes, defs]);

  const onConnect = useCallback((c: Connection) => {
    const next = addEdge(edgeOf({ source: c.source, target: c.target, source_port: c.sourceHandle, target_port: c.targetHandle, id: `e${Date.now()}` }, 0), edgesRef.current);
    setEdges(next);
    emit(nodesRef.current, next);
  }, [setEdges, emit]);

  function addNode(type: string, pos?: { x: number; y: number }) {
    const def = defs[type];
    const base = type.split(".").pop();
    let id = base!;
    let k = 2;
    while (nodes.some((n) => n.id === id)) id = `${base}_${k++}`;
    const config: any = {};
    if (def.config.some((f) => f.key === "entity") && spec.entities[0]) config.entity = spec.entities[0].name;
    const node: Node = {
      id, type: "apf", position: pos || { x: 80 + nodes.length * 30, y: 60 + nodes.length * 20 },
      data: { node: { id, type, label: def.label, config }, def, issues: [] },
    };
    const next = [...nodes, node];
    setNodes(next); setSelected(id); emit(next, edges);
  }

  function updateNode(id: string, patch: any) {
    const next = nodes.map((n) => n.id === id ? { ...n, data: { ...(n.data as any), node: { ...(n.data as any).node, ...patch } } } : n);
    setNodes(next); emit(next, edges);
  }

  function removeSelected() {
    if (!selected) return;
    const ns = nodes.filter((n) => n.id !== selected);
    const es = edges.filter((e) => e.source !== selected && e.target !== selected);
    setNodes(ns); setEdges(es); setSelected(null); emit(ns, es);
  }

  const sel = nodes.find((n) => n.id === selected);
  const selNode = sel ? (sel.data as any).node : null;
  const selDef = selNode ? defs[selNode.type] : null;
  const selIssues = issues.filter((i) => i.node_id === selected);

  return (
    <div className="relative flex border border-line rounded-md overflow-hidden bg-white" style={{ height }}>
      {/* palette */}
      <div className="w-[200px] shrink-0 border-r border-line flex flex-col">
        <div className="p-2 border-b border-line">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-2.5 text-ink-4" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find node" className="input h-8 pl-7 text-xs" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {catalogue.categories.map((cat) => {
            const items = catalogue.nodes.filter((n) => n.category === cat.id && (n.label + n.type).toLowerCase().includes(filter.toLowerCase()));
            if (!items.length) return null;
            return (
              <div key={cat.id}>
                <div className="text-2xs text-ink-4 px-1 mb-1">{cat.label}</div>
                {items.map((n) => {
                  const Icon = iconFor(n.icon);
                  return (
                    <button key={n.type} draggable title={n.description}
                      onDragStart={(e) => { e.dataTransfer.setData("application/apf-node", n.type); e.dataTransfer.effectAllowed = "move"; }}
                      onClick={() => addNode(n.type)}
                      className="w-full flex items-center gap-2 px-2 h-7 rounded text-xs text-left hover:bg-paper cursor-grab">
                      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: CAT_COLORS[n.category] }} />
                      <span className="truncate">{n.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="p-2 border-t border-line text-2xs text-ink-4">Drag onto the canvas or click to add. Connect output ports to input ports.</div>
      </div>

      {/* canvas */}
      <div ref={wrapper} className="flex-1 relative"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
        onDrop={(e) => {
          e.preventDefault();
          const type = e.dataTransfer.getData("application/apf-node");
          if (type) addNode(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={(ch) => {
            onNodesChange(ch);
            if (ch.some((c) => c.type === "remove")) {
              setSelected(null);
              setTimeout(() => {
                const ids = new Set(nodesRef.current.map((n) => n.id));
                const es = edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target));
                setEdges(es);
                emit(nodesRef.current, es);
              }, 0);
            }
          }}
          onNodeDragStop={() => setTimeout(() => emit(nodesRef.current, edgesRef.current), 0)}
          onEdgesChange={(ch) => {
            onEdgesChange(ch);
            if (ch.some((c) => c.type === "remove")) setTimeout(() => emit(nodesRef.current, edgesRef.current), 0);
          }}
          onConnect={onConnect} isValidConnection={isValidConnection}
          onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)}
          fitView fitViewOptions={{ padding: 0.12, maxZoom: 1.05 }} minZoom={0.3} maxZoom={1.6}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} color="#DCE2E8" />
          <Controls showInteractive={false} position="bottom-left" />
          <div className="absolute left-3 top-3 z-[5] flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-3 bg-white/80 rounded px-2 py-1">
            {Object.entries(CAT_COLORS).map(([k, c]) => (
              <span key={k} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: c }} />{catalogue.categories.find((x) => x.id === k)?.label}</span>
            ))}
          </div>
          <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => CAT_COLORS[(n.data as any)?.def?.category] || "#ccc"} maskColor="rgba(243,245,247,0.7)" style={{ width: 140, height: 90 }} />
        </ReactFlow>
      </div>

      {/* inspector (overlay, only while a node is selected) */}
      {selNode && selDef && (
      <div className="absolute right-0 top-0 bottom-0 w-[300px] border-l border-line flex flex-col bg-white shadow-pop z-10">
          <>
            <div className="px-4 h-11 flex items-center justify-between border-b border-line">
              <div className="text-sm font-semibold truncate">{selDef.label}</div>
              <div className="flex items-center gap-2">
                <button onClick={removeSelected} className="text-ink-3 hover:text-danger" aria-label="Delete node"><Trash2 className="h-4 w-4" /></button>
                <button onClick={() => setSelected(null)} className="text-ink-3 hover:text-ink" aria-label="Close inspector"><Icons.X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-xs text-ink-3">{selDef.description}</p>
              {selIssues.map((i, k) => (
                <div key={k} className={clsx("text-xs rounded px-2 py-1.5", i.level === "error" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn")}>{i.message}</div>
              ))}
              <Field label="Label"><input className="input" value={selNode.label || ""} onChange={(e) => updateNode(selNode.id, { label: e.target.value })} /></Field>
              <Field label="Node ID"><input className="input font-mono text-xs" value={selNode.id} disabled /></Field>
              {selDef.config.map((f: any) => (
                <ConfigField key={f.key} f={f} value={selNode.config?.[f.key]} spec={spec} providers={providers}
                  onChange={(v) => updateNode(selNode.id, { config: { ...selNode.config, [f.key]: v } })} />
              ))}
              <div className="text-2xs text-ink-4 pt-2 border-t border-line-2">
                Ports — in: {selDef.inputs.join(", ") || "none"} · out: {selDef.outputs.join(", ") || "none"}
              </div>
            </div>
          </>
      </div>
      )}
    </div>
  );
}

function ConfigField({ f, value, onChange, spec, providers }: { f: any; value: any; onChange: (v: any) => void; spec: any; providers: any[] }) {
  const label = f.label + (f.required ? " *" : "");
  switch (f.type) {
    case "textarea":
      return <Field label={label} hint={f.help}><textarea className="textarea text-xs" rows={4} value={value || ""} onChange={(e) => onChange(e.target.value)} /></Field>;
    case "number":
      return <Field label={label} hint={f.help}><input type="number" className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} /></Field>;
    case "bool":
      return <Toggle checked={!!value} onChange={onChange} label={f.label} />;
    case "select":
      return <Field label={label}><Select value={value || ""} onChange={onChange} placeholder="Select" options={f.options.map((o: string) => ({ value: o, label: o }))} /></Field>;
    case "tags":
      return <Field label={label} hint={f.help}><TagInput value={value || []} onChange={onChange}
        suggestions={f.key.includes("scope") ? spec.scopes.map((s: any) => s.name) : spec.entities.flatMap((e: any) => e.fields.map((x: any) => x.name))} /></Field>;
    case "json":
      return <JsonField label={label} help={f.help} value={value} onChange={onChange} />;
    case "entity":
      return <Field label={label}><Select value={value || ""} onChange={onChange} placeholder="Select entity" options={spec.entities.map((e: any) => ({ value: e.name, label: `${e.name} (${e.resource})` }))} /></Field>;
    case "policy":
      return <Field label={label}><Select value={value || ""} onChange={onChange} placeholder="Select policy" options={spec.policies.map((p: any) => ({ value: p.id, label: p.name }))} /></Field>;
    case "provider":
      return <Field label={label}><Select value={value || ""} onChange={onChange} placeholder="Select provider" options={providers.map((p: any) => ({ value: p.id, label: `${p.name}${p.model ? " · " + p.model : ""}` }))} /></Field>;
    default:
      return <Field label={label} hint={f.help}><input className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></Field>;
  }
}

function JsonField({ label, help, value, onChange }: { label: string; help?: string; value: any; onChange: (v: any) => void }) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : "");
  const [err, setErr] = useState<string>();
  useEffect(() => { setText(value ? JSON.stringify(value, null, 2) : ""); }, [value]);
  return (
    <Field label={label} hint={help} error={err}>
      <textarea className="textarea font-mono text-xs" rows={4} value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) { onChange(undefined); setErr(undefined); return; }
          try { onChange(JSON.parse(text)); setErr(undefined); } catch { setErr("Invalid JSON"); }
        }} />
    </Field>
  );
}
