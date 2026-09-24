"use client";
// Where the coding agent works: the browser workspace, or a project folder on your Mac node.

import { useEffect, useRef, useState } from "react";
import { nodeInfo, type NodeProject } from "@/lib/agent/workspace";

export function TargetPicker({ value, onChange, onConnect }: { value: string; onChange: (t: string) => void; onConnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const [projects, setProjects] = useState<NodeProject[] | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    nodeInfo().then((i) => { setProjects(i.projects); setNodeError(null); }).catch((e) => { setProjects(null); setNodeError(e.message); });
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Remember names so the button can show them without asking the node every render.
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    try { setNames(JSON.parse(localStorage.getItem("edgerunner.node.names") || "{}")); } catch { /* none */ }
  }, []);
  useEffect(() => {
    if (!projects) return;
    const n = Object.fromEntries(projects.map((p) => [`node:${p.id}`, p.name]));
    setNames(n);
    localStorage.setItem("edgerunner.node.names", JSON.stringify(n));
  }, [projects]);

  const isNode = value.startsWith("node:");
  const label = isNode ? `Mac · ${names[value] || "project"}` : "Browser";

  const item = (t: string, text: string, sub?: string) => (
    <button key={t} onClick={() => { onChange(t); setOpen(false); }}
            className={`block w-full px-3 py-1.5 text-left hover:bg-term-green/10 ${value === t ? "text-term-green" : "text-term-fg"}`}>
      {text} {sub && <span className="block truncate text-[10px] text-term-dim">{sub}</span>}
    </button>
  );

  return (
    <div ref={box} className="relative">
      <button onClick={(e) => {
                // The composer bar scrolls horizontally and would clip a normal dropdown, so place it on the window.
                const r = e.currentTarget.getBoundingClientRect();
                setPos({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 4 });
                setOpen((o) => !o);
              }} title="Where the agent works"
              className="flex items-center gap-1.5 rounded border border-term-border px-2 sm:px-2.5 py-0.5 text-xs font-semibold text-term-dim hover:border-term-green hover:text-term-fg">
        <span className={`h-1.5 w-1.5 rounded-full ${isNode ? "bg-term-amber" : "bg-term-green"}`} />
        <span className="max-w-[120px] truncate">{label}</span>
        <span className="text-[10px]">▾</span>
      </button>
      {open && pos && (
        <div style={{ right: pos.right, bottom: pos.bottom }}
             className="fixed z-50 w-64 max-w-[calc(100vw-16px)] overflow-hidden rounded border border-term-border bg-term-panel font-mono text-xs shadow-xl">
          {item("browser", "Browser workspace", "Node.js sandbox in this tab")}
          <div className="border-t border-term-border px-3 py-1 text-[10px] uppercase text-term-dim">Mac node</div>
          {projects?.map((p) => item(`node:${p.id}`, p.name, p.path))}
          {projects && !projects.length && <div className="px-3 py-1.5 text-[11px] text-term-dim">No projects yet.</div>}
          {nodeError && <div className="px-3 py-1.5 text-[11px] text-term-dim">{nodeError}</div>}
          <button onClick={() => { setOpen(false); onConnect(); }} className="block w-full border-t border-term-border px-3 py-1.5 text-left text-term-dim hover:text-term-green">
            ⚙ Mac node settings…
          </button>
        </div>
      )}
    </div>
  );
}
