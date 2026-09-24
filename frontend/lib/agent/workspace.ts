// Where the coding agent works: the in-browser workspace, or a project folder on your Mac through the
// EdgeRunner node (backend/app/routers/node.py). The agent's tools only talk to this interface.

import { edge, type Entry, type ExecResult } from "../edge/runtime";
import { getSecret } from "./secrets";

export interface Workspace {
  id: string;                     // "browser" | "node:<projectId>"
  label: string;
  kind: "browser" | "node";
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path?: string): Promise<Entry[]>;
  walk(path?: string, limit?: number): Promise<string[]>;
  rm(path: string): Promise<void>;
  exec(command: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>;
  start(command: string): Promise<{ output: string; url?: string; exited?: number | null }>;
  /** Told to the model: what this environment is and what it can use. */
  describe(): string;
}

export const browserWorkspace: Workspace = {
  id: "browser",
  label: "Browser workspace",
  kind: "browser",
  read: (p) => edge.read(p),
  write: (p, c) => edge.write(p, c),
  exists: (p) => edge.exists(p),
  list: (p) => edge.list(p),
  walk: (p, n) => edge.walk(p, n),
  rm: (p) => edge.rm(p),
  exec: (c, o) => edge.exec(c, o),
  start: (c) => edge.start(c),
  describe: () =>
    "You work in a project workspace that runs inside the user's browser (a WebContainer): Node.js 22, npm/npx " +
    "and a POSIX-like shell with common commands. There is no Python, no git binary, no sudo/apt, and no access to " +
    "the user's own files outside this workspace. Workspace root: /home/workspace. Web apps: prefer Vite; it runs " +
    "well here. Native modules and Python tools are not available.",
};

// ---- the Mac node --------------------------------------------------------------------------------

const URL_KEY = "edgerunner.node.url";
export const DEFAULT_NODE_URL = "http://127.0.0.1:8100";

export function nodeUrl(): string {
  if (typeof localStorage === "undefined") return DEFAULT_NODE_URL;
  return (localStorage.getItem(URL_KEY) || DEFAULT_NODE_URL).replace(/\/+$/, "");
}
export function setNodeUrl(url: string) {
  localStorage.setItem(URL_KEY, url.trim().replace(/\/+$/, "") || DEFAULT_NODE_URL);
}

export class NodeError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

export async function nodeFetch<T = any>(path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<T> {
  const token = await getSecret("node");
  const q = init.query ? "?" + new URLSearchParams(Object.entries(init.query).filter(([, v]) => v != null) as [string, string][]) : "";
  let r: Response;
  try {
    r = await fetch(`${nodeUrl()}/api/node${path}${q}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch {
    throw new NodeError(`Can't reach your Mac node at ${nodeUrl()}. Start it with: edgerunner-node`);
  }
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) throw new NodeError("Your Mac node didn't accept the token — copy it from `edgerunner-node --token` into ⚙ Settings → Mac node.", 401);
  if (!r.ok) throw new NodeError(typeof body.detail === "string" ? body.detail : `Mac node error ${r.status}`, r.status);
  return body as T;
}

export interface NodeProject { id: string; name: string; path: string }
export interface NodeInfo { platform: string; sandbox: boolean; projects: NodeProject[] }

export const nodeInfo = () => nodeFetch<NodeInfo>("/info");

export function nodeWorkspace(p: NodeProject, sandbox: boolean): Workspace {
  const project = p.id;
  const post = (path: string, body: object) => nodeFetch(path, { method: "POST", body: JSON.stringify({ project, ...body }) });
  return {
    id: `node:${p.id}`,
    label: `Mac · ${p.name}`,
    kind: "node",
    async read(path) {
      const r = await nodeFetch<{ content: string; encoding: string }>("/fs/read", { query: { project, path } });
      if (r.encoding !== "utf-8") throw new NodeError(`${path} is a binary file.`);
      return r.content;
    },
    write: async (path, content) => { await post("/fs/write", { path, content }); },
    exists: async (path) => (await nodeFetch<{ exists: boolean }>("/fs/stat", { query: { project, path } })).exists,
    list: (path = ".") => nodeFetch<Entry[]>("/fs/list", { query: { project, path } }),
    walk: (path = ".", limit = 5000) => nodeFetch<string[]>("/fs/walk", { query: { project, path, limit: String(limit) } }),
    rm: async (path) => { await post("/fs/rm", { path }); },
    async exec(command, opts = {}) {
      const r = await post("/exec", { command, timeout: Math.round((opts.timeoutMs ?? 120_000) / 1000) }) as any;
      return { code: r.code, output: r.output, timedOut: r.timed_out };
    },
    start: (command) => post("/start", { command }) as any,
    describe: () =>
      `You work in a project folder on the user's Mac: ${p.path}. Commands run in their login shell (zsh) in that ` +
      "folder, with the tools installed on the Mac (git, node, python3, etc. — check with `which` if unsure). " +
      (sandbox ? "A sandbox blocks writing outside the project folder (package caches and /tmp are fine). " : "") +
      "Use git freely for status/diff/commits, but never push, force, reset --hard or rewrite history unless the user asks. " +
      "Never print or read secrets such as .env files or keys unless the task needs it.",
  };
}
