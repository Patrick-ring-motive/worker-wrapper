/**
 * stream-worker.js
 *
 * Example worker that streams fetch responses chunk-by-chunk to the main thread.
 *
 * Protocol (stream-specific messages, layered on top of WorkerWrapper's base protocol):
 *
 *   Main → Worker:
 *     { type: "stream-start", streamId, url, fetchOptions? }   — begin streaming
 *     { type: "stream-cancel", streamId }                      — abort in-flight stream
 *
 *   Worker → Main:
 *     { type: "stream-chunk", streamId, chunk: Uint8Array }    — one chunk (transferred)
 *     { type: "stream-end",   streamId }                       — stream finished
 *     { type: "stream-error", streamId, error: string }        — stream failed
 *
 * Replace or extend the "stream-start" handler to stream from any source,
 * not just fetch — the main-thread StreamBridge doesn't care where chunks
 * come from.
 */

const activeStreams = new Map(); // streamId → AbortController

/**
 * Read a ReadableStream to completion, posting each chunk to the main thread.
 *
 * @param {string} streamId   — correlating id for this stream
 * @param {ReadableStream} readable — the source stream
 * @param {AbortSignal} signal — cancellation signal
 */
async function pipeToParent(streamId, readable, signal) {
  const reader = readable.getReader();
  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      // Transfer the underlying ArrayBuffer for zero-copy when possible
      const transfer = value?.buffer ? [value.buffer] : [];
      postMessage({ type: "stream-chunk", streamId, chunk: value }, transfer);
    }

    if (!signal.aborted) {
      postMessage({ type: "stream-end", streamId });
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      postMessage({ type: "stream-error", streamId, error: err.message });
    }
  } finally {
    reader.releaseLock();
    activeStreams.delete(streamId);
  }
}

// --- Message handler -------------------------------------------------------

onmessage = async (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  const { type, streamId } = data;

  if (type === "stream-start") {
    const { url, fetchOptions } = data;
    const ac = new AbortController();
    activeStreams.set(streamId, ac);

    try {
      const response = await fetch(url, { ...fetchOptions, signal: ac.signal });

      if (!response.ok) {
        postMessage({
          type: "stream-error",
          streamId,
          error: `HTTP ${response.status} ${response.statusText}`,
        });
        activeStreams.delete(streamId);
        return;
      }

      await pipeToParent(streamId, response.body, ac.signal);
    } catch (err) {
      if (err.name !== "AbortError") {
        postMessage({ type: "stream-error", streamId, error: err.message });
      }
      activeStreams.delete(streamId);
    }
  }

  if (type === "stream-cancel") {
    const ac = activeStreams.get(streamId);
    if (ac) {
      ac.abort();
      activeStreams.delete(streamId);
    }
  }
};

// --- Ready handshake (WorkerWrapper protocol) ------------------------------
postMessage({ type: "ready" });
