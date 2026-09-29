/**
 * Fake-pi entry test: import the real extension default export with a stubbed
 * `ExtensionAPI` and assert the wiring (provider + three hooks), then drive the
 * hooks with the message shapes pi passes them. The preload aliases
 * "@earendil-works/pi-ai" to the compat entrypoint so `index.ts` imports.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sarvamExtension from "../index.ts";

type Handler = (event: any, context?: any) => any;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; providers: any[] } {
  const handlers = new Map<string, Handler[]>();
  const providers: any[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerProvider: (provider: any) => {
      providers.push(provider);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers, providers };
}

function run(handlers: Map<string, Handler[]>, event: string, payload: any, context?: any): any {
  const list = handlers.get(event) ?? [];
  let result: any;
  for (const handler of list) result = handler(payload, context);
  return result;
}

describe("extension wiring", () => {
  test("registers the sarvam provider and the three hooks", () => {
    const { pi, handlers, providers } = fakePi();
    sarvamExtension(pi);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "sarvam");
    assert.equal(providers[0].name, "Sarvam AI");
    assert.deepEqual([...handlers.keys()].sort(), [
      "before_provider_request",
      "message_end",
      "turn_end",
    ]);
  });

  test("message_end rewrites an overflow so compaction can fire", () => {
    const { pi, handlers } = fakePi();
    sarvamExtension(pi);
    const result = run(handlers, "message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        provider: "sarvam",
        errorMessage:
          '422: {"message":"prompt_tokens (200008) + max_tokens (8) = 200016 exceeds the model context window of 128000 tokens for sarvam-105b."}',
      },
    });
    assert.match(result.message.errorMessage, /^context_length_exceeded: /);
  });

  test("message_end clarifies an auth failure and leaves other providers alone", () => {
    const { pi, handlers } = fakePi();
    sarvamExtension(pi);
    const auth = run(handlers, "message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        provider: "sarvam",
        errorMessage: '403: {"message":"Invalid or missing authentication credentials","code":"invalid_api_key_error"}',
      },
    });
    assert.match(auth.message.errorMessage, /dashboard\.sarvam\.ai/);

    const other = run(handlers, "message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        provider: "openai",
        errorMessage: '403: {"message":"Invalid or missing authentication credentials"}',
      },
    });
    assert.equal(other, undefined);
  });

  test("before_provider_request flattens parts and stamps reasoning off for sarvam only", () => {
    const { pi, handlers } = fakePi();
    sarvamExtension(pi);
    const fixed = run(handlers, "before_provider_request", {
      payload: {
        model: "sarvam-105b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
    });
    assert.deepEqual(fixed, {
      model: "sarvam-105b",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: null,
    });

    const untouched = run(handlers, "before_provider_request", {
      payload: { model: "gpt-5", messages: [] },
    });
    assert.equal(untouched, undefined);
  });

  test("turn_end appends a deduped auth hint in the TUI only", () => {
    const { pi, handlers } = fakePi();
    sarvamExtension(pi);
    const message = {
      role: "assistant",
      stopReason: "error",
      provider: "sarvam",
      errorMessage: '403: {"message":"Invalid or missing authentication credentials","code":"invalid_api_key_error"}',
    };
    const result = run(handlers, "turn_end", { outcome: "error", message, entries: [] }, { hasUI: true });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].customType, "sarvam-auth-help");

    const deduped = run(
      handlers,
      "turn_end",
      { outcome: "error", message, entries: [{ customType: "sarvam-auth-help" }] },
      { hasUI: true },
    );
    assert.equal(deduped, undefined);
  });

  test("turn_end stays silent in print mode so `pi -p` still prints the error", () => {
    // A persistent entry after the errored assistant message makes
    // `pi -p` print nothing. The handler must bail when the context has no UI.
    const { pi, handlers } = fakePi();
    sarvamExtension(pi);
    const result = run(
      handlers,
      "turn_end",
      {
        outcome: "error",
        message: {
          role: "assistant",
          stopReason: "error",
          provider: "sarvam",
          errorMessage: '403: {"message":"Invalid or missing authentication credentials"}',
        },
        entries: [],
      },
      { hasUI: false },
    );
    assert.equal(result, undefined);
  });
});
