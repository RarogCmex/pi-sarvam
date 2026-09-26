import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID, SARVAM_EFFORT } from "../catalog.ts";
import {
  buildModels,
  CHAT_COMPAT,
  DEFAULT_BASE_URL,
  DEFAULT_INR_PER_USD,
  entryToModel,
  inrPerUsd,
  inrToUsd,
  PROVIDER_ID,
  unknownModelToModel,
} from "../models.ts";

describe("currency conversion", () => {
  test("converts the documented INR rates at the documented rate", () => {
    const model = entryToModel(CATALOG_BY_ID.get("sarvam-105b")!, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD);
    assert.equal(model.cost.input, 0.305259); // 29.28 / 95.918696
    assert.equal(model.cost.output, 0.763146); // 73.2  / 95.918696
    assert.equal(model.cost.cacheRead, 0.114472); // 10.98 / 95.918696
    assert.equal(model.cost.cacheWrite, 0);
  });

  test("inrToUsd is invertible within rounding", () => {
    assert.equal(inrToUsd(0, 95.918696), 0);
    assert.equal(inrToUsd(95.918696, 95.918696), 1);
  });

  test("rate is overridable through the environment", () => {
    assert.equal(inrPerUsd(() => "100"), 100);
    assert.equal(inrPerUsd(() => " 83.5 "), 83.5);
    assert.equal(inrPerUsd(() => "0"), DEFAULT_INR_PER_USD);
    assert.equal(inrPerUsd(() => "nope"), DEFAULT_INR_PER_USD);
    assert.equal(inrPerUsd(() => undefined), DEFAULT_INR_PER_USD);
  });
});

describe("catalog -> Model", () => {
  test("registers under the sarvam provider on the completions surface", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.id.includes("/"), false, "ids stay bare — pi prefixes the provider");
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
      assert.equal(model.reasoning, true);
    }
  });

  test("carries the request-shape compat flags the gateway needs", () => {
    const model = entryToModel(CATALOG_BY_ID.get("sarvam-105b")!, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD);
    assert.equal(model.compat?.maxTokensField, "max_tokens");
    assert.equal(model.compat?.thinkingFormat, "openai");
    assert.equal(model.compat?.supportsReasoningEffort, true);
    assert.equal(model.compat?.supportsDeveloperRole, false);
    assert.equal(model.compat?.supportsStore, false);
    assert.equal(model.compat?.supportsLongCacheRetention, false);
    assert.equal(model.compat?.supportsStrictMode, false);
    assert.equal(model.compat?.supportsUsageInStreaming, true);
    assert.equal(model.compat?.supportsFinishReason, true);
    // No model-level compat entry may drift from the shared table.
    for (const entry of CATALOG) {
      const m = entryToModel(entry, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD);
      assert.deepEqual(m.compat, { ...CHAT_COMPAT });
    }
  });

  test("exposes the effort map and keeps `off` selectable", () => {
    const model = entryToModel(CATALOG_BY_ID.get("sarvam-105b")!, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD);
    assert.equal(model.thinkingLevelMap, SARVAM_EFFORT);
    const levels = getSupportedThinkingLevels(model);
    assert.ok(levels.includes("off"), "off must remain selectable");
    assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high"]);
  });

  test("clamps pi's extended levels onto the three the gateway accepts", () => {
    const model = entryToModel(CATALOG_BY_ID.get("sarvam-105b")!, DEFAULT_BASE_URL, DEFAULT_INR_PER_USD);
    const clamp = (level: ModelThinkingLevel) => clampThinkingLevel(model, level);
    assert.equal(clamp("off"), "off");
    assert.equal(clamp("minimal"), "minimal"); // then mapped to "low" at build time
    assert.equal(clamp("low"), "low");
    assert.equal(clamp("medium"), "medium");
    assert.equal(clamp("high"), "high");
    assert.equal(clamp("xhigh"), "high");
    assert.equal(clamp("max"), "high");
  });
});

describe("unknown ids from discovery", () => {
  test("inherit the 105b family limits, never a price", () => {
    const model = unknownModelToModel("sarvam-105b-turbo", DEFAULT_BASE_URL);
    assert.equal(model.contextWindow, 128_000);
    assert.equal(model.maxTokens, 16_384);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.thinkingLevelMap, SARVAM_EFFORT);
  });

  test("fall back conservatively for an unrecognised family", () => {
    const model = unknownModelToModel("mystery-model", DEFAULT_BASE_URL);
    assert.equal(model.contextWindow, 32_768);
    assert.equal(model.maxTokens, 4_096);
    assert.equal(model.cost.input, 0);
  });
});
