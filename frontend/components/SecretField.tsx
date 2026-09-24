"use client";
// A password field for an API key, stored encrypted in this browser (lib/agent/secrets.ts).

import { useEffect, useState } from "react";
import { getSecret, setSecret } from "@/lib/agent/secrets";

export function SecretField({ name, label, placeholder, help, onChange }: {
  name: string; label: string; placeholder: string; help: React.ReactNode; onChange?: (has: boolean) => void;
}) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    getSecret(name).then((k) => { setSaved(Boolean(k)); onChange?.(Boolean(k)); });
  }, [name, onChange]);

  const save = async (v: string | null) => {
    await setSecret(name, v);
    setSaved(Boolean(v));
    setValue("");
    setEditing(false);
    onChange?.(Boolean(v));
  };

  if (saved === null) return null;
  if (saved && !editing) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-term-green">● {label} saved (encrypted in this browser)</span>
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
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg outline-none focus:border-term-green"
        />
        <button type="submit" className="rounded border border-term-green/50 px-2.5 py-1 text-xs text-term-green hover:bg-term-green/10">save</button>
      </div>
      <p className="text-[10px] text-term-dim">{help}</p>
    </form>
  );
}

