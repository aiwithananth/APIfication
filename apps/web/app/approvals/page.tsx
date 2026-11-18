"use client";

import { CheckSquare } from "lucide-react";
import { useState } from "react";

import { Badge, Button, CodeBlock, Empty, PageHeader, Panel, Spinner, statusTone, Tabs, useToast } from "@/components/ui";
import { post, refreshAll, timeAgo, useApi } from "@/lib/api";

export default function Approvals() {
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const { data, isLoading, mutate } = useApi<any[]>(`/v1/approvals${tab === "pending" ? "?status=pending" : ""}`);
  const toast = useToast();
  const [comment, setComment] = useState<Record<string, string>>({});

  async function decide(a: any, decision: "approve" | "reject") {
    try {
      const r = await post(`/v1/approvals/${a.id}/decision`, { decision, comment: comment[a.id] || "" });
      const res = r.result;
      toast(decision === "reject" ? "Rejected" : a.kind === "release" ? `Released to production (r${res?.revision_number})` : `Approved · operation returned ${res?.status}`);
      mutate(); refreshAll();
    } catch (e: any) { toast(e.message, "bad"); }
  }

  return (
    <>
      <PageHeader title="Approvals" description="Production releases and held operations wait here. On approval, a held operation runs with the original caller's identity." />
      <Tabs value={tab} onChange={setTab} className="mb-5" tabs={[{ id: "pending", label: "Pending" }, { id: "all", label: "All" }]} />
      {isLoading ? <Spinner /> : !data?.length ? (
        <div className="panel"><Empty icon={<CheckSquare className="h-6 w-6" />} title={tab === "pending" ? "Nothing waiting for approval" : "No approvals yet"} /></div>
      ) : (
        <div className="space-y-4">
          {data.map((a) => (
            <Panel key={a.id} title={a.name} actions={<><Badge tone={a.kind === "release" ? "info" : "warn"}>{a.kind === "release" ? "release" : "held operation"}</Badge><Badge tone={statusTone(a.status)}>{a.status}</Badge></>}>
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
                <div className="space-y-2 text-sm">
                  <div className="text-ink-3">Requested by <b className="text-ink">{a.requested_by}</b> · {timeAgo(a.created_at)} · {a.environment} · needs <code className="text-xs">{a.approver_role}</code></div>
                  {a.reason && <div>{a.reason}</div>}
                  {a.kind === "release" && a.evidence && (
                    <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
                      <dt className="text-ink-3">Revision</dt><dd>r{a.revision_number}</dd>
                      <dt className="text-ink-3">Digest</dt><dd className="font-mono break-all">{a.evidence.digest}</dd>
                      <dt className="text-ink-3">Validation</dt><dd>{a.evidence.validation}</dd>
                      <dt className="text-ink-3">Tests</dt><dd>{a.evidence.tests}</dd>
                    </dl>
                  )}
                  {a.kind === "operation" && (
                    <>
                      <div className="text-xs text-ink-3">Operation <code>{a.operation_id}</code> via {a.interface} as <b>{a.principal?.client_name}</b> ({(a.principal?.roles || []).join(", ")})</div>
                      <CodeBlock code={JSON.stringify(a.inputs, null, 2)} maxHeight={160} />
                    </>
                  )}
                  {a.execution && <div className="text-xs">Execution result: <Badge tone={a.execution.status < 300 ? "good" : "bad"}>{a.execution.status}</Badge></div>}
                  {a.decided_by && <div className="text-xs text-ink-3">Decided by {a.decided_by}{a.self_approved && <span className="text-warn"> (self-approved — disallow in Settings for production)</span>}{a.comment && ` · “${a.comment}”`}</div>}
                </div>
                {a.status === "pending" && (
                  <div className="space-y-2">
                    <textarea className="textarea" rows={3} placeholder="Comment for the audit record" value={comment[a.id] || ""} onChange={(e) => setComment({ ...comment, [a.id]: e.target.value })} />
                    <div className="flex gap-2 justify-end">
                      <Button variant="danger" onClick={() => decide(a, "reject")}>Reject</Button>
                      <Button variant="primary" onClick={() => decide(a, "approve")}>{a.kind === "release" ? "Approve release" : "Approve and run"}</Button>
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
