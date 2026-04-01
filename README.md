# worker-wrapper

A lightweight wrapper around the Web `Worker` API that provides:

- **Async initialization** with a `"ready"` handshake
- **Awaitable round-trip messaging** via UUID-keyed transactions
- **Consolidated error handling** (constructor throw, runtime error, deserialization error)

## Install

```js
const { WorkerWrapper, TRANSACTION } = require("worker-wrapper");
```

## Usage

```js
// main thread
const worker = await WorkerWrapper.create("./my-worker.js");
const { value, error } = await worker.send("doThing", { payload: 123 });

if (error) {
  console.error("Worker reported an error:", error);
} else {
  console.log("Result:", value);
}

worker.terminate();
```

## Worker-side protocol

Your worker script must follow this message contract:

```js
// my-worker.js

// 1. Signal readiness
postMessage({ type: "ready" });

// 2. Handle incoming messages
onmessage = (event) => {
  const { type, id, ...data } = event.data;

  try {
    const result = handleWork(type, data);
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: err.message });
  }
};
```

| Direction | Shape | Purpose |
|-----------|-------|---------|
| Worker → Main | `{ type: "ready" }` | Signals init complete |
| Main → Worker | `{ type, id, ...data }` | Request with UUID |
| Worker → Main | `{ id, result }` | Successful response |
| Worker → Main | `{ id, error }` | Error response |

## API

### `WorkerWrapper.create(url, options?)` → `Promise<WorkerWrapper>`

Async factory. Resolves once the worker posts `{ type: "ready" }`.

### `worker.send(type, data?, transfer?)` → `ExposedPromise`

Posts a message and returns an `ExposedPromise` that resolves to `{ value, error, [TRANSACTION] }`.

### `worker.terminate()`

Terminates the worker and rejects all pending transactions.

### `TRANSACTION`

Symbol key attached to every resolved response, referencing the originating `ExposedPromise`.