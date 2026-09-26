import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { AuthContext, ProviderAuthInteraction, ProviderStreams } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID } from "../models.ts";
import {
  API_KEY_AUTH_NAME,
  API_KEYS_URL,
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  buildSarvamProvider,
  resolveBaseUrl,
  sarvamApiKeyAuth,
} from "../provider.ts";

const unused: ProviderStreams = {
  stream: () => {
    throw new Error("not used");
  },
  streamSimple: () => {
    throw new Error("not used");
  },
};

function authContext(env: Record<string, string>): AuthContext {
  return {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
}

function interaction(entered: string): ProviderAuthInteraction & {
  notifications: { message: string; links?: readonly { url: string; label?: string }[] }[];
} {
  const notifications: { message: string; links?: readonly { url: string; label?: string }[] }[] = [];
  return {
    signal: new AbortController().signal,
    notifications,
    notify: (event) => {
      if (event.type === "info") notifications.push({ message: event.message, links: event.links });
    },
    prompt: async () => entered,
  };
}

describe("resolveBaseUrl", () => {
  const realEnv = process.env[BASE_URL_ENV_VAR];
  afterEach(() => {
    if (realEnv === undefined) delete process.env[BASE_URL_ENV_VAR];
    else process.env[BASE_URL_ENV_VAR] = realEnv;
  });

  test("defaults to the Sarvam v1 endpoint", () => {
    assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://api.sarvam.ai/v1");
  });

  test("honours an override, trimmed and without a trailing slash", () => {
    assert.equal(
      resolveBaseUrl(() => "  https://proxy.example.com/sarvam/v1///  "),
      "https://proxy.example.com/sarvam/v1",
    );
  });

  test("ignores a blank override", () => {
    assert.equal(resolveBaseUrl(() => "   "), DEFAULT_BASE_URL);
  });

  test("reads the documented environment variable", () => {
    process.env[BASE_URL_ENV_VAR] = "https://mirror.example.com/v1";
    assert.equal(resolveBaseUrl(), "https://mirror.example.com/v1");
    delete process.env[BASE_URL_ENV_VAR];
    assert.equal(resolveBaseUrl(), DEFAULT_BASE_URL);
  });
});

describe("api key auth", () => {
  const auth = sarvamApiKeyAuth();

  test("is named for the /login list", () => {
    assert.equal(auth.name, API_KEY_AUTH_NAME);
  });

  test("login points at the dashboard before prompting", async () => {
    const ui = interaction("sk_abc123");
    const credential = await auth.login!(ui);
    assert.deepEqual(credential, { type: "api_key", key: "sk_abc123" });
    assert.equal(ui.notifications.length, 1);
    assert.deepEqual(ui.notifications[0].links, [{ url: API_KEYS_URL, label: "Sarvam AI dashboard" }]);
  });

  test("login trims whitespace from a pasted key", async () => {
    const credential = await auth.login!(interaction("  sk_abc123\n"));
    assert.equal(credential.key, "sk_abc123");
  });

  test("login refuses an empty key", async () => {
    await assert.rejects(() => auth.login!(interaction("   \n")), /No API key entered/);
  });

  test("login warns about an unexpected shape but still saves it", async () => {
    const ui = interaction("some-other-format");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "some-other-format");
    assert.equal(ui.notifications.length, 2, "dashboard link plus the shape warning");
    assert.match(ui.notifications[1].message, /does not look like a Sarvam key/);
  });

  test("resolve prefers the stored credential and trims it", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "sk_from_env" }),
      credential: { type: "api_key", key: "  sk_stored \n" },
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk_stored");
  });

  test("resolve falls back to the environment variable and names it", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "  sk_from_env\n" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk_from_env");
    assert.equal(result?.source, API_KEY_ENV_VAR);
  });

  test("resolve reports unconfigured when neither source has a key", async () => {
    assert.equal(
      await auth.resolve({ ctx: authContext({}), signal: new AbortController().signal }),
      undefined,
    );
    assert.equal(
      await auth.resolve({
        ctx: authContext({}),
        credential: { type: "api_key", key: "   " },
        signal: new AbortController().signal,
      }),
      undefined,
    );
  });
});

describe("buildSarvamProvider", () => {
  test("registers under the expected identity with api-key auth", () => {
    const provider = buildSarvamProvider(unused);
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.name, "Sarvam AI");
    assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
    assert.ok(provider.auth.apiKey, "api-key auth must be present");
    assert.equal(provider.auth.oauth, undefined);
    assert.equal(typeof provider.auth.apiKey!.login, "function");
    assert.equal(typeof provider.auth.apiKey!.resolve, "function");
  });

  test("serves the curated catalog synchronously, on completions only", () => {
    const provider = buildSarvamProvider(unused);
    const models = provider.getModels();
    assert.equal(models.length, 2);
    for (const model of models) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
    }
  });

  test("opts into dynamic refresh so new /v1 releases appear", () => {
    assert.equal(typeof buildSarvamProvider(unused).refreshModels, "function");
  });

  test("propagates a custom base url to every model", () => {
    const provider = buildSarvamProvider(unused, "https://proxy.example.com/sarvam/v1");
    assert.equal(provider.baseUrl, "https://proxy.example.com/sarvam/v1");
    for (const model of provider.getModels()) {
      assert.equal(model.baseUrl, "https://proxy.example.com/sarvam/v1");
    }
  });

  test("sends chat models through the injected completions adapter", () => {
    let calls = 0;
    const counting: ProviderStreams = {
      stream: () => {
        calls++;
        throw new Error("completions");
      },
      streamSimple: unused.streamSimple,
    };
    const provider = buildSarvamProvider(counting);
    const model = provider.getModels()[0];
    assert.equal(model.api, "openai-completions");
    assert.throws(() => provider.stream(model, normalizeContext({ messages: [] })), /completions/);
    assert.equal(calls, 1);
  });
});
