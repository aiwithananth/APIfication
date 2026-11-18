"use client";

import clsx from "clsx";
import {
  Activity, BookOpen, Bot, Boxes, CheckSquare, ChevronsLeft, ChevronsRight, Database, FlaskConical, FolderKanban,
  LayoutDashboard, Rocket, Search, Settings, Shield, Sparkles, Waypoints, Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";

import { useApi } from "@/lib/api";
import { Assistant } from "./Assistant";
import { Env, useApp } from "./AppContext";

type NavItem = { href: string; label: string; icon: React.ElementType; badge?: string };
const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Build", items: [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/projects", label: "Projects", icon: FolderKanban },
    { href: "/build", label: "API Builder", icon: Sparkles },
    { href: "/capabilities", label: "Capabilities", icon: Workflow },
    { href: "/connectors", label: "Connectors", icon: Database },
  ] },
  { group: "Interfaces", items: [
    { href: "/graphql", label: "GraphQL Studio", icon: Boxes },
    { href: "/mcp", label: "MCP Studio", icon: Waypoints },
    { href: "/agents", label: "Agentic Workspace", icon: Bot },
  ] },
  { group: "Govern", items: [
    { href: "/security", label: "Security & Policies", icon: Shield },
    { href: "/testing", label: "Testing", icon: FlaskConical },
    { href: "/deployments", label: "Deployments", icon: Rocket },
    { href: "/approvals", label: "Approvals", icon: CheckSquare, badge: "approvals" },
  ] },
  { group: "Operate", items: [
    { href: "/monitoring", label: "Monitoring & Audit", icon: Activity },
    { href: "/portal", label: "Developer Portal", icon: BookOpen },
  ] },
];

const ENVS: { id: Env; label: string; cls: string }[] = [
  { id: "development", label: "Development", cls: "bg-signal" },
  { id: "staging", label: "Staging", cls: "bg-warn" },
  { id: "production", label: "Production", cls: "bg-danger" },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { env, setEnv, assistantOpen, setAssistantOpen } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const { data: approvals } = useApi<any[]>("/v1/approvals?status=pending", { refreshInterval: 15000 });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") { e.preventDefault(); setAssistantOpen(!assistantOpen); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [assistantOpen, setAssistantOpen]);

  const pending = approvals?.length ?? 0;
  const current = NAV.flatMap((g) => g.items).find((i) => isActive(path, i.href)) ?? (path.startsWith("/settings") ? { label: "Settings" } : null);

  return (
    <div className="h-screen flex overflow-hidden">
      {/* ---------------------------------------------------------------- sidebar */}
      <nav aria-label="Main" className={clsx("bg-ink text-white/80 flex flex-col shrink-0 transition-[width] duration-200", collapsed ? "w-[60px]" : "w-[232px]")}>
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-white/10">
          <Logo />
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-[15px] font-semibold text-white tracking-[-0.01em]">APIfication</div>
              <div className="text-2xs text-white/45">Capability fabric</div>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-3">
          {NAV.map((g) => (
            <div key={g.group} className="mb-3">
              {!collapsed && <div className="px-4 pb-1 text-2xs text-white/40">{g.group}</div>}
              {g.items.map((it) => {
                const active = isActive(path, it.href);
                const Icon = it.icon;
                return (
                  <Link key={it.href} href={it.href} title={collapsed ? it.label : undefined}
                    className={clsx("relative flex items-center gap-2.5 mx-2 px-2.5 h-8 rounded text-[13px] transition-colors",
                      active ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white")}>
                    {active && <span className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-full bg-signal" />}
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    {!collapsed && <span className="truncate">{it.label}</span>}
                    {it.badge === "approvals" && pending > 0 && (
                      <span className={clsx("ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-warn text-white text-[10px] font-semibold flex items-center justify-center",
                        collapsed && "absolute right-0.5 top-0.5 ml-0")}>{pending}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-white/10 py-2">
          <Link href="/settings" className={clsx("flex items-center gap-2.5 mx-2 px-2.5 h-8 rounded text-[13px]",
            path.startsWith("/settings") ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white")}>
            <Settings className="h-4 w-4" strokeWidth={1.75} />{!collapsed && "Settings"}
          </Link>
          <button onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-2.5 mx-2 px-2.5 h-8 rounded text-[13px] hover:bg-white/5 w-[calc(100%-16px)]"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
          </button>
        </div>
      </nav>

      {/* ---------------------------------------------------------------- main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 bg-white border-b border-line flex items-center gap-3 px-5">
          <div className="text-sm text-ink-3 truncate">{current?.label}</div>
          <button onClick={() => setPalette(true)}
            className="ml-4 flex items-center gap-2 h-8 w-[min(420px,40vw)] px-3 rounded border border-line text-sm text-ink-4 hover:border-ink-4 bg-paper/50">
            <Search className="h-3.5 w-3.5" /> Search or jump to…
            <span className="ml-auto kbd">⌘K</span>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">Environment</span>
              <span className={clsx("h-2 w-2 rounded-full", ENVS.find((e) => e.id === env)?.cls)} />
              <select value={env} onChange={(e) => setEnv(e.target.value as Env)} className="bg-transparent text-sm font-medium outline-none cursor-pointer">
                {ENVS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </label>
            <span className="h-5 w-px bg-line" />
            <button onClick={() => setAssistantOpen(!assistantOpen)}
              className={clsx("flex items-center gap-1.5 h-8 px-3 rounded text-sm font-medium transition-colors",
                assistantOpen ? "bg-ink text-white" : "bg-signal-soft text-signal-2 hover:bg-signal/15")}>
              <Sparkles className="h-3.5 w-3.5" /> Assistant
            </button>
            <div className="h-8 w-8 rounded-full bg-ink-2 text-white text-xs font-semibold flex items-center justify-center" title="Platform Admin">PA</div>
          </div>
        </header>
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 overflow-y-auto min-w-0">
            <div className="max-w-[1320px] mx-auto px-6 py-6">{children}</div>
          </main>
          {assistantOpen && <Assistant onClose={() => setAssistantOpen(false)} />}
        </div>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

function Logo() {
  // three projections from one source: the product's mark
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <rect x="1" y="9" width="8" height="8" rx="2" fill="#0F7B6C" />
      <path d="M9 13 L17 4.5 M9 13 L17 13 M9 13 L17 21.5" stroke="#fff" strokeOpacity=".55" strokeWidth="1.4" />
      <circle cx="19.5" cy="4.5" r="2.5" fill="#2D5BD3" />
      <circle cx="19.5" cy="13" r="2.5" fill="#B8326F" />
      <circle cx="19.5" cy="21.5" r="2.5" fill="#6447D6" />
    </svg>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const { data: caps } = useApi<any[]>("/v1/capabilities");
  const { data: projects } = useApi<any[]>("/v1/projects");
  const { data: conns } = useApi<any[]>("/v1/connectors");
  const { askAssistant } = useApp();

  const items = useMemo(() => {
    const all: { label: string; hint: string; go: () => void }[] = [
      ...NAV.flatMap((g) => g.items.map((i) => ({ label: i.label, hint: g.group, go: () => router.push(i.href) }))),
      { label: "Settings", hint: "Settings", go: () => router.push("/settings") },
      { label: "Model providers", hint: "Settings", go: () => router.push("/settings/providers") },
      { label: "New connector", hint: "Action", go: () => router.push("/connectors/new") },
      ...(caps || []).map((c) => ({ label: c.name, hint: `Capability · ${c.project_name}`, go: () => router.push(`/capabilities/${c.id}`) })),
      ...(projects || []).map((p) => ({ label: p.name, hint: "Project", go: () => router.push(`/projects/${p.id}`) })),
      ...(conns || []).map((c) => ({ label: c.name, hint: "Connector", go: () => router.push(`/connectors/${c.id}`) })),
    ];
    const f = q ? all.filter((i) => (i.label + " " + i.hint).toLowerCase().includes(q.toLowerCase())) : all.slice(0, 12);
    if (q.length > 2) f.push({ label: `Ask the assistant: “${q}”`, hint: "Assistant", go: () => askAssistant(q) });
    return f.slice(0, 14);
  }, [q, caps, projects, conns, router, askAssistant]);

  useEffect(() => setIdx(0), [q]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onKeyDown={(e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
      if (e.key === "Enter" && items[idx]) { items[idx].go(); onClose(); }
    }}>
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative w-full max-w-[560px] bg-white rounded-md shadow-pop overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
          <Search className="h-4 w-4 text-ink-4" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a page, capability, project or connector"
            className="flex-1 text-sm outline-none" />
          <span className="kbd">Esc</span>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-1" role="listbox">
          {items.map((it, i) => (
            <li key={it.label + it.hint} role="option" aria-selected={i === idx}>
              <button onMouseEnter={() => setIdx(i)} onClick={() => { it.go(); onClose(); }}
                className={clsx("w-full flex items-center justify-between px-4 h-9 text-sm text-left", i === idx && "bg-paper")}>
                <span className="truncate">{it.label}</span><span className="text-2xs text-ink-4 ml-3 shrink-0">{it.hint}</span>
              </button>
            </li>
          ))}
          {!items.length && <li className="px-4 py-6 text-sm text-ink-3 text-center">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
