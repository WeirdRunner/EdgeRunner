// The coding agent: a model (OpenRouter) that calls tools on the in-browser workspace until the task is done.
// Emits the same stream events the chat UI already renders (token / think / tool_call / tool_result / done / error).

import { streamCompletion, ProviderError } from "./openrouter";
import { Checkpoint, openAITools, runTool, toolKind } from "./tools";

export type ApprovalMode = "auto" | "commands" | "all";   // ask for nothing / for commands only / for edits and commands
export interface AgentEvent { type: "token" | "think" | "tool_call" | "tool_result" | "done" | "error"; data: string }

const MAX_STEPS = 40;
const MAX_TOOL_RESULT = 12_000;

const SYSTEM = `You are EdgeRunner, a coding agent. You work in a project workspace that runs inside the user's browser \
(a WebContainer): Node.js 22, npm/npx and a POSIX-like shell with common commands. There is no Python, no git binary, \
no sudo/apt, and no access to the user's own files outside this workspace. Workspace root: /home/workspace.

How to work:
- Look before you change: list_files and read_file the relevant code first.
- Prefer edit_file for small changes; write_file for new files. Keep edits minimal and in the project's style.
- After changes, verify: run the build, tests or the script with run_command. If something fails, read the error and fix it.
- Dev servers and watchers never exit: run them with run_command background=true (e.g. npm run dev), never in the foreground.
- Web apps: prefer Vite; it runs well here. Native modules and Python tools are not available.
- Never invent command output or file contents. If you can't do something here, say so plainly.
- When done, reply with a short summary: what changed (files), how you verified it, and anything left for the user.
Keep replies concise; use Markdown.`;

/** Pending approvals: the UI resolves them with decide(). */
const pending = new Map<string, (ok: boolean) => void>();
export function decide(callId: string, approved: boolean) {
  pending.get(callId)?.(approved);
  pending.delete(callId);
}

const runs = new Map<string, Checkpoint>();
/** Undo every file change an agent reply made. */
export async function undoRun(runId: string): Promise<string[]> {
  const cp = runs.get(runId);
  return cp ? cp.undo() : [];
}

export async function* runAgent(opts: {
  model: string; history: { role: string; content: string }[]; runId: string;
  approval: ApprovalMode; signal?: AbortSignal; temperature?: number; maxTokens?: number;
}): AsyncGenerator<AgentEvent> {
  const cp = new Checkpoint();
  runs.set(opts.runId, cp);
  const messages: any[] = [{ role: "system", content: SYSTEM }, ...opts.history.filter((m) => m.role !== "system")];
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let text = "";
      let calls: { id: string; name: string; arguments: string }[] = [];
      for await (const ch of streamCompletion({ model: opts.model, messages, tools: openAITools(), signal: opts.signal,
                                                temperature: opts.temperature ?? 0.2, maxTokens: opts.maxTokens })) {
        if (ch.type === "text") { text += ch.text; yield { type: "token", data: ch.text }; }
        else if (ch.type === "reasoning") yield { type: "think", data: ch.text };
        else if (ch.type === "tool_calls") calls = ch.calls;
      }
      if (!calls.length) { yield { type: "done", data: opts.runId }; return; }

      messages.push({ role: "assistant", content: text || null,
                      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })) });
      for (const call of calls) {
        let args: Record<string, any> = {};
        let badArgs = false;
        try { args = JSON.parse(call.arguments?.trim() || "{}") ?? {}; } catch { badArgs = true; }
        const kind = toolKind(call.name);
        const needsOk = (kind === "command" && opts.approval !== "auto") || (kind === "edit" && opts.approval === "all");
        const base = { id: call.id, name: call.name, arguments: call.arguments, run_id: opts.runId };
        let outcome: { result: string; diff?: string; ok: boolean };
        if (badArgs) {
          outcome = { ok: false, result: "The tool arguments weren't valid JSON. Call the tool again with a JSON object." };
          yield { type: "tool_call", data: JSON.stringify({ ...base, status: "running" }) };
        } else {
          if (needsOk) {
            yield { type: "tool_call", data: JSON.stringify({ ...base, status: "approval" }) };
            const ok = await new Promise<boolean>((resolve) => {
              pending.set(call.id, resolve);
              opts.signal?.addEventListener("abort", () => resolve(false), { once: true });
            });
            if (!ok) {
              outcome = { ok: false, result: "The user declined this action. Ask them what to do instead, or take another approach." };
              yield { type: "tool_result", data: JSON.stringify({ ...base, status: "denied", result: "Declined." }) };
              messages.push({ role: "tool", tool_call_id: call.id, content: outcome.result });
              continue;
            }
          }
          yield { type: "tool_call", data: JSON.stringify({ ...base, status: "running" }) };
          outcome = await runTool(call.name, args, cp, opts.signal);
        }
        yield { type: "tool_result", data: JSON.stringify({ ...base, status: outcome.ok ? "done" : "failed", result: outcome.result, diff: outcome.diff }) };
        const r = outcome.result.length > MAX_TOOL_RESULT ? outcome.result.slice(0, MAX_TOOL_RESULT) + "\n… [cut]" : outcome.result;
        messages.push({ role: "tool", tool_call_id: call.id, content: r });
      }
      if (opts.signal?.aborted) return;
    }
    yield { type: "error", data: `Stopped after ${MAX_STEPS} steps without finishing — ask me to continue if it's on the right track.` };
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    yield { type: "error", data: e instanceof ProviderError ? e.message : `Agent error: ${(e as Error).message}` };
  }
}

/** Plain chat (no tools) with an OpenRouter model. */
export async function* runChat(opts: { model: string; history: { role: string; content: string }[]; signal?: AbortSignal;
                                       temperature?: number; maxTokens?: number }): AsyncGenerator<AgentEvent> {
  try {
    for await (const ch of streamCompletion({ model: opts.model, messages: opts.history, signal: opts.signal,
                                              temperature: opts.temperature, maxTokens: opts.maxTokens })) {
      if (ch.type === "text") yield { type: "token", data: ch.text };
      else if (ch.type === "reasoning") yield { type: "think", data: ch.text };
    }
    yield { type: "done", data: "" };
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    yield { type: "error", data: e instanceof ProviderError ? e.message : `Chat error: ${(e as Error).message}` };
  }
}
