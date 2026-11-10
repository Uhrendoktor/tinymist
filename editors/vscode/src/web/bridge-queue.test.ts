import { expect, test } from "vitest";
import { createBridgeCallDispatcher } from "./bridge-queue";

test("defers reentrant calls until the active WASM call returns", async () => {
  const dispatch = createBridgeCallDispatcher();
  let isBorrowed = false;
  let nestedCall: Promise<string> | undefined;

  const request = dispatch(() => {
    expect(isBorrowed).toBe(false);
    isBorrowed = true;
    nestedCall = dispatch(() => {
      expect(isBorrowed).toBe(false);
      return "nested";
    });
    isBorrowed = false;
    return "request";
  });

  await expect(request).resolves.toBe("request");
  expect(nestedCall).toBeDefined();
  await expect(nestedCall).resolves.toBe("nested");
});

test("does not hold the bridge while an LSP response is pending", async () => {
  const dispatch = createBridgeCallDispatcher();
  let resolveFirst: ((value: string) => void) | undefined;

  const first = dispatch(
    () =>
      new Promise<string>((resolve) => {
        resolveFirst = resolve;
      }),
  );

  await expect(dispatch(() => "next")).resolves.toBe("next");

  resolveFirst?.("first");
  await expect(first).resolves.toBe("first");
});
