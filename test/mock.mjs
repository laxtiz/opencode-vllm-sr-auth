// A local mock of the Decision API's key endpoints, for testing the
// plugin's sign-in flows without spending the real network address's
// key-creation quota (429 key_creation_limited, Retry-After: 3600).
//
//   node test/mock.mjs            # challenge + key creation on 127.0.0.1:3497
//
// Then point the plugin at it and run magpie in a sandbox (see AGENTS.md):
// the plugin's BASE must read http://127.0.0.1:3497 in that copy.
//
// Serves POST /api/keys/challenge (difficulty 8, fast to solve),
// POST /api/keys (validates the proof of work, one use per challenge),
// GET /api/keys/self/usage (a small quota for any sk-vsr- key).
import { createHash } from "node:crypto"
import { createServer } from "node:http"

const PORT = 3497
const created = new Set()

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
    if (req.url === "/api/keys/self/usage") {
      const auth = (req.headers.authorization || "").replace("Bearer ", "")
      if (!auth.startsWith("sk-vsr-")) {
        res.writeHead(401)
        return res.end()
      }
      // d3-flash: requests nearly exhausted, tokens barely touched — used
      // must follow the request budget (99%), not the token one (1%)
      return json(200, {
        quota: {
          resets_at: new Date(Date.now() + 3600_000).toISOString(),
          models: [
            { id: "vllm-sr/d3-flash", requests_today: 427680, requests_left: 4320, tokens_today: 4500000, tokens_left: 445500000 },
            { id: "vllm-sr/d3-ultra", requests_today: 6480, requests_left: 641520, tokens_today: 486000000, tokens_left: 54000000 },
          ],
        },
      })
    }
    json(404, {})
  })
}).listen(PORT, "127.0.0.1", () => console.log(`decision-api mock on 127.0.0.1:${PORT}`))
