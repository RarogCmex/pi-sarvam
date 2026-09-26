import assert from "node:assert/strict";
import test from "node:test";

test("the no-network preload blocks global fetch", async () => {
  await assert.rejects(
    async () => globalThis.fetch("https://api.sarvam.ai/v1/models"),
    /network blocked/,
  );
});
