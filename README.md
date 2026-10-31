# opencode-vllm-sr-auth

[OpenCode](https://opencode.ai) provider plugin for the [vLLM-SR Decision API](https://decision.vllm-sr.ai) — the free System One decision-model service from the [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) project. It also works in [magpie](https://usemagpie.ai) without changes.

Decision models answer typed questions about text, images and videos with calibrated probabilities, from one forward pass per question. They generate no text, so they are not chat models: the plugin marks every model `decides: true`, which magpie reads as "offered as a routing-group classifier, hidden from agents' model lists".

## Models

| Model | Size | Question types |
| --- | --- | --- |
| `vllm-sr/d3-ultra` | 27B | choice, noul, score, box, track |
| `vllm-sr/d3-flash` | 9B | choice, noul, score, box |
| `vllm-sr/d3-mini` | 4B | choice, noul, score |
| `vllm-sr/d3-nano` | 2B | choice, noul, score |
| `vllm-sr/d3-lite` | 0.8B | choice, noul, score |
| `vllm-sr/d3-edge` | 0.6B | choice, noul, score |

The list is refreshed from [`GET /v1/systemone/models`](https://decision.vllm-sr.ai/docs) for signed-in accounts. `vllm-sr/d3-turbo` and `vllm-sr/d3` are aliases of d3-ultra and are not listed separately.

## Sign in

1. Get a key: one click at [decision.vllm-sr.ai](https://decision.vllm-sr.ai/#key), no account. Keys are shown once (`sk-vsr-…`).
2. Add the plugin and sign in:

```sh
magpie plugin add opencode-vllm-sr-auth
magpie plugin login vllm-sr   # paste sk-vsr-…
```

In the magpie app: Plugins → add the plugin → sign in on the vLLM-SR row.

## Where the key is stored

In magpie's `plugin-auth.json` (permissions 600), the same file and format OpenCode uses for `auth.json`, so a sign-in can move between the two.

## Usage in magpie

- The provider id is `vllm-sr`. Point a routing group's intent rules at a model, e.g. `classifier=vllm-sr/d3-flash`.
- `magpie quota` shows each model's daily quota (tokens and requests, resetting 00:00 UTC), read live from the key's usage endpoint.

## Privacy

The Decision API may log every request and response, images and videos included, and use them to improve the service. Do not send sensitive data. See its [privacy notice](https://decision.vllm-sr.ai/privacy).

## License

MIT
