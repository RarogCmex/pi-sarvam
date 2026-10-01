import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  BLANK_TOOL_CONTENT_PLACEHOLDER,
  clarifyErrorMessage,
  fixSarvamPayload,
  flattenTextParts,
  normalizeOverflowError,
  sanitizeBlankToolContent,
  shouldClarify,
  withReasoningOff,
} from "../errors.ts";

// The exact strings pi composes from the live gateway bodies (2026-09-26):
// pi-ai formats a non-OK response as `<status>: <JSON body>` when the SDK could
// not fold the body into `error.message`.
const OVERFLOW_RAW =
  '422: {"message":"prompt_tokens (200008) + max_tokens (8) = 200016 exceeds the model context window of 128000 tokens for sarvam-105b.","code":"unprocessable_entity_error","request_id":"20260926_bbf1f0ed"}';
const CONV_OVERFLOW_RAW =
  '422: {"message":"prompt_tokens (70008) + max_tokens (8) = 70016 exceeds the model context window of 32000 tokens for sarvam-105b-conversations.","code":"unprocessable_entity_error","request_id":"x"}';
const CAP_400_RAW =
  '400: {"message":"max_tokens (128001) exceeds the maximum output length of 128000 tokens for sarvam-105b.","code":"invalid_request_error","request_id":"x"}';
const AUTH_RAW =
  '403: {"message":"Invalid or missing authentication credentials","code":"invalid_api_key_error","request_id":"20260926_f87904d3"}';

function assistant(errorMessage: string) {
  return {
    role: "assistant" as const,
    stopReason: "error" as const,
    provider: "sarvam",
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [],
    timestamp: 0,
  } as any;
}

describe("overflow normalization", () => {
  test("prefixes the gateway's shared-window wording so compaction fires", () => {
    const rewritten = normalizeOverflowError(OVERFLOW_RAW);
    assert.ok(rewritten?.startsWith("context_length_exceeded: "));
    assert.ok(rewritten!.includes("exceeds the model context window of 128000 tokens"));
    assert.equal(isContextOverflow(assistant(rewritten!)), true);
  });

  test("recognizes the 32K conversational variant too", () => {
    assert.ok(normalizeOverflowError(CONV_OVERFLOW_RAW)?.startsWith("context_length_exceeded: "));
  });

  test("leaves pi unable to compact before the rewrite (proves the rewrite is needed)", () => {
    assert.equal(isContextOverflow(assistant(OVERFLOW_RAW)), false);
  });

  test("does not touch the max_tokens cap error (config, not overflow)", () => {
    assert.equal(normalizeOverflowError(CAP_400_RAW), null);
    assert.equal(isContextOverflow(assistant(CAP_400_RAW)), false);
  });

  test("is idempotent and never rewrites a rate limit", () => {
    const once = normalizeOverflowError(OVERFLOW_RAW)!;
    assert.equal(normalizeOverflowError(once), null);
    assert.equal(
      normalizeOverflowError('429: {"message":"Rate limit exceeded","code":"rate_limit_exceeded_error"}'),
      null,
    );
  });

  test("never produces a message pi would retry", () => {
    const rewritten = normalizeOverflowError(OVERFLOW_RAW)!;
    assert.equal(isRetryableAssistantError(assistant(rewritten)), false);
  });
});

describe("auth clarification", () => {
  test("turns the flattened 403 body into an actionable sentence", () => {
    const clarified = clarifyErrorMessage(AUTH_RAW)!;
    assert.ok(clarified.includes("403"));
    assert.ok(clarified.includes("https://dashboard.sarvam.ai"));
    assert.ok(clarified.includes("/login sarvam"));
    assert.ok(clarified.includes("SARVAM_API_KEY"));
  });

  test("the clarified sentence is neither an overflow nor retryable", () => {
    const clarified = clarifyErrorMessage(AUTH_RAW)!;
    assert.equal(isContextOverflow(assistant(clarified)), false);
    assert.equal(isRetryableAssistantError(assistant(clarified)), false);
  });

  test("leaves unrelated errors untouched", () => {
    assert.equal(clarifyErrorMessage(CAP_400_RAW), undefined);
    assert.equal(clarifyErrorMessage("500 internal error"), undefined);
  });

  test("shouldClarify is guarded to this provider and error stops", () => {
    assert.equal(shouldClarify(assistant(AUTH_RAW)), true);
    assert.equal(shouldClarify({ role: "assistant", stopReason: "error", provider: "openai", errorMessage: AUTH_RAW }), false);
    assert.equal(shouldClarify({ role: "assistant", stopReason: "stop", provider: "sarvam", errorMessage: AUTH_RAW }), false);
    assert.equal(shouldClarify({ role: "user", stopReason: "error", provider: "sarvam", errorMessage: AUTH_RAW }), false);
    assert.equal(shouldClarify(assistant(OVERFLOW_RAW)), false);
  });
});

describe("reasoning-off payload fix", () => {
  test("stamps reasoning_effort:null when the field is absent", () => {
    const fixed = withReasoningOff({ messages: [] });
    assert.deepEqual(fixed, { messages: [], reasoning_effort: null });
  });

  test("leaves an explicit effort alone", () => {
    assert.equal(withReasoningOff({ reasoning_effort: "high" }), undefined);
  });
});

describe("text-part flattening (pi sends a parts array)", () => {
  test("collapses a text-only parts array to a string", () => {
    assert.equal(flattenTextParts([{ type: "text", text: "Hello " }, { type: "text", text: "world" }]), "Hello world");
  });

  test("passes through strings, empty arrays and non-text parts", () => {
    assert.equal(flattenTextParts("already a string"), "already a string");
    assert.deepEqual(flattenTextParts([]), []);
    const withImage = [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", data: "y" }];
    assert.equal(flattenTextParts(withImage), withImage, "image arrays must not be dropped");
    const malformed = [{ type: "text" }];
    assert.equal(flattenTextParts(malformed), malformed);
  });
});

describe("blank tool-content sanitizing (Sarvam requires a \\S in tool.content)", () => {
  // The wire shape pi-ai's completions adapter emits for a tool result.
  function payloadWithTool(content: unknown, extra: Record<string, any> = {}) {
    return {
      model: "sarvam-105b",
      messages: [
        { role: "user", content: "list the empty file" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content },
      ],
      ...extra,
    };
  }

  test("replaces the whitespace-only text that killed real sessions", () => {
    // Measured in the operator logs: every blank tool result was exactly "\n"
    // (pi's `read` on an empty file), and Sarvam answered
    // `400 … tool.content : String should match pattern '\S'`.
    for (const blank of ["\n", "   ", "\n\t", "\r\n"]) {
      const fixed = sanitizeBlankToolContent(payloadWithTool(blank))!;
      assert.equal(fixed.messages[2].content, BLANK_TOOL_CONTENT_PLACEHOLDER, JSON.stringify(blank));
    }
  });

  test("replaces an empty string too (the sibling 400: min_length=1)", () => {
    const fixed = sanitizeBlankToolContent(payloadWithTool(""))!;
    assert.equal(fixed.messages[2].content, BLANK_TOOL_CONTENT_PLACEHOLDER);
  });

  test("replaces a text-only parts array that joins to whitespace", () => {
    const fixed = sanitizeBlankToolContent(
      payloadWithTool([{ type: "text", text: "" }, { type: "text", text: " " }]),
    )!;
    assert.equal(fixed.messages[2].content, BLANK_TOOL_CONTENT_PLACEHOLDER);
  });

  test("leaves real output, other roles and non-text arrays alone", () => {
    assert.equal(sanitizeBlankToolContent(payloadWithTool("ok\n")), undefined);
    // A blank *user* turn is not ours to rewrite: only role "tool" is validated
    // this way, and inventing text for a user would change what was asked.
    const blankUser = { model: "sarvam-105b", messages: [{ role: "user", content: "  " }] };
    assert.equal(sanitizeBlankToolContent(blankUser), undefined);
    // An image-bearing array must survive rather than be flattened into text.
    const withImage = payloadWithTool([
      { type: "text", text: "" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    assert.equal(sanitizeBlankToolContent(withImage), undefined);
    // Malformed content is left for the gateway to reject loudly.
    assert.equal(sanitizeBlankToolContent(payloadWithTool(null)), undefined);
    assert.equal(sanitizeBlankToolContent(payloadWithTool(42)), undefined);
    assert.equal(sanitizeBlankToolContent({ model: "sarvam-105b" }), undefined);
    assert.equal(sanitizeBlankToolContent({ model: "sarvam-105b", messages: "nope" }), undefined);
  });

  test("touches nothing else in the payload and does not mutate it", () => {
    const original = payloadWithTool("\n", { reasoning_effort: null, tools: [] });
    const snapshot = JSON.parse(JSON.stringify(original));
    const fixed = sanitizeBlankToolContent(original)!;
    assert.deepEqual(original, snapshot, "the input payload must not be mutated");
    assert.equal(fixed.messages[0].content, "list the empty file");
    assert.equal(fixed.messages[1].content, "");
    assert.deepEqual(fixed.messages[1].tool_calls, snapshot.messages[1].tool_calls);
    assert.equal(fixed.messages[2].tool_call_id, "call_1");
    assert.deepEqual(fixed.tools, []);
    assert.equal(fixed.reasoning_effort, null);
  });

  test("is idempotent: its own placeholder is not blank", () => {
    const once = sanitizeBlankToolContent(payloadWithTool("\n"))!;
    assert.equal(sanitizeBlankToolContent(once), undefined);
  });

  test("the placeholder satisfies the rule Sarvam enforces", () => {
    assert.equal(BLANK_TOOL_CONTENT_PLACEHOLDER.length > 0, true);
    assert.equal(/\S/.test(BLANK_TOOL_CONTENT_PLACEHOLDER), true);
    // Chosen to match pi-ai's own substitution for an empty tool result, so a
    // sanitized payload looks host-built on any pi version.
    assert.equal(BLANK_TOOL_CONTENT_PLACEHOLDER, "(no tool output)");
  });
});

describe("fixSarvamPayload", () => {
  test("flattens content and injects reasoning off in one pass", () => {
    const fixed = fixSarvamPayload({
      model: "sarvam-105b",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    })!;
    assert.equal(fixed.messages[0].content, "sys");
    assert.equal(fixed.messages[1].content, "hi");
    assert.equal(fixed.reasoning_effort, null);
    // The original payload is not mutated.
    assert.equal(typeof (fixed as any).messages[1].content, "string");
  });

  test("keeps an explicit effort but still flattens", () => {
    const fixed = fixSarvamPayload({
      model: "sarvam-105b-conversations",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      reasoning_effort: "high",
    })!;
    assert.equal(fixed.messages[0].content, "hi");
    assert.equal(fixed.reasoning_effort, "high");
  });

  test("un-blanks a tool result while flattening and stamping reasoning", () => {
    const fixed = fixSarvamPayload({
      model: "sarvam-105b",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "tool", tool_call_id: "call_1", content: "\n" },
      ],
    })!;
    assert.equal(fixed.messages[0].content, "hi");
    assert.equal(fixed.messages[1].content, BLANK_TOOL_CONTENT_PLACEHOLDER);
    assert.equal(fixed.reasoning_effort, null);
  });

  test("a blank tool array is flattened first, then recognized as blank", () => {
    // Order inside fixSarvamPayload is load-bearing: flatten turns
    // [{type:"text",text:""}] into "", which the blank pass then catches.
    const fixed = fixSarvamPayload({
      model: "sarvam-105b",
      messages: [{ role: "tool", tool_call_id: "c", content: [{ type: "text", text: "" }] }],
      reasoning_effort: "high",
    })!;
    assert.equal(fixed.messages[0].content, BLANK_TOOL_CONTENT_PLACEHOLDER);
    assert.equal(fixed.reasoning_effort, "high");
  });

  test("returns undefined when nothing needs changing", () => {
    assert.equal(
      fixSarvamPayload({
        model: "sarvam-105b",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "low",
      }),
      undefined,
    );
    // A non-blank tool result with an explicit effort is already valid.
    assert.equal(
      fixSarvamPayload({
        model: "sarvam-105b",
        messages: [{ role: "tool", tool_call_id: "c", content: "ok" }],
        reasoning_effort: "low",
      }),
      undefined,
    );
  });

  test("never invents a tools array (Sarvam's 'no tools provided' 400 stays visible)", () => {
    // Deliberate: pi-ai sends `tools: []` when the context has none, and Sarvam
    // rejects tool messages in that state. Inventing a no-op tool would hide a
    // request pi built wrongly; agent mode always sends tools.
    const fixed = fixSarvamPayload({
      model: "sarvam-105b",
      messages: [{ role: "tool", tool_call_id: "c", content: "ok" }],
      tools: [],
      reasoning_effort: null,
    });
    assert.equal(fixed, undefined);
  });

  test("ignores other providers' models and garbage payloads", () => {
    assert.equal(fixSarvamPayload({ model: "gpt-5", messages: [] }), undefined);
    assert.equal(fixSarvamPayload({ model: "zai-org/GLM-5.3", messages: [] }), undefined);
    assert.equal(fixSarvamPayload({}), undefined);
    assert.equal(fixSarvamPayload(null as any), undefined);
  });
});
