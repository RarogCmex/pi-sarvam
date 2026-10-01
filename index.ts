/**
 * Sarvam AI provider for pi.
 *
 * Registers `sarvam` as a first-class pi-ai provider: the curated sarvam-105b
 * catalog (128K / 32K windows, INR-derived USD pricing), Sarvam's
 * `reasoning_effort` thinking control, `/login` support, a live `/v1/models`
 * overlay, and three readable error paths (context overflow → auto-compaction,
 * HTTP 403 auth → an actionable sentence, HTTP 402 no-credits → the billing
 * page instead of a pointless key rotation).
 *
 * pi 0.87 boundaries: `message_end` rewrites the error bubble (overflow and
 * auth), while `turn_end` appends a persistent `custom_message` with the
 * dashboard link so the auth fix survives scrolling.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. Subpaths
// other than /compat, /oauth and /providers/all are NOT aliased. tsconfig.json
// mirrors the loader's alias so `npm run typecheck` sees what pi sees. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules plain Node can load, which is what makes them testable.
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clarifyErrorMessage,
  clarifyQuotaErrorMessage,
  fixSarvamPayload,
  normalizeOverflowError,
  shouldClarify,
  shouldClarifyQuota,
} from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { API_KEYS_URL, buildSarvamProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  // Three rewrites, all guarded to this provider and to error-stop assistants:
  //   1. "exceeds the model context window of N tokens" → prefixed with
  //      `context_length_exceeded:` so pi's auto-compaction runs.
  //   2. the flattened 402 no-credits body → the billing page, plus the fact
  //      that the key was accepted so rotating it will not help.
  //   3. the flattened 403 auth body → a readable, actionable sentence.
  // Overflow is applied first so an overflow that also looks auth-ish still
  // triggers compaction; quota is applied before auth because it is the more
  // specific claim. errors.ts explains why no rewrite can trip pi's retry
  // classifier (pi already lists `insufficient_quota`/`billing` as
  // non-retryable, and the rewrites keep those substrings).
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const overflow = normalizeOverflowError(message.errorMessage ?? "");
    if (overflow) return { message: { ...message, errorMessage: overflow } };

    if (shouldClarifyQuota(message)) {
      const quota = clarifyQuotaErrorMessage(message.errorMessage ?? "");
      if (quota) return { message: { ...message, errorMessage: quota } };
    }

    if (!shouldClarify(message)) return;
    const errorMessage = clarifyErrorMessage(message.errorMessage ?? "");
    if (!errorMessage) return;
    return { message: { ...message, errorMessage } };
  });

  // Keep the `message_end` rewrite (transient, error bubble only) and, in the
  // TUI only, append a persistent helper entry so the fix does not disappear on
  // scroll. Guarded to error outcome + this provider + the two clarified cases
  // (403 auth, 402 no credits); deduped via customType so re-emits do not stack.
  // The `ctx.hasUI` gate is load-bearing: an entry appended *after* the errored
  // assistant message makes `pi -p` print nothing at all, so print mode keeps
  // only the rewritten error bubble.
  pi.on("turn_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.outcome !== "error") return;
    const msg = event.message as unknown as {
      role: string;
      stopReason?: string;
      provider?: string;
      errorMessage?: string;
    };
    const quota = shouldClarifyQuota(msg);
    if (!quota && !shouldClarify(msg)) return;
    const customType = quota ? "sarvam-quota-help" : "sarvam-auth-help";
    if (event.entries.some((e) => (e as { customType?: string }).customType === customType))
      return;
    const content = quota
      ? "Sarvam AI: this account has no remaining credits (HTTP 402 " +
        "`insufficient_quota_error`). The key itself was accepted, so rotating it will not " +
        `help. Top up at ${API_KEYS_URL}/billing, or switch to a funded key with ` +
        `\`/login ${PROVIDER_ID}\` or \`SARVAM_API_KEY\`.`
      : "Sarvam AI: the API key is invalid, revoked or expired (HTTP 403). An exhausted " +
        "balance is a *different* error — HTTP 402 `insufficient_quota_error` — so this is a " +
        `credential problem, not a billing one. Check the key: ${API_KEYS_URL} ` +
        `then run \`/login ${PROVIDER_ID}\` or update \`SARVAM_API_KEY\`.`;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType,
          content,
          display: true,
        },
      ],
    };
  });

  // Sarvam rejects three payload shapes pi produces by default (see errors.ts):
  // a user turn sent as a parts array instead of a string, a tool result whose
  // text is blank (which then poisons every later request in the session), and
  // the absent `reasoning_effort` that would leave reasoning on when the user
  // asked for `off`. One guarded transform fixes all three.
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, any> | undefined;
    if (!payload || typeof payload !== "object") return;
    const fixed = fixSarvamPayload(payload);
    if (fixed) return fixed;
  });

  pi.registerProvider(buildSarvamProvider(openAICompletionsApi()));
}
