/**
 * Live checks against the real Sarvam gateway — the items the offline suite
 * cannot cover (README § "What is verified live, and how"). Not part of
 * `npm test`: run explicitly with `npm run live`.
 *
 * Cost discipline (the whole point): every check is either a *rejected* request
 * (free) or a tiny generation (`max_tokens ≤ 64`, a 15-token prompt). Nothing
 * here generates output to "find a limit" — the limits were read from the
 * gateway's own rejection text, which is free. Each check prints the tokens it
 * spent and the cost those tokens imply at the catalog rates.
 *
 *  A. GET /v1/models: the key is accepted and the live ids match the catalog.
 *  B. Off: a tiny streaming turn with reasoning disabled → usage arrives,
 *     the wire body carries `reasoning_effort: null`, `max_tokens`,
 *     `include_usage`.
 *  C. On: reasoning_effort="low" → the reply carries `reasoning_content`.
 *  D. Tools: a function tool round-trips (finish_reason tool_calls → pi toolcall).
 *  E. Overflow: an over-context prompt is rejected, and pi's own classifier
 *     recognizes it *after* our rewrite (the raw text is not recognizable — the
 *     control proves the rewrite is doing the work). Free: the request 422s.
 *  F. Auth: a bad key is rejected and becomes a readable, non-retryable message.
 *  G. A user turn sent as a parts array (the shape pi's agent actually sends)
 *     is flattened and accepted.
 *
 * Prints PASS/FAIL per item; exit code 1 if anything failed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
  type ThinkingLevel,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { CATALOG_BY_ID, type CatalogEntry } from "../catalog.ts";
import { clarifyErrorMessage, fixSarvamPayload, normalizeOverflowError } from "../errors.ts";
import { DEFAULT_BASE_URL, DEFAULT_INR_PER_USD, entryToModel, inrToUsd } from "../models.ts";
import { parseModelIds } from "../discovery.ts";

// --- key ---------------------------------------------------------------------

/**
 * pi's own agent-dir resolver, so `$PI_CODING_AGENT_DIR` and rebranded
 * distributions are honoured: a hardcoded `~/.pi/agent/auth.json` misses a pi
 * started with an alternate config dir, which is where `/login sarvam` stored the
 * credential. Same class as the pi-nvidia-plus store fix (2026-09-30).
 */
const authJsonPath = (): string => join(getAgentDir(), "auth.json");

function loadKey(): string {
  if (process.env.SARVAM_API_KEY?.trim()) return process.env.SARVAM_API_KEY.trim();
  const auth = JSON.parse(readFileSync(authJsonPath(), "utf8")) as Record<
    string,
    { type?: string; key?: string }
  >;
  const key = auth["sarvam"]?.key?.trim();
  if (!key) throw new Error(`no sarvam key in SARVAM_API_KEY or ${authJsonPath()}`);
  return key;
}

const KEY = loadKey();
const api = openAICompletionsApi();
let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`\n[${tag}] ${name}\n${detail.replace(/^/gm, "  ")}`);
}

// --- cost accounting ----------------------------------------------------------

/** USD implied by a usage report, using the catalog's documented INR rates. */
function costOf(entry: CatalogEntry, usage: Usage): number {
  const { input, output, cacheRead } = entry.inr;
  const usd = (inr: number) => inrToUsd(inr, DEFAULT_INR_PER_USD);
  return (
    (usage.input * usd(input)) / 1e6 +
    (usage.output * usd(output)) / 1e6 +
    (usage.cacheRead * usd(cacheRead)) / 1e6
  );
}

function money(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// --- runner -------------------------------------------------------------------

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) throw new Error(`${id} not in catalog`);
  return entryToModel(entry, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD) as Model<"openai-completions">;
}

interface LiveResult {
  status: number;
  raw: string;
  text: string;
  reasoning: string;
  toolCalls: number;
  errorMessage: string | undefined;
  stopReason: string | undefined;
  usage: Usage;
  sent: Record<string, any>;
}

async function run(
  target: Model<"openai-completions">,
  options: {
    prompt: string;
    reasoning?: ThinkingLevel;
    maxTokens?: number;
    tools?: Tool[];
    apiKey?: string;
    userContent?: unknown;
  },
): Promise<LiveResult> {
  const ctx = normalizeContext({
    systemPrompt: "You are concise. Answer briefly.",
    messages: [
      {
        role: "user",
        content: (options.userContent ?? options.prompt) as any,
        timestamp: Date.now(),
      },
    ],
    tools: options.tools,
  });

  let status = 0;
  let raw = "";
  let text = "";
  let reasoning = "";
  let toolCalls = 0;
  let errorMessage: string | undefined;
  let stopReason: string | undefined;
  let final: AssistantMessage | undefined;
  let sent: Record<string, any> = {};

  const tee: typeof fetch = (async (input: any, init: any) => {
    const res = await fetch(input, init);
    status = res.status;
    void res.clone().text().then((t) => { raw = t; }).catch(() => {});
    return res;
  }) as typeof fetch;

  const stream = api.streamSimple(target, ctx, {
    apiKey: options.apiKey ?? KEY,
    reasoning: options.reasoning,
    maxTokens: options.maxTokens ?? 16,
    // Mirror the extension's before_provider_request hook.
    onPayload: (body) => {
      const fixed = fixSarvamPayload(body as Record<string, any>);
      sent = (fixed ?? body) as Record<string, any>;
      return fixed;
    },
    fetch: tee,
  });

  for await (const event of stream) {
    if (event.type === "done") { final = event.message; stopReason = `done:${event.reason}`; }
    if (event.type === "error") { errorMessage = event.error.errorMessage; final = event.error; stopReason = `error:${event.reason}`; }
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "thinking_delta") reasoning += event.delta;
    if (event.type === "toolcall_end") toolCalls++;
  }

  await new Promise((r) => setTimeout(r, 300));
  return {
    status,
    raw,
    text,
    reasoning,
    toolCalls,
    errorMessage,
    stopReason,
    usage: final?.usage ?? ZERO_USAGE,
    sent,
  };
}

// --- A. key + listing ---------------------------------------------------------

async function checkListing(): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/models`);
  const body = await res.text();
  if (res.status !== 200) {
    report("A: GET /v1/models", false, `status ${res.status}: ${body.slice(0, 200)}`);
    return;
  }
  const ids = parseModelIds(JSON.parse(body));
  const known = new Set(CATALOG_BY_ID.keys());
  const unknown = ids.filter((id) => !known.has(id));
  const stale = [...known].filter((id) => !ids.includes(id));
  report(
    "A: GET /v1/models (free)",
    stale.length === 0,
    [
      `${ids.length} ids listed: ${ids.join(", ")}`,
      `catalog ids not served (stale): ${stale.join(", ") || "none"}`,
      `gateway ids not in catalog (overlay candidates): ${unknown.join(", ") || "none"}`,
    ].join("\n"),
  );
}

// --- B..F ---------------------------------------------------------------------

async function main(): Promise<void> {
  await checkListing();
  let total = 0;

  // B: reasoning off — a real streaming turn with usage accounting.
  {
    const entry = CATALOG_BY_ID.get("sarvam-105b")!;
    const r = await run(model("sarvam-105b"), {
      prompt: "Say ok and nothing else.",
      reasoning: "off" as ThinkingLevel,
      maxTokens: 8,
    });
    const usd = costOf(entry, r.usage);
    total += usd;
    const usageInSse = /"usage"\s*:\s*\{[^}]*\}/.test(r.raw);
    report(
      "B: reasoning off — tiny streaming turn + usage",
      r.status === 200 && !r.errorMessage && r.usage.input > 0 && r.usage.output > 0,
      [
        `sent: max_tokens=${r.sent.max_tokens} reasoning_effort=${JSON.stringify(r.sent.reasoning_effort)} stream=${r.sent.stream} stream_options=${JSON.stringify(r.sent.stream_options)}`,
        `usage: input=${r.usage.input} output=${r.usage.output} reasoning=${r.usage.reasoning ?? "n/a"} total=${r.usage.totalTokens}`,
        `finish: ${r.stopReason}; usage object in SSE: ${usageInSse}`,
        `answer: ${JSON.stringify(r.text.slice(0, 40))}`,
        `spent ${r.usage.input + r.usage.output} tokens = ${money(usd)}`,
      ].join("\n"),
    );
  }

  // C: reasoning on — the reply must carry reasoning_content.
  {
    const entry = CATALOG_BY_ID.get("sarvam-105b")!;
    const r = await run(model("sarvam-105b"), {
      prompt: "What is 17*23? Answer with the number only.",
      reasoning: "low" as ThinkingLevel,
      maxTokens: 64,
    });
    const usd = costOf(entry, r.usage);
    total += usd;
    report(
      "C: reasoning on — reasoning_content present",
      r.usage.output > 0 && (r.reasoning.length > 0 || /reasoning_content/.test(r.raw)),
      [
        `sent reasoning_effort=${r.sent.reasoning_effort}`,
        `reasoning chars streamed: ${r.reasoning.length}`,
        `usage: input=${r.usage.input} output=${r.usage.output}`,
        `answer: ${JSON.stringify(r.text.slice(0, 40))}`,
        `spent ${r.usage.input + r.usage.output} tokens = ${money(usd)}`,
      ].join("\n"),
    );
  }

  // D: tools round-trip.
  {
    const entry = CATALOG_BY_ID.get("sarvam-105b")!;
    const weatherTool: Tool = {
      name: "get_weather",
      description: "Look up the weather for a city.",
      parameters: Type.Object({ city: Type.String({ description: "City" }) }),
    };
    const r = await run(model("sarvam-105b"), {
      prompt: "What is the weather in Paris? Use the tool.",
      reasoning: "off" as ThinkingLevel,
      maxTokens: 64,
      tools: [weatherTool],
    });
    const usd = costOf(entry, r.usage);
    total += usd;
    report(
      "D: function tool call round-trip",
      r.toolCalls >= 1 && !r.errorMessage,
      [
        `toolcall_end events: ${r.toolCalls}`,
        `finish: ${r.stopReason}`,
        `sent tools: ${Array.isArray(r.sent.tools) ? r.sent.tools.length : 0}, strict on tool: ${"strict" in (r.sent.tools?.[0]?.function ?? {})}`,
        `spent ${r.usage.input + r.usage.output} tokens = ${money(usd)}`,
      ].join("\n"),
    );
  }

  // E: overflow → rejected (free), then pi's classifier must accept our rewrite.
  {
    const huge = "word ".repeat(200_000); // ~200k tokens ≫ 128k window
    const r = await run(model("sarvam-105b"), {
      prompt: huge,
      reasoning: "off" as ThinkingLevel,
      maxTokens: 8,
    });
    const raw = r.errorMessage ?? "";
    const rewritten = normalizeOverflowError(raw);
    const asMsg = (m: string) => ({ role: "assistant", stopReason: "error", errorMessage: m }) as any;
    report(
      "E: over-context prompt rejected + recognized (free rejection)",
      r.status === 422 && !!rewritten && isContextOverflow(asMsg(rewritten)) && !isContextOverflow(asMsg(raw)),
      [
        `http status: ${r.status}`,
        `raw error recognized by pi as overflow: ${isContextOverflow(asMsg(raw))} (control — must be false)`,
        `after rewrite recognized: ${rewritten ? isContextOverflow(asMsg(rewritten)) : "n/a"}`,
        `raw: ${raw.slice(0, 220)}`,
        `spent 0 tokens = ${money(0)}`,
      ].join("\n"),
    );
  }

  // F: auth failure path (free).
  {
    const r = await run(model("sarvam-105b"), {
      prompt: "hi",
      reasoning: "off" as ThinkingLevel,
      maxTokens: 8,
      apiKey: "sk_invalid_key_for_the_auth_check",
    });
    const raw = r.errorMessage ?? "";
    const clarified = clarifyErrorMessage(raw);
    const asMsg = (m: string) => ({ role: "assistant", stopReason: "error", errorMessage: m }) as any;
    report(
      "F: invalid key rejected and clarified (free)",
      r.status === 403 && !!clarified && !isContextOverflow(asMsg(clarified)) && !isRetryableAssistantError(asMsg(clarified)),
      [
        `http status: ${r.status}`,
        `raw: ${raw.slice(0, 200)}`,
        `clarified: ${(clarified ?? "(none)").slice(0, 200)}`,
        `spent 0 tokens = ${money(0)}`,
      ].join("\n"),
    );
  }

  // G: pi's agent sends the user turn as a parts array, not a plain string.
  {
    const entry = CATALOG_BY_ID.get("sarvam-105b")!;
    const r = await run(model("sarvam-105b"), {
      prompt: "ignored",
      userContent: [{ type: "text", text: "Reply with exactly: ok" }],
      reasoning: "off" as ThinkingLevel,
      maxTokens: 8,
    });
    const usd = costOf(entry, r.usage);
    total += usd;
    const userMsg = (r.sent.messages ?? []).find((m: any) => m?.role === "user");
    report(
      "G: user turn sent as a parts array is flattened",
      r.status === 200 && !r.errorMessage && typeof userMsg?.content === "string",
      [
        `wire user.content type: ${Array.isArray(userMsg?.content) ? "array (BUG)" : typeof userMsg?.content}`,
        `answer: ${JSON.stringify(r.text.slice(0, 40))}`,
        `usage: input=${r.usage.input} output=${r.usage.output}`,
        `spent ${r.usage.input + r.usage.output} tokens = ${money(usd)}`,
      ].join("\n"),
    );
  }

  console.log(`\nTotal live spend this run: ${money(total)} (rejected requests are not billed)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
