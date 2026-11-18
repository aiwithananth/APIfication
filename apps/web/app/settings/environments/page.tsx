"use client";

import clsx from "clsx";

import { PageHeader, Panel, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";

const DOT: Record<string, string> = { development: "bg-signal", staging: "bg-warn", production: "bg-danger" };

export default function Environments() {
  const { data } = useApi<any[]>("/v1/environments");
  if (!data) return <Spinner />;
  return (
    <>
      <PageHeader title="Environments" description="Promotion gates are enforced by the deployment controller. Each environment has its own gateway URL." />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {data.map((e, i) => (
          <Panel key={e.name} title={<span className="flex items-center gap-2 capitalize"><span className={clsx("h-2 w-2 rounded-full", DOT[e.name])} />{e.name}</span>}>
            <div className="text-xs text-ink-3">Step {i + 1} · gate</div>
            <div className="text-sm font-medium">{e.gate}</div>
            <div className="mt-3 text-xs text-ink-3">Gateway</div>
            <code className="text-xs">/gw/{e.name}/&lt;project&gt;/api</code>
            {e.name === "production" && <p className="mt-3 text-2xs text-ink-4">GraphQL introspection disabled · wildcard scopes refused · schema download disabled.</p>}
          </Panel>
        ))}
      </div>
    </>
  );
}
