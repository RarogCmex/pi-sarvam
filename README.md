# pi-sarvam

A pi provider plugin for **Sarvam AI** (`https://api.sarvam.ai/v1`) and its
flagship chat model **`sarvam-105b`**. Registers the `sarvam` provider with a
curated catalog, INR→USD pricing, `reasoning_effort` thinking control, `/login`
support, a live `/v1/models` overlay, and a narrow error layer.

Everything a price/window/limit claim rests on was probed against the live
gateway on **2026-09-26** (pi 0.87.1, pi-ai 0.87.1); the raw evidence is quoted
below. Docs were treated as hypotheses, and where they disagreed with the
gateway the gateway won (recorded).

## Install / use

```
pi install git:github.com/RarogCmex/pi-sarvam@main
# or a local checkout:  pi install /path/to/pi-sarvam
# or one-shot:          pi -e /path/to/pi-sarvam/index.ts
/login sarvam                        # or export SARVAM_API_KEY=sk_...
pi --provider sarvam --model sarvam/sarvam-105b -p "hello"
```

Environment:

| Variable | Meaning |
|---|---|
| `SARVAM_API_KEY` | API key (`sk_…`). The stored credential from `/login` wins over it. |
| `SARVAM_BASE_URL` | Endpoint override (default `https://api.sarvam.ai/v1`), trailing slash stripped. |
| `SARVAM_INR_PER_USD` | FX rate for cost conversion (default `95.918696`). |

## The catalog

`GET https://api.sarvam.ai/v1/models` (public, no key) returns exactly two ids:

```json
{"object":"list","data":[
  {"id":"sarvam-105b","object":"model","created":0,"owned_by":"sarvam"},
  {"id":"sarvam-105b-conversations","object":"model","created":0,"owned_by":"sarvam"}]}
```

| Model | Context | pi `max_tokens` | Absolute output cap | Input | Thinking | ₹ in / cached / out per 1M |
|---|---|---|---|---|---|---|
| `sarvam-105b` | 128 000 | 16 384 | 128 000 | text | off + low/medium/high | 29.28 / 10.98 / 73.2 |
| `sarvam-105b-conversations` | 32 000 | 8 192 | 8 192 | text | off + low/medium/high | 29.28 / 10.98 / 73.2 |

Context windows and output caps were read from the gateway's own rejection text
(see § Verified live): the `128000`/`32000` windows and the `128000`/`8192`
output ceilings are **measured**, not copied from docs. Prices are **documented**
(`docs.sarvam.ai/api/getting-started/pricing`).

### Why `max_tokens` is 16 384, not 128 000

Sarvam enforces a **shared budget**: `prompt_tokens + max_tokens ≤ contextWindow`
(the 422 body spells out the arithmetic). pi, meanwhile, compacts at
`contextWindow − reserveTokens` (default `reserveTokens = 16384`) and sends
`max_tokens = model.maxTokens`. Declaring `maxTokens = 128000` would therefore
make pi reject *its own* request (111 616 + 128 000 ≫ 128 000) the moment the
prompt carried a single token. Publishing `16384` lines the two rules up exactly
at the compaction boundary: `111616 + 16384 = 128000`. For the 32K conversational
variant the model's owned cap (8192) is already below the reserve, so it is used
directly. `maxTokens ≤ 16384` is asserted in `test/catalog.test.ts`.

## Design decisions

### Wire protocol

`openai-completions` only. `/v1/responses` **404s** (probed), and the beta
Responses API lives on `/v2` — outside this plugin's `/v1` base URL. There is no
dormant Responses machinery to carry.

### Auth: which header actually goes on the wire

The key is resolved through pi's `envApiKeyAuth("Sarvam API key", ["SARVAM_API_KEY"])`
(`provider.ts`), so it comes from `/login` (stored) or the env var, and the OpenAI
adapter sends it as **`Authorization: Bearer <key>`**.

That is a decision, not an oversight. Sarvam's native header is
`api-subscription-key`, and the docs accept both here — "This endpoint additionally
accepts `Authorization: Bearer` for OpenAI-compatible tooling"
(`docs.sarvam.ai`, Chat Completions → Authentication, read 2026-09-26) — confirmed
live the same day: `GET /v1/models` and `POST /v1/chat/completions` both answer
to `Authorization: Bearer` alone.

Why the native header is not also sent: pi owns the header for a key-based
provider, and the only seam that could add one, the `before_provider_headers`
event (`core/extensions/types.d.ts:544-547`, fired from `core/sdk.js:191`),
receives the assembled headers but **not** the resolved credential. Emitting
`api-subscription-key` would mean re-reading the key from the environment or
`auth.json` outside pi's auth resolution — a second source of truth for a header
the gateway accepts anyway. If a future Sarvam surface stops honouring Bearer,
the fix is a `before_provider_headers` handler plus an explicit key read; this
paragraph exists so that decision is visible instead of implicit.

One non-OpenAI detail of the auth *shape*: an invalid or missing key returns
**403** with `code: "invalid_api_key_error"` — not 401 (see `Errors` below).

### Request shape (`models.ts` `CHAT_COMPAT`)

`api.sarvam.ai` hits none of pi-ai's URL auto-detection branches, so the
auto-detected (`vanilla OpenAI`) defaults are wrong in several places. Every flag
is deliberate:

| Flag | Value | Why (probe) |
|---|---|---|
| `maxTokensField` | `max_tokens` | Auto-detect picks `max_completion_tokens`, which the gateway **silently ignores** (`max_completion_tokens: 99999999` → normal 200 completion). |
| `thinkingFormat` | `openai` | Sarvam's knob is a top-level `reasoning_effort` string. |
| `supportsReasoningEffort` | `true` | Pin it so pi *states* an effort instead of inheriting the server's on-by-default reasoning. |
| `supportsDeveloperRole` | `false` | `role:"developer"` → `400 …Invalid role 'developer'. Must be one of: assistant, system, tool, user`. |
| `supportsStore` | `false` | `store` is accepted but ignored; not documented → don't send. |
| `supportsLongCacheRetention` | `false` | `prompt_cache_retention`/`prompt_cache_key` are accepted but ignored; not documented → don't send. |
| `supportsStrictMode` | `false` | `response_format` is documented; strict JSON-schema tools are not → keep `strict` off tool defs. |
| `supportsUsageInStreaming` | `true` | `stream_options:{include_usage:true}` works; usage arrives in a final chunk. |
| `supportsFinishReason` | `true` | `finish_reason` is present (`stop` / `length` / `tool_calls`). |

### Thinking control (`reasoning_effort`)

Sarvam accepts exactly **three** effort strings — `low`, `medium`, `high` (a
bogus value returns `400 … Input should be 'low', 'medium' or 'high'`). pi's six
levels map onto them (`catalog.ts` `SARVAM_EFFORT`): `minimal → low`,
`low/medium/high` pass through, and `xhigh`/`max` are marked unsupported (`null`)
so pi down-clamps them to `high` rather than sending an invalid string.

**Turning reasoning off is the subtle part.** Sarvam reasons *by default* and
only disables it when `reasoning_effort: null` is present; *omitting* the field
leaves reasoning on. pi omits the field for its `off` level, so the extension
stamps the explicit `null` in `before_provider_request` (`errors.ts`
`fixSarvamPayload`). `off` is deliberately **not** mapped in `SARVAM_EFFORT`:
mapping `off: null` would drop `off` from the picker (pi hides all-null levels)
and up-clamp the request to `low`, silently **billing** reasoning the user turned
off. (probed: `reasoning_effort: null` → `reasoning_content: null`,
`finish_reason:"stop"`; field omitted → `reasoning_content` populated.)

### Payload fix: flatten text parts (S28)

pi's agent sends a user turn as a **parts array**
(`[{"type":"text","text":"…"}]`), and pi-ai's completions adapter emits it
unchanged. Sarvam is Pydantic-validated and rejects the array:
`400 body.messages.1.user.content : Input should be a valid string`. So
`fixSarvamPayload` collapses a **text-only** parts array to a string and passes
anything else through untouched (images still fail loudly rather than being
silently dropped). This was found live — a plain `curl` probe passes while real
`pi -p` 400s. This is the known `S28` trap, reproduced here against `api.sarvam.ai`
and fixed.

### Currency

Sarvam bills in INR; pi's `ModelCost` is USD per 1M tokens. Rate:
**1 USD = 95.918696 INR** (mid-market, open.er-api.com, 2026-09-26),
overridable via `SARVAM_INR_PER_USD`. Converted rates:
`input $0.305259`, `cacheRead $0.114472`, `output $0.763146` per 1M;
`cacheWrite = 0` (no documented cache-write price).

**Honesty note on caching:** the gateway reports no cached-token breakdown
(`prompt_tokens_details: null` in every response), so pi's cost accounting bills
all input at the input rate and will not use the `cacheRead` figure. The
`cacheRead` field is populated only to record the documented rate, not because a
cache hit is observable. Cache behavior was **not** verified.

### Discovery

`fetchModels` (discovery.ts) reads `GET /v1/models` (no auth needed), and layers
an **additive, unknowns-only** overlay: known ids keep their curated prices/caps,
unknown `sarvam-*` ids get family-guessed limits and **zero** cost. A failed or
empty listing returns `[]` and leaves the curated baseline intact. Today the
overlay is always empty — the endpoint lists exactly the two curated ids.

### Errors (`errors.ts`)

1. **Overflow → auto-compaction.** Sarvam rejects an over-context prompt with
   `422 … exceeds the model context window of N tokens …`. None of pi's built-in
   overflow patterns match that wording, so `normalizeOverflowError` prefixes it
   with `context_length_exceeded`, which pi *does* recognize. Narrow: only this
   phrasing, never a rate limit, and *not* the separate
   `400 … exceeds the maximum output length …` (that is a config error, not
   overflow).
2. **Auth clarity.** An invalid key returns **403** (not 401) with an
   OpenAI-shaped body, which pi flattens to
   `403: {"message":"Invalid or missing authentication credentials",…}`.
   `clarifyErrorMessage` turns that into a sentence naming the dashboard and
   `/login sarvam`. The rewritten text is neither retryable nor overflow-classified
   (asserted against pi's real classifiers in `test/errors.test.ts`).
3. The persistent TUI helper entry (`turn_end`) is gated on **`ctx.hasUI`** — an
   entry appended after the errored assistant message makes `pi -p` print
   *nothing* (pitfall `P23`, reproduced live and fixed; see § Verified live).

## Surfaces — three states

- **Checked and absent (2026-09-26):** `POST /v1/responses` → `404
  {"error":{"message":"Not Found","code":"not_found_error"}}`.
- **Exists but deliberately not added:** the open-weight models
  (`glm5.3`, `gemma4`, `deepseekv4-flash`) are served on **`/v2/chat/completions`**
  (beta, whitelisted per key) and never appear on `/v1`; the beta
  `POST /v2/responses` likewise. This plugin is pinned to the `/v1` base URL, so
  they are out of scope (a `SARVAM_BASE_URL` override to `…/v2` would register
  them, but their ids/limits were not researched). Non-chat modalities (Saaras
  STT, Bulbul TTS, Mayura translate, document intelligence) are not
  chat-completions shapes and are out of scope for a coding agent.
- **Deliberately not investigated:** whether `/v2` chat completions could be a
  second `api` route on the same provider, and speech modalities as multimodal
  adapters. That was not the goal.

Deprecated siblings `sarvam-m` (24B) and `sarvam-30b` are **not** listed by
`/v1/models` and rejected as unknown ids — correctly absent.

## Non-goals

Multi-account key pools, i18n, a separate transport/retry layer, `/v2` routing,
speech/vision adapters, command trees, persisted setting stores. The `pi` checks
needed are: register, `/login`, `--list-models`, `pi -p`, tools, thinking
on/off, and the two error paths.

## What is verified live, and how

All on **2026-09-26**, pi 0.87.1, key from `secret.env` (`sk_…`, prefix
`sk_xxxx`). Cost discipline: every fact below came from a **rejected** request
(free) or a tiny generation (`max_tokens ≤ 64`). No limit was "measured" by
generating output.

### Free probes (rejections disclose the truth)

| Probe | Response |
|---|---|
| `GET /v1/models`, no auth | `200` + the two ids above |
| `POST /v1/chat/completions`, empty body | `400 body.messages : Field required` |
| …with a bad key | `403 {"message":"Invalid or missing authentication credentials","code":"invalid_api_key_error"}` |
| …unknown model | `400 …Input 'nope-xyz' should be one of sarvam-105b, sarvam-105b-conversations` |
| `reasoning_effort:"bogus"` | `400 … Input should be 'low', 'medium' or 'high'` |
| `reasoning_effort:"none"` | `400 … Input should be 'low', 'medium' or 'high'` |
| `max_tokens: 99999999` | `400 … exceeds the maximum output length of 128000 tokens for sarvam-105b` |
| same, `sarvam-105b-conversations` | `400 … 8192 tokens for sarvam-105b-conversations` |
| `max_completion_tokens: 99999999` | `200` — **ignored** |
| `role:"developer"` | `400 … Invalid role 'developer'. Must be one of: assistant, system, tool, user` |
| `store:true` + `prompt_cache_key` + `prompt_cache_retention` | `200` — accepted but ignored |
| 200 008-token prompt | `422 prompt_tokens (200008) + max_tokens (8) = 200016 exceeds the model context window of 128000 tokens for sarvam-105b` |
| 70 008-token prompt, conversations | `422 … context window of 32000 tokens for sarvam-105b-conversations` |

### Tiny paid probes (fractions of a cent)

- `reasoning_effort: null` → `reasoning_content: null`, `finish_reason:"stop"` (reasoning OFF).
- field omitted → `reasoning_content` populated (reasoning ON by default).
- `stream:true` + `stream_options:{include_usage:true}` → final chunk
  `usage:{completion_tokens, prompt_tokens, total_tokens, reasoning_tokens}`.
- function tool → `finish_reason:"tool_calls"`,
  `tool_calls:[{"function":{"name":"get_weather","arguments":"{\"city\": \"Paris\"}"}}]`.

### Offline + harness

- `npm run typecheck` (`tsc -p tsconfig.json`) — clean.
- `npm test` (`node --test`, with a preload that blocks `fetch`) — **82 passing**.
  Includes wire-format tests that drive pi-ai's real adapter and pin the exact
  outgoing body across the catalog × every thinking level, and negative-safety
  tests against pi's real `isContextOverflow` / `isRetryableAssistantError`.
- `npm run live` (`live/check.ts`) — **A–G all PASS**; see cost log. E and F are
  free (rejected); the control in E proves the raw overflow text is *not*
  recognized and the rewrite is doing real work.

### Real `pi` runs (loaded with `-e`, no global install)

- `pi --list-models sarvam` → both models, `128K / 16.4K / thinking yes / images
  no` and `32K / 8.2K / …`.
- `pi -p --thinking off "Reply with exactly: ok"` → `ok`.
- `pi -p --thinking off "Read ./package.json and reply with only the name field"`
  → `pi-sarvam` (a real tool loop: read → answer).
- `pi -p --thinking medium "Read /etc/hosts …"` → worked (reasoning on).
- **Invalid key in print mode** → prints the clarified 403 sentence, exit 1.
  *Before* the `ctx.hasUI` gate this hung with **no output** (P23); the fix is
  covered by `test/entry.test.ts`.

## Cost log (what was spent, and why that figure)

Rates: `$0.305259/M` input, `$0.763146/M` output. Cost is `tokens × rate`.

| Activity | Tokens | Cost |
|---|---|---|
| `live/check.ts` run 1 (B 34 + C 101 + D 136) | 271 | $0.000121 |
| `live/check.ts` run 2 (B 34 + C 55 + D 136 + G 33) | 258 | $0.000097 |
| `pi -p` simple, thinking off (instrumented) | 495 | $0.000152 |
| `pi -p` read tool, thinking off (instrumented) | 7 778 | $0.002385 |
| `pi -p` read tool, thinking medium (instrumented) | 4 023 | $0.001280 |
| Two earlier `pi -p` runs (same shapes, uninstrumented) | ≈ 8 300 | ≈ $0.002500 |
| All rejected probes (context caps, auth, enum, tools) | 0 (not billed) | $0.000000 |
| **Total** | | **≈ $0.0065** |

That is **≈ 13 % of the $0.05 budget**. The two most expensive rows are the
agent runs (they carry pi's ~800-token system prompt **per turn**); the
limit-discovery probes that would normally dominate such a bill cost **nothing**
because they were rejected before inference.

## What remains unverified

- **Auto-compaction end-to-end.** The overflow *classification* is proven
  (harness E + unit tests), but a real session driven over the 128K edge until pi
  compacts and retries was not run (it needs a deliberately large, multi-turn
  session; the rejection itself is free but the surrounding turns are not).
- **Cache behavior.** `cacheRead` pricing is documented, never observed (the
  gateway reports no cached-token breakdown).
- **Credits-exhausted error.** Not reproducible without draining the account; the
  docs only say "requests will return errors". The auth rewrite names the
  possibility but does not detect it.
- **`/v2` surface and open-weight models** — out of scope by base URL; not probed
  for this key.
- **`pi install <path>`** specifically (vs `-e`): the `pi.extensions` manifest is
  standard, but the install path was not exercised to avoid mutating the global
  pi config.
- **TUI rendering** of the `sarvam-auth-help` entry (only `ctx.hasUI` gating is
  tested; the TUI itself was not opened).

## Layout

```
index.ts      the only pi-runtime-coupled file (loader-alias import + hooks + registerProvider)
provider.ts   createProvider assembly, auth/login, base-url resolution
catalog.ts    pure data: ids, windows, INR prices, effort map, provenance comments
models.ts     catalog -> pi Model: currency, compat flags, family guesses
discovery.ts  additive /v1/models overlay (never throws)
errors.ts     overflow normalization, auth clarification, payload fixes
live/check.ts live A–G harness (explicit; not part of npm test)
test/*.ts     node --test suite + no-network preload
```
