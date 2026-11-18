"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { NewProject } from "@/components/NewProject";
import { Button, Empty, PageHeader, Spinner } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/api";

export default function Projects() {
  const { data, isLoading, mutate } = useApi<any[]>("/v1/projects");
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Projects" description="A project groups related capabilities, connectors, MCP servers and deployments."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>New project</Button>} />
      {isLoading ? <Spinner /> : !data?.length ? (
        <div className="panel"><Empty icon={<FolderKanban className="h-6 w-6" />} title="No projects yet"
          action={<Button variant="primary" onClick={() => setOpen(true)}>Create a project</Button>}>Projects own capabilities and the gateway URL slug.</Empty></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="panel p-4 hover:border-ink-4 transition-colors block">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{p.name}</div>
                  <div className="text-2xs text-ink-4 font-mono">/{p.slug}</div>
                </div>
                <span className="text-2xs text-ink-4 shrink-0">{timeAgo(p.updated_at)}</span>
              </div>
              {p.description && <p className="mt-2 text-sm text-ink-3 line-clamp-2">{p.description}</p>}
              <div className="mt-3 flex gap-4 text-xs text-ink-3">
                <span><b className="text-ink tabular-nums">{p.capability_count}</b> capabilities</span>
                <span><b className="text-ink tabular-nums">{p.active_deployments}</b> live deployments</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <NewProject open={open} onClose={() => setOpen(false)} onCreated={() => mutate()} />
    </>
  );
}

