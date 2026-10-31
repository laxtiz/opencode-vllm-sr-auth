# AGENTS.md

Provider plugin for [magpie](https://usemagpie.ai) / OpenCode: signs in to the [vLLM-SR Decision API](https://decision.vllm-sr.ai) (free System One decision models) and turns it into provider `vllm-sr`. Protocol reference: <https://decision.vllm-sr.ai/docs>.

## The one rule that breaks the plugin

`index.mjs` must export **only** the plugin function (`VllmSrAuthPlugin`). magpie calls every function exported from the entry module as a plugin. Put helpers in module-local constants, or on `export const _internal` for tests.

## Decision models, not chat models

- All models carry `decides: true` and the provider `decide: true`: magpie offers them as routing-group classifiers and hides them from agents. Do not remove these flags or add chat models — the upstream cannot generate text.
- `npm: "@ai-sdk/openai-compatible"` is a placeholder; no chat request ever reaches it.

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

## Sign-in and identity

- Sign-in state lives in magpie's `plugin-auth.json`, keyed by provider id `vllm-sr` — not by the plugin path. Moving/renaming the folder is safe, but re-register it: `magpie plugin rm <old-path> && magpie plugin add <new-path>`.
- `auth.usage` reads `GET /api/keys/self/usage`; daily quotas reset 00:00 UTC per model. Format user-facing numbers with `toLocaleString("en-US")` (thousands separators) — keep this convention in any new display string.
- Errors meant to flag a dead sign-in must carry `signIn: "expired"`; a plain 401 from `fetch` also marks the account.

## Display-name and metadata facts (verified against magpie source)

- A locally-added folder plugin's display name in the app is its **folder name**; there is no override field. Friendly names like "MiniMax Code" come from the community `registry.json` and only apply to published packages.
- `package.json` `magpie` object supports only `icon` (https URL or data URI, ≤1 MB) and `maxConcurrency`; provider-level extras (`website`, `keys`) go in the `config` hook's provider object, not `package.json`.
- `keywords` must keep `opencode` + `opencode-plugin` + vendor for npm search to find it; keep `files` in sync (README.md is shown as the plugin's detail page).
