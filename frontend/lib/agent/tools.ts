// What the coding agent can do in its workspace (lib/agent/workspace.ts: the browser, or a project on your Mac).
// File changes are snapshotted per run for undo.

import { createTwoFilesPatch } from "diff";
import type { Workspace } from "./workspace";

export type ToolKind = "read" | "edit" | "command";
export interface ToolOutcome { result: string; diff?: string; ok: boolean }

const S = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "integer", description });

export const TOOL_SPECS = [
  { name: "list_files", kind: "read" as ToolKind,
    description: "List files and folders (node_modules and .git are skipped). Use first to see a project's layout.",
    parameters: S({ path: str("Folder, relative to the workspace root. Default '.'"), depth: num("How many levels deep, 1-4. Default 2") }, []) },
  { name: "read_file", kind: "read" as ToolKind,
    description: "Read a text file with line numbers. For big files read a range with offset/limit.",
    parameters: S({ path: str("File path relative to the workspace root"), offset: num("First line to read (1-based)"), limit: num("How many lines. Default 400") }, ["path"]) },
  { name: "search", kind: "read" as ToolKind,
    description: "Search file contents with a regular expression. Returns file:line: text for each match (max 200).",
    parameters: S({ pattern: str("JavaScript regular expression"), path: str("Folder to search. Default '.'"), glob: str("Only files whose path ends with this, e.g. '.ts'") }, ["pattern"]) },
  { name: "write_file", kind: "edit" as ToolKind,
    description: "Create a file or replace its whole content. Prefer edit_file for changes to existing files.",
    parameters: S({ path: str("File path relative to the workspace root"), content: str("The complete file content") }, ["path", "content"]) },
  { name: "edit_file", kind: "edit" as ToolKind,
    description: "Replace an exact piece of text in a file. old_string must match exactly once (include enough surrounding lines to be unique) unless replace_all is true.",
    parameters: S({ path: str("File path"), old_string: str("Exact text to replace"), new_string: str("Replacement text"),
                    replace_all: { type: "boolean", description: "Replace every occurrence" } }, ["path", "old_string", "new_string"]) },
  { name: "run_command", kind: "command" as ToolKind,
    description: "Run a shell command in the workspace folder. Returns the output and exit code. Use for installs, builds, tests and running scripts.",
    parameters: S({ command: str("The command line"), timeout_seconds: num("Stop after this many seconds. Default 120, max 600"),
                    background: { type: "boolean", description: "For commands that keep running (dev servers, watchers): start it, return its first output and preview URL, and leave it running. Running the same command again restarts it." } }, ["command"]) },
];

export function toolKind(name: string): ToolKind | null {
  return TOOL_SPECS.find((t) => t.name === name)?.kind ?? null;
}

export function openAITools() {
  return TOOL_SPECS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Original content of every file a run changed (null = the file didn't exist), for "undo this run". */
export class Checkpoint {
  files = new Map<string, string | null>();
  constructor(private ws: Workspace) {}
  async remember(path: string) {
    if (this.files.has(path)) return;
    this.files.set(path, (await this.ws.exists(path)) ? await this.ws.read(path).catch(() => null) : null);
  }
  async undo(): Promise<string[]> {
    const restored: string[] = [];
    for (const [path, before] of this.files) {
      if (before === null) await this.ws.rm(path);
      else await this.ws.write(path, before);
      restored.push(path);
    }
    this.files.clear();
    return restored;
  }
}

function patch(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, "", "", { context: 3 })
    .split("\n").filter((l) => !/^(Index: |={10,}|--- a\/|\+\+\+ b\/)/.test(l)).join("\n");   // keep only the @@ hunks
}

async function tree(ws: Workspace, path: string, depth: number, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await ws.list(path)) {
    if (e.name === "node_modules" || e.name === ".git") { if (e.dir) out.push(`${prefix}${e.name}/ (skipped)`); continue; }
    out.push(`${prefix}${e.name}${e.dir ? "/" : ""}`);
    if (e.dir && depth > 1) out.push(...await tree(ws, e.path, depth - 1, prefix + "  "));
    if (out.length > 400) break;
  }
  return out;
}

export async function runTool(ws: Workspace, name: string, args: Record<string, any>, cp: Checkpoint, signal?: AbortSignal): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_files": {
        const lines = await tree(ws, args.path || ".", Math.max(1, Math.min(4, args.depth || 2)));
        return { ok: true, result: lines.join("\n") || "(empty folder)" };
      }
      case "read_file": {
        const text = await ws.read(args.path);
        const lines = text.split("\n");
        const start = Math.max(1, args.offset || 1), limit = Math.max(1, Math.min(2000, args.limit || 400));
        const slice = lines.slice(start - 1, start - 1 + limit);
        const more = lines.length > start - 1 + limit ? `\n… ${lines.length - (start - 1 + limit)} more lines (read with offset=${start + limit})` : "";
        return { ok: true, result: slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n") + more };
      }
      case "search": {
        let re: RegExp;
        try { re = new RegExp(args.pattern, "i"); } catch (e) { return { ok: false, result: `Invalid regular expression: ${(e as Error).message}` }; }
        const hits: string[] = [];
        for (const f of await ws.walk(args.path || ".")) {
          if (args.glob && !f.endsWith(args.glob)) continue;
          let text: string;
          try { text = await ws.read(f); } catch { continue; }
          if (text.includes("\u0000")) continue;                       // binary
          text.split("\n").forEach((l, i) => { if (hits.length < 200 && re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`); });
          if (hits.length >= 200) break;
        }
        return { ok: true, result: hits.join("\n") || "No matches." };
      }
      case "write_file": {
        await cp.remember(args.path);
        const before = (await ws.exists(args.path)) ? await ws.read(args.path).catch(() => "") : "";
        await ws.write(args.path, args.content ?? "");
        return { ok: true, result: `${before ? "Updated" : "Created"} ${args.path} (${String(args.content ?? "").split("\n").length} lines).`,
                 diff: patch(args.path, before, args.content ?? "") };
      }
      case "edit_file": {
        const before = await ws.read(args.path);
        const count = before.split(args.old_string).length - 1;
        if (!args.old_string) return { ok: false, result: "old_string is empty." };
        if (count === 0) return { ok: false, result: `old_string wasn't found in ${args.path}. Read the file again and copy the exact text.` };
        if (count > 1 && !args.replace_all) return { ok: false, result: `old_string appears ${count} times in ${args.path}; add surrounding lines to make it unique, or set replace_all.` };
        await cp.remember(args.path);
        const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string);
        await ws.write(args.path, after);
        return { ok: true, result: `Edited ${args.path}${count > 1 ? ` (${count} places)` : ""}.`, diff: patch(args.path, before, after) };
      }
      case "run_command": {
        if (args.background) {
          const r = await ws.start(args.command);
          const state = r.exited != null ? `[exited with code ${r.exited}]` : r.url ? `[running; preview at ${r.url} — the user can open it in the Preview pane]` : "[still running]";
          return { ok: r.exited == null || r.exited === 0, result: `${r.output || "(no output yet)"}\n${state}` };
        }
        const t = Math.max(5, Math.min(600, args.timeout_seconds || 120));
        const r = await ws.exec(args.command, { timeoutMs: t * 1000, signal });
        return { ok: r.code === 0, result: `${r.output || "(no output)"}\n[exit code ${r.code}${r.timedOut ? `, stopped after ${t}s` : ""}]` };
      }
      default:
        return { ok: false, result: `Unknown tool "${name}". Available: ${TOOL_SPECS.map((t) => t.name).join(", ")}.` };
    }
  } catch (e) {
    return { ok: false, result: `Error: ${(e as Error).message || e}` };
  }
}
