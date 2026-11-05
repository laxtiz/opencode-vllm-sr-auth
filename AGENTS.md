# AGENTS.md

Provider plugin for [magpie](https://usemagpie.ai) / OpenCode: signs in to [vLLM-SR](https://app.vllm-sr.ai) (free System Duo: System One decision models plus the System Two chat router) and turns it into provider `vllm-sr`. Protocol reference: <https://app.vllm-sr.ai/docs>.

## The one rule that breaks the plugin

`index.mjs` must export **only** the plugin function (`VllmSrAuthPlugin`). magpie calls every function exported from the entry module as a plugin. Put helpers in module-local constants, or on `export const _internal` for tests.

## Two systems, one decide switch

- The provider keeps `decide: true` — magpie's docs: without it, `decides` has no effect and **every** model is used for chat. The per-model `decides: true` flag is what makes a model a hidden classifier; `vllm-sr/auto` (System Two, real chat) omits it and stays visible.
- System One models get a one-token output budget; `vllm-sr/auto` gets a real one and `tool_call: true`.
- `npm: "@ai-sdk/openai-compatible"` serves both: the upstream speaks OpenAI Chat Completions on `/v1/chat/completions` (System Two) and magpie posts decisions to `{baseURL}/systemone` (System One).

## Model ids: bare names, not full ids

Model-map keys (config hook and models hook) must be **bare** (`auto`, `d3-flash`); magpie prefixes the provider id itself. Full ids as keys produce doubled ids (`vllm-sr/vllm-sr/auto`). The models hook sets `id` to the full upstream id.

## Developing against the real magpie

- The folder is loaded in place (`magpie plugin add <path>`); nothing is installed. Every `magpie` CLI command loads the current folder contents, so edits apply on the next command. In the app, toggle the plugin off/on.
- To test without touching the user's real magpie (logins, config), run magpie in a sandbox:
  ```sh
  sb=$(mktemp -d)
  m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
  m plugin add /path/to/opencode-vllm-sr-auth </dev/null
  m plugin --json   # load errors, hooks, models
  ```
- Host errors and `console.log` from the plugin appear as `plugin: …` lines; the `page-chat` lines on every command are unrelated noise from another plugin.

## Sign-in flow tests: mock the Decision API first

Key creation is rate-limited per network address (429 `key_creation_limited`, `Retry-After: 3600`) and the challenge endpoint also has a per-minute cap. **Never run a sign-in flow test against the real `decision.vllm-sr.ai`** — it burns the user's quota for the hour. Always:

1. Start the mock: `node test/mock.mjs` (127.0.0.1:3497; difficulty 8, so the PoW is instant).
2. Use the persistent sandbox `/tmp/opencode/magpie-sb`, never a fresh `mktemp -d` per test: a new HOME makes magpie re-download bun and the plugin-host (76 MB, and it can time out). Set it up once, then reuse:
   ```sh
   export HOME=/tmp/opencode/magpie-sb XDG_CONFIG_HOME=/tmp/opencode/magpie-sb/.config XDG_CACHE_HOME=/tmp/opencode/magpie-sb/.cache MAGPIE_ADDR=127.0.0.1:3499
   mkdir -p /tmp/opencode/magpie-sb/plug
   cp index.mjs package.json /tmp/opencode/magpie-sb/plug/
   sed -i 's#const BASE = "https://decision.vllm-sr.ai"#const BASE = "http://127.0.0.1:3497"#' /tmp/opencode/magpie-sb/plug/index.mjs
   node test/mock.mjs &
   magpie plugin add /tmp/opencode/magpie-sb/plug </dev/null
   ```
   After edits, refresh the copy (`cp … && magpie plugin rm … && magpie plugin add …`) or just re-add: the CLI loads the folder contents on every command. If a magpie command hangs with no output, a stale plugin-host from a killed run is the usual cause: `pkill -f magpie-bu[n]` and retry.
3. Exercise the flows (`magpie plugin login vllm-sr …`, `magpie quota`, `magpie plugin --json`), then kill the mock. Leaving the sandbox in place is fine — it is gitignored territory under /tmp and makes the next run instant.

The mock validates the proof of work the same way the real API does (leading zero bits of SHA-256 ≥ difficulty), so a passing run means the logic is right, not just that a call happened. Its `/api/keys/self/usage` returns deliberately lopsided numbers (requests nearly spent, tokens barely touched) so a `used` bug shows in `magpie quota` at once. Real-API calls are only for one-shot verifications the user asks for.

## Sign-in and identity

- Sign-in state lives in magpie's `plugin-auth.json`, keyed by provider id `vllm-sr` — not by the plugin path. Moving/renaming the folder is safe, but re-register it: `magpie plugin rm <old-path> && magpie plugin add <new-path>`.
- `auth.usage` reads both systems: `/api/keys/self/usage` (System One, `quota.models[]` per model) and `/pt/api/keys/self/usage` (System Two, flat `quota` for the pool behind `vllm-sr/auto` — a different shape and endpoint, the `/pt/` prefix is System Two's, not an old-key thing). Each model has a request budget and a token budget; `used` is the larger share of the two — many small requests fill the request budget first. Format user-facing numbers with `toLocaleString("en-US")` (thousands separators) — keep this convention in any new display string.
- Errors meant to flag a dead sign-in must carry `signIn: "expired"`; a plain 401 from `fetch` also marks the account.

## Display-name and metadata facts (verified against magpie source)

- A locally-added folder plugin's display name comes from `package.json` `magpie.name` (one line, ≤80 bytes); without it, it is the folder name. `magpie.name` only applies to plugins the community `registry.json` does not list — the registry's name wins there. The `magpie` object also supports `icon` (https URL or data URI, ≤1 MB) and `maxConcurrency`; provider-level extras (`website`, `keys`) go in the `config` hook's provider object, not `package.json`.
- An auth method of `type: "api"` with `keyless: true` skips magpie's key input box: magpie runs the method's `authorize` at once (see zen-free in the community plugins). A plain `type: "api"` method always prompts for a key first, even with an `authorize`.
- `keywords` must keep `opencode` + `opencode-plugin` + vendor for npm search to find it; keep `files` in sync (README.md is shown as the plugin's detail page).
