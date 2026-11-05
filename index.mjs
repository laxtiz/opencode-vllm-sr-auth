import { createHash } from "node:crypto"

// OpenCode / magpie provider plugin for vLLM-SR (https://app.vllm-sr.ai),
// a free service with two systems on one origin and one key:
//
// - System One, the decision models: they answer typed questions with
//   calibrated probabilities and generate no text, so they are marked
//   `decides: true` — magpie offers them as routing-group classifiers and
//   hides them from agents' model lists.
// - System Two, vllm-sr/auto: an OpenAI Chat Completions endpoint whose
//   router (vLLM Semantic Router) picks a model from its pool per request.
//   A plain chat model: no decides flag, visible to agents.
//
// The provider keeps `decide: true` — magpie's docs: without it, `decides`
// has no effect and every model is used for chat. The per-model `decides`
// flag is what separates classifiers from chat models.

const PROVIDER = "vllm-sr"
const BASE = "https://app.vllm-sr.ai"
const VERSION = "0.4.3"

// Key auto-registration, per https://app.vllm-sr.ai/docs#authentication
// ("Create a key from a terminal"): solve the proof-of-work challenge
// locally, no browser and no account, then return the key from `authorize`.
// A challenge is single-use, expires after 10 minutes, and each address may
// ask for 20 per minute; key creation itself is rate-limited per address.
async function createKey() {
  const res = await fetch(`${BASE}/api/keys/challenge`, { method: "POST" })
  if (!res.ok) throw new Error(`vLLM-SR answered ${res.status} asking for a challenge`)
  const c = await res.json()
  // The doc's test: SHA-256 of "challenge:nonce" read as a big-endian integer
  // below 1 << (256 - difficulty) — that is, its leading zero bits number at
  // least `difficulty`. At the usual difficulty of 20 that is a million
  // hashes, a second or two.
  const prefix = `${c.challenge}:`
  const solves = (digest) => {
    let zeros = 0
    for (const byte of digest) {
      if (byte === 0) {
        zeros += 8
        continue
      }
      zeros += Math.clz32(byte) - 24
      break
    }
    return zeros >= c.difficulty
  }
  let nonce = 0
  while (!solves(createHash("sha256").update(prefix + nonce).digest())) nonce++
  const done = await fetch(`${BASE}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: c.challenge, nonce: String(nonce), accept_terms: true }),
  })
  if (!done.ok) throw new Error(`vLLM-SR answered ${done.status} creating the key`)
  const k = await done.json()
  return k.api_key
}

// System One: one entry per family, not per retired name — d3-mini/nano/
// lite/edge are aliases of d3-flash, d3-turbo/d3 of d3-ultra. Keys are the
// FULL upstream ids: magpie sends a model map's key to the upstream as the
// model field verbatim, and these ids carry the vllm-sr/ prefix.
const S1_MODELS = {
  "vllm-sr/d3-ultra": { name: "Decision d3-ultra" },
  "vllm-sr/d3-flash": { name: "Decision d3-flash" },
  "vllm-sr/vela3-turbo": { name: "Decision vela3-turbo" },
  "vllm-sr/vela3-flash": { name: "Decision vela3-flash" },
}

// A decision model generates no text: a one-token output budget. The
// upstream caps a request's input at 131072 tokens (GET /api/info).
const s1Model = {
  limit: { context: 131072, output: 1 },
  tool_call: false,
  free: true,
  decides: true,
}

// System Two: the router model. Input and output share the service's
// 131072-token request cap; the pool (today GLM-5.3-Flash and Qwen3.8) does
// function calling.
const autoModel = {
  limit: { context: 131072, output: 16384 },
  tool_call: true,
  free: true,
}

const DEFAULT_MODELS = {
  ...Object.fromEntries(Object.entries(S1_MODELS).map(([id, m]) => [id, { ...s1Model, ...m }])),
  "vllm-sr/auto": { ...autoModel, name: "vLLM-SR Auto" },
}

export const VllmSrAuthPlugin = async ({ client }) => ({
  // The provider, and the models it has while nobody is signed in.
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "vLLM-SR",
      npm: "@ai-sdk/openai-compatible",
      api: `${BASE}/v1`,
      decide: true, // the switch that makes per-model decides effective
      website: BASE,
      keys: `${BASE}/keys`,
      models: DEFAULT_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    // a free key is not one of several accounts to rotate through: one
    // sign-in per magpie, so routing never waits on account selection
    single: true,
    methods: [
      { type: "api", label: "Decision API key", placeholder: "sk-vsr-…" },
      {
        // keyless so magpie runs `authorize` straight away with no key input
        // box: magpie prompts for a key on every plain type "api" method.
        type: "api",
        keyless: true,
        label: "Create a key automatically",
        authorize: async () => ({ type: "success", key: await createKey() }),
      },
    ],

    // Every request this account sends carries its key.
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      return {
        baseURL: `${BASE}/v1`,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${auth.key}`)
          headers.set("x-vllm-sr-client", `opencode-vllm-sr-auth/${VERSION}`)
          return fetch(input, { ...init, headers })
        },
      }
    },

    // magpie's own hook: how much of the key's daily quota is used.
    // Both systems reset at 00:00 UTC and count requests and tokens;
    // whichever budget is tighter decides, so `used` is the larger of the
    // two ratios — many small requests fill the request budget first, big
    // inputs the token budget. The systems report differently and on
    // different endpoints, so each is read and unpacked on its own:
    // System One returns a quota entry per model on /api/keys/self/usage,
    // System Two one flat quota for the pool behind vllm-sr/auto on
    // /pt/api/keys/self/usage.
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return { plan: "Free", windows: [] }
      const headers = { authorization: `Bearer ${auth.key}` }
      const fmt = (n) => (n ?? 0).toLocaleString("en-US")
      const share = (today, left) => {
        const total = (today ?? 0) + (left ?? 0)
        return total > 0 ? (today ?? 0) / total : 0
      }
      const usedPct = (q) =>
        Math.round(Math.max(share(q.requests_today, q.requests_left), share(q.tokens_today, q.tokens_left)) * 100)
      const display = (q) =>
        `${fmt(q.requests_today)} / ${fmt((q.requests_today ?? 0) + (q.requests_left ?? 0))} requests · ${fmt(q.tokens_today)} / ${fmt((q.tokens_today ?? 0) + (q.tokens_left ?? 0))} tokens`
      const window = (name, quota) => ({
        name,
        used: usedPct(quota),
        resetsAt: quota.resets_at,
        span: 86400,
        display: display(quota),
      })
      const read = async (path) => {
        try {
          const res = await fetch(`${BASE}${path}`, { headers })
          if (!res.ok) return { error: `vLLM-SR answered ${res.status} on ${path}` }
          return { quota: (await res.json()).quota ?? {} }
        } catch (e) {
          return { error: `vLLM-SR unreachable on ${path}: ${e}` }
        }
      }

      const [s1, s2] = await Promise.all([
        read("/api/keys/self/usage"),
        read("/pt/api/keys/self/usage"),
      ])
      const windows = []
      if (s1.quota) {
        for (const m of s1.quota.models ?? []) {
          windows.push(window(m.id.replace("vllm-sr/", ""), m))
        }
      }
      if (s2.quota) windows.push(window("auto", s2.quota))
      const errors = [s1.error, s2.error].filter(Boolean)
      return errors.length && !windows.length
        ? { error: errors.join("; "), windows: [] }
        : { plan: "Free", windows }
    },
  },

  // The published models of this account.
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      // The list needs no key, but ask only for signed-in accounts:
      // magpie keeps provider.models otherwise.
      if (auth?.type !== "api") return provider.models
      let list
      try {
        const res = await fetch(`${BASE}/v1/models`)
        if (!res.ok) return provider.models
        list = (await res.json()).data ?? []
      } catch {
        return provider.models // magpie keeps the previous list
      }
      const out = {}
      for (const m of list) {
        if (m.alias_of) continue // served by the model it aliases
        const short = m.id.replace("vllm-sr/", "")
        // System Two marks itself ("system": "two"); everything else is a
        // System One decision model
        const two = m.system === "two"
        out[m.id] = two
          ? { ...autoModel, id: m.id, name: `vLLM-SR ${short}` }
          : { ...s1Model, id: m.id, name: `Decision ${short}` }
      }
      return Object.keys(out).length ? out : provider.models
    },
  },
})
