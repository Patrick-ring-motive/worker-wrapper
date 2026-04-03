const {
  describe,
  it,
  beforeEach,
  mock
} = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// ExposedPromise tests
// ---------------------------------------------------------------------------
const {
  ExposedPromise
} = require("./expose-promise");

describe("ExposedPromise", () => {
  it("starts in pending state", () => {
    const ep = new ExposedPromise();
    assert.equal(ep.status, "pending");
    assert.equal(ep.value, undefined);
    assert.equal(ep.settled, false);
  });

  it("resolves and updates status/value after microtask", async () => {
    const ep = new ExposedPromise();
    ep.resolve(42);
    // status updates one tick later
    await ep;
    assert.equal(ep.status, "fulfilled");
    assert.equal(ep.value, 42);
    assert.equal(ep.settled, true);
  });

  it("rejects and updates status/value after microtask", async () => {
    const ep = new ExposedPromise();
    const reason = new Error("boom");
    ep.reject(reason);
    await ep.catch(() => {}); // consume rejection
    assert.equal(ep.status, "rejected");
    assert.equal(ep.value, reason);
    assert.equal(ep.settled, true);
  });

  it("stores executor and runs it immediately", async () => {
    const ep = new ExposedPromise((resolve) => resolve("from executor"));
    const val = await ep;
    assert.equal(val, "from executor");
    assert.equal(typeof ep.executor, "function");
  });

  it("executor is null when omitted", () => {
    const ep = new ExposedPromise();
    assert.equal(ep.executor, null);
  });

  it("catches synchronous executor throw", async () => {
    const ep = new ExposedPromise(() => {
      throw new Error("sync throw");
    });
    await assert.rejects(ep.promise, {
      message: "sync throw"
    });
    assert.equal(ep.status, "rejected");
  });

  it(".then() delegates to the inner promise", async () => {
    const ep = new ExposedPromise();
    const chained = ep.then((v) => v + 1);
    ep.resolve(10);
    assert.equal(await chained, 11);
    // returns a plain Promise, not ExposedPromise
    assert.ok(!(chained instanceof ExposedPromise));
  });

  it(".catch() delegates to the inner promise", async () => {
    const ep = new ExposedPromise();
    const caught = ep.catch((r) => r.message);
    ep.reject(new Error("caught"));
    assert.equal(await caught, "caught");
  });

  it(".finally() delegates to the inner promise", async () => {
    let called = false;
    const ep = new ExposedPromise();
    const fin = ep.finally(() => {
      called = true;
    });
    ep.resolve("done");
    await fin;
    assert.ok(called);
  });
});

// ---------------------------------------------------------------------------
// WorkerWrapper tests — with a mock Worker global
// ---------------------------------------------------------------------------

/**
 * Minimal mock Worker constructor.
 * Captures handlers set by WorkerWrapper so tests can simulate messages.
 */
function createMockWorkerClass() {
  let instances = [];

  class MockWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.posted = []; // captures postMessage calls
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
      return instances[instances.length - 1];
    },
    reset() {
      instances = [];
    },
  };
}

describe("WorkerWrapper", () => {
  let mockWorkerCtx;

  beforeEach(() => {
    mockWorkerCtx = createMockWorkerClass();
    globalThis.Worker = mockWorkerCtx.MockWorker;
  });

  // Helper: require fresh module to pick up the global Worker mock
  function loadModule() {
    // Clear module cache so each test gets a fresh import with current global
    delete require.cache[require.resolve("./index")];
    delete require.cache[require.resolve("./expose-promise")];
    return require("./index");
  }

  // -- create / init --------------------------------------------------------

  it("create() resolves after worker posts ready", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");

    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });

    const wrapper = await createPromise;
    assert.ok(wrapper instanceof WorkerWrapper);
    assert.ok(wrapper._ready.settled);
  });

  it("create() rejects if Worker constructor throws", async () => {
    globalThis.Worker = function() {
      throw new Error("bad url");
    };
    const {
      WorkerWrapper
    } = loadModule();
    await assert.rejects(WorkerWrapper.create("bad://url"), {
      message: "bad url"
    });
  });

  it("create() rejects on onerror before ready", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("fail.js");

    const worker = mockWorkerCtx.lastInstance;
    const errEvent = {
      type: "error",
      message: "load failed"
    };
    worker.onerror(errEvent);

    await assert.rejects(createPromise, (err) => {
      assert.equal(err, errEvent);
      return true;
    });
  });

  it("create() rejects on onmessageerror before ready", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("fail.js");

    const worker = mockWorkerCtx.lastInstance;
    const errEvent = {
      type: "messageerror"
    };
    worker.onmessageerror(errEvent);

    await assert.rejects(createPromise, (err) => {
      assert.equal(err, errEvent);
      return true;
    });
  });

  // -- send / round-trip ----------------------------------------------------

  it("send() posts a message with type, id, and spread data", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    wrapper.send("doThing", {
      payload: 99
    });

    assert.equal(worker.posted.length, 1);
    const msg = worker.posted[0].data;
    assert.equal(msg.type, "doThing");
    assert.equal(msg.payload, 99);
    assert.ok(typeof msg.id === "string" && msg.id.length > 0);
  });

  it("send() returns an ExposedPromise that resolves on worker reply", async () => {
    const {
      WorkerWrapper,
      TRANSACTION
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    const ep = wrapper.send("compute", {
      n: 5
    });
    // Verify it's an ExposedPromise (duck-type check — loadModule() resets the cache)
    assert.ok(typeof ep.resolve === "function");
    assert.ok(typeof ep.reject === "function");
    assert.ok(ep.promise instanceof Promise);

    // Simulate worker responding with the matching id
    const id = worker.posted[0].data.id;
    worker.onmessage({
      data: {
        id,
        result: 120
      }
    });

    const response = await ep;
    assert.equal(response.value, 120);
    assert.equal(response.error, undefined);
    assert.equal(response[TRANSACTION], ep);
  });

  it("send() forwards error field from worker", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    const ep = wrapper.send("fail");
    const id = worker.posted[0].data.id;
    worker.onmessage({
      data: {
        id,
        error: "something broke"
      }
    });

    const response = await ep;
    assert.equal(response.error, "something broke");
    assert.equal(response.value, undefined);
  });

  it("send() passes transferables to postMessage", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    const buf = new ArrayBuffer(8);
    wrapper.send("upload", {
      size: 8
    }, [buf]);

    assert.deepEqual(worker.posted[0].transfer, [buf]);
  });

  // -- terminate ------------------------------------------------------------

  it("terminate() terminates the worker and rejects pending transactions", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    const ep = wrapper.send("slow");
    wrapper.terminate();

    assert.ok(worker.terminated);
    await assert.rejects(ep.promise, {
      message: "Worker terminated"
    });
    assert.equal(wrapper.transactions.size, 0);
  });

  // -- post-init errors -----------------------------------------------------

  it("onerror after init rejects all pending transactions", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    const ep1 = wrapper.send("a");
    const ep2 = wrapper.send("b");

    const errEvent = {
      message: "runtime error"
    };
    worker.onerror(errEvent);

    await assert.rejects(ep1.promise, (e) => e === errEvent);
    await assert.rejects(ep2.promise, (e) => e === errEvent);
    assert.equal(wrapper.transactions.size, 0);
  });

  it("onmessageerror after init rejects all pending transactions", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    const ep = wrapper.send("x");
    const errEvent = {
      type: "messageerror"
    };
    worker.onmessageerror(errEvent);

    await assert.rejects(ep.promise, (e) => e === errEvent);
  });

  // -- malformed messages ---------------------------------------------------

  it("ignores null event.data without throwing", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    // Should not throw
    assert.doesNotThrow(() => worker.onmessage({
      data: null
    }));
    assert.doesNotThrow(() => worker.onmessage({
      data: "string"
    }));
    assert.doesNotThrow(() => worker.onmessage({
      data: 42
    }));
  });

  it("ignores messages with unknown id", async () => {
    const {
      WorkerWrapper
    } = loadModule();
    const createPromise = WorkerWrapper.create("test.js");
    const worker = mockWorkerCtx.lastInstance;
    worker.onmessage({
      data: {
        type: "ready"
      }
    });
    const wrapper = await createPromise;

    assert.doesNotThrow(() =>
      worker.onmessage({
        data: {
          id: "unknown-uuid",
          result: 1
        }
      })
    );
  });
});
