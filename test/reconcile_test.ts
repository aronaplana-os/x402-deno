import { reconcilePendingSettlements } from "../src/x402.ts";

const NETWORK = "eip155:8453";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYER = "0x1111111111111111111111111111111111111111";
const NONCE = "0x" + "cd".repeat(32);
const TX = "0x" + "ab".repeat(32);

function ledgerKey(payer = PAYER, nonce = NONCE): Deno.KvKey {
  return ["x402-v2", NETWORK, ASSET.toLowerCase(), payer, nonce];
}

async function seed(
  kv: Deno.Kv,
  state: "settling" | "uncertain",
  expiresAt: number,
  payer = PAYER,
  nonce = NONCE,
): Promise<Deno.KvKey> {
  const key = ledgerKey(payer, nonce);

  await kv.set(key, {
    state,
    headerHash: "header",
    requestHash: "request",
    expiresAt,
    createdAt: Date.now(),
    response: {
      status: 200,
      headers: [["content-type", "application/json"]],
      chunks: 1,
    },
  }, { expireIn: Math.max(60_000, expiresAt - Date.now()) });

  await kv.set(
    [...key, "body", 0],
    new TextEncoder().encode('{"ok":true}'),
    { expireIn: Math.max(60_000, expiresAt - Date.now()) },
  );

  return key;
}

function mockRpc(used: boolean, tx = TX): void {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
    };

    if (body.method === "eth_call") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: "0x" + "0".repeat(63) + (used ? "1" : "0"),
      });
    }

    if (body.method === "eth_blockNumber") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x100" });
    }

    if (body.method === "eth_getLogs") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: used ? [{ transactionHash: tx }] : [],
      });
    }

    throw new Error("unexpected rpc method");
  }) as typeof fetch;
}

Deno.test("reconcile marks an on-chain-used settling record as settled", async () => {
  const kv = await Deno.openKv(":memory:");
  const realFetch = globalThis.fetch;

  try {
    const key = await seed(kv, "settling", Date.now() + 2 * 60 * 60 * 1000);
    mockRpc(true);

    const result = await reconcilePendingSettlements({
      kv,
      rpcUrl: "https://rpc.test",
    });

    if (result.settled !== 1 || result.scanned !== 1) {
      throw new Error("unexpected result " + JSON.stringify(result));
    }

    const entry = await kv.get<Record<string, unknown>>(key);
    if (entry.value?.state !== "settled") {
      throw new Error("state not settled");
    }

    const settlement = entry.value.settlement as
      | { success?: boolean; transaction?: string }
      | undefined;

    if (settlement?.success !== true || settlement.transaction !== TX) {
      throw new Error("bad settlement " + JSON.stringify(settlement));
    }
  } finally {
    globalThis.fetch = realFetch;
    kv.close();
  }
});

Deno.test("reconcile deletes an unused record after the authorization expires", async () => {
  const kv = await Deno.openKv(":memory:");
  const realFetch = globalThis.fetch;

  try {
    const key = await seed(
      kv,
      "settling",
      Date.now() - 60 * 60 * 1000,
    );
    mockRpc(false);

    const result = await reconcilePendingSettlements({
      kv,
      rpcUrl: "https://rpc.test",
    });

    if (result.expired !== 1) {
      throw new Error("unexpected result " + JSON.stringify(result));
    }

    const entry = await kv.get(key);
    if (entry.value !== null) {
      throw new Error("expired record was not deleted");
    }
  } finally {
    globalThis.fetch = realFetch;
    kv.close();
  }
});
