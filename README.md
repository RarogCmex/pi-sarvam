# pi-sarvam

A provider plugin for [pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`, the coding agent this plugs into) targeting
**Sarvam AI** (`https://api.sarvam.ai/v1`) and its flagship chat model
**`sarvam-105b`**. npm name: `@rarogcmex/pi-sarvam`. Registers the `sarvam`
provider with a curated catalog, INR→USD pricing, `reasoning_effort` thinking
control, `/login` support, a live `/v1/models` overlay, and a narrow error layer.

Everything a price/window/limit claim rests on was probed against the live
gateway on **2026-09-26** (pi 0.87.1, pi-ai 0.87.1); the responses are quoted
verbatim in § What is verified live below. Vendor docs were treated as
hypotheses, and where a doc disagreed with the gateway the gateway won — each
such case is called out where it is relied on.

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
provider, and the only seam that could add one — the `before_provider_headers`
extension event — receives the assembled headers but **not** the resolved
credential. (Verified against pi 0.87.1; the event is declared in pi's
`core/extensions/types.d.ts` and fired from its `core/sdk.js`. Line numbers are
version-fragile, the symbol names are not.) Emitting
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

### Payload fix: flatten text parts

pi's agent sends a user turn as a **parts array**
(`[{"type":"text","text":"…"}]`), and pi-ai's completions adapter emits it
unchanged. Sarvam is Pydantic-validated and rejects the array:
`400 body.messages.1.user.content : Input should be a valid string`. So
`fixSarvamPayload` collapses a **text-only** parts array to a string and passes
anything else through untouched (images still fail loudly rather than being
silently dropped). This was found live — a plain `curl` probe passes while real
`pi -p` 400s, so it is invisible to any test that builds the body by hand. The
rule it generalizes to: **a hand-written probe proves nothing about the shape pi
actually sends; drive the real adapter or the real agent.**

### Payload fix: blank tool results

Sarvam validates a tool result's `content` with Pydantic (`min_length=1`,
pattern `\S`), so one whose text is empty **or whitespace-only** is rejected:
`400 body.messages.N.tool.content : String should match pattern '\S'`. Unlike a
normal bad request, this **kills the session**: the offending turn stays in the
transcript, so every later request replays it and fails at the *same* message
index — resume cannot move past it, and each retry burns a round trip for zero
tool calls.

pi produces such results routinely, and nothing upstream catches the whitespace
case. The *empty* case is caught twice over: pi's `bash` tool emits `(no output)`
for an empty stdout (its own `formatOutput` default), and pi-ai's completions
adapter emits `(no tool output)` when a tool result's joined text is empty — that
substitution measured on pi-ai 0.87.0, 0.99.2 and 1.0.0 by driving the real adapter
(the 2026-10-03 re-run is identical to the 0.99.2 capture: empty goes out as `(no
tool output)`, whitespace still goes through as-is), and
both wordings observed live in a pi 0.99.2 session. Whitespace goes straight
through all of it: `read` on a file whose *whole content is whitespace* reaches
the wire as-is (observed live on pi 0.99.2 — the tool result arrived as a blank
message). That is the reachable trigger, and the operator logs that found this
say the same thing: 29 distinct rejected requests in 2026-09-29/30 (unique
gateway `request_id`, across 15 sessions), **every one** `pattern '\S'` and none
the sibling `at least 1 character`, from 14 distinct blank tool results — each a
single `"\n"`, all from reading one 1-byte newline-only file (13 via `read`, 1
via a `bash` `sed -n`).

`fixSarvamPayload` replaces a blank tool `content` with
`BLANK_TOOL_CONTENT_PLACEHOLDER`, deliberately the *host's* own wording
(`(no tool output)`), so a sanitized payload is indistinguishable from one the
adapter built itself on a version that already placeholders empty results.
Narrow on three axes: only `role: "tool"` is rewritten (a blank *user* turn is
not ours to invent text for); only text is judged, so an array carrying an image
or a malformed part passes through untouched — the same rule as the flatten
above, fail loudly rather than drop data; and the placeholder itself is
non-blank, so the pass is idempotent.

**Deliberately not fixed:** Sarvam also answers `400 … Tool messages found but
no tools provided` when tool messages arrive with no `tools` array, and pi-ai
sends `tools: []` in that state (measured). Agent mode always sends tools, so
this plugin does not invent a no-op tool to paper over a request pi built
wrongly; `test/errors.test.ts` pins that decision.

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

`fetchSarvamModels` (discovery.ts), wired into the provider's `fetchModels`
field, reads `GET /v1/models` (no auth needed), and layers
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
3. **No-credits clarity.** An exhausted account returns **402** with
   `{"message":"No credits available.","code":"insufficient_quota_error"}` —
   measured live 2026-10-01, which **corrects an earlier claim in this README**
   that credits and a bad key share the 403. They do not, so
   `clarifyQuotaErrorMessage` says the part that saves the user time: the key
   *was* accepted, rotating it will not help, top up at
   `dashboard.sarvam.ai/billing`. pi already classifies `insufficient_quota` as
   non-retryable and the rewrite keeps that substring, asserted against the real
   classifier, so a drained account fails fast instead of looping.
4. The persistent TUI helper entry (`turn_end`) is gated on **`ctx.hasUI`** — an
   entry appended after the errored assistant message makes `pi -p` print
   *nothing*, which was reproduced live and fixed; see § Verified live. The 403
   and 402 cases get separate `customType`s (`sarvam-auth-help`,
   `sarvam-quota-help`) and dedupe independently.

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
speech/vision adapters, command trees, persisted setting stores.

In particular **i18n is a non-goal**: every user-facing string in this plugin is
English, including the persistent auth helper entry that `index.ts` appends in
the TUI. If you see a non-English runtime message from this provider, that is a
bug — `test/entry.test.ts` covers the entry's presence but not its wording, so
the assertion to add is on `content`.

## What is verified live, and how

Two dated passes, both with a real key. The catalog/limit facts below were
probed on **2026-09-26** (pi 0.87.1); the whole harness was re-run on
**2026-10-01** (pi 0.99.2, pi-ai 0.99.2) and **A–I all PASS** with no drift in
any gateway wording, which is also when checks H (blank tool result) and I
(no-credits 402) were added. Cost discipline: every fact here came from a
**rejected** request (free) or a tiny generation (`max_tokens ≤ 64`). No limit
was "measured" by generating output.

Re-running this yourself needs Node ≥ 22.18 (the harness is `.ts` executed
directly), `node scripts/link-pi.mjs` once for the typecheck, and a key —
`live/check.ts` resolves `SARVAM_API_KEY` or the credential stored by
`/login sarvam` in `auth.json` under pi's agent dir (`$PI_CODING_AGENT_DIR` when
set, else `~/.pi/agent`). Check I additionally needs a key whose account is out
of credits, via `SARVAM_DRAINED_API_KEY`; without it I reports SKIP. The
harness reads no other file.

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
| key whose account has no credits (2026-10-01) | `402 {"message":"No credits available.","code":"insufficient_quota_error"}` — **not** the 403 a bad key gets |
| tool message with `content: "\n"` (2026-10-01) | `400 body.messages.3.tool.content : String should match pattern '\S'` |
| same, `content: "(no tool output)"` | `200` — the sanitized form is accepted (this half is a paid probe, 176 tokens) |

### Tiny paid probes (fractions of a cent)

- `reasoning_effort: null` → `reasoning_content: null`, `finish_reason:"stop"` (reasoning OFF).
- field omitted → `reasoning_content` populated (reasoning ON by default).
- `stream:true` + `stream_options:{include_usage:true}` → final chunk
  `usage:{completion_tokens, prompt_tokens, total_tokens, reasoning_tokens}`.
- function tool → `finish_reason:"tool_calls"`,
  `tool_calls:[{"function":{"name":"get_weather","arguments":"{\"city\": \"Paris\"}"}}]`.

### Offline + harness

- `npm run typecheck` (`tsc -p tsconfig.json`) — clean.
- `npm test` (`node --test`, with a preload that blocks `fetch`) — green;
  105 tests at the time of writing. Run it rather than trusting the count.
  Includes wire-format tests that drive pi-ai's real adapter and pin the exact
  outgoing body across the catalog × every thinking level, a tool-result
  transcript for the blank-content fix (with the un-fixed control alongside it),
  and negative-safety tests against pi's real `isContextOverflow` /
  `isRetryableAssistantError`.
- `npm run live` (`live/check.ts`) — **A–I all PASS on 2026-10-01** (pi 0.99.2),
  total spend **$0.000188**; A–G previously all PASS on 2026-09-26 (pi 0.87.1).
  Setup and cost in § Development and § What verifying this cost. E, F, H1 and I
  are free (rejected requests). Two of the checks carry their own control: E
  proves the raw overflow text is *not* recognized by pi, and H1 proves the raw
  blank tool result is *still* rejected by the gateway — without H1 a passing H2
  would not distinguish the fix from a gateway that stopped caring.

### Real `pi` runs (loaded with `-e`, no global install)

- `pi --list-models sarvam` → both models, `128K / 16.4K / thinking yes / images
  no` and `32K / 8.2K / …`.
- `pi -p --thinking off "Reply with exactly: ok"` → `ok`.
- `pi -p --thinking off "Read ./package.json and reply with only the name field"`
  → `pi-sarvam` (a real tool loop: read → answer).
- `pi -p --thinking medium "Read /etc/hosts …"` → worked (reasoning on).
- **Invalid key in print mode** → prints the clarified 403 sentence, exit 1.
  *Before* the `ctx.hasUI` gate this produced **no output at all**; the fix is
  covered by `test/entry.test.ts`.
- **End-to-end beacon for the blank tool result (2026-10-01, pi 0.99.2).** A real
  agent run whose first tool call returns whitespace, then three more steps:

  ```bash
  printf '\n' > blank.txt          # the trigger: a file that is only a newline
  PI_CODING_AGENT_DIR=$(mktemp -d) SARVAM_API_KEY=… \
    pi -ne -ns -np -nc -t read,bash -e ./index.ts \
       --provider sarvam --model sarvam-105b --thinking off \
       -p "read ./blank.txt, then run echo step1, echo step2, echo step3 \
           as separate tool calls, then reply exactly: DONE"
  ```

  - **v0.1.1 (with the fix)** → `read` + 3 × `bash`, all four results delivered,
    session log contains zero `tool.content` errors, prints `DONE`, exit 0
    (2045 input / 65 output tokens).
  - **v0.1.0 (control, cloned from the published tag)** → the model issued the
    same four calls, and the *next* request died:
    `400 body.messages.3.tool.content : String should match pattern '\S'`,
    `stopReason: error`, exit 1 (971 / 62 tokens). Same prompt, same key, same
    minute — the only difference is the sanitizer.

## What verifying this cost

≈ **$0.0065** for the 2026-09-26 build, plus ≈ **$0.0012** for the 2026-10-01
re-verification (`live/check.ts` A–I: $0.000188; the two agent runs of the
blank-tool-result beacon: $0.00067 with the fix and $0.00034 for the v0.1.0
control), at the catalog's `$0.305259/M` input and `$0.763146/M` output. Two
facts worth carrying over:

- **Every limit in the tables above was learned for free.** Context windows,
  output caps, role and enum validation, and the auth shape all came from
  requests the gateway **rejected before inference**, which it does not bill.
- **What did cost money was the agent, not the probing.** The four paid rows are
  the two `live/check.ts` generations (`max_tokens ≤ 64`) and three real `pi -p`
  runs; the agent runs dominate because pi resends its system prompt every turn.

The per-request token ledger that produced the figure is not reproduced here —
it is build-process record, not documentation. `live/check.ts` prints its own
token counts on each run if you want to re-derive the cost.

## Known limitations

- **Auto-compaction is proven at the classifier, not end to end.** The overflow
  *classification* is covered (harness E + unit tests against pi's real
  `isContextOverflow`), but a real session driven over the 128K edge until pi
  compacts and retries was not run: the rejection itself is free, the
  surrounding multi-turn session is not.
- **Cache behavior is documented, never observed.** `cacheRead` pricing comes
  from the vendor's rate card; the gateway reports no cached-token breakdown, so
  pi will bill all input at the input rate.
- **Credits-exhausted was mis-documented until 2026-10-01.** This README used to
  say an exhausted balance shares the bad key's 403 and is therefore
  indistinguishable. Measured with a genuinely drained key, it is
  **402 `insufficient_quota_error`** — a different status *and* code — so the two
  are now separated (`clarifyQuotaErrorMessage`, harness check I). What is still
  unverified: every other billing state (a hard spend cap, a suspended account,
  a payment failure), which may or may not use the same 402.
- **Two curated ids only.** The open-weight models are visible on the vendor's
  site but were not researched, and `/v2` is out of scope by base URL.

## What was left unchecked in the build

Recorded so a contributor does not re-derive it:

- **`pi install` from the published source** — exercised 2026-09-30 against
  `git:github.com/RarogCmex/pi-sarvam@main` with `PI_CODING_AGENT_DIR` pointed at a
  throwaway directory, so no global pi config was mutated: the package installed,
  `pi list` showed it, and `pi --list-models sarvam` listed both catalog models
  under a deliberately invalid key. The control run (same key, empty config dir,
  no package) listed none — that difference is what makes the check mean
  something. Still unchecked: a request to the live gateway on a valid key.
- **TUI rendering** of the `sarvam-auth-help` / `sarvam-quota-help` entries: only
  the `ctx.hasUI` gating is tested; the TUI itself was not opened.
- **Check I needs a drained key**, so for most readers `npm run live` prints
  `[SKIP] I`. The 402 shape it asserts was measured once, on 2026-10-01, with a
  key whose account had zero credits; if you change the quota wording, re-run it
  with such a key rather than trusting the unit test's recorded body.
- **Auto-compaction end to end** (see Known limitations) and **every other
  provider in a mixed session**: the payload transform is guarded to `sarvam-*`
  model ids and that guard is unit-tested, but no mixed-provider session was run
  live.

## Development

```bash
node scripts/link-pi.mjs   # once: link pi's packages from your global install
npm run check              # typecheck + offline tests (fetch is blocked by a preload)
npm run live               # opt-in A–G harness against the real gateway; spends credits
```

Prerequisites: **Node ≥ 22.18** (the tests and `live/check.ts` are `.ts` run
directly — type stripping and `node --test`'s `.ts` discovery are unflagged from
22.18) and a pi install.

pi's own packages are not dependencies of this plugin — at runtime pi's extension
loader aliases the bare `@earendil-works/pi-ai` specifier to its own copy — so a
plain `npm install` leaves nothing to typecheck against. `scripts/link-pi.mjs`
links them from your global pi install; it probes the npm prefix, nvm, pnpm,
`~/.local`, `/usr/local` and the directory the `pi` executable resolves to, and
creates junctions on Windows. For a specific install:
`PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`. Verified against
pi 0.87.1 / pi-ai 0.87.1 / `@types/node` 22.19.19; the same setup and
`npm run check` were re-run on pi 0.99.1 / pi-ai 0.99.1 (2026-09-30, 82/82 green),
on pi 0.99.2 (2026-10-01, 105/105) and on pi 1.0.0 / pi-ai 1.0.0 (2026-10-03,
105/105 green; `pi -ne -e <repo> --offline --list-models sarvam` prints the same
two models).

`npm run typecheck` shells out to a bare `tsc`, and this repo deliberately carries
no devDependencies (`scripts/link-pi.mjs` links only pi's packages), so TypeScript
must be on your `PATH`: `npm i -g typescript@5.9.3` — the version CI pins
(`.github/workflows/check.yml`); 7.0.2 also typechecks clean (measured 2026-09-30).

`live/check.ts` needs a key and nothing else: it resolves `SARVAM_API_KEY` or the
credential stored by `/login sarvam`.

## Layout

```
index.ts      the only pi-runtime-coupled file (loader-alias import + hooks + registerProvider)
provider.ts   createProvider assembly, auth/login, base-url resolution
catalog.ts    pure data: ids, windows, INR prices, effort map, provenance comments
models.ts     catalog -> pi Model: currency, compat flags, family guesses
discovery.ts  additive /v1/models overlay (never throws)
errors.ts     overflow normalization, auth + quota clarification, payload fixes
live/check.ts live A–I harness (explicit; not part of npm test)
test/*.ts     node --test suite + no-network preload
scripts/      link-pi.mjs — dev setup only, not loaded by pi
```
