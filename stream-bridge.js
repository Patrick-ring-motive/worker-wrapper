const { WorkerWrapper } = require("./index");

/**
 * StreamBridge
 *
 * Composes a WorkerWrapper and layers a streaming protocol on top, so a
 * ReadableStream inside the worker can be consumed as a ReadableStream
 * on the main thread — chunks flow concurrently as the worker produces them.
 *
 * How it works:
 *   1. The bridge intercepts the worker's `onmessage` handler.
 *   2. Stream-protocol messages (stream-chunk / stream-end / stream-error)
 *      are routed to the matching ReadableStreamDefaultController.
 *   3. Everything else falls through to WorkerWrapper's normal handler
 *      (ready handshake, request/response transactions, etc.).
 *
 * Usage:
 *   const bridge = await StreamBridge.create("./stream-worker.js");
 *
 *   const readable = bridge.requestStream({ url: "/large-file.bin" });
 *   const reader   = readable.getReader();
 *
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     process(value);          // Uint8Array chunks, as they arrive
 *   }
 *
 *   bridge.terminate();
 */
class StreamBridge {
  /**
   * @param {WorkerWrapper} wrapper
   */
  constructor(wrapper) {
    /** @type {WorkerWrapper} */
    this._wrapper = wrapper;

    /**
     * Active streams: streamId → ReadableStreamDefaultController
     * @type {Map<string, ReadableStreamDefaultController>}
     */
    this._streams = new Map();

    this._hookMessages();
  }

  /**
   * Async factory — creates the underlying WorkerWrapper and waits for the
   * worker's "ready" handshake before returning.
   *
   * @param {string | URL} url
   * @param {WorkerOptions} [options]
   * @returns {Promise<StreamBridge>}
   */
  static async create(url, options) {
    const wrapper = await WorkerWrapper.create(url, options);
    return new StreamBridge(wrapper);
  }

  // ---- Stream API ---------------------------------------------------------

  /**
   * Ask the worker to begin streaming and return a ReadableStream that
   * yields chunks as the worker posts them.
   *
   * `config` is spread into the message sent to the worker, so its shape
   * depends on the worker script (e.g. `{ url, fetchOptions }` for the
   * bundled stream-worker).
   *
   * The returned stream supports cancellation — calling `reader.cancel()`
   * or `stream.cancel()` sends a "stream-cancel" message to the worker.
   *
   * @param {object} [config]  — worker-specific parameters
   * @returns {ReadableStream}
   */
  requestStream(config = {}) {
    const streamId = crypto.randomUUID();

    const stream = new ReadableStream({
      start: (controller) => {
        this._streams.set(streamId, controller);
      },
      cancel: () => {
        this._streams.delete(streamId);
        this._wrapper._worker.postMessage({
          type: "stream-cancel",
          streamId,
        });
      },
    });

    // Tell the worker to start producing chunks
    this._wrapper._worker.postMessage({
      type: "stream-start",
      streamId,
      ...config,
    });

    return stream;
  }

  // ---- Delegate non-stream RPC to WorkerWrapper ---------------------------

  /**
   * Standard request/response round-trip (WorkerWrapper.send).
   */
  send(type, data, transfer) {
    return this._wrapper.send(type, data, transfer);
  }

  /**
   * Terminate the worker, error every active stream, and reject pending
   * transactions.
   */
  terminate() {
    for (const controller of this._streams.values()) {
      try {
        controller.error(new Error("Worker terminated"));
      } catch {
        /* stream may already be closed */
      }
    }
    this._streams.clear();
    this._wrapper.terminate();
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * Replace the worker's onmessage with a handler that intercepts
   * stream-protocol messages and forwards everything else to
   * WorkerWrapper's original handler.
   */
  _hookMessages() {
    const worker = this._wrapper._worker;
    const origHandler = worker.onmessage;

    worker.onmessage = (event) => {
      if (!event.data || typeof event.data !== "object") return;

      switch (event.data.type) {
        case "stream-chunk":
        case "stream-end":
        case "stream-error":
          this._onStreamMessage(event.data);
          return;
      }

      // Not a stream message — let WorkerWrapper handle it
      origHandler.call(worker, event);
    };
  }

  /**
   * Route an incoming stream message to the correct ReadableStream controller.
   */
  _onStreamMessage({ type, streamId, chunk, error }) {
    const controller = this._streams.get(streamId);
    if (!controller) return;

    switch (type) {
      case "stream-chunk":
        try {
          controller.enqueue(chunk);
        } catch {
          /* stream already closed/errored by consumer */
        }
        break;

      case "stream-end":
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        this._streams.delete(streamId);
        break;

      case "stream-error":
        try {
          controller.error(new Error(error));
        } catch {
          /* already errored */
        }
        this._streams.delete(streamId);
        break;
    }
  }
}

module.exports = { StreamBridge };
