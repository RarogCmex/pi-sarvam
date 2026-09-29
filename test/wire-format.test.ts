/**
 * Wire-format tests.
 *
 * These drive pi's real `openai-completions` adapter — the same
 * `openAICompletionsApi()` `index.ts` registers — and capture the request body
 * through `onPayload`, applying the same `withReasoningOff` transform the
 * extension's `before_provider_request` hook applies. Nothing touches the
 * network: `fetch` is replaced with a stub that records the URL and throws.
 *
 * This is the test that matters most, because every compat flag in `models.ts`
 * exists to change these bytes and a wrong guess fails only at runtime against a
 * paid API.
 */

import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Context, Model, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID, SARVAM_EFFORT } from "../catalog.ts";
import { fixSarvamPayload } from "../errors.ts";
import { DEFAULT_BASE_URL, DEFAULT_INR_PER_USD, entryToModel } from "../models.ts";

const api = openAICompletionsApi();

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
};

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  assert.ok(entry, `${id} missing from catalog`);
  return entryToModel(entry, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD) as Model<"openai-completions">;
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
    ...overrides,
  });
}

let requestedUrl: string | undefined;

afterEach(() => {
  requestedUrl = undefined;
});

/**
 * Run a stream to its (expected) failure and return the body it would have sent,
 * after the same reasoning-off transform pi applies at `before_provider_request`.
 * The body is JSON round-tripped on purpose: pi assigns several fields the literal
 * value `undefined`, so a `key in body` check would lie about the wire bytes.
 */
async function capture(
  target: Model<"openai-completions">,
  options: { reasoning?: ThinkingLevel; maxTokens?: number; tools?: Tool[]; userContent?: unknown } = {},
): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;
  const blocked = new Error("network blocked by test");

  const transcript = options.userContent
    ? normalizeContext({
        systemPrompt: "You are pi, a coding agent.",
        messages: [{ role: "user", content: options.userContent as any, timestamp: Date.now() }],
        tools: options.tools,
      })
    : context({ tools: options.tools });

  const stream = api.streamSimple(target, transcript, {
    apiKey: "sk_test",
    reasoning: options.reasoning,
    maxTokens: options.maxTokens ?? 2048,
    onPayload: (body) => {
      const fixed = fixSarvamPayload(body as Record<string, any>);
      payload = (fixed ?? body) as Record<string, any>;
      return fixed;
    },
    fetch: ((url: any) => {
      requestedUrl = String(url);
      throw blocked;
    }) as unknown as typeof fetch,
  });

  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") break;
  }

  assert.ok(payload, "adapter never built a request payload");
  return JSON.parse(JSON.stringify(payload));
}

describe("request shape common to every Sarvam model", () => {
  test("posts to the /v1 chat completions endpoint", async () => {
    await capture(model("sarvam-105b"));
    assert.equal(requestedUrl, "https://api.sarvam.ai/v1/chat/completions");
  });

  test("uses max_tokens, not max_completion_tokens", async () => {
    const body = await capture(model("sarvam-105b"), { maxTokens: 4096 });
    assert.equal(body.max_tokens, 4096);
    assert.equal("max_completion_tokens" in body, false);
  });

  test("never sends fields the gateway ignores or rejects", async () => {
    const body = await capture(model("sarvam-105b"), { tools: [weatherTool] });
    for (const field of ["store", "prompt_cache_retention", "prompt_cache_key", "priority"]) {
      assert.equal(field in body, false, `${field} should not be sent`);
    }
  });

  test("asks for streaming usage so token accounting works", async () => {
    const body = await capture(model("sarvam-105b"));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("uses the system role, not developer", async () => {
    const body = await capture(model("sarvam-105b"));
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are pi, a coding agent.");
    assert.equal(
      body.messages.some((m: any) => m.role === "developer"),
      false,
    );
  });

  test("sends plain function tools without the strict flag", async () => {
    const body = await capture(model("sarvam-105b"), { tools: [weatherTool] });
    assert.equal(body.tools.length, 1);
    const fn = body.tools[0].function;
    assert.equal(fn.name, "get_weather");
    assert.deepEqual(fn.parameters.properties.city, { type: "string", description: "City name" });
    assert.equal("strict" in fn, false, "strict JSON-schema tools are not documented");
  });
});

describe("user content flattening (pi sends a parts array)", () => {
  test("a text-only parts array becomes a plain string", async () => {
    // pi's agent sends user turns as [{type:"text",text:"…"}]; Sarvam's
    // Pydantic body rejects the array (`400 …content : Input should be a valid
    // string`). The payload hook must flatten it.
    const body = await capture(model("sarvam-105b"), {
      userContent: [{ type: "text", text: "Say hi." }],
    });
    const user = body.messages.find((m: any) => m.role === "user");
    assert.equal(user.content, "Say hi.");
  });

  test("multiple text parts are concatenated", async () => {
    const body = await capture(model("sarvam-105b"), {
      userContent: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
    });
    const user = body.messages.find((m: any) => m.role === "user");
    assert.equal(user.content, "Hello world");
  });

  test("an attached image on a text-only model degrades to a placeholder, then flattens", async () => {
    // pi's adapter already rewrites an image part to a text placeholder for a
    // model without image input, so nothing reaches the wire that Sarvam would
    // reject; the flatten then makes the turn a valid string. (The unit-level
    // guard that a raw non-text array is *not* flattened lives in errors.test.ts.)
    const body = await capture(model("sarvam-105b"), {
      userContent: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    });
    const user = body.messages.find((m: any) => m.role === "user");
    assert.equal(typeof user.content, "string");
    assert.match(user.content, /image omitted/);
  });
});

describe("reasoning_effort: the gateway's three-value switch", () => {
  const expected: Record<ThinkingLevel, string | null> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };

  test("off sends an explicit null, which is what actually disables reasoning", async () => {
    const body = await capture(model("sarvam-105b"), { reasoning: "off" as ThinkingLevel });
    assert.equal("reasoning_effort" in body, true);
    assert.equal(body.reasoning_effort, null);
  });

  test("maps every non-off level onto low/medium/high, never a pi-internal name", async () => {
    const legal = new Set(["low", "medium", "high"]);
    for (const id of CATALOG_BY_ID.keys()) {
      for (const [level, value] of Object.entries(expected)) {
        const body = await capture(model(id), { reasoning: level as ThinkingLevel });
        const effort = body.reasoning_effort as string;
        assert.equal(effort, value, `${id} at ${level}`);
        assert.ok(legal.has(effort), `${id} at ${level} sent ${effort}`);
      }
    }
  });

  test("never leaks a pi-internal level name to the gateway", async () => {
    for (const level of Object.keys(expected) as ThinkingLevel[]) {
      const body = await capture(model("sarvam-105b"), { reasoning: level });
      assert.notEqual(body.reasoning_effort, "minimal");
      assert.notEqual(body.reasoning_effort, "xhigh");
      assert.notEqual(body.reasoning_effort, "max");
    }
  });

  test("the shared effort map only ever produces gateway-legal strings", () => {
    const values = Object.values(SARVAM_EFFORT).filter((v): v is string => typeof v === "string");
    assert.deepEqual([...new Set(values)].sort(), ["high", "low", "medium"]);
  });
});
