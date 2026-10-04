export class BodyTooLargeError extends Error {}

/** Count actual bytes before buffering; callers own header checks and error/UTF-8 policy. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array>, maxBytes: number,
  { ignoreCancelErrors = false }: { ignoreCancelErrors?: boolean } = {},
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Preserve each route's handling of a rejecting underlying cancel hook.
        const cancelled = reader.cancel("request too large");
        if (ignoreCancelErrors) await cancelled.catch(() => {});
        else await cancelled;
        throw new BodyTooLargeError("request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
