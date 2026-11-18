"use client";

import clsx from "clsx";
import { Building2, Cpu, Fingerprint, KeyRound, Layers, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/settings", label: "Organisation", icon: Building2 },
  { href: "/settings/providers", label: "Model providers", icon: Cpu },
  { href: "/settings/assistant", label: "Assistant", icon: Sparkles },
  { href: "/settings/environments", label: "Environments", icon: Layers },
  { href: "/settings/identity", label: "Identity & access", icon: Fingerprint },
  { href: "/settings/secrets", label: "Secrets vault", icon: KeyRound },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[208px_1fr] gap-6">
      <nav aria-label="Settings" className="lg:sticky lg:top-0 self-start">
        <div className="text-lg font-semibold mb-3">Settings</div>
        <ul className="space-y-0.5">
          {ITEMS.map((i) => {
            const active = path === i.href;
            const Icon = i.icon;
            return (
              <li key={i.href}>
                <Link href={i.href} className={clsx("flex items-center gap-2.5 h-8 px-2.5 rounded text-sm",
                  active ? "bg-white border border-line font-medium" : "text-ink-3 hover:text-ink hover:bg-white/60")}>
                  <Icon className="h-4 w-4" strokeWidth={1.75} />{i.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
