// A local mock of vLLM-SR's key and model endpoints, for testing the
// plugin's sign-in flows without spending the real network address's
// key-creation quota (429 key_creation_limited, Retry-After: 3600).
//
//   node test/mock.mjs            # 127.0.0.1:3497
//
// Then point the plugin at it and run magpie in the persistent sandbox
// (see AGENTS.md): the plugin's BASE must read http://127.0.0.1:3497 in
// that copy.
//
// Serves POST /api/keys/challenge (difficulty 8, fast to solve), POST
// /api/keys (validates the proof of work, one use per challenge), GET
// /v1/systemone/models, GET /pt/api/info, and both usage endpoints with
// deliberately lopsided numbers so a `used` bug shows at once.
import { createHash } from "node:crypto"
import { createServer } from "node:http"

const PORT = 3497
const created = new Set()

const s1Quota = {
  resets_at: new Date(Date.now() + 3600_000).toISOString(),
  // d3-flash: requests nearly exhausted, tokens barely touched — used must
  // follow the request budget (99%); d3-ultra the reverse (tokens 90%)
  models: [
    { id: "vllm-sr/d3-flash", requests_today: 748440, requests_left: 7560, tokens_today: 6480000, tokens_left: 641520000 },
    { id: "vllm-sr/d3-ultra", requests_today: 6480, requests_left: 641520, tokens_today: 486000000, tokens_left: 54000000 },
  ],
}

const s2Quota = {
  day: new Date().toISOString().slice(0, 10),
  resets_at: new Date(Date.now() + 3600_000).toISOString(),
  requests_today: 54000,
  requests_left: 54000,
  requests_per_day: 108000,
  requests_per_minute: 180,
  tokens_today: 180000000,
  tokens_left: 180000000,
  tokens_per_day: 360000000,
  tokens_per_minute: 600000,
  max_concurrency: 16,
}

createServer((req, res) => {
  const body = []
  req.on("data", (c) => body.push(c))
  req.on("end", () => {
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(JSON.stringify(obj))
    }
    if (req.url === "/api/keys/challenge" && req.method === "POST") {
      const challenge = `mock.${Date.now()}.${Math.random().toString(16).slice(2)}`
      return json(200, {
        algorithm: "sha256",
        challenge,
        difficulty: 8,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })
    }
    if (req.url === "/api/keys" && req.method === "POST") {
      const b = JSON.parse(Buffer.concat(body).toString() || "{}")
      if (!b.accept_terms) return json(400, { error: { code: "terms_not_accepted" } })
      if (created.has(b.challenge)) return json(400, { error: { code: "invalid_proof" } })
      // leading zero bits of the digest must number at least the difficulty
      const digest = createHash("sha256").update(`${b.challenge}:${b.nonce}`).digest()
      let bits = 0
      for (const byte of digest) {
        if (byte) {
          bits += Math.clz32(byte) - 24
          break
        }
        bits += 8
      }
      if (bits < 8) return json(400, { error: { code: "invalid_proof" } })
      created.add(b.challenge)
      return json(201, { api_key: `sk-vsr-mock-${Math.random().toString(16).slice(2)}` })
    }
    if (req.url === "/v1/systemone" && req.method === "POST") {
      const b = JSON.parse(Buffer.concat(body).toString() || "{}")
      // same idea: log the model id magpie puts on decision requests
      console.log(`[mock] decide model received: ${JSON.stringify(b.model)}`)
      const answers = {}
      for (const q of Object.keys(b.questions ?? {})) answers[q] = { choice: "code", score: 1, confidence: 0.9 }
      return json(200, { model: b.model, answers })
    }
    if (req.url === "/v1/chat/completions") {
      const b = JSON.parse(Buffer.concat(body).toString() || "{}")
      // echo the model id magpie put on the request — the whole point of
      // this endpoint is to see what magpie sends upstream
      console.log(`[mock] chat model received: ${JSON.stringify(b.model)}`)
      return json(200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: b.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    if (req.url === "/v1/models") {
      return json(200, {
        data: [
          { id: "vllm-sr/d3-ultra", object: "model", owned_by: "vllm-sr" },
          { id: "vllm-sr/d3-turbo", object: "model", owned_by: "vllm-sr", alias_of: "vllm-sr/d3-ultra" },
          { id: "vllm-sr/d3-flash", object: "model", owned_by: "vllm-sr" },
          { id: "vllm-sr/d3-mini", object: "model", owned_by: "vllm-sr", alias_of: "vllm-sr/d3-flash" },
          { id: "vllm-sr/vela3-turbo", object: "model", owned_by: "vllm-sr" },
          { id: "vllm-sr/vela3-flash", object: "model", owned_by: "vllm-sr" },
          { id: "vllm-sr/auto", object: "model", owned_by: "vllm-sr", system: "two" },
        ],
      })
    }
    if (req.url === "/v1/systemone/models") {
      return json(200, {
        data: [
          { id: "vllm-sr/d3-ultra" },
          { id: "vllm-sr/d3-flash" },
          { id: "vllm-sr/d3-mini", alias_of: "vllm-sr/d3-flash" },
          { id: "vllm-sr/vela3-turbo" },
          { id: "vllm-sr/vela3-flash" },
        ],
      })
    }
    if (req.url === "/pt/api/info") {
      return json(200, {
        models: [{ id: "vllm-sr/auto", routes_to: ["zai/glm-5.3-flash", "qwen/qwen3.8-27b"] }],
      })
    }
    if (req.url === "/api/keys/self/usage") {
      const auth = (req.headers.authorization || "").replace("Bearer ", "")
      if (!auth.startsWith("sk-vsr-")) {
        res.writeHead(401)
        return res.end()
      }
      return json(200, { quota: s1Quota })
    }
    if (req.url === "/pt/api/keys/self/usage") {
      const auth = (req.headers.authorization || "").replace("Bearer ", "")
      if (!auth.startsWith("sk-vsr-")) {
        res.writeHead(401)
        return res.end()
      }
      return json(200, { quota: s2Quota })
    }
    json(404, {})
  })
}).listen(PORT, "127.0.0.1", () => console.log(`vLLM-SR mock on 127.0.0.1:${PORT}`))
