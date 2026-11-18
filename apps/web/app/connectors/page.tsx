"use client";

import { Database, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Badge, Button, Empty, PageHeader, Spinner, StatusDot } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/api";

export default function Connectors() {
  const { data, isLoading } = useApi<any[]>("/v1/connectors");
  const { data: types } = useApi<any[]>("/v1/connectors/types");
  const router = useRouter();
  const label = (t: string) => types?.find((x) => x.type === t)?.label || t;
  return (
    <>
      <PageHeader title="Connectors" description="Registered databases and existing APIs. Credentials live in the vault; the browser never connects to a database."
        actions={<Link href="/connectors/new"><Button variant="primary" icon={<Plus className="h-4 w-4" />}>New connector</Button></Link>} />
      <div className="panel">
        {isLoading ? <Spinner /> : !data?.length ? (
          <Empty icon={<Database className="h-6 w-6" />} title="No connectors yet" action={<Link href="/connectors/new"><Button variant="primary">Register a database</Button></Link>}>
            Connect PostgreSQL or an existing API. New connectors start read-only.
          </Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th>Environment</th><th>Access</th><th>Tables</th><th>Health</th><th className="text-right">Updated</th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} className="cursor-pointer" onClick={() => router.push(`/connectors/${c.id}`)}>
                <td><div className="font-medium">{c.name}</div><div className="text-2xs text-ink-4">{c.owner}</div></td>
                <td className="text-ink-2">{label(c.type)}</td>
                <td><Badge>{c.environment}</Badge></td>
                <td>{c.read_only ? <Badge>read-only</Badge> : <Badge tone="warn">read/write</Badge>}</td>
                <td className="tabular-nums">{c.table_count}</td>
                <td><span className="inline-flex items-center gap-1.5 text-xs"><StatusDot tone={c.health === "healthy" ? "good" : c.health === "failing" ? "bad" : "neutral"} />{c.health}</span></td>
                <td className="text-right text-2xs text-ink-4">{timeAgo(c.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {types && (
        <div className="mt-5 text-xs text-ink-3">
          Supported now: {types.filter((t) => t.status === "supported").map((t) => t.label).join(", ")}.
          Planned: {types.filter((t) => t.status === "planned").map((t) => t.label).join(", ")}.
        </div>
      )}
    </>
  );
}
