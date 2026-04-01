const { ExposedPromise } = require("./expose-promise");

/**
 * Symbol key for the originating ExposedPromise on every resolved wrapper object.
 * Exported so callers can access it without guessing.
 */
const TRANSACTION = Symbol("transaction");

/**
 * WorkerWrapper
 *
 * Wraps a Web Worker with:
 *   - Async initialization via static WorkerWrapper.create()
 *   - Consolidated init error handling (3 failure surfaces)
 *   - UUID-keyed ExposedPromise transaction map for awaitable round-trips
 *
 * Worker-side protocol:
 *   Init:     worker posts { type: "ready" } when ready to receive messages
 *   Response: worker posts { id, result } on success
 *             worker posts { id, error }  on failure (error should be serializable)
 *
 * Usage:
 *   const worker = await WorkerWrapper.create("./my-worker.js");
 *   const result = await worker.send("doThing", { payload: 123 });
 */
class WorkerWrapper {
  /**
   * @param {string | URL} url
   * @param {WorkerOptions} [options]
   */
  constructor(url, options) {
    this.transactions = new Map(); // uuid -> ExposedPromise
    this._ready = new ExposedPromise();

    // --- Init error surface 1: synchronous constructor throw ---
    // (invalid URL, security error, unsupported options, etc.)
    try {
      this._worker = new Worker(url, options);
    } catch (err) {
      this._ready.reject(err);
      return;
    }

    // --- Init error surface 2: worker runtime / load error ---
    this._worker.onerror = (event) => {
      if (!this._ready.settled) {
        this._ready.reject(event);
        return;
      }
      // Post-init error: reject all pending transactions
      this._rejectAll(event);
    };

    // --- Init error surface 3: message deserialization error ---
    this._worker.onmessageerror = (event) => {
      if (!this._ready.settled) {
        this._ready.reject(event);
        return;
      }
      // Post-init: a specific transaction's response was undeserializable;
      // we can't know which one, so reject all pending transactions.
      this._rejectAll(event);
    };

    this._worker.onmessage = (event) => {
      if (!event.data || typeof event.data !== "object") return;
      const { type, id, result, error } = event.data;

      // Handshake
      if (type === "ready") {
        this._ready.resolve();
        return;
      }

      // Round-trip resolution
      if (id && this.transactions.has(id)) {
        const ep = this.transactions.get(id);
        this.transactions.delete(id);
        ep.resolve({ value: result, error, [TRANSACTION]: ep });
      }
    };
  }

  /**
   * Async factory — waits for the worker's "ready" handshake before returning.
   * This is the intended public constructor.
   *
   * @param {string | URL} url
   * @param {WorkerOptions} [options]
   * @returns {Promise<WorkerWrapper>}
   */
  static async create(url, options) {
    const wrapper = new WorkerWrapper(url, options);
    await wrapper._ready;
    return wrapper;
  }

  /**
   * Send a message to the worker and return an ExposedPromise that resolves
   * to { value, error, [TRANSACTION] } when the worker posts back with the matching id.
   * Always resolves — check the `error` field rather than catching.
   *
   * @param {string} type
   * @param {*} [data]
   * @param {Transferable[]} [transfer]  — optional transferables (e.g. ArrayBuffers)
   * @returns {ExposedPromise<{ value: *, error: *, [TRANSACTION]: ExposedPromise }>}
   */
  send(type, data, transfer) {
    const id = crypto.randomUUID();
    const ep = new ExposedPromise();
    this.transactions.set(id, ep);
    this._worker.postMessage({ type, id, ...data }, transfer ?? []);
    return ep;
  }

  /**
   * Terminate the worker and reject any transactions still pending.
   */
  terminate() {
    this._worker.terminate();
    this._rejectAll(new Error("Worker terminated"));
  }

  // -------------------------------------------------------------------------

  _rejectAll(reason) {
    for (const ep of this.transactions.values()) {
      ep.reject(reason);
    }
    this.transactions.clear();
  }
}

module.exports = { WorkerWrapper, TRANSACTION };
