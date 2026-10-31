// OpenCode / magpie provider plugin for the vLLM-SR Decision API
// (https://decision.vllm-sr.ai), a free System One decision-model service.
//
// Decision models answer typed questions with calibrated probabilities and
// generate no text, so their models are marked `decides: true`: magpie offers
// them as routing-group classifiers and hides them from agents' model lists.

const PROVIDER = "vllm-sr"
const BASE = "https://decision.vllm-sr.ai"

const DEFAULT_MODELS = {
  "vllm-sr/d3-ultra": { name: "Decision d3-ultra" },
  "vllm-sr/d3-flash": { name: "Decision d3-flash" },
  "vllm-sr/d3-mini": { name: "Decision d3-mini" },
  "vllm-sr/d3-nano": { name: "Decision d3-nano" },
  "vllm-sr/d3-lite": { name: "Decision d3-lite" },
  "vllm-sr/d3-edge": { name: "Decision d3-edge" },
}

const baseModel = {
  limit: { context: 128000, output: 1 },
  tool_call: false,
  free: true,
  decides: true,
}

export const VllmSrAuthPlugin = async ({ client }) => ({
  // The provider, and the models it has while nobody is signed in.
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "vLLM-SR Decision",
      npm: "@ai-sdk/openai-compatible", // never used for chat; decides only
      api: `${BASE}/v1`,
      decide: true,
      website: BASE,
      keys: `${BASE}/#key`,
      models: Object.fromEntries(
        Object.entries(DEFAULT_MODELS).map(([id, m]) => [id, { ...baseModel, ...m }]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "Decision API key", placeholder: "sk-vsr-…" }],

    // Every request this account sends carries its key.
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      return {
        baseURL: `${BASE}/v1`,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${auth.key}`)
          headers.set("x-vllm-sr-client", "opencode-vllm-sr-auth/0.1.0")
          return fetch(input, { ...init, headers })
        },
      }
    },

    // magpie's own hook: how much of the key's daily quota is used.
    // Daily quotas reset at 00:00 UTC and are counted per model.
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return { plan: "Free", windows: [] }
      let res
      try {
        res = await fetch(`${BASE}/api/keys/self/usage`, {
          headers: { authorization: `Bearer ${auth.key}` },
        })
      } catch (e) {
        return { error: `Decision API unreachable: ${e}`, windows: [] }
      }
      if (!res.ok) return { error: `Decision API answered ${res.status}`, windows: [] }
      const u = await res.json()
      const fmt = (n) => (n ?? 0).toLocaleString("en-US")
      const windows = (u.quota?.models ?? []).map((m) => {
        const short = m.id.replace("vllm-sr/", "")
        const tokensTotal = (m.tokens_today ?? 0) + (m.tokens_left ?? 0)
        const requestsTotal = (m.requests_today ?? 0) + (m.requests_left ?? 0)
        const used =
          tokensTotal > 0 ? Math.round(((m.tokens_today ?? 0) / tokensTotal) * 100) : 0
        return {
          name: short,
          used,
          resetsAt: u.quota?.resets_at,
          span: 86400,
          display: `${fmt(m.tokens_today)} / ${fmt(tokensTotal)} tokens · ${fmt(m.requests_today)} / ${fmt(requestsTotal)} requests`,
        }
      })
      return { plan: "Free", windows }
    },
  },

  // The published models of this account.
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      let list
      try {
        // The model list needs no key, but ask only for signed-in accounts:
        // magpie keeps provider.models otherwise.
        if (auth?.type !== "api") return provider.models
        const res = await fetch(`${BASE}/v1/systemone/models`)
        if (!res.ok) return provider.models
        list = (await res.json()).data ?? []
      } catch {
        return provider.models // magpie keeps the previous list
      }
      const out = {}
      for (const m of list) {
        if (m.alias_of) continue // served by the model it aliases
        const short = m.id.replace("vllm-sr/", "")
        out[m.id] = { ...baseModel, id: m.id, name: `Decision ${short}` }
      }
      return Object.keys(out).length ? out : provider.models
    },
  },
})
