/** x402 v2 / Base USDC / EIP-3009 middleware. No imports. */

const NETWORK = "eip155:8453";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT = "10000";
const MAX_TIMEOUT_SECONDS = 60;

const RETAIN_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 32 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PAYMENT_HEADER_CHARS = 16 * 1024;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

type JsonObject = Record<string, unknown>;

type PaymentRequirements = {
  scheme: "exact";
  network: typeof NETWORK;
  amount: typeof AMOUNT;
  asset: typeof ASSET;
  payTo: string;
  maxTimeoutSeconds: typeof MAX_TIMEOUT_SECONDS;
  extra: { name: "USD Coin"; version: "2" };
};

type Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

type PaymentPayload = {
  x402Version: 2;
  accepted: PaymentRequirements;
  resource?: { url: string };
  payload: {
    signature: string;
    authorization: Authorization;
  };
  extensions?: JsonObject;
};

type Settlement = {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  amount?: string;
  extensions?: JsonObject;
};

type ResponseMeta = {
  status: number;
  headers: [string, string][];
  chunks: number;
};

type State =
  | "running"
  | "settling"
  | "settled"
  | "uncertain"
  | "failed";

type Ledger = {
  state: State;
  headerHash: string;
  requestHash: string;
  expiresAt: number;
  createdAt: number;
  response?: ResponseMeta;
  settlement?: Settlement;
  transaction?: string;
};

export type X402Options = {
  kv: Deno.Kv;
  payTo: string;
  publicUrl: string;
  facilitatorBaseUrl: string;
  facilitatorBearerToken?: string;
  handler: (request: Request) => Promise<Response>;
  verifyTimeoutMs?: number;
  settleTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  settlementReserveMs?: number;
  boundHeaderNames?: string[];
};

function isObject(value: unknown): value is JsonObject {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function eqAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function b64(value: unknown): string {
  const bytes = enc.encode(JSON.stringify(value));
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 8192),
    );
  }

  return btoa(binary);
}

function unb64(value: string): unknown {
  const valid =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (
    value.length > MAX_PAYMENT_HEADER_CHARS ||
    !valid.test(value)
  ) {
    throw new Error("invalid_base64");
  }

  const binary = atob(value);
  const bytes = Uint8Array.from(
    binary,
    (ch) => ch.charCodeAt(0),
  );

  return JSON.parse(dec.decode(bytes));
}

async function sha256(
  data: Uint8Array | string,
): Promise<string> {
  const bytes =
    typeof data === "string" ? enc.encode(data) : data;

  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(bytes),
    ),
  );

  return Array.from(
    digest,
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}

function json(
  status: number,
  value: unknown,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);

  headers.set(
    "content-type",
    "application/json; charset=utf-8",
  );
  headers.set("cache-control", "no-store");
  headers.set(
    "access-control-expose-headers",
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  );

  return new Response(JSON.stringify(value), {
    status,
    headers,
  });
}

function error(
  status: number,
  code: string,
  message: string,
  tx?: string,
): Response {
  const headers: HeadersInit =
    status === 503 || status === 504
      ? { "retry-after": "5" }
      : {};

  return json(
    status,
    {
      error: {
        code,
        message,
        ...(tx ? { transaction: tx } : {}),
      },
    },
    headers,
  );
}

/**
 * Construct the canonical x402 v2 PaymentRequired object.
 *
 * Bazaar's schema validates the discovery info, including
 * the HTTP body example. It is not a replacement for
 * runtime validation of incoming inference requests.
 */
function makePaymentRequired(
  errorCode: string,
  publicUrl: string,
  req: PaymentRequirements,
) {
  return {
    x402Version: 2,
    error: errorCode,

    resource: {
      url: publicUrl,
      description:
        "One non-streaming OpenAI-compatible chat completion",
      mimeType: "application/json",
    },

    accepts: [req],

    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",

            body: {
              model: "example-model",
              messages: [
                {
                  role: "user",
                  content: "Hello",
                },
              ],
              stream: false,
            },

            headers: {
              "content-type": "application/json",
            },
          },

          output: {
            type: "json",
            example: {
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Hello",
                  },
                  finish_reason: "stop",
                },
              ],
            },
          },
        },

        schema: {
          $schema:
            "https://json-schema.org/draft/2020-12/schema",
          type: "object",

          properties: {
            input: {
              type: "object",

              properties: {
                type: { const: "http" },
                method: { const: "POST" },
                bodyType: { const: "json" },

                body: {
                  type: "object",

                  properties: {
                    model: { type: "string" },

                    messages: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          role: { type: "string" },
                          content: { type: "string" },
                        },
                        required: ["role", "content"],
                      },
                    },

                    stream: { const: false },
                  },

                  required: ["model", "messages"],
                },

                headers: {
                  type: "object",
                  additionalProperties: {
                    type: "string",
                  },
                },
              },

              required: [
                "type",
                "method",
                "bodyType",
                "body",
              ],
              additionalProperties: false,
            },

            output: {
              type: "object",
              properties: {
                type: { const: "json" },
                example: { type: "object" },
              },
              required: ["type"],
            },
          },

          required: ["input"],
          additionalProperties: false,
        },
      },
    },
  };
}

function challenge(
  errorCode: string,
  publicUrl: string,
  req: PaymentRequirements,
): Response {
  const required = makePaymentRequired(
    errorCode,
    publicUrl,
    req,
  );

  return json(402, required, {
    "PAYMENT-REQUIRED": b64(required),
  });
}

/**
 * Structural validation only.
 *
 * EIP-712 signature recovery, balance checks, nonce state
 * and transfer simulation are delegated to the facilitator.
 */
function parsePayment(
  raw: unknown,
  req: PaymentRequirements,
  publicUrl: string,
):
  | {
    payment: PaymentPayload;
    auth: Authorization;
    validAfter: bigint;
    validBefore: bigint;
  }
  | string {
  if (
    !isObject(raw) ||
    raw.x402Version !== 2 ||
    !isObject(raw.accepted) ||
    !isObject(raw.payload) ||
    !isObject(raw.payload.authorization)
  ) {
    return "malformed";
  }

  const a = raw.accepted;
  const p = raw.payload;
  const auth = p.authorization as JsonObject;

  if (
    typeof a.scheme !== "string" ||
    typeof a.network !== "string" ||
    typeof a.amount !== "string" ||
    typeof a.asset !== "string" ||
    typeof a.payTo !== "string" ||
    !isObject(a.extra)
  ) {
    return "malformed";
  }

  if (
    a.scheme !== req.scheme ||
    a.network !== req.network ||
    a.amount !== req.amount ||
    !eqAddress(a.asset, req.asset) ||
    !eqAddress(a.payTo, req.payTo) ||
    a.maxTimeoutSeconds !== req.maxTimeoutSeconds ||
    a.extra.name !== req.extra.name ||
    a.extra.version !== req.extra.version ||
    (
      a.extra.assetTransferMethod !== undefined &&
      a.extra.assetTransferMethod !== "eip3009"
    ) ||
    (
      a.extra.paymentFlow !== undefined &&
      a.extra.paymentFlow !== "authorization"
    )
  ) {
    return "mismatch";
  }

  if (
    raw.resource !== undefined &&
    (
      !isObject(raw.resource) ||
      raw.resource.url !== publicUrl
    )
  ) {
    return "mismatch";
  }

  if (
    typeof p.signature !== "string" ||
    !SIGNATURE.test(p.signature) ||
    typeof auth.from !== "string" ||
    !ADDRESS.test(auth.from) ||
    typeof auth.to !== "string" ||
    !ADDRESS.test(auth.to) ||
    typeof auth.value !== "string" ||
    !DECIMAL.test(auth.value) ||
    typeof auth.validAfter !== "string" ||
    !DECIMAL.test(auth.validAfter) ||
    typeof auth.validBefore !== "string" ||
    !DECIMAL.test(auth.validBefore) ||
    typeof auth.nonce !== "string" ||
    !NONCE.test(auth.nonce)
  ) {
    return "malformed";
  }

  if (
    !eqAddress(auth.to, req.payTo) ||
    auth.value !== req.amount
  ) {
    return "mismatch";
  }

  return {
    payment: raw as PaymentPayload,
    auth: auth as Authorization,
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
  };
}

class LimitError extends Error {}

/** Bounded buffering, including for unknown Content-Length. */
async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;

      if (size > max) {
        throw new LimitError("body_too_large");
      }

      parts.push(value.slice());
    }
  } catch (cause) {
    void reader.cancel().catch(() => {});
    throw cause;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return bytes;
}

function cleanHeaders(
  original: Headers,
): [string, string][] {
  const headers = new Headers(original);

  for (
    const name of [
      "set-cookie",
      "content-length",
      "content-encoding",
      "transfer-encoding",
      "connection",
      "keep-alive",
      "payment-response",
      "payment-required",
      "cache-control",
    ]
  ) {
    headers.delete(name);
  }

  headers.set("cache-control", "no-store");
  headers.set(
    "access-control-expose-headers",
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  );

  return [...headers.entries()];
}

function expiry(entry: Ledger): number {
  return Math.max(
    1000,
    entry.expiresAt - Date.now(),
  );
}

function keyFor(
  auth: Authorization,
): Deno.KvKey {
  return [
    "x402-v2",
    NETWORK,
    ASSET.toLowerCase(),
    auth.from.toLowerCase(),
    auth.nonce.toLowerCase(),
  ];
}

function validSettlement(
  value: unknown,
  payer: string,
): value is Settlement {
  if (
    !isObject(value) ||
    typeof value.success !== "boolean" ||
    value.network !== NETWORK ||
    typeof value.transaction !== "string" ||
    (
      value.payer !== undefined &&
      (
        typeof value.payer !== "string" ||
        !eqAddress(value.payer, payer)
      )
    ) ||
    (
      value.amount !== undefined &&
      value.amount !== AMOUNT
    )
  ) {
    return false;
  }

  if (value.success) {
    return TX_HASH.test(value.transaction);
  }

  return typeof value.errorReason === "string" &&
    (
      value.transaction === "" ||
      TX_HASH.test(value.transaction)
    ) &&
    (
      value.errorReason !== "settlement_pending" ||
      TX_HASH.test(value.transaction)
    );
}

class FacilitatorError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Facilitator v2 wire body:
 * {
 *   x402Version: 2,
 *   paymentPayload,
 *   paymentRequirements
 * }
 */
async function facilitatorPost(
  baseUrl: string,
  bearer: string | undefined,
  endpoint: "verify" | "settle",
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  timeoutMs: number,
): Promise<unknown> {
  const url = new URL(endpoint, baseUrl);

  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
  });

  if (bearer) {
    headers.set(
      "authorization",
      `Bearer ${bearer}`,
    );
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payment,
        paymentRequirements: requirements,
      }),
      signal,
      redirect: "error",
    });

    if (
      response.status >= 500 ||
      response.status === 429
    ) {
      void response.body?.cancel();

      throw new FacilitatorError(
        "facilitator_unavailable",
        503,
      );
    }

    if (!response.ok) {
      void response.body?.cancel();

      throw new FacilitatorError(
        "facilitator_bad_response",
        502,
      );
    }

    const bytes = await readLimited(
      response.body,
      16 * 1024,
    );

    try {
      return JSON.parse(dec.decode(bytes));
    } catch {
      throw new FacilitatorError(
        "facilitator_bad_response",
        502,
      );
    }
  } catch (cause) {
    if (cause instanceof FacilitatorError) {
      throw cause;
    }

    if (
      signal.aborted ||
      (
        cause instanceof Error &&
        (
          cause.name === "TimeoutError" ||
          cause.name === "AbortError"
        )
      )
    ) {
      throw new FacilitatorError(
        "facilitator_timeout",
        504,
      );
    }

    if (cause instanceof LimitError) {
      throw new FacilitatorError(
        "facilitator_bad_response",
        502,
      );
    }

    throw new FacilitatorError(
      "facilitator_unavailable",
      503,
    );
  }
}

/** Versionstamp-protected state transition. */
async function updateState(
  kv: Deno.Kv,
  key: Deno.KvKey,
  from: State,
  to: State,
  patch: Partial<Ledger>,
): Promise<void> {
  const entry = await kv.get<Ledger>(
    key,
    { consistency: "strong" },
  );

  if (
    !entry.value ||
    entry.value.state !== from
  ) {
    throw new Error("state_conflict");
  }

  const next: Ledger = {
    ...entry.value,
    ...patch,
    state: to,
  };

  const commit = await kv.atomic()
    .check(entry)
    .set(key, next, { expireIn: expiry(next) })
    .commit();

  if (!commit.ok) {
    throw new Error("state_conflict");
  }
}

/**
 * Persist response before attempting settlement.
 * Chunking keeps individual values within Deno KV limits.
 */
async function stageResponse(
  kv: Deno.Kv,
  key: Deno.KvKey,
  response: Response,
  body: Uint8Array,
): Promise<void> {
  const entry = await kv.get<Ledger>(
    key,
    { consistency: "strong" },
  );

  if (
    !entry.value ||
    entry.value.state !== "running"
  ) {
    throw new Error("state_conflict");
  }

  const count = Math.ceil(
    body.length / CHUNK_SIZE,
  );

  const next: Ledger = {
    ...entry.value,
    state: "settling",
    response: {
      status: response.status,
      headers: cleanHeaders(response.headers),
      chunks: count,
    },
  };

  const ttl = expiry(next);

  const atomic = kv.atomic()
    .check(entry)
    .set(key, next, { expireIn: ttl });

  for (let i = 0; i < count; i++) {
    atomic.set(
      [...key, "body", i],
      body.slice(
        i * CHUNK_SIZE,
        (i + 1) * CHUNK_SIZE,
      ),
      { expireIn: ttl },
    );
  }

  if (!(await atomic.commit()).ok) {
    throw new Error("state_conflict");
  }
}

/**
 * Identical paid retries return the original response.
 * The inference handler and facilitator are not called again.
 */
async function cachedResponse(
  kv: Deno.Kv,
  key: Deno.KvKey,
  ledger: Ledger,
): Promise<Response> {
  if (
    !ledger.response ||
    !ledger.settlement?.success
  ) {
    throw new Error("missing_receipt");
  }

  const meta = ledger.response;
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (let i = 0; i < meta.chunks; i++) {
    const entry = await kv.get<Uint8Array>(
      [...key, "body", i],
      { consistency: "strong" },
    );

    if (!(entry.value instanceof Uint8Array)) {
      throw new Error("missing_chunk");
    }

    size += entry.value.length;

    if (size > MAX_RESPONSE_BYTES) {
      throw new Error("invalid_chunk_size");
    }

    chunks.push(entry.value);
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  const headers = new Headers(meta.headers);

  headers.set(
    "PAYMENT-RESPONSE",
    b64(ledger.settlement),
  );
  headers.set("cache-control", "no-store");

  return new Response(
    [204, 205, 304].includes(meta.status)
      ? null
      : body,
    {
      status: meta.status,
      headers,
    },
  );
}

function reasonForVerify(
  reason: unknown,
): string {
  if (
    reason === "invalid_exact_evm_payload_signature" ||
    reason === "invalid_signature"
  ) {
    return "invalid_signature";
  }

  if (
    reason ===
      "invalid_exact_evm_payload_authorization_valid_before"
  ) {
    return "authorization_expired";
  }

  if (
    reason ===
      "invalid_exact_evm_payload_authorization_valid_after"
  ) {
    return "authorization_not_yet_valid";
  }

  return "payment_invalid";
}

/**
 * Protect POST /v1/chat/completions.
 *
 * All instances must use the same durable KV database.
 */
export function createX402Middleware(
  options: X402Options,
): (request: Request) => Promise<Response> {
  if (
    !ADDRESS.test(options.payTo) ||
    /^0x0{40}$/i.test(options.payTo)
  ) {
    throw new Error(
      "X402_PAY_TO must be a nonzero EVM address",
    );
  }

  const resource = new URL(options.publicUrl);

  const facilitator = new URL(
    options.facilitatorBaseUrl.replace(/\/+$/, "") + "/",
  );

  if (
    resource.protocol !== "https:" ||
    resource.search ||
    resource.hash ||
    facilitator.protocol !== "https:" ||
    facilitator.search ||
    facilitator.hash ||
    facilitator.username ||
    facilitator.password
  ) {
    throw new Error(
      "Canonical HTTPS URLs are required",
    );
  }

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: AMOUNT,
    payTo: options.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      name: "USD Coin",
      version: "2",
    },
  };

  const verifyTimeoutMs =
    options.verifyTimeoutMs ?? 4000;

  const settleTimeoutMs =
    options.settleTimeoutMs ?? 15000;

  const inferenceTimeoutMs =
    options.inferenceTimeoutMs ?? 30000;

  const settlementReserveMs =
    options.settlementReserveMs ?? 18000;

  const boundHeaders =
    options.boundHeaderNames ?? [
      "authorization",
      "cookie",
      "openai-organization",
      "openai-project",
    ];

  if (
    boundHeaders.some(
      (name) => !/^[a-zA-Z0-9-]+$/.test(name),
    )
  ) {
    throw new Error("Invalid bound header name");
  }

  for (
    const duration of [
      verifyTimeoutMs,
      settleTimeoutMs,
      inferenceTimeoutMs,
      settlementReserveMs,
    ]
  ) {
    if (
      !Number.isSafeInteger(duration) ||
      duration < 1000 ||
      duration > 60000
    ) {
      throw new Error(
        "Invalid timeout configuration",
      );
    }
  }

  return async (
    request: Request,
  ): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname !== resource.pathname) {
      return error(
        404,
        "not_found",
        "Unknown route",
      );
    }

    if (request.method !== "POST") {
      return json(
        405,
        {
          error: {
            code: "method_not_allowed",
            message: "POST required",
          },
        },
        { allow: "POST" },
      );
    }

    if (url.search) {
      return error(
        400,
        "unexpected_query",
        "Query parameters are not supported",
      );
    }

    const header = request.headers.get(
      "PAYMENT-SIGNATURE",
    );

    if (header === null) {
      return challenge(
        "PAYMENT-SIGNATURE header is required",
        options.publicUrl,
        requirements,
      );
    }

    if (header.length > MAX_PAYMENT_HEADER_CHARS) {
      return error(
        400,
        "invalid_payment_payload",
        "Malformed PAYMENT-SIGNATURE",
      );
    }

    let parsed: unknown;

    try {
      parsed = unb64(header);
    } catch {
      return error(
        400,
        "invalid_payment_payload",
        "Malformed PAYMENT-SIGNATURE",
      );
    }

    const result = parsePayment(
      parsed,
      requirements,
      options.publicUrl,
    );

    if (typeof result === "string") {
      return result === "malformed"
        ? error(
          400,
          "invalid_payment_payload",
          "Malformed PAYMENT-SIGNATURE",
        )
        : challenge(
          "payment_requirements_mismatch",
          options.publicUrl,
          requirements,
        );
    }

    const {
      payment,
      auth,
      validAfter,
      validBefore,
    } = result;

    /*
     * Canonicalize all unsigned, server-controlled
     * payment metadata. Never forward buyer-modified
     * payment requirements or Bazaar discovery data.
     */
    const required = makePaymentRequired(
      "Payment required",
      options.publicUrl,
      requirements,
    );

    const paymentForFacilitator: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: payment.payload,
      resource: required.resource,
      extensions: required.extensions,
    };

    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();

    if (contentType !== "application/json") {
      return error(
        415,
        "unsupported_media_type",
        "application/json required",
      );
    }

    const contentLength = request.headers.get(
      "content-length",
    );

    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_REQUEST_BYTES
    ) {
      return error(
        413,
        "request_too_large",
        "JSON request exceeds size limit",
      );
    }

    let body: Uint8Array<ArrayBuffer>;
    let input: unknown;

    try {
      body = await readLimited(
        request.body,
        MAX_REQUEST_BYTES,
      );

      input = JSON.parse(dec.decode(body));
    } catch (cause) {
      if (cause instanceof LimitError) {
        return error(
          413,
          "request_too_large",
          "JSON request exceeds size limit",
        );
      }

      return error(
        400,
        "invalid_request",
        "Invalid JSON request body",
      );
    }

    if (
      !isObject(input) ||
      typeof input.model !== "string" ||
      input.model.length === 0 ||
      !Array.isArray(input.messages) ||
      input.messages.length === 0 ||
      !input.messages.every(
        (m: unknown) =>
          isObject(m) &&
          typeof m.role === "string" &&
          (
            typeof m.content === "string" ||
            Array.isArray(m.content) ||
            m.content === null
          ),
      )
    ) {
      return error(
        400,
        "invalid_request",
        "Expected model and messages",
      );
    }

    if (input.stream === true) {
      return error(
        400,
        "streaming_not_supported",
        "Use stream:false with authorization flow",
      );
    }

    /*
     * Replay identity is scoped to the token's
     * EIP-3009 nonce domain:
     * network + token + payer + nonce.
     */
    const key = keyFor(auth);

    const headerHash = await sha256(header);

    const identityHeaders = boundHeaders
      .map(
        (name) =>
          [
            name.toLowerCase(),
            request.headers.get(name) ?? "",
          ] as [string, string],
      )
      .sort(
        ([a], [b]) => a.localeCompare(b),
      );

    const requestHash = await sha256(
      JSON.stringify({
        method: "POST",
        url: options.publicUrl,
        bodyHash: await sha256(body),
        headers: identityHeaders,
      }),
    );

    let existing: Deno.KvEntryMaybe<Ledger>;

    try {
      existing = await options.kv.get<Ledger>(
        key,
        { consistency: "strong" },
      );
    } catch {
      return error(
        503,
        "payment_store_unavailable",
        "Payment state unavailable",
      );
    }

    if (existing.value) {
      const entry = existing.value;

      if (
        entry.headerHash !== headerHash ||
        entry.requestHash !== requestHash
      ) {
        return error(
          409,
          "payment_replayed",
          "Authorization already used for another request",
        );
      }

      if (entry.state === "settled") {
        try {
          return await cachedResponse(
            options.kv,
            key,
            entry,
          );
        } catch {
          return error(
            503,
            "payment_receipt_unavailable",
            "Paid response temporarily unavailable",
          );
        }
      }

      if (
        entry.state === "uncertain" ||
        entry.state === "settling"
      ) {
        return error(
          409,
          "settlement_unknown",
          "Payment requires reconciliation; do not resubmit",
          entry.transaction,
        );
      }

      if (entry.state === "running") {
        return error(
          409,
          "payment_in_progress",
          "This payment is already processing",
        );
      }

      return error(
        409,
        "payment_replayed",
        "This payment authorization was consumed",
      );
    }

    const now = BigInt(
      Math.floor(Date.now() / 1000),
    );

    if (now <= validAfter) {
      return challenge(
        "authorization_not_yet_valid",
        options.publicUrl,
        requirements,
      );
    }

    if (now >= validBefore) {
      return challenge(
        "authorization_expired",
        options.publicUrl,
        requirements,
      );
    }

    if (
      validBefore >
        now + BigInt(MAX_TIMEOUT_SECONDS + 5)
    ) {
      return challenge(
        "authorization_window_too_long",
        options.publicUrl,
        requirements,
      );
    }

    /*
     * Step 1: Verify without spending funds.
     */
    let verification: unknown;

    try {
      verification = await facilitatorPost(
        facilitator.href,
        options.facilitatorBearerToken,
        "verify",
        paymentForFacilitator,
        requirements,
        verifyTimeoutMs,
      );
    } catch (cause) {
      if (cause instanceof FacilitatorError) {
        return error(
          cause.status,
          cause.code,
          "Payment verification unavailable",
        );
      }

      return error(
        503,
        "facilitator_unavailable",
        "Payment verification unavailable",
      );
    }

    if (
      !isObject(verification) ||
      typeof verification.isValid !== "boolean" ||
      (
        verification.payer !== undefined &&
        (
          typeof verification.payer !== "string" ||
          !eqAddress(verification.payer, auth.from)
        )
      )
    ) {
      return error(
        502,
        "facilitator_bad_response",
        "Invalid facilitator verification response",
      );
    }

    if (!verification.isValid) {
      return challenge(
        reasonForVerify(
          verification.invalidReason,
        ),
        options.publicUrl,
        requirements,
      );
    }

    /*
     * Ensure the authorization has enough time
     * remaining before committing the nonce.
     */
    if (
      Number(
        validBefore * 1000n -
          BigInt(Date.now()),
      ) < settlementReserveMs + 1000
    ) {
      return challenge(
        "authorization_expiring",
        options.publicUrl,
        requirements,
      );
    }

    /*
     * Step 2: Atomic nonce reservation.
     *
     * A failed check means another edge instance
     * has already claimed the same authorization.
     */
    const expiresAt =
      Number(validBefore) * 1000 +
      RETAIN_AFTER_EXPIRY_MS;

    const ledger: Ledger = {
      state: "running",
      headerHash,
      requestHash,
      createdAt: Date.now(),
      expiresAt,
    };

    try {
      const claim = await options.kv.atomic()
        .check({
          key,
          versionstamp: null,
        })
        .set(
          key,
          ledger,
          { expireIn: expiry(ledger) },
        )
        .commit();

      if (!claim.ok) {
        return error(
          409,
          "payment_in_progress",
          "This payment is already claimed",
        );
      }
    } catch {
      return error(
        503,
        "payment_store_unavailable",
        "Payment state unavailable",
      );
    }

    /*
     * Step 3: Execute inference.
     *
     * Keep a settlement time reserve and do not
     * expose the successful output yet.
     */
    const remainingMs =
      Number(
        validBefore * 1000n -
          BigInt(Date.now()),
      ) - settlementReserveMs;

    if (remainingMs < 1000) {
      return challenge(
        "authorization_expiring",
        options.publicUrl,
        requirements,
      );
    }

    const controller = new AbortController();

    const onClientAbort = () => {
      controller.abort();
    };

    request.signal.addEventListener(
      "abort",
      onClientAbort,
      { once: true },
    );

    const downstreamHeaders = new Headers(
      request.headers,
    );

    downstreamHeaders.delete(
      "PAYMENT-SIGNATURE",
    );

    const downstream = new Request(
      request.url,
      {
        method: "POST",
        headers: downstreamHeaders,
        body,
        signal: controller.signal,
      },
    );

    const deadlineMs = Math.min(
      inferenceTimeoutMs,
      remainingMs,
    );

    let timer:
      | ReturnType<typeof setTimeout>
      | undefined;

    let inference:
      | {
        response: Response;
        bytes: Uint8Array;
      }
      | Response;

    try {
      const work = async () => {
        const response = await options.handler(
          downstream,
        );

        if (!response.ok) {
          return response;
        }

        if (
          response.headers.get("content-encoding") &&
          response.headers.get("content-encoding") !==
            "identity"
        ) {
          void response.body?.cancel();
          throw new Error(
            "compressed_response",
          );
        }

        if (
          response.headers
            .get("content-type")
            ?.toLowerCase()
            .includes("text/event-stream")
        ) {
          void response.body?.cancel();
          throw new Error(
            "unexpected_stream",
          );
        }

        const bytes = await readLimited(
          response.body,
          MAX_RESPONSE_BYTES,
        );

        return {
          response,
          bytes,
        };
      };

      const timeout = new Promise<never>(
        (_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(
                new Error(
                  "inference_timeout",
                ),
              );
            },
            deadlineMs,
          );
        },
      );

      inference = await Promise.race([
        work(),
        timeout,
      ]);
    } catch (cause) {
      if (cause instanceof LimitError) {
        return error(
          502,
          "inference_response_too_large",
          "Inference response exceeds buffer limit",
        );
      }

      if (
        cause instanceof Error &&
        cause.message === "inference_timeout"
      ) {
        return error(
          504,
          "inference_timeout",
          "Inference exceeded payment deadline",
        );
      }

      if (
        cause instanceof Error &&
        cause.message === "compressed_response"
      ) {
        return error(
          502,
          "unsupported_response_encoding",
          "Inference response must be uncompressed",
        );
      }

      if (
        cause instanceof Error &&
        cause.message === "unexpected_stream"
      ) {
        return error(
          502,
          "unexpected_stream",
          "Inference returned an unsupported stream",
        );
      }

      return error(
        502,
        "inference_failed",
        "Inference failed before payment settlement",
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      request.signal.removeEventListener(
        "abort",
        onClientAbort,
      );
    }

    /*
     * Upstream error: do not charge.
     * The nonce remains consumed locally.
     */
    if (inference instanceof Response) {
      return new Response(
        inference.body,
        {
          status: inference.status,
          headers: cleanHeaders(
            inference.headers,
          ),
        },
      );
    }

    /*
     * Step 4: Stage the successful response
     * durably before requesting settlement.
     */
    try {
      await stageResponse(
        options.kv,
        key,
        inference.response,
        inference.bytes,
      );
    } catch {
      return error(
        503,
        "payment_store_unavailable",
        "Payment state unavailable before settlement",
      );
    }

    /*
     * Step 5: Settle on Base.
     */
    let settlement: unknown;

    try {
      settlement = await facilitatorPost(
        facilitator.href,
        options.facilitatorBearerToken,
        "settle",
        paymentForFacilitator,
        requirements,
        settleTimeoutMs,
      );
    } catch (cause) {
      try {
        await updateState(
          options.kv,
          key,
          "settling",
          "uncertain",
          {},
        );
      } catch {
        // Fail closed. Never clear the nonce.
      }

      const status =
        cause instanceof FacilitatorError
          ? cause.status
          : 503;

      return error(
        status,
        "settlement_unknown",
        "Settlement outcome unknown; reconcile before retrying",
      );
    }

    if (
      !validSettlement(
        settlement,
        auth.from,
      )
    ) {
      try {
        await updateState(
          options.kv,
          key,
          "settling",
          "uncertain",
          {},
        );
      } catch {
        // Fail closed.
      }

      return error(
        502,
        "settlement_unknown",
        "Malformed settlement response; reconcile before retrying",
      );
    }

    if (!settlement.success) {
      /*
       * A broadcast transaction may still confirm.
       * Never treat it as a terminal failure merely
       * because the facilitator could not confirm it.
       */
      if (
        settlement.errorReason ===
          "settlement_pending" ||
        settlement.transaction !== ""
      ) {
        try {
          await updateState(
            options.kv,
            key,
            "settling",
            "uncertain",
            {
              transaction:
                settlement.transaction,
            },
          );
        } catch {
          // Fail closed.
        }

        const pending = error(
          503,
          "settlement_unknown",
          "Settlement pending confirmation; reconcile before retrying",
          settlement.transaction,
        );

        pending.headers.set(
          "PAYMENT-RESPONSE",
          b64(settlement),
        );

        return pending;
      }

      /*
       * Terminal settlement failure:
       * no transaction was broadcast.
       */
      try {
        await updateState(
          options.kv,
          key,
          "settling",
          "failed",
          { settlement },
        );
      } catch {
        return error(
          503,
          "payment_store_unavailable",
          "Payment state unavailable after settlement failure",
        );
      }

      const failed = challenge(
        "settlement_failed",
        options.publicUrl,
        requirements,
      );

      failed.headers.set(
        "PAYMENT-RESPONSE",
        b64(settlement),
      );

      return failed;
    }

    /*
     * Step 6: Persist the confirmed settlement.
     */
    try {
      await updateState(
        options.kv,
        key,
        "settling",
        "settled",
        {
          settlement,
          transaction:
            settlement.transaction,
        },
      );
    } catch {
      return error(
        503,
        "payment_store_unavailable",
        "Payment succeeded but receipt persistence failed; reconcile before retrying",
      );
    }

    /*
     * Step 7: Return the original inference result
     * with the base64 SettlementResponse header.
     */
    try {
      const stored = await options.kv.get<Ledger>(
        key,
        { consistency: "strong" },
      );

      if (!stored.value) {
        throw new Error("missing_receipt");
      }

      return await cachedResponse(
        options.kv,
        key,
        stored.value,
      );
    } catch {
      return error(
        503,
        "payment_receipt_unavailable",
        "Payment succeeded but response is temporarily unavailable",
      );
    }
  };
}

/**
 * Admin-only recovery hook.
 *
 * NEVER expose this function through a public HTTP route.
 *
 * Call ONLY after independently checking the Base
 * transaction receipt and confirming that USDC's
 * Transfer and AuthorizationUsed logs match the
 * payer, nonce, recipient and amount.
 *
 * This records a confirmed fact; it does not perform
 * the on-chain verification itself.
 */
export async function recordConfirmedSettlement(
  kv: Deno.Kv,
  payer: string,
  nonce: string,
  confirmed: Settlement,
): Promise<void> {
  if (
    !ADDRESS.test(payer) ||
    !NONCE.test(nonce) ||
    !validSettlement(
      confirmed,
      payer,
    ) ||
    !confirmed.success
  ) {
    throw new Error(
      "Invalid confirmed settlement",
    );
  }

  const key: Deno.KvKey = [
    "x402-v2",
    NETWORK,
    ASSET.toLowerCase(),
    payer.toLowerCase(),
    nonce.toLowerCase(),
  ];

  const entry = await kv.get<Ledger>(
    key,
    { consistency: "strong" },
  );

  if (
    !entry.value ||
    !entry.value.response ||
    (
      entry.value.state !== "uncertain" &&
      entry.value.state !== "settling"
    )
  ) {
    throw new Error(
      "No pending settlement to reconcile",
    );
  }

  const next: Ledger = {
    ...entry.value,
    state: "settled",
    settlement: confirmed,
    transaction:
      confirmed.transaction,
  };

  const commit = await kv.atomic()
    .check(entry)
    .set(
      key,
      next,
      { expireIn: expiry(next) },
    )
    .commit();

  if (!commit.ok) {
    throw new Error(
      "Concurrent reconciliation; retry after inspecting state",
    );
  }
}

export type ReconcileOptions = {
  kv: Deno.Kv;
  rpcUrl?: string;
  limit?: number;
  now?: number;
};

export type ReconcileResult = {
  scanned: number;
  settled: number;
  expired: number;
  pending: number;
  errors: number;
};

const BASE_RPC_DEFAULT = "https://mainnet.base.org";

/** keccak256("AuthorizationUsed(address,bytes32)") */
const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

/** bytes4(keccak256("authorizationState(address,bytes32)")) */
const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";

function word(value: string): string {
  if (!ADDRESS.test(value) && !NONCE.test(value)) {
    throw new Error("Invalid address or nonce");
  }

  return value
    .toLowerCase()
    .replace(/^0x/, "")
    .padStart(64, "0");
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    void response.body?.cancel();
    throw new Error("rpc_http_" + response.status);
  }

  const doc = await response.json() as
    | { result?: unknown; error?: unknown }
    | null;

  if (
    doc === null ||
    typeof doc !== "object" ||
    doc.error !== undefined
  ) {
    throw new Error("rpc_error");
  }

  return doc.result;
}

async function authorizationUsed(
  rpcUrl: string,
  payer: string,
  nonce: string,
): Promise<boolean> {
  const result = await rpc(rpcUrl, "eth_call", [
    {
      to: ASSET,
      data: AUTHORIZATION_STATE_SELECTOR +
        word(payer) +
        word(nonce),
    },
    "latest",
  ]);

  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(result)) {
    throw new Error("rpc_bad_result");
  }

  return BigInt(result) === 1n;
}

/**
 * Best effort: find the settling transaction for an authorization
 * that is already used on-chain.
 */
async function authorizationTx(
  rpcUrl: string,
  payer: string,
  nonce: string,
): Promise<string> {
  try {
    const headHex = await rpc(rpcUrl, "eth_blockNumber", []);

    if (typeof headHex !== "string") return "";

    const head = Number(BigInt(headHex));
    const from = Math.max(0, head - 50000);

    const logs = await rpc(rpcUrl, "eth_getLogs", [
      {
        address: ASSET,
        fromBlock: "0x" + from.toString(16),
        toBlock: "latest",
        topics: [
          AUTHORIZATION_USED_TOPIC,
          "0x" + word(payer),
          "0x" + word(nonce),
        ],
      },
    ]);

    if (Array.isArray(logs) && logs.length > 0) {
      const tx = (logs[0] as { transactionHash?: unknown })
        .transactionHash;

      if (typeof tx === "string" && TX_HASH.test(tx)) {
        return tx;
      }
    }
  } catch {
    // The nonce check is authoritative; the hash is a receipt detail.
  }

  return "";
}

/**
 * Reconcile paid-but-undelivered claims.
 *
 * A handler can settle successfully and then die before writing
 * "settled". The buyer's retry then fails /verify because the
 * on-chain nonce is already used. The buffered response is still
 * in KV, so the correct resolution is to check the chain and, if
 * the nonce was used, mark the record settled and let the cached
 * response be replayed.
 *
 * Run this from a cron/queue, or call it from an admin endpoint.
 * It performs one bounded page (options.limit, default 100).
 */
export async function reconcilePendingSettlements(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const rpcUrl = options.rpcUrl ?? BASE_RPC_DEFAULT;
  const limit = options.limit ?? 100;
  const now = options.now ?? Date.now();

  const result: ReconcileResult = {
    scanned: 0,
    settled: 0,
    expired: 0,
    pending: 0,
    errors: 0,
  };

  const entries = options.kv.list<Ledger>(
    {
      prefix: [
        "x402-v2",
        NETWORK,
        ASSET.toLowerCase(),
      ],
    },
    { limit },
  );

  for await (const entry of entries) {
    const ledger = entry.value;

    if (
      !ledger ||
      (
        ledger.state !== "settling" &&
        ledger.state !== "uncertain"
      )
    ) {
      continue;
    }

    result.scanned++;

    const payer = String(entry.key[3]);
    const nonce = String(entry.key[4]);

    try {
      if (await authorizationUsed(rpcUrl, payer, nonce)) {
        const transaction = await authorizationTx(
          rpcUrl,
          payer,
          nonce,
        );

        const settlement: Settlement = {
          success: true,
          transaction,
          network: NETWORK,
          payer,
        };

        const next: Ledger = {
          ...ledger,
          state: "settled",
          settlement,
          transaction,
        };

        const commit = await options.kv.atomic()
          .check(entry)
          .set(
            entry.key,
            next,
            {
              expireIn: Math.max(
                RETAIN_AFTER_EXPIRY_MS,
                expiry(next),
              ),
            },
          )
          .commit();

        if (commit.ok) {
          result.settled++;
        } else {
          result.pending++;
        }

        continue;
      }

      const validBefore =
        ledger.expiresAt - RETAIN_AFTER_EXPIRY_MS;

      if (now >= validBefore) {
        const commit = await options.kv.atomic()
          .check(entry)
          .delete(entry.key)
          .commit();

        if (commit.ok) {
          result.expired++;
        } else {
          result.pending++;
        }
      } else {
        result.pending++;
      }
    } catch {
      result.errors++;
    }
  }

  return result;
}
