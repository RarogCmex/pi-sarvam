/**
 * Curated Sarvam AI catalog for the v1 endpoint (https://api.sarvam.ai/v1).
 *
 * Data provenance — every number was read from a public Sarvam page and then
 * confirmed (or corrected) against the live gateway on 2026-09-26. Nothing here
 * is guessed; where the docs and the gateway disagreed, the gateway won and the
 * disagreement is recorded in the comment.
 *
 *   ids                  GET https://api.sarvam.ai/v1/models (live, 2026-09-26)
 *                        → ["sarvam-105b", "sarvam-105b-conversations"]
 *   contextWindow        docs.sarvam.ai/api/getting-started/models/sarvam-105b
 *                        live: 422 error text "exceeds the model context window
 *                        of 128000 tokens for sarvam-105b" (200008+8 input)
 *                        → 128000. conversations: "32000 tokens".
 *   max output cap       live 400: "max_tokens (N) exceeds the maximum output
 *                        length of 128000 tokens for sarvam-105b" / "8192 tokens
 *                        for sarvam-105b-conversations".
 *   prices (INR/1M)      docs.sarvam.ai/api/getting-started/pricing
 *   reasoning_effort     live 400: "Input should be 'low', 'medium' or 'high'"
 *                        (the how-to page claims a default of "medium" and the
 *                        model page claims "low"; both are unverified defaults,
 *                        and both are irrelevant because pi always states one.)
 *
 * What is deliberately NOT here:
 *   - The open-weight models (glm5.3, gemma4, deepseekv4-flash) live on
 *     /v2/chat/completions and are beta-gated per key. /v1 404s them and
 *     /v1/models never lists them, so this plugin (pinned to /v1) cannot serve
 *     them. They are documented as "exists but not added" in the README.
 *   - Non-chat Sarvam modalities (Saaras STT, Bulbul TTS, Mayura translate,
 *     document intelligence) are not chat-completions shapes and are out of
 *     scope for a coding agent's provider plugin.
 *   - Sarvam-M / Sarvam-30B are deprecated and absent from /v1/models.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Sarvam speaks the OpenAI chat-completions shape on /v1. */
export type GatewayApi = "openai-completions";

/** Indian Rupees per 1M tokens (the currency Sarvam bills in). */
export interface InrPrice {
  input: number;
  output: number;
  /** Documented "cached input" rate; see the note in models.ts about usage reporting. */
  cacheRead: number;
}

/**
 * How the model exposes reasoning. Sarvam only has one shape: a top-level
 * `reasoning_effort` string, with reasoning *on by default* and disabled by
 * sending `null` (probed 2026-09-26). See models.ts for the off-handling.
 */
export interface ThinkingControl {
  kind: "effort";
  levels: ThinkingLevelMap;
}

export interface CatalogEntry {
  /** Exact Sarvam model id — case-sensitive (a wrong id 400s, not 404s). */
  id: string;
  name: string;
  /** Total window shared by prompt + reasoning + answer (prompt+N ≤ window). */
  contextWindow: number;
  /**
   * `max_tokens` pi sends. NOT the model's absolute output ceiling — see the
   * rationale in the entries below.
   */
  maxTokens: number;
  input: ("text" | "image")[];
  thinking: ThinkingControl;
  inr: InrPrice;
  /** Free-text caveat surfaced in the README; pi's Model has no notes field. */
  priceNote?: string;
}

/**
 * Sarvam accepts exactly three `reasoning_effort` strings — `low`, `medium`,
 * `high` (live 400 enumerates them). pi's six levels collapse onto them:
 * `minimal` shares `low`, and `xhigh`/`max` are marked unsupported so pi
 * down-clamps them to `high` instead of sending an invalid value.
 *
 * `off` is intentionally absent from this map. Mapping `off: null` would *hide*
 * the switch from pi (an all-null level is dropped from the picker and the
 * request is up-clamped to `low`), silently billing reasoning the user asked to
 * turn off. Leaving `off` unmapped keeps it selectable; the missing `null`
 * argument that pi then omits is injected in the transport hook (index.ts).
 */
export const SARVAM_EFFORT: ThinkingLevelMap = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "sarvam-105b",
    name: "Sarvam 105B",
    contextWindow: 128_000,
    // The model's absolute output cap is 128000 (live). We publish 16384 so the
    // gateway's shared-budget rule (prompt_tokens + max_tokens ≤ 128000) holds
    // right up to pi's compaction boundary: pi compacts at
    // contextWindow − reserveTokens (default 16384) and sends max_tokens =
    // model.maxTokens, so 111616 + 16384 = 128000 exactly. Declaring 128000
    // here would make pi reject its own requests with a 422 the moment the
    // prompt carried a single token.
    maxTokens: 16_384,
    input: ["text"],
    thinking: { kind: "effort", levels: SARVAM_EFFORT },
    inr: { input: 29.28, output: 73.2, cacheRead: 10.98 },
    priceNote: "reasoning tokens bill as output; no separate cache-write price",
  },
  {
    id: "sarvam-105b-conversations",
    name: "Sarvam 105B Chat",
    contextWindow: 32_000,
    // Its absolute output cap (8192) is below pi's 16384 reserve, so use it
    // directly: 15616 (compaction boundary) + 8192 < 32000.
    maxTokens: 8_192,
    input: ["text"],
    thinking: { kind: "effort", levels: SARVAM_EFFORT },
    inr: { input: 29.28, output: 73.2, cacheRead: 10.98 },
    priceNote: "reasoning tokens bill as output; /v1-only (no /v2 route)",
  },
];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.id, entry]),
);
