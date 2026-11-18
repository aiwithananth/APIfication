"use client";

import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, XCircle } from "lucide-react";

import { MethodTag, ProjectionStrip } from "./ProjectionStrip";
import { Badge } from "./ui";

export function OperationsTable({ spec, onSelect, selected }: { spec: any; onSelect?: (id: string) => void; selected?: string }) {
  const pol = Object.fromEntries((spec.policies || []).map((p: any) => [p.id, p]));
  return (
    <div className="overflow-x-auto"><table className="tbl">
      <thead><tr><th>Operation</th><th>REST</th><th>Interfaces</th><th>Scope · roles</th><th>Effect</th></tr></thead>
      <tbody>
        {spec.operations.map((o: any) => {
          const rest = o.interfaces.find((i: any) => i.kind === "rest");
          return (
            <tr key={o.id} onClick={() => onSelect?.(o.id)} className={clsx(onSelect && "cursor-pointer", selected === o.id && "bg-signal-soft/40")}>
              <td><div className="font-medium">{o.name}</div><div className="text-2xs text-ink-4 font-mono">{o.id}</div></td>
              <td>{rest ? <div className="flex items-center gap-2"><MethodTag method={rest.method} /><span className="font-mono text-xs">{rest.path}</span></div> : <span className="text-ink-4">—</span>}</td>
              <td><ProjectionStrip interfaces={o.interfaces.filter((i: any) => i.enabled !== false).map((i: any) => i.kind)} size="sm" /></td>
              <td><div className="font-mono text-xs">{o.required_scopes.join(", ")}</div>
                <div className="text-2xs text-ink-3">{(pol[o.policy_ref]?.roles || []).join(", ") || <span className="text-warn">any role</span>}</div></td>
              <td>
                <div className="flex flex-wrap gap-1">
                  <Badge tone={o.side_effect === "read" ? "neutral" : "warn"}>{o.side_effect}</Badge>
                  {o.approval_required && <Badge tone="warn">approval</Badge>}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}

/** Roles × operations matrix: who can do what, including row-level restrictions. */
export function RoleMatrix({ spec }: { spec: any }) {
  const roles: string[] = Array.from(new Set((spec.policies || []).flatMap((p: any) => p.roles))) as string[];
  const pol = Object.fromEntries((spec.policies || []).map((p: any) => [p.id, p]));
  if (!roles.length) return <p className="text-sm text-ink-3">No roles defined.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>Operation</th>{roles.map((r) => <th key={r} className="text-center font-mono">{r}</th>)}</tr></thead>
        <tbody>
          {spec.operations.map((o: any) => {
            const p = pol[o.policy_ref];
            return (
              <tr key={o.id}>
                <td>{o.name}</td>
                {roles.map((r) => {
                  const ok = p?.roles.includes(r);
                  const rf = p?.row_filters?.find((f: any) => f.when_role === r);
                  return (
                    <td key={r} className="text-center">
                      {ok ? (
                        <span className="inline-flex items-center gap-1 text-signal-2 text-xs" title={rf ? `Only rows where ${rf.field} = caller` : "Allowed"}>
                          <CheckCircle2 className="h-4 w-4" />{rf && <span className="text-2xs">assigned only</span>}
                          {o.approval_required && <span className="text-2xs text-warn">+approval</span>}
                        </span>
                      ) : <span className="text-ink-4/60">—</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FieldMap({ entity }: { entity: any }) {
  return (
    <table className="tbl">
      <thead><tr><th>Field</th><th>Type</th><th>Classification</th><th>Returned</th><th>Writable</th></tr></thead>
      <tbody>
        {entity.fields.map((f: any) => (
          <tr key={f.name}>
            <td className="font-mono text-xs">
              {f.name}
              {f.name === entity.primary_key && <Badge className="ml-1.5">key</Badge>}
              {f.name === entity.tenant_key && <Badge tone="info" className="ml-1.5">tenant</Badge>}
              {f.name === entity.owner_key && <Badge tone="info" className="ml-1.5">owner</Badge>}
            </td>
            <td className="text-xs text-ink-3">{f.type}</td>
            <td><Badge tone={f.classification === "restricted" ? "bad" : f.classification === "confidential" ? "warn" : "neutral"}>{f.classification}</Badge></td>
            <td className="text-xs">
              {!f.exposed ? <span className="text-danger">never</span>
                : f.masked_unless_scope ? <span>masked unless <code className="font-mono">{f.masked_unless_scope}</code></span>
                  : <span className="text-ink-3">yes</span>}
            </td>
            <td className="text-xs">{f.writable ? "yes" : <span className="text-ink-4">no</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ValidationList({ validation, onPick }: { validation: any; onPick?: (issue: any) => void }) {
  if (!validation) return null;
  const items = [...validation.errors, ...validation.warnings];
  if (!items.length) {
    return <div className="flex items-center gap-2 text-sm text-signal-2"><CheckCircle2 className="h-4 w-4" /> Valid — {validation.summary}</div>;
  }
  return (
    <ul className="space-y-1.5">
      {items.map((i: any, k: number) => (
        <li key={k}>
          <button onClick={() => onPick?.(i)} className="w-full text-left flex items-start gap-2 text-sm hover:bg-paper rounded px-1 py-0.5">
            {i.level === "error" ? <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 text-warn shrink-0 mt-0.5" />}
            <span><span className="font-mono text-2xs text-ink-4 mr-1.5">{i.code}</span>{i.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function NotesList({ assumptions, questions }: { assumptions: string[]; questions: string[] }) {
  return (
    <div className="space-y-3">
      {questions?.length > 0 && (
        <div>
          <div className="text-xs font-medium text-warn mb-1">Needs your decision</div>
          <ul className="space-y-1">{questions.map((q, i) => <li key={i} className="flex gap-2 text-sm"><HelpCircle className="h-4 w-4 text-warn shrink-0 mt-0.5" />{q}</li>)}</ul>
        </div>
      )}
      {assumptions?.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink-3 mb-1">Assumptions</div>
          <ul className="space-y-1">{assumptions.map((a, i) => <li key={i} className="flex gap-2 text-sm text-ink-2"><CircleDashed className="h-4 w-4 text-ink-4 shrink-0 mt-0.5" />{a}</li>)}</ul>
        </div>
      )}
      {!questions?.length && !assumptions?.length && <p className="text-sm text-ink-3">No assumptions were needed.</p>}
    </div>
  );
}

export function AgentTimeline({ steps, findings }: { steps: any[]; findings?: any[] }) {
  return (
    <div>
      <ol className="relative border-l border-line ml-2">
        {steps.map((s, i) => (
          <li key={i} className="ml-4 pb-3 last:pb-0">
            <span className={clsx("absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white",
              s.status === "completed" ? "bg-signal" : s.status === "skipped" ? "bg-ink-4" : "bg-danger")} />
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">{s.name}</span>
              <span className="text-2xs text-ink-4">{s.model} · {s.ms} ms</span>
            </div>
            <div className="text-xs text-ink-3">{s.summary}</div>
          </li>
        ))}
      </ol>
      {findings && findings.length > 0 && (
        <div className="mt-3 rounded border border-warn/30 bg-warn-soft/50 p-3">
          <div className="text-xs font-medium text-warn mb-1">Reviewer findings</div>
          <ul className="space-y-1 text-sm">{findings.map((f, i) => <li key={i}><Badge tone={f.severity === "high" || f.severity === "blocking" ? "bad" : "warn"} className="mr-1.5">{f.severity}</Badge>{f.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
