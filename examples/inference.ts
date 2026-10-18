/**
 * Placeholder for your own inference handler.
 *
 * It must return a Response and honour request.signal. Replace this file
 * with your real handler; the middleware buffers the Response body and
 * settles payment before releasing it.
 */
export async function existingFetchHandler(
  request: Request,
): Promise<Response> {
  const input = await request.json().catch(() => null);

  return Response.json({
    id: "chatcmpl-placeholder",
    object: "chat.completion",
    model: input?.model ?? "unknown",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Replace this handler." },
        finish_reason: "stop",
      },
    ],
  });
}
