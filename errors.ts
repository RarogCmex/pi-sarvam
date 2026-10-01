/**
 * Error-message clarification and payload fixes for the Sarvam gateway.
 *
 * Two jobs, both narrow and both unit-testable without a network:
 *
 *  1. Overflow normalization. Sarvam rejects a prompt that does not fit with
 *     HTTP 422 and the message
 *       "prompt_tokens (200008) + max_tokens (8) = 200016 exceeds the model
 *        context window of 128000 tokens for sarvam-105b."
 *     None of pi's built-in overflow patterns match that wording ("exceeds the
 *     context window" requires the literal article, absent here), so without a
 *     rewrite auto-compaction never fires and the session is stuck. We prefix
 *     the message with `context_length_exceeded`, which pi's classifier does
 *     match.
 *
 *  2. Auth clarification. An invalid/absent key returns HTTP 403 (not 401) with
 *     an OpenAI-shaped body, so pi's message is a flattened
 *     `403: {"message":"Invalid or missing authentication credentials",
 *      "code":"invalid_api_key_error",...}`. We turn that into a sentence that
 *     names the dashboard and the `/login` command.
 *
 *  3. Request-shape fixes. Sarvam is a Pydantic-validated single-vendor API and
 *     rejects three payload shapes pi produces by default:
 *     (a) pi sends a user turn as a *parts array*
 *         (`[{"type":"text","text":"…"}]`) while Sarvam requires a plain
 *         string (`400 body.messages.1.user.content : Input should be a valid
 *         string`);
 *     (b) Sarvam reasons *by default* and only disables it when
 *         `reasoning_effort: null` is present, while pi omits the field for its
 *         `off` level; and
 *     (c) Sarvam requires a tool result to carry at least one non-whitespace
 *         character (`400 body.messages.N.tool.content : String should match
 *         pattern '\S'`), while pi routinely produces blank ones.
 *     `fixSarvamPayload` applies all three, narrowly.
 *
 * Every rewrite avoids the substrings pi's retry classifier and overflow
 * detector key on (except the deliberate `context_length_exceeded` marker), so
 * a permanent auth failure cannot become a retry loop and an auth message
 * cannot trigger compaction.
 */

import { API_KEYS_URL, PROVIDER_ID } from "./models.ts";

/** Local alias so the wording below stays readable; defined once in models.ts. */
const KEY_DASHBOARD_URL = API_KEYS_URL;

/**
 * The gateway's oversize-prompt wording. Confirmed live 2026-09-26 for both
 * `sarvam-105b` ("128000 tokens") and `sarvam-105b-conversations` ("32000
 * tokens"). Deliberately specific: the sibling 400
 * "exceeds the maximum output length of N tokens" is a max_tokens/config error,
 * not an overflow, and must not trigger compaction.
 */
const CONTEXT_OVERFLOW_RE = /exceeds the model context window of [\d,]+ tokens?/i;

/** Never treat a throttle as an overflow. */
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|\bRPM\b|\bTPM\b|\bRPD\b|\bTPD\b|\bquota\b/i;

/** Sarvam's 403 auth rejection, either as the error code or the raw sentence. */
const AUTH_FAILURE_RE = /invalid_api_key_error|invalid or missing authentication credentials/i;

/**
 * Map Sarvam overflow phrasing onto pi's `context_length_exceeded` marker so
 * auto-compaction runs. Returns the rewritten text, or null when the error is
 * not a genuine overflow (or already rewritten — idempotent).
 */
export function normalizeOverflowError(errorMessage: string): string | null {
  if (!errorMessage) return null;
  if (errorMessage.startsWith("context_length_exceeded")) return null;
  if (RATE_LIMIT_RE.test(errorMessage)) return null;
  if (!CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
  return `context_length_exceeded: ${errorMessage}`;
}

/**
 * Return a clearer message for a Sarvam auth/billing failure, or undefined when
 * the message should be left exactly as pi produced it.
 *
 * The rewrite names both causes the gateway collapses into one status (invalid
 * key and zero credit balance share the 403), and points at the dashboard.
 */
export function clarifyErrorMessage(errorMessage: string): string | undefined {
  const trimmed = errorMessage.trim();
  if (!AUTH_FAILURE_RE.test(trimmed)) return undefined;
  return (
    `${PROVIDER_ID}: authentication failed (HTTP 403). Sarvam rejects an invalid, ` +
    "revoked or expired API key — and an account with no remaining credits — with the " +
    `same status, so check both. Create or verify a key at ${KEY_DASHBOARD_URL} ` +
    `(credits: ${KEY_DASHBOARD_URL}/billing), then run /login ${PROVIDER_ID} ` +
    "or update SARVAM_API_KEY. Original message: " +
    errorMessage
  );
}

/** True when an assistant message is a Sarvam auth failure worth clarifying. */
export function shouldClarify(message: {
  role: string;
  stopReason?: string;
  provider?: string;
  errorMessage?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === PROVIDER_ID &&
    typeof message.errorMessage === "string" &&
    AUTH_FAILURE_RE.test(message.errorMessage.trim())
  );
}

/** Every /v1 chat id lives in the sarvam-105b family. */
const SARVAM_MODEL_RE = /^sarvam-/i;

/**
 * Collapse a text-only parts array into a string. Anything that is not a
 * non-empty array of `{type:"text",text:string}` parts (a plain string, an
 * image/attachment array, a malformed value) is returned unchanged, so images
 * fail loudly at the gateway instead of being silently dropped. Pure.
 */
export function flattenTextParts(content: unknown): unknown {
  if (!Array.isArray(content) || content.length === 0) return content;
  const textOnly = content.every(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
  );
  if (!textOnly) return content;
  return (content as { text: string }[]).map((part) => part.text).join("");
}

/** Rewrite every message whose `content` is a text-only parts array. */
export function flattenMessageContent(
  payload: Record<string, any>,
): Record<string, any> | undefined {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return undefined;
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message.content) === false) {
      return message;
    }
    const flat = flattenTextParts(message.content);
    if (flat === message.content) return message;
    changed = true;
    return { ...message, content: flat };
  });
  return changed ? { ...payload, messages: next } : undefined;
}

/**
 * The text a blank tool result is replaced with. Deliberately the *host's* own
 * wording: pi-ai's completions adapter already substitutes this exact string
 * when a tool result joins to an empty text (measured on pi-ai 0.87.0 and
 * 0.99.2), so a sanitized payload is indistinguishable from one the adapter
 * built itself, whichever pi version produced it.
 */
export const BLANK_TOOL_CONTENT_PLACEHOLDER = "(no tool output)";

/** Empty or whitespace-only — the two shapes Sarvam's `\S` pattern rejects. */
const BLANK_TEXT_RE = /^\s*$/;

/**
 * Replace a blank tool-result `content` with `BLANK_TOOL_CONTENT_PLACEHOLDER`.
 *
 * Why this matters more than a normal 400: the offending turn stays in the
 * transcript, so *every* later request in the session replays it and fails at
 * the same message index — resume cannot move past it, and the session is dead
 * from that point on. Measured in the operator logs of 2026-09-29/30 (36 run
 * files): 214 rejections, every one `tool.content : String should match pattern
 * '\S'` and none the sibling `at least 1 character`; 28 blank tool results, each
 * a single `"\n"`, all from reading one 1-byte newline-only file (26 through
 * pi's `read`, 2 through a `bash` `sed -n`).
 *
 * Whitespace-only is the reachable case: a *truly empty* result is already
 * placeholdered twice over — pi's `bash` tool emits `(no output)` for an empty
 * stdout, and pi-ai's completions adapter emits `(no tool output)` when a tool
 * result joins to empty text (that substitution measured on pi-ai 0.87.0 and
 * 0.99.2 by driving the real adapter; both wordings also observed live in a pi
 * 0.99.2 session). A result whose text is only whitespace passes through both —
 * which is the gap this closes.
 *
 * Only text is judged: a content array carrying anything else (an image part, a
 * malformed part) is returned untouched — the same rule as `flattenTextParts`,
 * so data is never silently dropped to satisfy the validator. Pure.
 */
export function sanitizeBlankToolContent(
  payload: Record<string, any>,
): Record<string, any> | undefined {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return undefined;
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "tool") return message;
    const content = message.content;
    if (typeof content === "string") {
      if (!BLANK_TEXT_RE.test(content)) return message;
    } else if (Array.isArray(content)) {
      const flat = flattenTextParts(content);
      // Not a string ⇒ not a text-only array ⇒ leave it to fail loudly.
      if (typeof flat !== "string" || !BLANK_TEXT_RE.test(flat)) return message;
    } else {
      return message;
    }
    changed = true;
    return { ...message, content: BLANK_TOOL_CONTENT_PLACEHOLDER };
  });
  return changed ? { ...payload, messages: next } : undefined;
}

/**
 * Stamp `reasoning_effort: null` onto a Sarvam payload that omits it, which is
 * exactly the "thinking off" request. Returns a new payload when a change was
 * made, otherwise undefined so the caller leaves the original untouched.
 */
export function withReasoningOff(
  payload: Record<string, any>,
): Record<string, any> | undefined {
  if ("reasoning_effort" in payload) return undefined;
  return { ...payload, reasoning_effort: null };
}

/**
 * The single `before_provider_request` transform for Sarvam payloads: flatten
 * text-only parts arrays, un-blank tool results, and inject the explicit
 * reasoning-off flag. Guarded to `sarvam-*` model ids so other providers in the
 * same pi session are untouched. Returns undefined when nothing changed. Pure.
 *
 * Order matters for the first two: flattening turns `[{"type":"text","text":""}]`
 * into `""`, which the blank-tool pass then recognizes.
 */
export function fixSarvamPayload(
  payload: Record<string, any>,
): Record<string, any> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const model = payload.model;
  if (typeof model !== "string" || !SARVAM_MODEL_RE.test(model)) return undefined;

  const flattened = flattenMessageContent(payload);
  const sanitized = sanitizeBlankToolContent(flattened ?? payload);
  const next = sanitized ?? flattened ?? payload;

  const stamped = withReasoningOff(next);
  if (stamped) return stamped;
  return next === payload ? undefined : next;
}
