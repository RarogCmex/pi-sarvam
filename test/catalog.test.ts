import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CATALOG, CATALOG_BY_ID, SARVAM_EFFORT } from "../catalog.ts";

describe("catalog invariants", () => {
  test("has the two /v1 models and unique ids", () => {
    assert.equal(CATALOG.length, 2);
    assert.equal(CATALOG_BY_ID.size, CATALOG.length, "duplicate model id in catalog");
    assert.ok(CATALOG_BY_ID.has("sarvam-105b"));
    assert.ok(CATALOG_BY_ID.has("sarvam-105b-conversations"));
  });

  test("ids are the live /v1 ids (never guessed)", () => {
    for (const entry of CATALOG) {
      assert.match(entry.id, /^sarvam-105b(-conversations)?$/, `${entry.id} is not a /v1 id`);
    }
  });

  test("windows and output caps are positive and ordered", () => {
    for (const entry of CATALOG) {
      assert.ok(entry.contextWindow > 0, `${entry.id} contextWindow`);
      assert.ok(entry.maxTokens > 0, `${entry.id} maxTokens`);
      assert.ok(
        entry.maxTokens <= entry.contextWindow,
        `${entry.id} maxTokens ${entry.maxTokens} exceeds contextWindow ${entry.contextWindow}`,
      );
      assert.ok(entry.name.length > 0, `${entry.id} has no display name`);
      assert.ok(entry.input.includes("text"), `${entry.id} must accept text`);
    }
  });

  test("documents the measured windows for the two variants", () => {
    // Live 422 bodies, 2026-09-26.
    assert.equal(CATALOG_BY_ID.get("sarvam-105b")!.contextWindow, 128_000);
    assert.equal(CATALOG_BY_ID.get("sarvam-105b-conversations")!.contextWindow, 32_000);
  });

  test("keeps max_tokens at or below pi's default compaction reserve", () => {
    // The gateway enforces prompt_tokens + max_tokens <= contextWindow, and pi
    // compacts at contextWindow - 16384. A larger maxTokens would let pi reject
    // its own requests at the compaction boundary.
    for (const entry of CATALOG) {
      assert.ok(entry.maxTokens <= 16_384, `${entry.id} maxTokens ${entry.maxTokens} > 16384`);
    }
  });

  test("prices are positive and cache read never costs more than fresh input", () => {
    for (const entry of CATALOG) {
      const { input, output, cacheRead } = entry.inr;
      assert.ok(input > 0, `${entry.id} has no input price`);
      assert.ok(output > 0, `${entry.id} has no output price`);
      assert.ok(cacheRead > 0, `${entry.id} has no cache-read price`);
      assert.ok(cacheRead <= input, `${entry.id} cache read costs more than fresh input`);
    }
  });

  test("the shared effort map only sends gateway-legal values", () => {
    // Live 400 enumerates the legal set: low/medium/high.
    const legal = new Set(["low", "medium", "high"]);
    for (const [level, value] of Object.entries(SARVAM_EFFORT)) {
      if (value === null) continue;
      assert.ok(legal.has(value as string), `level ${level} maps to illegal effort ${value}`);
    }
    for (const entry of CATALOG) {
      assert.equal(entry.thinking.levels, SARVAM_EFFORT);
    }
  });

  test("does not map `off` — mapping it to null would silently hide the switch", () => {
    // getSupportedThinkingLevels() drops an all-null level, and pi would then
    // up-clamp `off` to `low`, billing reasoning the user turned off.
    assert.equal("off" in SARVAM_EFFORT, false);
  });
});
