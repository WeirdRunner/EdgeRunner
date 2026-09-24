"use client";

import { useState } from "react";
import { edge } from "@/lib/edge/runtime";

// What a code block can run in the in-browser workspace (Node.js + a POSIX-like shell).
const RUNNABLE_LANGS = new Set(["bash", "sh", "shell", "zsh", "javascript", "js", "mjs", "node", "typescript", "ts", "html", "htm"]);

export function isRunnable(lang: string | null): boolean {
  if (!lang) return false;
  return RUNNABLE_LANGS.has(lang.toLowerCase());
}

export function CodeRunner({
  getCode,
  lang,
}: {
  getCode: () => string;
  lang: string;
}) {
  const l = lang.toLowerCase();
  const isHtml = l === "html" || l === "htm";

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [htmlPreviewCode, setHtmlPreviewCode] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(true);

  async function run() {
    const rawCode = getCode().trim();
    if (!rawCode) return;

    if (isHtml) {
      setHtmlPreviewCode(rawCode);
      return;
    }

    setRunning(true);
    setOutput(null);
    setExitCode(null);
    setDurationMs(null);

    const started = performance.now();
    try {
      const res =
        l === "typescript" || l === "ts"
          ? await edge.run("npx", ["-y", "tsx", "-e", rawCode], { timeoutMs: 120_000 })
          : ["javascript", "js", "mjs", "node"].includes(l)
            ? await edge.run("node", ["--input-type=module", "-e", rawCode], { timeoutMs: 60_000 })
            : await edge.exec(rawCode, { timeoutMs: 120_000 });
      setOutput(res.output || "(no output)");
      setExitCode(res.code);
    } catch (e) {
      setOutput(`error: ${(e as Error).message}`);
      setExitCode(1);
    } finally {
      setDurationMs(Math.round(performance.now() - started));
      setRunning(false);
    }
  }

  return (
    <div className="border-t border-term-border/60 bg-term-panel/40 px-3 py-2 text-xs font-mono select-none">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 rounded border border-term-green/60 bg-term-green/10 px-2.5 py-1 text-[11px] font-semibold text-term-green transition-all hover:bg-term-green/20 hover:border-term-green hover:shadow-[0_0_12px_rgba(57,255,20,0.25)] active:scale-95 disabled:opacity-50"
          title="Execute code in the shared workspace sandbox"
        >
          <span>{running ? "⚡" : "▶"}</span>
          <span>{running ? "running…" : "run in workspace"}</span>
        </button>

        {exitCode !== null && (
          <div className="flex items-center gap-2 text-[10px]">
            <span
              className={`rounded px-1.5 py-0.2 font-bold ${
                exitCode === 0
                  ? "bg-term-green/20 text-term-green border border-term-green/40"
                  : "bg-term-red/20 text-term-red border border-term-red/40"
              }`}
            >
              ● exit {exitCode}
            </span>
            {durationMs !== null && (
              <span className="text-term-dim">{durationMs}ms</span>
            )}
            <button
              onClick={() => setExpanded((x) => !x)}
              className="text-term-dim hover:text-term-fg text-[9px] transition-colors"
            >
              {expanded ? "▾ hide" : "▸ show"}
            </button>
          </div>
        )}
      </div>

      {/* HTML Sandboxed Preview */}
      {htmlPreviewCode && (
        <div className="mt-2 rounded border border-term-border overflow-hidden bg-white">
          <iframe
            title="HTML Preview"
            sandbox="allow-scripts"
            className="w-full h-48 border-0"
            srcDoc={htmlPreviewCode}
          />
        </div>
      )}

      {/* Execution Output */}
      {output !== null && expanded && !isHtml && (
        <div className="mt-2 rounded border border-term-border/80 bg-term-bg/95 p-2 text-xs font-mono text-term-fg leading-relaxed overflow-x-auto max-h-48 whitespace-pre-wrap select-text shadow-inner">
          {output}
        </div>
      )}
    </div>
  );
}
