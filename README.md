# x402-deno

A drop-in **x402 v2 paywall for any Deno fetch handler**. Charge per request in USDC on Base, with no accounts, no API keys, and no payment processor integration. Buyers pay with any x402 client; the money lands directly in your wallet.

Built for [Deno Deploy](https://deno.com/deploy) using only built-in Deno and Web APIs. No npm dependencies.

```ts
import { createX402Middleware } from "./x402.ts";

const paid = createX402Middleware({
  kv: await Deno.openKv(),
  payTo: Deno.env.get("X402_PAY_TO")!,
  publicUrl: "https://api.example.com/v1/chat/completions",
  facilitatorBaseUrl: "https://facilitator.payai.network",
  handler: inferenceHandler,
});

Deno.serve((request) =>
  new URL(request.url).pathname === "/v1/chat/completions"
    ? paid(request)
    : inferenceHandler(request)
);
```

## What it does

The server answers an unpaid request with `402 Payment Required` and a base64 `PAYMENT-REQUIRED` header describing the exact price (0.01 USDC, `eip155:8453`, `exact` scheme, EIP-3009). The client signs a `transferWithAuthorization` and retries with `PAYMENT-SIGNATURE`. The middleware then:

1. Validates the payload against the requirements.
2. Calls the facilitator's `/verify` endpoint (no funds move yet).
3. **Atomically reserves** `(network, asset, payer, nonce)` in Deno KV before doing any work.
4. Runs your handler with a bounded timeout and buffers the result.
5. Calls `/settle`, and only then releases the response.
6. Returns `PAYMENT-RESPONSE` with the on-chain transaction hash.

If settlement has an unknown outcome, the request fails closed. A client can retry the same signed payment; the stored response is replayed from KV without running inference or settling twice.

### Why the KV reservation matters

A naive implementation keeps replay state in memory. On Deno Deploy, or any horizontally scaled runtime, two instances can accept the same EIP-3009 nonce concurrently and both deliver the resource. Writes to Deno KV have a compare-and-set primitive, so this module claims the nonce with `versionstamp: null` before inference. Exactly one instance wins; the others get `409 payment_in_progress` (or replay the cached result if the winner already finished).

This is the same guarantee an on-chain nonce gives, but enforced before the resource is consumed.

## Quick start

1. Copy `src/x402.ts` into your project.
2. Deploy to Deno Deploy (or run locally):

```bash
deno run --unstable-kv --allow-net --allow-env main.ts
```

3. Set environment variables:

| Variable | Required | Description |
|---|---|---|
| `X402_PAY_TO` | yes | Non-zero EVM address that receives USDC |
| `X402_PUBLIC_URL` | yes | Canonical HTTPS URL of the paid resource |
| `X402_FACILITATOR_URL` | yes | Facilitator base URL, e.g. `https://facilitator.payai.network` |
| `X402_FACILITATOR_TOKEN` | no | Bearer token for facilitators that require one |

Use a facilitator that supports Base mainnet. `x402.org`'s public facilitator is testnet-only; PayAI and Coinbase CDP support mainnet.

4. Point an x402 client at the endpoint. Any client that implements `exact` / `eip155:8453` works.

## Configuration

`createX402Middleware` accepts:

| Option | Default | Purpose |
|---|---|---|
| `kv` | required | `Deno.Kv` used for nonce claims and response replay |
| `payTo` | required | Merchant address |
| `publicUrl` | required | Canonical resource URL (no query or hash) |
| `facilitatorBaseUrl` | required | HTTPS facilitator |
| `facilitatorBearerToken` | — | Optional auth for the facilitator |
| `handler` | required | Your `(request: Request) => Promise<Response>` |
| `verifyTimeoutMs` | `4000` | `/verify` budget |
| `settleTimeoutMs` | `15000` | `/settle` budget |
| `inferenceTimeoutMs` | `30000` | Handler budget |
| `settlementReserveMs` | `18000` | Time held back from the authorization window for settlement |
| `boundHeaderNames` | `authorization`, `cookie`, `openai-organization`, `openai-project` | Headers included in the request hash, so a paid response can't be replayed for a different tenant or identity |

The price, network, and asset are module constants at the top of `x402.ts`:

```ts
const NETWORK = "eip155:8453";                                  // Base mainnet
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";     // native USDC
const AMOUNT = "10000";                                         // 0.01 USDC (6 decimals)
const MAX_TIMEOUT_SECONDS = 60;
```

Change `AMOUNT` for a different price. Supporting multiple prices or networks means building `requirements` per route; the current design deliberately keeps one immutable requirement object so validation can't drift.

## Error behavior

All non-402 errors use:

```json
{ "error": { "code": "ERROR_CODE", "message": "..." } }
```

| Condition | HTTP | Code |
|---|---|---|
| Missing payment | 402 | `PaymentRequired`, `PAYMENT-SIGNATURE header is required` |
| Malformed base64/JSON | 400 | `invalid_payment_payload` |
| Wrong amount/asset/network/recipient | 402 | `payment_requirements_mismatch` |
| Invalid signature | 402 | `invalid_signature` |
| Expired authorization | 402 | `authorization_expired` |
| Authorization window too long | 402 | `authorization_window_too_long` |
| Concurrent replay | 409 | `payment_in_progress` |
| Same nonce, different request | 409 | `payment_replayed` |
| Facilitator timeout | 504 | `facilitator_timeout` |
| Facilitator 5xx | 503 | `facilitator_unavailable` |
| Invalid facilitator response | 502 | `facilitator_bad_response` |
| Deno KV unavailable | 503 | `payment_store_unavailable` |
| Handler timeout | 504 | `inference_timeout` |
| Terminal settlement failure | 402 | `settlement_failed` |
| Settlement timeout / unknown outcome | 504 / 503 | `settlement_unknown` |

`settlement_unknown` is deliberate: a timeout does not prove the transaction failed on chain. Retrying the same payment resolves it either to a cached response or a confirmed settlement.

## Limitations

- **No streaming.** The x402 `exact` flow settles after the resource runs, so paid output is buffered before settlement. `stream: true` is rejected up front with `400 streaming_not_supported` instead of being silently mishandled. In this design, streaming before settlement means giving away unpaid work.
- **One price, one network, one asset per middleware.** Compose one middleware per route if you need different prices.
- **Facilitator trust.** Verification and settlement are delegated. Pick a facilitator you trust, and keep `facilitatorBearerToken` secret.
- **Not audited.** This is an integration-grade implementation, not a security audit. Review it before handling meaningful volume.
- **KV expiry.** Replay records and cached responses live until 24 hours after the authorization expires. Deleting KV entries early re-opens replay windows.

## Tests

```bash
deno task test
```

The smoke tests cover the challenge shape, routing and malformed-payload errors, and the full settle + replay path with a mocked facilitator. They require `--unstable-kv` (already set in `deno.json`).

## Production checklist

- Use a dedicated `payTo` wallet, not a hot wallet holding other funds.
- Keep `X402_PUBLIC_URL` exactly equal to the URL clients call; the resource field is signed into the requirement set.
- Bind identity headers (`authorization`, `cookie`, tenant headers) if the same endpoint serves multiple users; otherwise a cached paid response could be replayed across identities.
- Alert on `payment_store_unavailable` and `settlement_unknown`; both mean money or service state is uncertain.
- If your handler can take longer than `inferenceTimeoutMs`, raise it and keep `settlementReserveMs` large enough for `/settle` to land inside `validBefore`.
- The client's `validBefore` must fall within `MAX_TIMEOUT_SECONDS + 5` seconds of the server clock (`authorization_window_too_long` otherwise). Keep the server clock synchronized.

## Origin

The initial implementation was generated by an AI model (GPT-6 Work via a third-party relay) in response to a detailed specification, then extracted, type-checked with `deno check`, and reviewed for documentation and packaging by [Arona Plana](https://aronaplana.dynv6.net/). Treat the AI-generated code as a starting point and review it yourself; the security notes above are part of that review, not a substitute for one.

## Support

If this saves you time, tips are welcome:

- Lightning: `aronaplana@coinos.io`
- EVM (Base / Ethereum): `0x265A2CD6Bf17fE20FcE68Db5473EA29a1Ac389d1`
- Bitcoin: `bc1q9zmgsmg7vw6464wzn4g463t6hfzz4tux3qdta2`

## License

MIT
