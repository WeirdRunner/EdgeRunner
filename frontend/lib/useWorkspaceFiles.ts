"use client";
// The file tree of the in-browser workspace (lib/edge/runtime.ts). Refreshes itself when anything
// changes files — the agent, the terminal or the editor.

import { useCallback, useEffect, useState } from "react";
import { edge } from "@/lib/edge/runtime";

export interface FileItem {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
  children?: FileItem[];
}

export interface UseWorkspaceFiles {
  items: FileItem[];
  root: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  readFile: (path: string) => Promise<{ content: string; size: number; name: string }>;
  writeFile: (path: string, content: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<boolean>;
  deleteItem: (path: string) => Promise<boolean>;
}

const HIDDEN = new Set(["node_modules", ".git"]);   // shown, but not expanded (can be huge)

async function tree(path: string, budget = { left: 3000 }): Promise<FileItem[]> {
  const out: FileItem[] = [];
  for (const e of await edge.list(path)) {
    if (budget.left-- <= 0) break;
    if (e.dir) {
      out.push({ name: e.name, path: e.path, type: "directory", children: HIDDEN.has(e.name) ? [] : await tree(e.path, budget) });
    } else {
      out.push({ name: e.name, path: e.path, type: "file" });
    }
  }
  return out;
}

export function useWorkspaceFiles(): UseWorkspaceFiles {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await tree("."));
      setError(null);
    } catch (e) {
      setError(edge.support() || (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return edge.onFiles(() => void refresh());
  }, [refresh]);

  const readFile = useCallback(async (path: string) => {
    const content = await edge.read(path);
    return { content, size: content.length, name: path.split("/").pop() || path };
  }, []);

  const writeFile = useCallback(async (path: string, content: string) => {
    await edge.write(path, content);
    await refresh();
    return true;
  }, [refresh]);

  const deleteItem = useCallback(async (path: string) => {
    await edge.rm(path);
    await refresh();
    return true;
  }, [refresh]);

  const mkdir = useCallback(async (path: string) => {
    const clean = path.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return false;
    await edge.mkdir(clean);
    await refresh();
    return true;
  }, [refresh]);

  return { items, root: "~/workspace", loading, error, refresh, readFile, writeFile, mkdir, deleteItem };
}
