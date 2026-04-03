/**
 * ExposedPromise
 *
 * A Promise wrapper that surfaces all internals:
 *   - .promise  — the underlying Promise
 *   - .resolve  — the resolve function
 *   - .reject   — the reject function
 *   - .executor — the original input function (if any)
 *   - .status   — "pending" | "fulfilled" | "rejected"
 *   - .value    — settled value or rejection reason
 *   - .settled  — boolean convenience getter
 *
 * Notes:
 *   - .status and .value update one microtask tick after settlement,
 *     accurately reflecting thenable resolution rather than the raw
 *     input to resolve().
 *   - .then/.catch/.finally return plain Promises, not ExposedPromises.
 */
class ExposedPromise {
  constructor(executor) {
    this.status = "pending";
    this.value = undefined;
    this.executor = executor ?? null;

    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      if (executor) {
        try {
          executor(resolve, reject);
        } catch (err) {
          reject(err);
        }
      }
    });

    // Source of truth for status/value — updates after thenable assimilation
    this.promise.then(
      (value) => {
        this.status = "fulfilled";
        this.value = value;
      },
      (reason) => {
        this.status = "rejected";
        this.value = reason;
      }
    ).catch(() => {}); // prevent unhandled rejection warning on the tracking branch
  }

  get settled() {
    return this.status !== "pending";
  }

  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }

  catch (onRejected) {
    return this.promise.catch(onRejected);
  } finally(onFinally) {
    return this.promise.finally(onFinally);
  }
}

module.exports = {
  ExposedPromise
};
