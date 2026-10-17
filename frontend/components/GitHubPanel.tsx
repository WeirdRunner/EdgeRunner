"use client";
// Source control for the in-browser workspace: clone GitHub repos into folders, see what changed,
// commit & push, pull, or publish a folder as a new repository (lib/edge/github.ts).

import { useCallback, useEffect, useState } from "react";
import { edge } from "@/lib/edge/runtime";
import * as github from "@/lib/edge/github";
import type { RepoLink, RepoStatus } from "@/lib/edge/github";

const btn = "rounded border border-term-border bg-term-panel px-2 py-1 text-[11px] font-semibold text-term-dim hover:border-term-green hover:text-term-green disabled:opacity-40";
const input = "w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none";

function Repo({ link, onOpen, onChanged }: { link: RepoLink; onOpen: (path: string) => void; onChanged: () => void }) {
  const [st, setSt] = useState<RepoStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean; url?: string } | null>(null);

  const refresh = useCallback(() => { github.status(link).then(setSt).catch((e) => setNote({ text: e.message, ok: false })); }, [link]);
  useEffect(() => { refresh(); return edge.onFiles(refresh); }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try { await fn(); } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
    setBusy(false);
    onChanged();
    refresh();
  };

  const changes = st ? [...st.modified.map((p) => ["M", p]), ...st.added.map((p) => ["A", p]), ...st.deleted.map((p) => ["D", p])] : [];

  return (
    <div className="space-y-2 rounded border border-term-border p-2">
      <div className="flex items-center justify-between gap-2">
        <a href={`https://github.com/${link.repo}/tree/${link.branch}`} target="_blank" rel="noreferrer" className="truncate font-semibold text-term-fg hover:text-term-green">
          {link.repo}
        </a>
        <span className="shrink-0 text-[10px] text-term-dim">⎇ {link.branch} · {link.base.slice(0, 7)}</span>
      </div>
      <div className="text-[10px] text-term-dim">in {link.folder}/</div>
      <div className="max-h-40 space-y-0.5 overflow-y-auto">
        {st === null && <div className="text-[11px] text-term-dim">checking…</div>}
        {st && !changes.length && <div className="text-[11px] text-term-dim">No changes.</div>}
        {changes.map(([k, p]) => (
          <button key={p} onClick={() => k !== "D" && onOpen(`${link.folder}/${p}`)}
                  className="flex w-full items-center gap-1.5 truncate text-left text-[11px] hover:text-term-fg">
            <span className={k === "A" ? "text-term-green" : k === "D" ? "text-term-red" : "text-term-amber"}>{k}</span>
            <span className="truncate text-term-dim">{p}</span>
          </button>
        ))}
      </div>
      {changes.length > 0 && (
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Commit message"
                  className={`${input} h-14 resize-none`} />
      )}
      <div className="flex flex-wrap gap-1.5">
        {changes.length > 0 && (
          <button className={btn} disabled={busy || !msg.trim()} onClick={() => run(async () => {
            const r = await github.push(link, msg.trim(), (m) => setNote({ text: m, ok: true }));
            setMsg("");
            setNote({ text: `Pushed ${r.sha.slice(0, 7)}`, ok: true, url: r.url });
          })}>↑ Commit &amp; push</button>
        )}
        <button className={btn} disabled={busy} onClick={() => run(async () => {
          const r = await github.pull(link, (m) => setNote({ text: m, ok: true }));
          setNote({
            ok: !r.conflicts.length,
            text: r.upToDate ? "Already up to date." : `Pulled ${r.updated} file change${r.updated === 1 ? "" : "s"}.` +
              (r.conflicts.length ? ` Changed on both sides (kept yours; GitHub's saved as .theirs): ${r.conflicts.join(", ")}` : ""),
          });
        })}>↓ Pull</button>
        <button className={btn} disabled={busy} title="Forget the link (files stay)" onClick={() => run(async () => {
          if (confirm(`Stop syncing ${link.folder}/ with ${link.repo}? The files stay in the workspace.`)) await github.unlink(link.folder);
        })}>unlink</button>
      </div>
      {note && (
        <p className={`text-[11px] ${note.ok ? "text-term-green" : "text-term-red"}`}>
          {note.text} {note.url && <a href={note.url} target="_blank" rel="noreferrer" className="underline">view ↗</a>}
        </p>
      )}
    </div>
  );
}

export function GitHubPanel({ onOpenFile, onChanged }: { onOpenFile: (path: string) => void; onChanged: () => void }) {
  const [list, setList] = useState<RepoLink[]>([]);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [pubFolder, setPubFolder] = useState("");
  const [pubName, setPubName] = useState("");

  const reload = useCallback(async () => {
    const l = await github.links();
    setList(l);
    const linked = new Set(l.map((x) => x.folder));
    setFolders((await edge.list(".").catch(() => [])).filter((e) => e.dir && !linked.has(e.name) && e.name !== "node_modules").map((e) => e.name));
  }, []);
  useEffect(() => { void reload(); return edge.onFiles(() => void reload()); }, [reload]);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <div className="border-b border-term-border pb-2 font-bold uppercase tracking-wider text-term-fg">GitHub</div>

      {list.map((l) => <Repo key={l.folder} link={l} onOpen={onOpenFile} onChanged={() => { void reload(); onChanged(); }} />)}

      <div className="space-y-1.5 border-t border-term-border pt-3">
        <div className="text-[10px] font-bold uppercase text-term-dim">Clone a repository</div>
        <input className={input} placeholder="owner/name or github.com URL" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <input className={input} placeholder="branch (default branch if empty)" value={branch} onChange={(e) => setBranch(e.target.value)} />
        <button className={btn} disabled={busy || !repo.trim()} onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            await github.clone(repo, { branch: branch.trim() || undefined, onProgress: (m) => setNote({ text: m, ok: true }) });
            setRepo(""); setBranch("");
            await reload();
            onChanged();
          } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
          setBusy(false);
        }}>⤓ Clone</button>
        {note && <p className={`text-[11px] ${note.ok ? "text-term-green" : "text-term-red"}`}>{note.text}</p>}
      </div>

      {folders.length > 0 && (
        <div className="space-y-1.5 border-t border-term-border pt-3">
          <div className="text-[10px] font-bold uppercase text-term-dim">Publish a folder as a new private repo</div>
          <select className={input} value={pubFolder} onChange={(e) => { setPubFolder(e.target.value); setPubName(e.target.value); }}>
            <option value="">choose a folder…</option>
            {folders.map((f) => <option key={f} value={f}>{f}/</option>)}
          </select>
          {pubFolder && <input className={input} placeholder="repository name" value={pubName} onChange={(e) => setPubName(e.target.value)} />}
          <button className={btn} disabled={busy || !pubFolder || !pubName.trim()} onClick={async () => {
            setBusy(true);
            setNote(null);
            try {
              const l = await github.publish(pubFolder, pubName.trim(), { onProgress: (m) => setNote({ text: m, ok: true }) });
              setNote({ text: `Published github.com/${l.repo}`, ok: true });
              setPubFolder(""); setPubName("");
              await reload();
            } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
            setBusy(false);
          }}>↑ Publish</button>
        </div>
      )}
      <p className="text-[10px] leading-relaxed text-term-dim">
        Works through GitHub&apos;s API: no local history or branches, just clone, commit &amp; push, pull. Private repos,
        pushing and publishing need a token in ⚙ Settings.
      </p>
    </div>
  );
}
