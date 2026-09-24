"use client";
// Pick an OpenRouter model (free ones first) and keep the API key, encrypted in this browser.

import { useEffect, useMemo, useState } from "react";
import { listModels, OR_PREFIX, type OrModel } from "@/lib/agent/openrouter";
import { getSecret, setSecret } from "@/lib/agent/secrets";

export function OpenRouterKey({ onChange }: { onChange?: (hasKey: boolean) => void }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    getSecret("openrouter").then((k) => { setSaved(Boolean(k)); onChange?.(Boolean(k)); });
  }, [onChange]);

  const save = async (v: string | null) => {
    await setSecret("openrouter", v);
    setSaved(Boolean(v));
    setValue("");
    setEditing(false);
    onChange?.(Boolean(v));
  };

  if (saved === null) return null;
  if (saved && !editing) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-term-green">● OpenRouter key saved (encrypted in this browser)</span>
        <button className="text-term-dim underline hover:text-term-fg" onClick={() => setEditing(true)}>change</button>
        <button className="text-term-dim underline hover:text-term-red" onClick={() => save(null)}>remove</button>
      </div>
    );
  }
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(value.trim()); }}
    >
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          placeholder="sk-or-v1-…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg outline-none focus:border-term-green"
        />
        <button type="submit" className="rounded border border-term-green/50 px-2.5 py-1 text-xs text-term-green hover:bg-term-green/10">save</button>
      </div>
      <p className="text-[10px] text-term-dim">
        Free key at{" "}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline hover:text-term-fg">openrouter.ai/keys</a>
        . It stays in this browser and is only sent to OpenRouter.
      </p>
    </form>
  );
}

export function OpenRouterPanel({ currentModelId, onPick }: { currentModelId: string; onPick: (id: string, name: string) => void }) {
  const [models, setModels] = useState<OrModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(true);

  useEffect(() => {
    listModels().then(setModels).catch((e) => setError((e as Error).message));
  }, []);

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return models.filter((m) => m.tools && (!freeOnly || m.free) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
  }, [models, query, freeOnly]);

  return (
    <div className="space-y-3">
      <OpenRouterKey />
      <p className="text-[11px] text-term-dim">
        Runs in your browser: chat, plus the coding agent working on the in-browser workspace. Only models that can use tools are listed.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search models…"
          className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg outline-none focus:border-term-green"
        />
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-term-dim">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> free only
        </label>
      </div>
      {error && <p className="text-[11px] text-term-red">{error}</p>}
      {!error && !models.length && <p className="text-[11px] text-term-dim">loading models…</p>}
      <div className="grid gap-1.5">
        {shown.map((m) => {
          const id = OR_PREFIX + m.id;
          const current = currentModelId === id;
          return (
            <button
              key={m.id}
              onClick={() => onPick(id, m.name)}
              className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-left transition-colors ${
                current ? "border-term-green/80 bg-term-green/10" : "border-term-border bg-term-panel/40 hover:border-term-green/70"
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-term-fg">{m.name}</span>
                <span className="block truncate text-[10px] text-term-dim">{m.id}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-term-dim">
                {m.context ? `${Math.round(m.context / 1000)}k ctx` : ""}
                {m.reasoning && <span className="text-term-amber">thinks</span>}
                {m.free && <span className="text-term-green">free</span>}
                {current && <span className="font-semibold text-term-green">✓</span>}
              </span>
            </button>
          );
        })}
        {models.length > 0 && !shown.length && <p className="text-[11px] text-term-dim">No matching models.</p>}
      </div>
    </div>
  );
}
