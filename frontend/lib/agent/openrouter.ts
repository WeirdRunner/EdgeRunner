// OpenRouter, called straight from the browser: one key, many models (including free ones).
// Model ids in conversations look like "openrouter/qwen/qwen3.8-27b:free".

import { getSecret } from "./secrets";

export const OR_PREFIX = "openrouter/";
const API = "https://openrouter.ai/api/v1";
// Picked when nothing is chosen yet: free, tool-calling, good at code (first one that's still listed wins).
const PREFERRED = ["poolside/laguna-s-2.1:free", "qwen/qwen3.8-27b:free", "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free", "cohere/north-mini-code:free"];

export interface OrModel { id: string; name: string; context: number; tools: boolean; reasoning: boolean; free: boolean }
export interface ToolCallDelta { id: string; name: string; arguments: string }
export type OrChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_calls"; calls: ToolCallDelta[] }
  | { type: "usage"; prompt: number; completion: number }
  | { type: "finish"; reason: string };

export class ProviderError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

let cache: { at: number; models: OrModel[] } | null = null;

export async function listModels(): Promise<OrModel[]> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.models;
  const r = await fetch(`${API}/models`);
  if (!r.ok) throw new ProviderError(`Couldn't load OpenRouter's model list (${r.status}).`, r.status);
  const data = (await r.json()).data as Array<Record<string, any>>;
  const models = data.map((m) => ({
    id: m.id as string, name: (m.name as string) || m.id,
    context: (m.context_length as number) || 0,
    tools: (m.supported_parameters || []).includes("tools"),
    reasoning: (m.supported_parameters || []).includes("reasoning"),
    free: String(m.id).endsWith(":free"),
  })).sort((a, b) => Number(b.free) - Number(a.free) || Number(b.tools) - Number(a.tools) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), models };
  return models;
}

export async function defaultModel(): Promise<string> {
  const models = await listModels().catch(() => [] as OrModel[]);
  const ids = new Set(models.map((m) => m.id));
  return OR_PREFIX + (PREFERRED.find((p) => ids.has(p)) || models.find((m) => m.free && m.tools)?.id || PREFERRED[0]);
}

function explain(status: number, body: string): string {
  let msg = body;
  try { msg = JSON.parse(body)?.error?.message || body; } catch { /* plain text */ }
  if (status === 401) return "OpenRouter didn't accept your API key — check it in ⚙ Settings → Models.";
  if (status === 402) return "Your OpenRouter account is out of credit for this model. Pick a free model (ending in :free).";
  if (status === 429) return `OpenRouter rate limit: ${msg}. Free models allow a limited number of requests per day — try again later, pick another free model, or add a little credit to raise the limit.`;
  if (status === 404) return `OpenRouter: ${msg}. The model may no longer be available — pick another one.`;
  return `OpenRouter ${status}: ${String(msg).slice(0, 300)}`;
}

export async function* streamCompletion(opts: {
  model: string; messages: unknown[]; tools?: unknown[]; signal?: AbortSignal;
  temperature?: number; maxTokens?: number;
}): AsyncGenerator<OrChunk> {
  const key = await getSecret("openrouter");
  if (!key) throw new ProviderError("Add your OpenRouter API key in ⚙ Settings → Models (free at openrouter.ai/keys).", 401);
  const body: Record<string, unknown> = {
    model: opts.model.startsWith(OR_PREFIX) ? opts.model.slice(OR_PREFIX.length) : opts.model,
    messages: opts.messages, stream: true, usage: { include: true },
    ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  };
  const r = await fetch(`${API}/chat/completions`, {
    method: "POST", signal: opts.signal, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
               "HTTP-Referer": "https://github.com/deveshpat/EdgeRunner", "X-Title": "EdgeRunner" },
  });
  if (!r.ok || !r.body) throw new ProviderError(explain(r.status, await r.text()), r.status);

  const calls = new Map<number, ToolCallDelta>();
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;                 // ": OPENROUTER PROCESSING" keep-alives
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new ProviderError(explain(chunk.error.code || 500, JSON.stringify(chunk)), chunk.error.code);
      if (chunk.usage) yield { type: "usage", prompt: chunk.usage.prompt_tokens || 0, completion: chunk.usage.completion_tokens || 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      const reasoning = d.reasoning ?? d.reasoning_content;
      if (reasoning) yield { type: "reasoning", text: reasoning };
      if (d.content) yield { type: "text", text: d.content };
      for (const tc of d.tool_calls || []) {
        const slot = calls.get(tc.index ?? 0) || { id: "", name: "", arguments: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        calls.set(tc.index ?? 0, slot);
      }
      if (choice.finish_reason) {
        if (calls.size) yield { type: "tool_calls", calls: [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })) };
        yield { type: "finish", reason: choice.finish_reason };
        calls.clear();
      }
    }
  }
  if (calls.size) yield { type: "tool_calls", calls: [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })) };
}
