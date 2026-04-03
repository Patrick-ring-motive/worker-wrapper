const {
  describe,
  it,
  beforeEach
} = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Helpers: mock Worker + minimal ReadableStream polyfill for Node < 18
// ---------------------------------------------------------------------------

/** Captures postMessage calls and exposes handler hooks for simulation. */
function createMockWorkerClass() {
  let instances = [];

  class MockWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.posted = [];
      this.terminated = false;
      instances.push(this);
    }
    postMessage(data, transfer) {
      this.posted.push({
        data,
        transfer
      });
    }
    terminate() {
      this.terminated = true;
    }
  }

  return {
    MockWorker,
    get lastInstance() {
      return instances.at(-1);
    },
    reset() {
      instances = [];
    },
  };
}

/** Reload modules so each test gets a fresh copy bound to the current Worker mock. */
function loadModules() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.endsWith("/index.js") ||
      key.endsWith("/expose-promise.js") ||
      key.endsWith("/stream-bridge.js")
    ) {
      delete require.cache[key];
    }
  }
  const {
    StreamBridge
  } = require("./stream-bridge");
  const {
    WorkerWrapper,
    TRANSACTION
  } = require("./index");
  return {
    StreamBridge,
    WorkerWrapper,
    TRANSACTION
  };
}

/** Helper: create a StreamBridge with a ready-handshake already done. */
async function createReadyBridge(mockCtx) {
  const {
    StreamBridge
  } = loadModules();
  const promise = StreamBridge.create("test-stream.js");
  const worker = mockCtx.lastInstance;
  // Simulate the worker posting ready
  worker.onmessage({
    data: {
      type: "ready"
    }
  });
  return {
    bridge: await promise,
    worker
  };
}

/** Collect a ReadableStream into an array of chunks. */
async function collectStream(readable) {
  const reader = readable.getReader();
  const chunks = [];
  while (true) {
    const {
      done,
      value
    } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamBridge", () => {
  let mockCtx;

  beforeEach(() => {
    mockCtx = createMockWorkerClass();
    globalThis.Worker = mockCtx.MockWorker;
  });

  // -- creation -------------------------------------------------------------

  it("create() resolves after the worker ready handshake", async () => {
    const {
      bridge
    } = await createReadyBridge(mockCtx);
    assert.ok(bridge);
    assert.ok(bridge._wrapper);
  });

  // -- requestStream --------------------------------------------------------

  it("requestStream() posts a stream-start message with config", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    bridge.requestStream({
      url: "https://example.com/data"
    });

    const msg = worker.posted.at(-1).data;
    assert.equal(msg.type, "stream-start");
    assert.equal(msg.url, "https://example.com/data");
    assert.ok(typeof msg.streamId === "string" && msg.streamId.length > 0);
  });

  it("chunks posted by worker are enqueued into the ReadableStream", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const readable = bridge.requestStream({
      url: "/file"
    });

    // Find the streamId from the posted message
    const {
      streamId
    } = worker.posted.at(-1).data;

    // Simulate worker sending two chunks then ending the stream
    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId,
        chunk: new Uint8Array([1, 2, 3]),
      },
    });
    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId,
        chunk: new Uint8Array([4, 5]),
      },
    });
    worker.onmessage({
      data: {
        type: "stream-end",
        streamId
      }
    });

    const chunks = await collectStream(readable);

    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[0], new Uint8Array([1, 2, 3]));
    assert.deepEqual(chunks[1], new Uint8Array([4, 5]));
  });

  it("stream-end closes the ReadableStream", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const readable = bridge.requestStream({});
    const {
      streamId
    } = worker.posted.at(-1).data;

    worker.onmessage({
      data: {
        type: "stream-end",
        streamId
      }
    });

    const chunks = await collectStream(readable);
    assert.deepEqual(chunks, []);
  });

  it("stream-error errors the ReadableStream", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const readable = bridge.requestStream({});
    const {
      streamId
    } = worker.posted.at(-1).data;

    worker.onmessage({
      data: {
        type: "stream-error",
        streamId,
        error: "boom"
      },
    });

    const reader = readable.getReader();
    await assert.rejects(reader.read(), {
      message: "boom"
    });
  });

  it("multiple concurrent streams are independent", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const streamA = bridge.requestStream({
      url: "/a"
    });
    const idA = worker.posted.at(-1).data.streamId;

    const streamB = bridge.requestStream({
      url: "/b"
    });
    const idB = worker.posted.at(-1).data.streamId;

    assert.notEqual(idA, idB);

    // Interleave chunks from both streams
    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId: idA,
        chunk: "a1"
      },
    });
    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId: idB,
        chunk: "b1"
      },
    });
    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId: idA,
        chunk: "a2"
      },
    });
    worker.onmessage({
      data: {
        type: "stream-end",
        streamId: idA
      }
    });
    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId: idB,
        chunk: "b2"
      },
    });
    worker.onmessage({
      data: {
        type: "stream-end",
        streamId: idB
      }
    });

    const chunksA = await collectStream(streamA);
    const chunksB = await collectStream(streamB);

    assert.deepEqual(chunksA, ["a1", "a2"]);
    assert.deepEqual(chunksB, ["b1", "b2"]);
  });

  // -- cancellation ---------------------------------------------------------

  it("cancelling the stream sends stream-cancel to the worker", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const readable = bridge.requestStream({});
    const {
      streamId
    } = worker.posted.at(-1).data;

    await readable.cancel();

    const cancelMsg = worker.posted.at(-1).data;
    assert.equal(cancelMsg.type, "stream-cancel");
    assert.equal(cancelMsg.streamId, streamId);

    // Stream should be removed from active map
    assert.equal(bridge._streams.size, 0);
  });

  // -- terminate ------------------------------------------------------------

  it("terminate() errors all active streams and terminates the worker", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const streamA = bridge.requestStream({
      url: "/a"
    });
    const streamB = bridge.requestStream({
      url: "/b"
    });

    bridge.terminate();

    assert.ok(worker.terminated);
    assert.equal(bridge._streams.size, 0);

    // Both streams should be errored
    const readerA = streamA.getReader();
    await assert.rejects(readerA.read(), {
      message: "Worker terminated"
    });

    const readerB = streamB.getReader();
    await assert.rejects(readerB.read(), {
      message: "Worker terminated"
    });
  });

  // -- fallthrough to WorkerWrapper -----------------------------------------

  it("non-stream messages still reach WorkerWrapper (send/receive)", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);
    const {
      TRANSACTION
    } = loadModules();

    const ep = bridge.send("ping", {
      ts: 1
    });

    const sentMsg = worker.posted.at(-1).data;
    assert.equal(sentMsg.type, "ping");
    const {
      id
    } = sentMsg;

    // Simulate worker reply through the hooked onmessage
    worker.onmessage({
      data: {
        id,
        result: "pong"
      }
    });

    const {
      value
    } = await ep;
    assert.equal(value, "pong");
  });

  // -- edge cases -----------------------------------------------------------

  it("ignores stream messages for unknown streamIds", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    // Should not throw
    assert.doesNotThrow(() => {
      worker.onmessage({
        data: {
          type: "stream-chunk",
          streamId: "nope",
          chunk: "x"
        },
      });
      worker.onmessage({
        data: {
          type: "stream-end",
          streamId: "nope"
        },
      });
      worker.onmessage({
        data: {
          type: "stream-error",
          streamId: "nope",
          error: "x"
        },
      });
    });
  });

  it("chunks after stream-end are silently ignored", async () => {
    const {
      bridge,
      worker
    } = await createReadyBridge(mockCtx);

    const readable = bridge.requestStream({});
    const {
      streamId
    } = worker.posted.at(-1).data;

    worker.onmessage({
      data: {
        type: "stream-chunk",
        streamId,
        chunk: "ok"
      },
    });
    worker.onmessage({
      data: {
        type: "stream-end",
        streamId
      }
    });

    // Late chunk for same streamId — should not throw
    assert.doesNotThrow(() => {
      worker.onmessage({
        data: {
          type: "stream-chunk",
          streamId,
          chunk: "late"
        },
      });
    });

    const chunks = await collectStream(readable);
    assert.deepEqual(chunks, ["ok"]);
  });
});
