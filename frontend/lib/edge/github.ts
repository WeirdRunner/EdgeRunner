// GitHub for the in-browser workspace, through GitHub's REST API (which browsers may call; git's own
// protocol can't be used from a web page). A repository lives in a workspace folder; we remember the
// commit it came from and each file's blob hash, so status, pull and push are real (like git, minus history).

import { edge } from "./runtime";
import { idb } from "./idb";
import { getSecret, setSecret } from "../agent/secrets";

const API = "https://api.github.com";
const LINKS = "github:links";
const MAX_FILES = 3000;
const MAX_BYTES = 5_000_000;

export interface RepoLink {
  folder: string;             // workspace folder, e.g. "EdgeRunner"
  repo: string;               // "owner/name"
  branch: string;
  base: string;               // commit sha the folder matches (as of last clone/pull/push)
  files: Record<string, { sha: string; mode: string }>;   // path inside the repo → blob
}
export interface RepoStatus { added: string[]; modified: string[]; deleted: string[] }

export class GitHubError extends Error {}

// ---- token -------------------------------------------------------------------------------------

export async function githubToken(): Promise<string | null> {
  const legacy = typeof localStorage !== "undefined" ? localStorage.getItem("edgerunner.git.token") : null;
  if (legacy) {                                   // move the old plain-text token into encrypted storage
    await setSecret("github", legacy);
    localStorage.removeItem("edgerunner.git.token");
  }
  return getSecret("github");
}

async function gh(path: string, init: RequestInit = {}, token?: string | null): Promise<any> {
  const t = token === undefined ? await githubToken() : token;
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    ...init,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
               ...(t ? { Authorization: `Bearer ${t}` } : {}),
               ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (r.status === 204) return null;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = body?.message || r.statusText;
    if (r.status === 401) throw new GitHubError("GitHub didn't accept your token — check it in ⚙ Settings.");
    if (r.status === 403 && /rate limit/i.test(msg)) throw new GitHubError(t ? "GitHub rate limit reached — try again in a few minutes." : "GitHub's limit for anonymous use is reached — add a token in ⚙ Settings.");
    if (r.status === 404) throw new GitHubError(t ? `Not found on GitHub (or your token can't see it): ${path.split("?")[0]}` : "Not found. If the repository is private, add a GitHub token in ⚙ Settings.");
    throw new GitHubError(`GitHub ${r.status}: ${msg}`);
  }
  return body;
}

// ---- helpers -----------------------------------------------------------------------------------

export function parseRepo(input: string): string {
  const m = input.trim().replace(/\.git$/, "").match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
  if (!m) throw new GitHubError("Use owner/name or a github.com URL.");
  return `${m[1]}/${m[2]}`;
}

/** git's blob hash: sha1("blob <size>\0<bytes>") — lets us tell which files changed without git. */
async function blobSha(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(head.length + bytes.length);
  buf.set(head);
  buf.set(bytes, head.length);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/\n/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

export async function links(): Promise<RepoLink[]> {
  return Object.values((await idb.get<Record<string, RepoLink>>(LINKS)) || {});
}
async function saveLink(l: RepoLink | null, folder?: string) {
  const all = (await idb.get<Record<string, RepoLink>>(LINKS)) || {};
  if (l) all[l.folder] = l; else if (folder) delete all[folder];
  await idb.set(LINKS, all);
}
export async function unlink(folder: string) { await saveLink(null, folder); }

async function remoteTree(repo: string, ref: string) {
  const commit = await gh(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  const tree = await gh(`/repos/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new GitHubError("This repository is too big to open in the browser.");
  const blobs = (tree.tree as any[]).filter((e) => e.type === "blob" && e.mode !== "120000");   // skip symlinks/submodules
  return { sha: commit.sha as string, treeSha: commit.commit.tree.sha as string, blobs };
}

async function download(repo: string, sha: string, e: { path: string; sha: string }, token: string | null): Promise<Uint8Array> {
  if (!token) {                                   // public repos: raw files don't count against the API limit
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${e.path.split("/").map(encodeURIComponent).join("/")}`);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  }
  const blob = await gh(`/repos/${repo}/git/blobs/${e.sha}`, {}, token);
  return unb64(blob.content);
}

// ---- operations --------------------------------------------------------------------------------

export async function clone(input: string, opts: { branch?: string; folder?: string; onProgress?: (m: string) => void } = {}): Promise<RepoLink> {
  const repo = parseRepo(input);
  const token = await githubToken();
  const info = await gh(`/repos/${repo}`, {}, token);
  const branch = opts.branch || info.default_branch;
  const folder = (opts.folder || repo.split("/")[1]).replace(/^\/+|\/+$/g, "");
  if (await edge.exists(folder)) throw new GitHubError(`A folder named "${folder}" already exists in the workspace.`);
  opts.onProgress?.(`Reading ${repo}@${branch}…`);
  const { sha, blobs } = await remoteTree(repo, branch);
  if (blobs.length > MAX_FILES) throw new GitHubError(`${blobs.length} files is more than the browser workspace handles (${MAX_FILES}).`);
  const files: RepoLink["files"] = {};
  let done = 0, skipped = 0;
  await pool(blobs, 8, async (e) => {
    if (e.size > MAX_BYTES) { skipped++; return; }
    await edge.writeBytes(`${folder}/${e.path}`, await download(repo, sha, e, token));
    files[e.path] = { sha: e.sha, mode: e.mode };
    if (++done % 25 === 0) opts.onProgress?.(`Downloaded ${done}/${blobs.length} files…`);
  });
  const link: RepoLink = { folder, repo, branch, base: sha, files };
  await saveLink(link);
  opts.onProgress?.(`Cloned ${repo} into ${folder}/ (${done} files${skipped ? `, ${skipped} large files skipped` : ""}).`);
  return link;
}

/** The common subset of .gitignore: globs, `**`, leading `/`, trailing `/`, `!` negation, comments. */
export function ignoreMatcher(text: string): (path: string) => boolean {
  const rules = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const neg = l.startsWith("!");
    let pat = neg ? l.slice(1) : l;
    const dirOnly = pat.endsWith("/");
    pat = pat.replace(/\/+$/, "");
    const anchored = pat.startsWith("/") || pat.includes("/");
    pat = pat.replace(/^\//, "");
    const glob = (g: string) => g.split("**").map((part) => part.split("*").map((q) =>
      q.split("?").map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]")).join("[^/]*")).join(".*");
    const rx = pat.split("/**/").map(glob).join("/(?:.*/)?");         // a/**/b also matches a/b
    // A match on a directory also covers everything inside it.
    const re = new RegExp(`${anchored ? "^" : "(^|/)"}${rx}${dirOnly ? "/" : "(/|$)"}`);
    return { neg, re };
  });
  return (path) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path)) ignored = !r.neg;
    return ignored;
  };
}

export async function status(link: RepoLink): Promise<RepoStatus> {
  const gi = await edge.read(`${link.folder}/.gitignore`).catch(() => "");
  const ignored = ignoreMatcher(gi);
  const local = new Map<string, string>();
  for (const p of await edge.walk(link.folder, MAX_FILES)) {
    const rel = p.slice(link.folder.length + 1);
    if (!link.files[rel] && ignored(rel)) continue;          // tracked files stay tracked, like git
    local.set(rel, await blobSha(await edge.readBytes(p)));
  }
  const st: RepoStatus = { added: [], modified: [], deleted: [] };
  for (const [p, sha] of local) {
    if (!link.files[p]) st.added.push(p);
    else if (link.files[p].sha !== sha) st.modified.push(p);
  }
  for (const p of Object.keys(link.files)) if (!local.has(p) && !/(^|\/)node_modules\//.test(p)) st.deleted.push(p);
  return st;
}

/** Commit every change in the folder and push it to the branch. */
export async function push(link: RepoLink, message: string, onProgress?: (m: string) => void): Promise<{ sha: string; url: string }> {
  const token = await githubToken();
  if (!token) throw new GitHubError("Pushing needs a GitHub token (⚙ Settings) with access to this repository's contents.");
  const st = await status(link);
  const changed = [...st.added, ...st.modified];
  if (!changed.length && !st.deleted.length) throw new GitHubError("Nothing to commit — no files changed.");
  const head = await gh(`/repos/${link.repo}/git/ref/heads/${encodeURIComponent(link.branch)}`, {}, token);
  if (head.object.sha !== link.base) throw new GitHubError("The branch has new commits on GitHub. Pull first, then push.");
  const baseCommit = await gh(`/repos/${link.repo}/git/commits/${link.base}`, {}, token);
  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  const newFiles = { ...link.files };
  let n = 0;
  await pool(changed, 6, async (p) => {
    const bytes = await edge.readBytes(`${link.folder}/${p}`);
    const blob = await gh(`/repos/${link.repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: b64(bytes), encoding: "base64" }) }, token);
    const mode = link.files[p]?.mode || "100644";
    entries.push({ path: p, mode, type: "blob", sha: blob.sha });
    newFiles[p] = { sha: blob.sha, mode };
    onProgress?.(`Uploaded ${++n}/${changed.length} files…`);
  });
  for (const p of st.deleted) { entries.push({ path: p, mode: link.files[p].mode, type: "blob", sha: null }); delete newFiles[p]; }
  const tree = await gh(`/repos/${link.repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }) }, token);
  const commit = await gh(`/repos/${link.repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [link.base] }) }, token);
  await gh(`/repos/${link.repo}/git/refs/heads/${encodeURIComponent(link.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) }, token);
  await saveLink({ ...link, base: commit.sha, files: newFiles });
  return { sha: commit.sha, url: commit.html_url || `https://github.com/${link.repo}/commit/${commit.sha}` };
}

/** Bring in new commits. A file changed both here and on GitHub keeps your version; GitHub's is saved
 *  next to it as <file>.theirs so you can merge by hand (delete the .theirs file before pushing). */
export async function pull(link: RepoLink, onProgress?: (m: string) => void): Promise<{ updated: number; conflicts: string[]; upToDate: boolean }> {
  const token = await githubToken();
  onProgress?.("Checking GitHub…");
  const remote = await remoteTree(link.repo, link.branch);
  if (remote.sha === link.base) return { updated: 0, conflicts: [], upToDate: true };
  const st = await status(link);
  const dirty = new Set([...st.added, ...st.modified, ...st.deleted]);
  const files = { ...link.files };
  const conflicts: string[] = [];
  let updated = 0;
  const remotePaths = new Set<string>();
  await pool(remote.blobs, 8, async (e) => {
    remotePaths.add(e.path);
    if (link.files[e.path]?.sha === e.sha) return;                     // unchanged on GitHub
    if (e.size > MAX_BYTES) return;
    const bytes = await download(link.repo, remote.sha, e, token);
    if (dirty.has(e.path)) {
      await edge.writeBytes(`${link.folder}/${e.path}.theirs`, bytes);
      conflicts.push(e.path);
    } else {
      await edge.writeBytes(`${link.folder}/${e.path}`, bytes);
      updated++;
    }
    files[e.path] = { sha: e.sha, mode: e.mode };
  });
  for (const p of Object.keys(link.files)) {
    if (remotePaths.has(p)) continue;                                  // deleted on GitHub
    delete files[p];
    if (dirty.has(p)) { conflicts.push(p); continue; }                 // you changed it: keep yours (shows as added)
    await edge.rm(`${link.folder}/${p}`);
    updated++;
  }
  await saveLink({ ...link, base: remote.sha, files });
  return { updated, conflicts, upToDate: false };
}

/** Create a new GitHub repository from a workspace folder. */
export async function publish(folder: string, name: string, opts: { private?: boolean; onProgress?: (m: string) => void } = {}): Promise<RepoLink> {
  const token = await githubToken();
  if (!token) throw new GitHubError("Publishing needs a GitHub token (⚙ Settings) that can create repositories.");
  opts.onProgress?.("Creating the repository…");
  const repo = await gh(`/user/repos`, { method: "POST", body: JSON.stringify({ name, private: opts.private ?? true, auto_init: true }) }, token);
  const { sha, blobs } = await remoteTree(repo.full_name, repo.default_branch);
  const link: RepoLink = { folder, repo: repo.full_name, branch: repo.default_branch, base: sha,
                           files: Object.fromEntries(blobs.map((b: any) => [b.path, { sha: b.sha, mode: b.mode }])) };
  await saveLink(link);
  // GitHub's README would otherwise look "deleted" locally.
  for (const b of blobs) if (!(await edge.exists(`${folder}/${b.path}`))) await edge.writeBytes(`${folder}/${b.path}`, await download(repo.full_name, sha, b, token));
  await push(link, "Initial commit from EdgeRunner", opts.onProgress).catch((e) => {
    if (!(e instanceof GitHubError && /Nothing to commit/.test(e.message))) throw e;
  });
  return (await links()).find((l) => l.folder === folder)!;
}
