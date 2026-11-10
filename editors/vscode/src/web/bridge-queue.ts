/**
 * Serialize calls into an object whose methods require exclusive mutable access.
 *
 * A callback is considered active only until it returns. If it returns a
 * Promise, the queue does not wait for that Promise to settle; otherwise an
 * LSP request waiting for a later response could block that response forever.
 */
export function createBridgeCallDispatcher() {
  const pending: Array<() => void> = [];
  let dispatching = false;

  return function dispatch<T>(callback: () => T): Promise<Awaited<T>> {
    return new Promise<Awaited<T>>((resolve, reject) => {
      pending.push(() => {
        try {
          resolve(callback() as Awaited<T>);
        } catch (error) {
          reject(error);
        }
      });

      if (dispatching) {
        return;
      }

      dispatching = true;
      try {
        while (pending.length > 0) {
          const next = pending.shift();
          next?.();
        }
      } finally {
        dispatching = false;
      }
    });
  };
}
