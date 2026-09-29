/**
 * Catalog → pi `Model` conversion.
 *
 * Two things pi cannot infer for Sarvam:
 *
 *  1. Currency. Sarvam bills in Indian Rupees; pi's `ModelCost` is USD per
 *     million tokens. We convert at a documented, overridable rate
 *     (`SARVAM_INR_PER_USD`) because FX drifts and a stale hard-coded rate is a
 *     silently wrong cost report.
 *
 *  2. Request shape. `api.sarvam.ai` matches none of pi's auto-detection
 *     branches, so the detected defaults are wrong in four places — every flag
 *     below is set deliberately and each is backed by a live probe recorded in
 *     README § "What is verified live, and how".
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
  CATALOG,
  SARVAM_EFFORT,
  type CatalogEntry,
  type GatewayApi,
  type InrPrice,
} from "./catalog.ts";

export type { GatewayApi } from "./catalog.ts";

export const PROVIDER_ID = "sarvam";
export const DEFAULT_BASE_URL = "https://api.sarvam.ai/v1";

/**
 * Where a key is created and credits are visible. One constant on purpose: the
 * same URL is printed by the login prompt and by the auth error rewrite, and the
 * two used to be separate literals that could drift. Lives here because
 * `errors.ts` and `provider.ts` both import this module, and neither may import
 * the other's constants without risking a cycle.
 */
export const API_KEYS_URL = "https://dashboard.sarvam.ai";

/**
 * INR per 1 USD. Mid-market rate on 2026-09-26 (open.er-api.com: 1 USD =
 * 95.918696 INR). Overridable per session via `SARVAM_INR_PER_USD`.
 */
export const DEFAULT_INR_PER_USD = 95.918696;

/** Precision so a sub-cent INR rate stays non-zero after conversion. */
const USD_DECIMALS = 1e6;

export function inrPerUsd(env: (name: string) => string | undefined = (n) => process.env[n]): number {
  const raw = env("SARVAM_INR_PER_USD");
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INR_PER_USD;
}

export function inrToUsd(inr: number, rate: number): number {
  return Math.round((inr / rate) * USD_DECIMALS) / USD_DECIMALS;
}

function toCost(inr: InrPrice, rate: number): ModelCost {
  return {
    input: inrToUsd(inr.input, rate),
    output: inrToUsd(inr.output, rate),
    cacheRead: inrToUsd(inr.cacheRead, rate),
    // Sarvam publishes no cache-write price; cached input is billed at cacheRead.
    cacheWrite: 0,
  };
}

/**
 * Compatibility flags for the Sarvam /v1 chat-completions gateway.
 *
 * Auto-detection classifies `api.sarvam.ai` as a vanilla OpenAI endpoint. Each
 * line below either restores a documented field or suppresses one that would
 * break the request:
 *
 *  - maxTokensField        the gateway reads `max_tokens` and *silently ignores*
 *                          `max_completion_tokens` (probed: sending
 *                          max_completion_tokens=99999999 returns a normal
 *                          completion, no cap error). The auto-detected default
 *                          is `max_completion_tokens`, so without this override
 *                          pi's output limit would be dropped and the server
 *                          default (2048) used.
 *  - thinkingFormat        "openai" → a top-level `reasoning_effort` string,
 *                          which is exactly Sarvam's knob.
 *  - supportsReasoningEffort
 *                          explicit, so pi always states an effort instead of
 *                          relying on the server's on-by-default reasoning.
 *  - supportsDeveloperRole the gateway rejects role `developer`
 *                          ("Invalid role 'developer'. Must be one of:
 *                          assistant, system, tool, user"); auto-detection
 *                          defaults to true here.
 *  - supportsStore / supportsLongCacheRetention
 *                          `store` and `prompt_cache_retention` are accepted but
 *                          ignored, and are not in the docs — do not send them.
 *  - supportsStrictMode     Sarvam documents `response_format` but not strict
 *                          JSON-schema tools; keep `strict` off the tool defs.
 *  - supportsUsageInStreaming / supportsFinishReason
 *                          both are actually supported (probed include_usage and
 *                          finish_reason arrive) — left on so token accounting
 *                          and stop reasons work.
 */
export const CHAT_COMPAT: OpenAICompletionsCompat = {
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
  supportsReasoningEffort: true,
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsLongCacheRetention: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsOpenAIGrammarTools: false,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type SarvamModel = Model<GatewayApi>;

export function entryToModel(
  entry: CatalogEntry,
  baseUrl: string,
  rate: number,
): SarvamModel {
  const model: Model<"openai-completions"> = {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: true,
    thinkingLevelMap: entry.thinking.levels,
    input: entry.input,
    cost: toCost(entry.inr, rate),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...CHAT_COMPAT },
  };
  return model;
}

export function buildModels(baseUrl: string, rate: number = inrPerUsd()): SarvamModel[] {
  return CATALOG.map((entry) => entryToModel(entry, baseUrl, rate));
}

/**
 * Conservative shape for a model id this build has never seen (e.g. a future
 * id surfaced by `GET /v1/models`). Cost stays zero so pi reports $0.00 rather
 * than an invented number, and the window is small enough that compaction fires
 * early. Ids in the sarvam-105b family inherit the catalog's real limits.
 */
export const UNKNOWN_MODEL_DEFAULTS = {
  contextWindow: 32_768,
  maxTokens: 4_096,
} as const;

export function guessContext(id: string): number {
  if (/^sarvam-105b-conversations$/i.test(id)) return 32_000;
  if (/^sarvam-105b(?:$|-)/i.test(id)) return 128_000;
  return UNKNOWN_MODEL_DEFAULTS.contextWindow;
}

export function guessMaxTokens(id: string): number {
  if (/^sarvam-105b-conversations$/i.test(id)) return 8_192;
  if (/^sarvam-105b(?:$|-)/i.test(id)) return 16_384;
  return UNKNOWN_MODEL_DEFAULTS.maxTokens;
}

export function guessThinking(): CatalogEntry["thinking"] {
  // Every /v1 chat model is the 105B family and exposes reasoning_effort.
  return { kind: "effort", levels: SARVAM_EFFORT };
}

export function unknownModelToModel(id: string, baseUrl: string): SarvamModel {
  const entry: CatalogEntry = {
    id,
    name: id,
    contextWindow: guessContext(id),
    maxTokens: guessMaxTokens(id),
    input: ["text"],
    thinking: guessThinking(),
    inr: { input: 0, output: 0, cacheRead: 0 },
  };
  const model = entryToModel(entry, baseUrl, DEFAULT_INR_PER_USD);
  // Unknown ids must not invent a price: pin the object so tests can
  // identity-compare against ZERO_COST.
  model.cost = { ...ZERO_COST };
  return model;
}
