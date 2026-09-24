"use client";
// A real terminal: xterm.js connected to a shell running inside this browser tab (lib/edge/runtime.ts).

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { edge, type EdgeStatus } from "@/lib/edge/runtime";

export function EdgeTerminal({ className = "" }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<EdgeStatus>(edge.status);
  const [error, setError] = useState(edge.error);

  useEffect(() => edge.onChange(() => { setStatus(edge.status); setError(edge.error); }), []);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const css = getComputedStyle(document.documentElement);
      const term = new Terminal({
        convertEol: true, cursorBlink: true, fontSize: 13,
        fontFamily: "var(--font-mono), ui-monospace, Menlo, monospace",
        theme: { background: css.getPropertyValue("--term-bg").trim() || "#0b0f0b", foreground: "#d6e3d6", cursor: "#39ff14" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      cleanups.push(() => term.dispose());
      if (edge.support()) {
        term.writeln(`\x1b[33m${edge.support()}\x1b[0m`);
        return;
      }
      term.writeln("\x1b[2mStarting the in-browser workspace…\x1b[0m");
      try {
        const proc = await edge.shell({ cols: term.cols, rows: term.rows });
        if (disposed) { proc.kill(); return; }
        term.clear();
        const input = proc.input.getWriter();
        const sub = term.onData((d) => void input.write(d));
        void proc.output.pipeTo(new WritableStream({ write: (d) => term.write(d) })).catch(() => {});
        const ro = new ResizeObserver(() => {
          try { fit.fit(); proc.resize({ cols: term.cols, rows: term.rows }); } catch { /* hidden */ }
        });
        ro.observe(host.current!);
        cleanups.push(() => { ro.disconnect(); sub.dispose(); proc.kill(); });
        term.focus();
      } catch (e) {
        term.writeln(`\x1b[31mCouldn't start the workspace: ${(e as Error).message}\x1b[0m`);
      }
    })();
    return () => { disposed = true; cleanups.forEach((f) => f()); };
  }, []);

  return (
    <div className={`relative h-full w-full ${className}`}>
      {status === "booting" && (
        <div className="absolute right-3 top-2 z-10 text-[11px] text-term-dim">booting workspace…</div>
      )}
      {status === "error" && (
        <div className="absolute right-3 top-2 z-10 text-[11px] text-red-400" title={error}>workspace error</div>
      )}
      <div ref={host} className="h-full w-full p-2" />
    </div>
  );
}
