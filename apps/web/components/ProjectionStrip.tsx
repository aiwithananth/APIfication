import clsx from "clsx";

const ITEMS = [
  { id: "rest", label: "REST", on: "bg-rest text-white", off: "bg-white text-ink-4 border-line" },
  { id: "graphql", label: "GraphQL", on: "bg-gql text-white", off: "bg-white text-ink-4 border-line" },
  { id: "mcp", label: "MCP", on: "bg-mcp text-white", off: "bg-white text-ink-4 border-line" },
];

/**
 * The projection strip: which interfaces one canonical capability is projected to.
 * Lit segments are generated from the spec; unlit ones are available but not exposed.
 */
export function ProjectionStrip({ interfaces, size = "md" }: { interfaces: string[]; size?: "sm" | "md" }) {
  return (
    <span className="inline-flex rounded-sm overflow-hidden border border-line" aria-label={`Interfaces: ${interfaces.join(", ") || "none"}`}>
      {ITEMS.map((i, idx) => {
        const on = interfaces.includes(i.id);
        return (
          <span
            key={i.id}
            title={on ? `${i.label} exposed` : `${i.label} not exposed`}
            className={clsx(
              "inline-flex items-center font-medium",
              size === "sm" ? "h-5 px-1.5 text-[10px]" : "h-6 px-2 text-2xs",
              idx > 0 && "border-l border-line",
              on ? i.on : i.off,
              !on && "line-through decoration-ink-4/50",
            )}
          >
            {i.label}
          </span>
        );
      })}
    </span>
  );
}

export function MethodTag({ method }: { method: string }) {
  const m = method.toUpperCase();
  return (
    <span className={clsx("inline-flex items-center justify-center w-14 h-5 rounded-sm text-[10px] font-semibold font-mono",
      m === "GET" && "bg-rest-soft text-rest",
      m === "POST" && "bg-signal-soft text-signal-2",
      (m === "PATCH" || m === "PUT") && "bg-warn-soft text-warn",
      m === "DELETE" && "bg-danger-soft text-danger")}>{m}</span>
  );
}
