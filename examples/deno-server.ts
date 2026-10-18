import { createX402Middleware } from "../src/x402.ts";

// Import your existing inference handler.
// It must return a Response and support request.signal.
import { existingFetchHandler } from "./inference.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const kv = await Deno.openKv();

const paidChatCompletions = createX402Middleware({
  kv,

  payTo: requiredEnv("X402_PAY_TO"),
  publicUrl: requiredEnv("X402_PUBLIC_URL"),

  facilitatorBaseUrl:
    requiredEnv("X402_FACILITATOR_URL"),

  facilitatorBearerToken:
    Deno.env.get("X402_FACILITATOR_TOKEN"),

  // Include any additional identity or tenant headers
  // that can affect the inference response.
  boundHeaderNames: [
    "authorization",
    "cookie",
    "openai-organization",
    "openai-project",
    "x-tenant-id",
  ],

  handler: existingFetchHandler,
});

Deno.serve(async (request) => {
  const url = new URL(request.url);

  // Handle browser CORS preflight in your existing CORS
  // layer before invoking payment middleware.

  if (url.pathname === "/v1/chat/completions") {
    return await paidChatCompletions(request);
  }

  // All other routes remain unchanged.
  return await existingFetchHandler(request);
});
