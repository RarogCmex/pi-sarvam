/**
 * Provider assembly.
 *
 * Split out from `index.ts` so it loads under plain Node (and `node --test`):
 * everything here resolves through pi-ai's core entrypoint. The one symbol that
 * does not — `openAICompletionsApi`, which pi's loader serves from the compat
 * entrypoint — is injected by `index.ts` instead of imported here.
 */

import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { fetchSarvamModels } from "./discovery.ts";
import {
  API_KEYS_URL,
  buildModels,
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  type GatewayApi,
} from "./models.ts";

// Re-exported so existing importers (`index.ts`, `test/provider.test.ts`) keep
// resolving it from here. The single definition lives in `models.ts`.
export { API_KEYS_URL };
export const API_KEY_AUTH_NAME = "Sarvam AI API key";
export const API_KEY_ENV_VAR = "SARVAM_API_KEY";
export const BASE_URL_ENV_VAR = "SARVAM_BASE_URL";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Endpoint override for a proxy, a mirror, or the beta `/v2` surface. */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
  const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : DEFAULT_BASE_URL;
}

/**
 * Standard stored-key-then-env resolution with two Sarvam touches: the dashboard
 * link during `/login`, and whitespace trimming on both paths. A key pasted with
 * a trailing newline is rejected with the same 403 as a revoked one (see
 * errors.ts), which reads like an account problem rather than a stray character.
 */
export function sarvamApiKeyAuth(): ApiKeyAuth {
  const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
  return {
    ...base,

    async login(interaction) {
      interaction.signal.throwIfAborted();
      interaction.notify({
        type: "info",
        message: "Create a Sarvam AI API key on the dashboard:",
        links: [{ url: API_KEYS_URL, label: "Sarvam AI dashboard" }],
      });
      const entered = await interaction.prompt({
        type: "secret",
        message: API_KEY_AUTH_NAME,
        placeholder: "sk_...",
      });
      interaction.signal.throwIfAborted();
      const key = entered.trim();
      if (!key) throw new Error("No API key entered.");
      if (!key.startsWith("sk_")) {
        // Accept it anyway — rejecting on shape would lock users out the moment
        // Sarvam changes its key format.
        interaction.notify({
          type: "info",
          message: "That does not look like a Sarvam key (expected sk_…). Saving it regardless.",
        });
      }
      return { type: "api_key", key };
    },

    async resolve(input) {
      const resolved = await base.resolve(input);
      const key = resolved?.auth.apiKey?.trim();
      if (!resolved || !key) return undefined;
      return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
    },
  };
}

/**
 * Build the `sarvam` provider.
 *
 * `models` is the curated baseline, always present and never network-dependent.
 * `fetchModels` layers live discovery on top: pi merges the overlay per id,
 * persists it through its own ModelsStore and restores it offline, so a new
 * `sarvam-*` release shows up without a catalog edit while a failed listing
 * degrades to the baseline.
 *
 * Only the `openai-completions` surface is registered. `/v1/responses` returns
 * 404 and `/v2/responses` (beta) is outside the v1 base URL, so there is no
 * dormant Responses machinery to carry.
 */
export function buildSarvamProvider(
  api: ProviderStreams,
  baseUrl: string = resolveBaseUrl(),
): Provider<GatewayApi> {
  return createProvider<GatewayApi>({
    id: PROVIDER_ID,
    name: "Sarvam AI",
    baseUrl,
    auth: { apiKey: sarvamApiKeyAuth() },
    models: buildModels(baseUrl),
    fetchModels: (context) => fetchSarvamModels(baseUrl, context),
    api: { "openai-completions": api },
  });
}
