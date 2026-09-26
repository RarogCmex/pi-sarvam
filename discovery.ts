/**
 * Live model discovery — the dynamic half of a semi-dynamic catalog.
 *
 * `GET /v1/models` is public (no key required, probed 2026-09-26) and currently
 * returns exactly the two ids in the catalog. This module implements
 * `createProvider`'s `fetchModels`: pi persists the result through its own
 * ModelsStore and merges it over the curated baseline, so a future `sarvam-*`
 * release shows up without a plugin edit.
 *
 * The overlay is deliberately **additive** and **unknowns-only**: known ids keep
 * their curated prices/caps (a live listing does not freeze today's INR rates),
 * and a failed or empty listing leaves the baseline untouched instead of
 * emptying the picker.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "./catalog.ts";
import { unknownModelToModel, type SarvamModel } from "./models.ts";

/** `GET /v1/models` body: {"object":"list","data":[{"id":"sarvam-105b",...}]}. */
interface ModelsResponse {
  object?: string;
  data?: { id?: unknown }[];
}

/**
 * Modalities that must never reach a coding agent's picker if the endpoint ever
 * starts listing non-chat models alongside the chat ones.
 */
const EXCLUDED = /(embed|rerank|bge|vector|whisper|stt|tts|asr|speech|audio|image|video|vision|ocr|translate|transliter|diariz|doc)/i;

/** Pull model ids out of a `/v1/models` body. Pure so it is testable offline. */
export function parseModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as ModelsResponse).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    const trimmed = id.trim();
    if (EXCLUDED.test(trimmed)) continue;
    ids.push(trimmed);
  }
  return [...new Set(ids)];
}

/**
 * Overlay for discovered ids the catalog does not know. Known ids are skipped
 * so a plugin update to curated prices/caps wins without waiting for a refresh.
 */
export function buildOverlay(
  ids: readonly string[],
  baseUrl: string,
  known: ReadonlySet<string> = new Set(CATALOG_BY_ID.keys()),
): SarvamModel[] {
  return ids.filter((id) => !known.has(id)).map((id) => unknownModelToModel(id, baseUrl));
}

/**
 * `fetchModels` implementation. Never throws: returning `[]` leaves the curated
 * baseline (and any previously persisted overlay) untouched, so an offline start
 * degrades to "static catalog" instead of "broken provider".
 *
 * The listing endpoint needs no credential, so discovery works even before the
 * user has logged in.
 */
export async function fetchSarvamModels(
  baseUrl: string,
  context: RefreshModelsContext,
  timeoutMs = 8_000,
): Promise<SarvamModel[]> {
  if (!context.allowNetwork || context.signal.aborted) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const ids = parseModelIds(await response.json());
    return buildOverlay(ids, baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
