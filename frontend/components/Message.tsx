"use client";

import { useMemo, useState } from "react";

import type { Role, ToolEvent } from "@/lib/api";
import type { MessageStats } from "@/lib/storage";
import { Markdown } from "./Markdown";

interface MessageProps {
  role: Role;
  content: string;
  tools?: ToolEvent[];
  stats?: MessageStats;
  streaming?: boolean;
  harness?: string;
  onDelete?: () => void;
  onEdit?: (newContent: string) => void;
  onFork?: () => void;
}

export function Message({
  role,
  content,
  tools,
  stats,
  streaming,
  harness = "chat",
  onDelete,
  onEdit,
  onFork,
}: MessageProps) {
  const isTerminal = harness === "terminal";
  const isAgent = harness === "agent";
  const isDeepSeek = harness === "deepseek" || harness === "dsh";

  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(content);

  const previewMatch = useMemo(() => {
    if (!content) return null;
    const urlMatch =
      content.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\S*/i) ||
      content.match(/https?:\/\/[^\s)]+/i);
    if (urlMatch) return { type: "url", target: urlMatch[0] };
    const htmlMatch = content.match(/\b[\w-]+\.html\b/i);
    if (htmlMatch) return { type: "html", target: htmlMatch[0] };
    return null;
  }, [content]);

  const promptLabel =
    role === "user"
      ? isTerminal
        ? "you@edgerunner:~/workspace$ "
        : "you@edgerunner:~$ "
      : role === "assistant"
        ? isTerminal
          ? "bash > "
          : isAgent
            ? "agent > "
            : isDeepSeek
              ? "deepseek > "
              : "model > "
        : "# system ";

  const promptColor =
    role === "user"
      ? "text-term-green"
      : role === "assistant"
        ? isTerminal
          ? "text-term-dim"
          : isAgent
            ? "text-term-amber"
            : isDeepSeek
              ? "text-cyan-400"
              : "text-term-dim"
        : "text-term-dim";

  function handleSaveEdit() {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    setIsEditing(false);
    if (trimmed !== content && onEdit) {
      onEdit(trimmed);
    }
  }

  return (
    <div className="group py-2 font-mono text-sm sm:text-base leading-relaxed">
      {isEditing ? (
        <div className="my-1.5 rounded border border-term-green/60 bg-term-panel/80 p-2.5 space-y-2">
          <div className="flex items-center justify-between text-xs text-term-dim">
            <span className="text-term-green font-semibold">Editing message…</span>
            <span>↵ to save · Esc to cancel · ⇧↵ for newline</span>
          </div>
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSaveEdit();
              } else if (e.key === "Escape") {
                setIsEditing(false);
                setEditDraft(content);
              }
            }}
            className="w-full min-h-[70px] p-2.5 rounded border border-term-border bg-term-bg text-term-fg text-sm focus:outline-none focus:border-term-green resize-y leading-relaxed font-mono"
            autoFocus
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => {
                setIsEditing(false);
                setEditDraft(content);
              }}
              className="px-2.5 py-1 rounded border border-term-border text-xs text-term-dim hover:text-term-fg"
            >
              cancel
            </button>
            <button
              onClick={handleSaveEdit}
              className="px-2.5 py-1 rounded border border-term-green/60 bg-term-green/20 text-term-green text-xs font-bold hover:bg-term-green/30"
            >
              save & run ↵
            </button>
          </div>
        </div>
      ) : (
        (content || streaming || (tools && tools.length > 0)) && (
          <div>
            <span className={`${promptColor} select-none font-bold`}>{promptLabel}</span>
            {role === "user" ? (
              <span className="whitespace-pre-wrap break-words">{content}</span>
            ) : (
              <AssistantBody content={content} streaming={streaming} tools={tools} />
            )}
          </div>
        )
      )}

      {!streaming && !isEditing && (content || tools?.length) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5 sm:gap-3.5 text-xs text-term-dim opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity select-none">
          <CopyButton text={content} />
          {onEdit && (
            <button
              className="hover:text-term-green transition-colors"
              onClick={() => {
                setEditDraft(content);
                setIsEditing(true);
              }}
            >
              edit
            </button>
          )}
          {onFork && (
            <button
              className="hover:text-cyan-400 transition-colors"
              onClick={onFork}
              title="Fork session from this checkpoint"
            >
              ⑂ fork
            </button>
          )}
          {previewMatch && (
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("edgerunner:open-preview", {
                      detail: { url: previewMatch.type === "url" ? previewMatch.target : undefined },
                    }),
                  );
                }
              }}
              className="flex items-center gap-1.5 rounded border border-term-green/60 bg-term-green/10 px-2 py-0.5 text-xs text-term-green hover:bg-term-green/20 transition-colors"
              title="Open in native Sandboxed Live Previewer"
            >
              <span>🌐</span>
              <span>Preview {previewMatch.target}</span>
            </button>
          )}
          {onDelete && (
            <button className="hover:text-term-red transition-colors" onClick={onDelete}>
              delete
            </button>
          )}
          {stats && (
            <span className="ml-auto tabular-nums text-xs">
              {isTerminal ? (
                `${(stats.ms / 1000).toFixed(2)}s`
              ) : (
                `${stats.tokens} tok · ${tokPerSec(stats)} tok/s · ${(stats.ms / 1000).toFixed(1)}s`
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export type MessageSegment =
  | { type: "think"; content: string; open: boolean }
  | { type: "tool"; tool: ToolEvent }
  | { type: "markdown"; content: string };

function parseChronologicalSegments(
  content: string,
  propTools?: ToolEvent[],
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  if (!content && (!propTools || propTools.length === 0)) return segments;

  let toolIdx = 0;
  const toolsPool = propTools ? [...propTools] : [];
  let remaining = content || "";

  while (remaining.length > 0) {
    const openThinkMatch = remaining.match(/<(?:think|thought|reasoning|thought_process)>|\[THINK\]/i);
    const closeThinkMatch = remaining.match(/<\/(?:think|thought|reasoning|thought_process)>|\[\/THINK\]/i);
    const toolCallMatch = remaining.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    const fnCallMatch = remaining.match(/<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/function>/i);
    const refMatch = remaining.match(/<tool_ref id="([^"]+)"\/>/);

    const matches = [
      openThinkMatch && openThinkMatch.index !== undefined ? { type: "open_think", idx: openThinkMatch.index, match: openThinkMatch } : null,
      closeThinkMatch && closeThinkMatch.index !== undefined ? { type: "close_think", idx: closeThinkMatch.index, match: closeThinkMatch } : null,
      toolCallMatch && toolCallMatch.index !== undefined ? { type: "tool_call", idx: toolCallMatch.index, match: toolCallMatch } : null,
      fnCallMatch && fnCallMatch.index !== undefined ? { type: "fn_call", idx: fnCallMatch.index, match: fnCallMatch } : null,
      refMatch && refMatch.index !== undefined ? { type: "tool_ref", idx: refMatch.index, match: refMatch } : null,
    ].filter(Boolean).sort((a, b) => a!.idx - b!.idx);

    if (matches.length === 0) {
      const clean = remaining.trim();
      if (clean) segments.push({ type: "markdown", content: clean });
      break;
    }

    const first = matches[0]!;
    const prefix = remaining.slice(0, first.idx);

    if (first.type === "open_think") {
      if (prefix.trim()) segments.push({ type: "markdown", content: prefix.trim() });
      const afterOpen = remaining.slice(first.idx + first.match[0].length);
      const closeMatch = afterOpen.match(/<\/(?:think|thought|reasoning|thought_process)>|\[\/THINK\]/i);
      if (closeMatch && closeMatch.index !== undefined) {
        const thoughtContent = afterOpen.slice(0, closeMatch.index).trim();
        if (thoughtContent) {
          segments.push({ type: "think", content: thoughtContent, open: false });
        }
        remaining = afterOpen.slice(closeMatch.index + closeMatch[0].length);
      } else {
        const thoughtContent = afterOpen.trim();
        if (thoughtContent) {
          segments.push({ type: "think", content: thoughtContent, open: true });
        }
        remaining = "";
      }
    } else if (first.type === "close_think") {
      const thoughtContent = prefix.replace(/^<(?:think|thought|reasoning|thought_process)>\s*|^\[THINK\]\s*/i, "").trim();
      if (thoughtContent) {
        segments.push({ type: "think", content: thoughtContent, open: false });
      }
      remaining = remaining.slice(first.idx + first.match[0].length);
    } else if (first.type === "tool_ref") {
      if (prefix.trim()) segments.push({ type: "markdown", content: prefix.trim() });
      const i = toolsPool.findIndex((t) => t.id === first.match[1]);
      if (i !== -1) segments.push({ type: "tool", tool: toolsPool.splice(i, 1)[0] });
      remaining = remaining.slice(first.idx + first.match[0].length);
    } else if (first.type === "tool_call" || first.type === "fn_call") {
      if (prefix.trim()) segments.push({ type: "markdown", content: prefix.trim() });

      let toolName = "terminal";
      let toolCmd = "";

      if (first.type === "tool_call") {
        const inner = first.match[1].trim();
        try {
          const parsed = JSON.parse(inner);
          if (parsed && typeof parsed === "object") {
            toolName = parsed.name || parsed.function?.name || "terminal";
            const args = parsed.arguments || parsed.parameters || parsed.function?.arguments || parsed;
            toolCmd = typeof args === "string" ? args : JSON.stringify(args);
          }
        } catch {}

        if (!toolCmd) {
          const innerFn = inner.match(/<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:<\/function>|$)/i);
          if (innerFn) {
            toolName = innerFn[1].trim();
            const paramMatches = [...innerFn[2].matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/parameter>/gi)];
            toolCmd = paramMatches.length > 0 ? paramMatches.map((m) => m[2].trim()).join("\n") : innerFn[2].trim();
          } else {
            toolCmd = inner;
          }
        }
      } else if (first.type === "fn_call") {
        toolName = first.match[1].trim();
        const paramMatches = [...first.match[2].matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/parameter>/gi)];
        toolCmd = paramMatches.length > 0 ? paramMatches.map((m) => m[2].trim()).join("\n") : first.match[2].trim();
      }

      let matchedToolIndex = toolsPool.findIndex((t) => {
        if (t.arguments && toolCmd) {
          const normA = t.arguments.replace(/\s+/g, " ").trim();
          const normB = toolCmd.replace(/\s+/g, " ").trim();
          if (normA === normB || normA.includes(normB) || normB.includes(normA)) return true;
        }
        return t.name === toolName;
      });

      let matchedTool: ToolEvent | null = null;
      if (matchedToolIndex !== -1) {
        matchedTool = toolsPool.splice(matchedToolIndex, 1)[0];
      } else if (toolsPool.length > 0) {
        matchedTool = toolsPool.shift() || null;
      }

      const toolObj: ToolEvent = matchedTool || {
        id: `inline_call_${++toolIdx}`,
        name: toolName,
        arguments: toolCmd,
      };

      segments.push({ type: "tool", tool: toolObj });
      remaining = remaining.slice(first.idx + first.match[0].length);
    }
  }

  // Any remaining unassigned tools
  while (toolsPool.length > 0) {
    const t = toolsPool.shift()!;
    segments.push({ type: "tool", tool: t });
  }

  return segments;
}

function AssistantBody({
  content,
  streaming,
  tools,
}: {
  content: string;
  streaming?: boolean;
  tools?: ToolEvent[];
}) {
  const segments = useMemo(
    () => parseChronologicalSegments(content, tools),
    [content, tools],
  );
  const runId = tools?.find((t) => t.diff && t.run_id)?.run_id;

  if (segments.length === 0) {
    return <Markdown content={content} />;
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, idx) => {
        if (seg.type === "think") {
          return (
            <details
              key={`think_${idx}`}
              className="my-2 rounded-md border border-term-border bg-term-panel/80 px-3 py-1.5 text-xs text-term-dim shadow-sm"
              open={seg.open}
            >
              <summary className="cursor-pointer select-none font-semibold text-[11px] uppercase tracking-wider text-term-amber hover:text-term-fg transition-colors">
                {seg.open ? "⚡ Thinking Process…" : "💡 Thought Process"}
              </summary>
              <div className="mt-2 whitespace-pre-wrap font-mono text-[11px] sm:text-xs leading-relaxed text-term-fg border-l-2 border-term-amber/50 pl-2.5">
                {seg.content}
              </div>
            </details>
          );
        }

        if (seg.type === "tool") {
          return <ToolCall key={seg.tool.id || `tool_${idx}`} tool={seg.tool} />;
        }

        return <Markdown key={`md_${idx}`} content={seg.content} />;
      })}
      {!streaming && runId && <UndoRun runId={runId} />}
    </div>
  );
}

// One-line summary of a tool call's arguments ("npm test", "src/app.ts").
function argSummary(tool: ToolEvent): string {
  if (!tool.arguments) return "";
  try {
    const a = JSON.parse(tool.arguments);
    if (a && typeof a === "object") {
      return String(a.command ?? a.path ?? a.pattern ?? a.cmd ?? a.code ?? tool.arguments);
    }
  } catch {}
  return tool.arguments;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="mt-1.5 max-h-72 overflow-auto rounded border border-term-border/40 bg-term-bg/80 p-2 text-[11px] leading-relaxed">
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("+") ? "text-term-green" : l.startsWith("-") ? "text-term-red" : l.startsWith("@@") ? "text-term-amber" : "text-term-dim"
          }
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function ToolCall({ tool }: { tool: ToolEvent }) {
  const status = tool.status ?? (tool.result != null ? "done" : "running");
  const [open, setOpen] = useState(false);
  const [decided, setDecided] = useState(false);
  const summary = argSummary(tool);
  const failed =
    status === "failed" ||
    (!tool.status && Boolean(tool.result && /exit code [1-9]|^error:/m.test(tool.result)));

  const decideCall = async (ok: boolean) => {
    setDecided(true);
    const { decide } = await import("@/lib/agent/agent");
    decide(tool.id, ok);
  };

  return (
    <div className="rounded border border-term-border bg-term-panel/50 px-2.5 py-1.5 text-xs font-mono">
      <div
        className="flex cursor-pointer items-center justify-between gap-2"
        onClick={() => (tool.result || tool.diff) && setOpen((o) => !o)}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={failed ? "text-term-red" : status === "denied" ? "text-term-dim" : "text-term-green"}>
            {failed ? "✗" : status === "denied" ? "⊘" : status === "done" ? "✓" : "●"}
          </span>
          <span className="font-semibold text-term-fg">{tool.name}</span>
          {summary && <span className="truncate text-[11px] text-term-dim">{summary}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px]">
          {status === "running" && <span className="animate-pulse text-term-green">running…</span>}
          {status === "denied" && <span className="text-term-dim">declined</span>}
          {(tool.result || tool.diff) && <span className="text-term-dim">{open ? "▾ hide" : "▸ details"}</span>}
        </div>
      </div>
      {status === "approval" && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[11px] text-term-amber">Allow this?</span>
          <button
            disabled={decided}
            onClick={() => decideCall(true)}
            className="rounded border border-term-green/50 bg-term-green/10 px-2 py-0.5 text-[11px] text-term-green hover:bg-term-green/20 disabled:opacity-50"
          >
            Allow
          </button>
          <button
            disabled={decided}
            onClick={() => decideCall(false)}
            className="rounded border border-term-red/40 px-2 py-0.5 text-[11px] text-term-red hover:bg-term-red/10 disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      )}
      {tool.diff && (open || status === "done") && <DiffView diff={tool.diff} />}
      {open && tool.result && !tool.diff && (
        <pre className="mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded border border-term-border/40 bg-term-bg/80 p-2 text-xs leading-relaxed text-term-fg">
          {tool.result}
        </pre>
      )}
    </div>
  );
}

// Put back every file an agent reply changed.
function UndoRun({ runId }: { runId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [files, setFiles] = useState<string[]>([]);
  return (
    <button
      disabled={state !== "idle"}
      onClick={async () => {
        setState("busy");
        const { undoRun } = await import("@/lib/agent/agent");
        setFiles(await undoRun(runId));
        setState("done");
      }}
      className="rounded border border-term-border px-2 py-0.5 text-[11px] text-term-dim hover:text-term-fg disabled:opacity-60"
      title="Restore the files this reply changed"
    >
      {state === "done" ? (files.length ? `restored ${files.length} file${files.length > 1 ? "s" : ""}` : "nothing to undo (reload clears undo history)") : state === "busy" ? "undoing…" : "↶ undo file changes"}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="hover:text-term-fg"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function tokPerSec(s: MessageStats): string {
  if (!s.ms) return "0.0";
  return ((s.tokens / s.ms) * 1000).toFixed(1);
}
