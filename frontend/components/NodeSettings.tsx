"use client";
// Connect the EdgeRunner node on your Mac, and choose the project folders the agent may work in.

import { useCallback, useEffect, useState } from "react";
import { SecretField } from "./SecretField";
import { DEFAULT_NODE_URL, nodeFetch, nodeInfo, nodeUrl, setNodeUrl, type NodeInfo } from "@/lib/agent/workspace";
import type { Settings } from "@/lib/storage";

const input = "rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none";
const btn = "rounded border border-term-border px-2 py-1 text-[11px] text-term-dim hover:border-term-green hover:text-term-green disabled:opacity-40";

export function NodeSettings({ settings, onSettingsChange }: { settings: Settings; onSettingsChange: (p: Partial<Settings>) => void }) {
  const [url, setUrl] = useState(DEFAULT_NODE_URL);
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setError(null);
    try { setInfo(await nodeInfo()); } catch (e) { setInfo(null); setError((e as Error).message); }
  }, []);

  useEffect(() => { setUrl(nodeUrl()); void check(); }, [check]);

  return (
    <div className="space-y-3 rounded-lg border border-term-border bg-term-panel/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-term-fg">MAC NODE (AGENT ON YOUR OWN FILES)</span>
        <span className={`text-[11px] ${info ? "text-term-green" : "text-term-dim"}`}>
          {info ? `● connected${info.sandbox ? " · sandboxed" : ""}` : "○ not connected"}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-term-dim">
        On your Mac run <code className="text-term-fg">edgerunner-node</code> (from the backend folder) and paste the token it prints
        (<code className="text-term-fg">edgerunner-node --token</code> shows it again). The agent can then work in the project folders
        you add below — nothing else on the Mac.
      </p>
      <div className="flex gap-2">
        <input className={`${input} min-w-0 flex-1`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={DEFAULT_NODE_URL} />
        <button className={btn} onClick={() => { setNodeUrl(url); void check(); }}>connect</button>
      </div>
      <SecretField name="node" label="Node token" placeholder="token from edgerunner-node" onChange={() => void check()}
                   help={<>Stored encrypted in this browser; only sent to your node.</>} />
      {error && <p className="text-[11px] text-term-red">{error}</p>}

      {info && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold uppercase text-term-dim">Projects</div>
          {info.projects.length === 0 && <p className="text-[11px] text-term-dim">None yet — add a folder the agent may work in.</p>}
          {info.projects.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate"><span className="text-term-fg">{p.name}</span> <span className="text-term-dim">{p.path}</span></span>
              <button className="shrink-0 text-term-dim hover:text-term-red" onClick={async () => {
                await nodeFetch(`/projects/${p.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
                void check();
              }}>remove</button>
            </div>
          ))}
          <div className="flex gap-2">
            <input className={`${input} min-w-0 flex-1`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/code/my-app" />
            <button className={btn} disabled={busy || !folder.trim()} onClick={async () => {
              setBusy(true);
              try {
                await nodeFetch("/projects", { method: "POST", body: JSON.stringify({ path: folder.trim() }) });
                setFolder("");
                await check();
              } catch (e) { setError((e as Error).message); }
              setBusy(false);
            }}>add folder</button>
          </div>
          <label className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-term-dim">
            On the Mac, the agent asks before:
            <select value={settings.nodeApproval ?? "commands"} className={input}
                    onChange={(e) => onSettingsChange({ nodeApproval: e.target.value as Settings["nodeApproval"] })}>
              <option value="commands">running commands (recommended)</option>
              <option value="all">file edits and commands</option>
              <option value="auto">nothing</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
