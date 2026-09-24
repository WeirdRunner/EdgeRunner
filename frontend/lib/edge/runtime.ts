// The edge runtime: a real workspace, shell and Node.js running inside this browser tab (WebContainers).
//
//   edge.boot()                 start it (once per tab); restores your files from browser storage
//   edge.exec("npm test")       run a command → { code, output }
//   edge.read/write/list/rm     files, relative to the workspace root
//   edge.shell({ cols, rows })  an interactive shell (jsh) for the terminal panel
//
// Needs a desktop Chromium browser (Chrome, Edge, Brave; Safari/Firefox are beta) and cross-origin isolation,
// which public/coi-serviceworker.js provides on static hosts like GitHub Pages. Everything else in the app
// keeps working without it; `edge.support()` says why it's unavailable.

import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import { idb } from "./idb";

export type EdgeStatus = "idle" | "booting" | "ready" | "unsupported" | "error";
export interface ExecResult { code: number; output: string; timedOut?: boolean }
export interface Entry { name: string; path: string; dir: boolean }

const SNAPSHOT_KEY = "workspace:snapshot";
const MAX_OUTPUT = 30_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r(?!\n)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n… [${s.length - MAX_OUTPUT} characters cut] …\n${s.slice(-half)}`;
}

function norm(path: string): string {
  const parts: string[] = [];
  for (const p of path.replace(/\\/g, "/").split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/") || ".";
}

class EdgeRuntime {
  status: EdgeStatus = "idle";
  error = "";
  private wc: WebContainer | null = null;
  private booting: Promise<WebContainer> | null = null;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Why the in-browser runtime can't run here (empty string when it can). */
  support(): string {
    if (typeof window === "undefined") return "not in a browser";
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
      return "This browser tab isn't cross-origin isolated. Reload once; if it persists, use Chrome, Edge or Brave on a computer.";
    return "";
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(status: EdgeStatus, error = "") {
    this.status = status;
    this.error = error;
    this.listeners.forEach((f) => f());
  }

  get root(): string {
    return this.wc?.workdir ?? "/home/workspace";
  }

  async boot(): Promise<WebContainer> {
    if (this.wc) return this.wc;
    if (this.booting) return this.booting;
    const why = this.support();
    if (why) {
      this.set("unsupported", why);
      throw new Error(why);
    }
    this.set("booting");
    this.booting = (async () => {
      const { WebContainer } = await import("@webcontainer/api");
      const wc = await WebContainer.boot({ workdirName: "workspace" });
      const saved = await idb.get<FileSystemTree>(SNAPSHOT_KEY).catch(() => undefined);
      if (saved) await wc.mount(saved);
      wc.fs.watch(".", { recursive: true }, (_event, file) => {
        if (typeof file === "string" && /(^|\/)node_modules(\/|$)/.test(file)) return;
        this.scheduleSave();
      });
      this.wc = wc;
      this.set("ready");
      return wc;
    })().catch((e) => {
      this.booting = null;
      this.set("error", String(e?.message || e));
      throw e;
    });
    return this.booting;
  }

  /** Workspace files are kept in browser storage (node_modules excluded — reinstall with npm). */
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 1500);
  }

  async save(): Promise<void> {
    if (!this.wc) return;
    const tree = await this.wc.export(".", { format: "json", excludes: ["**/node_modules/**", "node_modules/**"] });
    await idb.set(SNAPSHOT_KEY, tree);
  }

  async exec(command: string, opts: { cwd?: string; timeoutMs?: number; onOutput?: (chunk: string) => void; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const wc = await this.boot();
    const proc = await wc.spawn("jsh", ["-c", command], { cwd: opts.cwd ? norm(opts.cwd) : undefined, terminal: { cols: 120, rows: 40 } });
    let out = "";
    void proc.output.pipeTo(new WritableStream({ write(chunk) { out += chunk; opts.onOutput?.(chunk); } })).catch(() => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 120_000);
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const code = await proc.exit;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    return { code: timedOut ? 124 : code, output: clip(stripAnsi(out)).trimEnd(), timedOut };
  }

  async shell(size: { cols: number; rows: number }): Promise<WebContainerProcess> {
    const wc = await this.boot();
    return wc.spawn("jsh", { terminal: size });
  }

  async read(path: string): Promise<string> {
    const wc = await this.boot();
    return wc.fs.readFile(norm(path), "utf-8");
  }

  async write(path: string, content: string): Promise<void> {
    const wc = await this.boot();
    const p = norm(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir) await wc.fs.mkdir(dir, { recursive: true });
    await wc.fs.writeFile(p, content);
  }

  async exists(path: string): Promise<boolean> {
    const wc = await this.boot();
    try { await wc.fs.readdir(norm(path)); return true; } catch { /* not a dir */ }
    try { await wc.fs.readFile(norm(path)); return true; } catch { return false; }
  }

  async list(path = "."): Promise<Entry[]> {
    const wc = await this.boot();
    const base = norm(path);
    const items = await wc.fs.readdir(base, { withFileTypes: true });
    return items
      .map((d) => ({ name: d.name, path: base === "." ? d.name : `${base}/${d.name}`, dir: d.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  /** Every file under `path` (skips node_modules and .git), for search and the file tree. */
  async walk(path = ".", limit = 5000): Promise<string[]> {
    const out: string[] = [];
    const visit = async (p: string) => {
      if (out.length >= limit) return;
      for (const e of await this.list(p)) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        if (e.dir) await visit(e.path);
        else out.push(e.path);
      }
    };
    await visit(path);
    return out;
  }

  async rm(path: string): Promise<void> {
    const wc = await this.boot();
    await wc.fs.rm(norm(path), { recursive: true, force: true });
  }

  /** Replace the whole workspace (e.g. a cloned repository). */
  async replaceAll(tree: FileSystemTree): Promise<void> {
    const wc = await this.boot();
    for (const e of await this.list(".")) await wc.fs.rm(e.path, { recursive: true, force: true });
    await wc.mount(tree);
    await this.save();
  }

  onServerReady(fn: (port: number, url: string) => void): () => void {
    let off = () => {};
    void this.boot().then((wc) => { off = wc.on("server-ready", fn); }).catch(() => {});
    return () => off();
  }
}

export const edge = new EdgeRuntime();
