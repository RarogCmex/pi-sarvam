/**
 * Sarvam AI provider for pi.
 *
 * Registers `sarvam` as a first-class pi-ai provider: the curated sarvam-105b
 * catalog (128K / 32K windows, INR-derived USD pricing), Sarvam's
 * `reasoning_effort` thinking control, `/login` support, a live `/v1/models`
 * overlay, and two readable error paths (context overflow → auto-compaction,
 * HTTP 403 auth → an actionable sentence).
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
  fixSarvamPayload,
  normalizeOverflowError,
  shouldClarify,
} from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { API_KEYS_URL, buildSarvamProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  // Two rewrites, both guarded to this provider and to error-stop assistants:
  //   1. "exceeds the model context window of N tokens" → prefixed with
  //      `context_length_exceeded:` so pi's auto-compaction runs.
  //   2. the flattened 403 auth body → a readable, actionable sentence.
  // Overflow is applied first so an overflow that also looks auth-ish still
  // triggers compaction. errors.ts explains why neither rewrite can trip pi's
  // retry classifier.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const overflow = normalizeOverflowError(message.errorMessage ?? "");
    if (overflow) return { message: { ...message, errorMessage: overflow } };

    if (!shouldClarify(message)) return;
    const errorMessage = clarifyErrorMessage(message.errorMessage ?? "");
    if (!errorMessage) return;
    return { message: { ...message, errorMessage } };
  });

  // Keep the `message_end` rewrite (transient, error bubble only) and, in the
  // TUI only, append a persistent helper entry so the fix does not disappear on
  // scroll. Guarded to error outcome + this provider + the 403 auth case only;
  // deduped via customType so re-emits do not stack. The `ctx.hasUI` gate is
  // load-bearing: an entry appended *after* the errored assistant message makes
  // `pi -p` print nothing at all (pitfall P23), so print mode keeps only the
  // rewritten error bubble.
  pi.on("turn_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.outcome !== "error") return;
    const msg = event.message as unknown as {
      role: string;
      stopReason?: string;
      provider?: string;
      errorMessage?: string;
    };
    if (!shouldClarify(msg)) return;
    if (event.entries.some((e) => (e as { customType?: string }).customType === "sarvam-auth-help"))
      return;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "sarvam-auth-help",
          content:
            "Sarvam AI: the API key is invalid, revoked or expired — or the account has run " +
            `out of credits (the gateway answers both with HTTP 403). Check the key and the balance: ${API_KEYS_URL} ` +
            `then run \`/login ${PROVIDER_ID}\` or update \`SARVAM_API_KEY\`.`,
          display: true,
        },
      ],
    };
  });

  // Sarvam rejects two payload shapes pi produces by default (see errors.ts):
  // a user turn sent as a parts array instead of a string (S28), and the absent
  // `reasoning_effort` that would leave reasoning on when the user asked for
  // `off`. One guarded transform fixes both.
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, any> | undefined;
    if (!payload || typeof payload !== "object") return;
    const fixed = fixSarvamPayload(payload);
    if (fixed) return fixed;
  });

  pi.registerProvider(buildSarvamProvider(openAICompletionsApi()));
}
