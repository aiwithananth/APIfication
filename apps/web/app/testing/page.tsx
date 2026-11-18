"use client";

import clsx from "clsx";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Badge, Empty, PageHeader, Panel, Spinner, statusTone } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/api";

function Testing() {
  const sp = useSearchParams();
  const cap = sp.get("capability");
  const { data, isLoading } = useApi<any[]>(`/v1/test-runs${cap ? `?capability_id=${cap}` : ""}`);
  const [sel, setSel] = useState(sp.get("run") || "");
  const run = data?.find((r) => r.id === sel) || data?.[0];
  const [filter, setFilter] = useState<"all" | "failed">("all");
  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="Testing & validation" description="Generated suites cover positive, negative, role-matrix, tenant isolation, redaction, injection and validation cases. A revision must pass before it can reach staging." />
      {!data?.length ? <div className="panel"><Empty icon={<FlaskConical className="h-6 w-6" />} title="No test runs yet">Open a capability and select Run tests.</Empty></div> : (
        <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-5 items-start">
          <Panel title="Runs" bodyClass="p-2">
            <ul className="space-y-0.5">{data.map((r) => (
              <li key={r.id}><button onClick={() => setSel(r.id)} className={clsx("w-full text-left px-2 py-1.5 rounded flex items-center gap-2", r.id === run?.id ? "bg-signal-soft" : "hover:bg-paper")}>
                <Badge tone={statusTone(r.status)}>{r.passed}/{r.total}</Badge>
                <div className="min-w-0"><div className="text-sm truncate">{r.name}</div><div className="text-2xs text-ink-4">{r.environment} · {timeAgo(r.created_at)}</div></div>
              </button></li>
            ))}</ul>
          </Panel>
          {run && (
            <Panel title={run.name} actions={<>
              <button onClick={() => setFilter(filter === "all" ? "failed" : "all")} className="text-xs text-ink-3 hover:text-ink">{filter === "all" ? "Show failures only" : "Show all"}</button>
              <Link href={`/capabilities/${run.capability_id}?tab=tests`} className="text-xs text-signal-2 hover:underline">Open capability</Link>
            </>} bodyClass="p-0">
              <div className="px-4 py-3 border-b border-line flex flex-wrap gap-4 text-sm">
                <span><b className="tabular-nums">{run.passed}</b> passed</span>
                <span className={run.failed ? "text-danger" : ""}><b className="tabular-nums">{run.failed}</b> failed</span>
                <span className="text-ink-3">{run.duration_ms} ms · revision {run.revision_number} · by {run.actor}</span>
              </div>
              <table className="tbl"><thead><tr><th>Test</th><th>Category</th><th>Status</th><th>Result</th><th className="text-right">ms</th></tr></thead>
                <tbody>{run.results.filter((r: any) => filter === "all" || !r.passed).map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.name}<div className="text-2xs text-ink-4 font-mono">{r.operation_id}</div></td>
                    <td><Badge>{r.category}</Badge></td>
                    <td className="tabular-nums text-xs">{r.status}</td>
                    <td>{r.passed ? <Badge tone="good">passed</Badge> : <span className="text-xs text-danger">{r.problems.join("; ")}</span>}</td>
                    <td className="text-right text-2xs text-ink-4 tabular-nums">{r.ms}</td>
                  </tr>
                ))}</tbody></table>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() { return <Suspense><Testing /></Suspense>; }
