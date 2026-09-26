import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { buildOverlay, fetchSarvamModels, parseModelIds } from "../discovery.ts";
import { DEFAULT_BASE_URL } from "../models.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as RefreshModelsContext;
}

/** The exact `GET /v1/models` body shape (live 2026-09-26). */
const payload = (...ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "sarvam" })),
});

describe("parseModelIds", () => {
  test("reads the live two-model listing", () => {
    assert.deepEqual(parseModelIds(payload("sarvam-105b", "sarvam-105b-conversations")), [
      "sarvam-105b",
      "sarvam-105b-conversations",
    ]);
  });

  test("dedupes and trims", () => {
    assert.deepEqual(parseModelIds(payload("sarvam-105b", "sarvam-105b ", "sarvam-105b")), ["sarvam-105b"]);
  });

  test("drops non-chat modalities", () => {
    assert.deepEqual(parseModelIds(payload("sarvam-105b", "saaras-stt", "bulbul-tts", "mayura-translate")), [
      "sarvam-105b",
    ]);
  });

  test("survives malformed payloads", () => {
    assert.deepEqual(parseModelIds(null), []);
    assert.deepEqual(parseModelIds({}), []);
    assert.deepEqual(parseModelIds({ data: "nope" }), []);
    assert.deepEqual(parseModelIds({ data: [null, 1, {}, { id: "" }] }), []);
  });
});

describe("buildOverlay", () => {
  test("keeps known ids out so curated prices/caps win", () => {
    assert.deepEqual(buildOverlay(["sarvam-105b", "sarvam-105b-conversations"], DEFAULT_BASE_URL), []);
  });

  test("adds unknown ids with family-guessed limits and zero cost", () => {
    const overlay = buildOverlay(["sarvam-105b-turbo"], DEFAULT_BASE_URL);
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].id, "sarvam-105b-turbo");
    assert.equal(overlay[0].contextWindow, 128_000);
    assert.deepEqual(overlay[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(CATALOG_BY_ID.has("sarvam-105b-turbo"), false);
  });
});

describe("fetchSarvamModels", () => {
  test("returns an overlay from the live listing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload("sarvam-105b", "sarvam-105b-next")), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const models = await fetchSarvamModels(DEFAULT_BASE_URL, makeContext());
    assert.deepEqual(models.map((m) => m.id), ["sarvam-105b-next"]);
  });

  test("never throws — a failed listing degrades to the curated baseline", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchSarvamModels(DEFAULT_BASE_URL, makeContext()), []);

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSarvamModels(DEFAULT_BASE_URL, makeContext()), []);
  });

  test("is inert when network access is disallowed or the signal is aborted", async () => {
    globalThis.fetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSarvamModels(DEFAULT_BASE_URL, makeContext({ allowNetwork: false })), []);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(
      await fetchSarvamModels(DEFAULT_BASE_URL, makeContext({ signal: aborted.signal })),
      [],
    );
  });
});
