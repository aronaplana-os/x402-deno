import { createX402Middleware } from "../src/x402.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertExists<T>(value: T | null | undefined): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error("Expected value to exist");
  }
}

const PAY_TO = "0x265A2CD6Bf17fE20FcE68Db5473EA29a1Ac389d1";
const PAYER = "0x1111111111111111111111111111111111111111";
const PUBLIC_URL = "https://api.example.com/v1/chat/completions";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function middleware(handler?: (request: Request) => Promise<Response>) {
  return createX402Middleware({
    kv: null as unknown as Deno.Kv,
    payTo: PAY_TO,
    publicUrl: PUBLIC_URL,
    facilitatorBaseUrl: "https://facilitator.example.com",
    handler: handler ?? (async () => Response.json({ ok: true })),
  });
}

function paidRequest(payload?: unknown, path = "/v1/chat/completions") {
  const headers = new Headers({
    "content-type": "application/json",
  });

  if (payload !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    headers.set("PAYMENT-SIGNATURE", btoa(binary));
  }

  return new Request(`https://api.example.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "example-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
}

function paymentPayload(nonce = `0x${"cd".repeat(32)}`) {
  const now = Math.floor(Date.now() / 1000);

  return {
    x402Version: 2,
    resource: { url: PUBLIC_URL },
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "10000",
        validAfter: String(now - 60),
        validBefore: String(now + 60),
        nonce,
      },
    },
  };
}

function decode(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

Deno.test("unpaid request returns a v2 challenge", async () => {
  const response = await middleware()(paidRequest());

  assertEquals(response.status, 402);
  const header = response.headers.get("PAYMENT-REQUIRED");
  assertExists(header);

  const required = decode(header);
  assertEquals(required.x402Version, 2);
  assertEquals(required.accepts[0].scheme, "exact");
  assertEquals(required.accepts[0].network, "eip155:8453");
  assertEquals(required.accepts[0].asset, ASSET);
  assertEquals(required.accepts[0].amount, "10000");
  assertEquals(required.accepts[0].payTo, PAY_TO);
  assertExists(required.extensions.bazaar.info.input);
});

Deno.test("routing and payload errors are rejected", async () => {
  const paid = middleware();

  assertEquals((await paid(paidRequest(undefined, "/other"))).status, 404);
  assertEquals(
    (await paid(new Request(PUBLIC_URL, { method: "GET" }))).status,
    405,
  );

  const malformed = new Request(PUBLIC_URL, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": "not-base64" },
    body: "{}",
  });
  assertEquals((await paid(malformed)).status, 400);

  const mismatch = await paid(
    paidRequest({ ...paymentPayload(), accepted: { ...paymentPayload().accepted, amount: "1" } }),
  );
  assertEquals(mismatch.status, 402);
  const required = decode(mismatch.headers.get("PAYMENT-REQUIRED")!);
  assertEquals(required.error, "payment_requirements_mismatch");
});

Deno.test("happy path settles once and replays the cached response", async () => {
  const { kv, close } = await openMemoryKv();
  const calls = { verify: 0, settle: 0, handler: 0 };

  const paid = createX402Middleware({
    kv,
    payTo: PAY_TO,
    publicUrl: PUBLIC_URL,
    facilitatorBaseUrl: "https://facilitator.example.com",
    handler: () => {
      calls.handler++;
      return Promise.resolve(
        Response.json({ object: "chat.completion", paid: true }),
      );
    },
  });

  const realFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith("/verify")) {
      calls.verify++;
      return Promise.resolve(Response.json({ isValid: true, payer: PAYER }));
    }

    if (url.endsWith("/settle")) {
      calls.settle++;
      return Promise.resolve(Response.json({
        success: true,
        transaction: `0x${"ab".repeat(32)}`,
        network: "eip155:8453",
        payer: PAYER,
      }));
    }

    return realFetch(input);
  }) as typeof fetch;

  try {
    const payload = paymentPayload();
    const first = await paid(paidRequest(payload));

    assertEquals(first.status, 200);
    const body = await first.json() as { object: string; paid: boolean };
    assertEquals(body.object, "chat.completion");
    assertEquals(body.paid, true);
    assertExists(first.headers.get("PAYMENT-RESPONSE"));

    const second = await paid(paidRequest(payload));
    assertEquals(second.status, 200);
    assertEquals(calls.handler, 1);
    assertEquals(calls.verify, 1);
    assertEquals(calls.settle, 1);
  } finally {
    globalThis.fetch = realFetch;
    await close();
  }
});

async function openMemoryKv() {
  const kv = await Deno.openKv(":memory:");
  return { kv, close: () => kv.close() };
}
