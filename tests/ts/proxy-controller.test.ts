import { describe, expect, it } from "vitest";
import { runProxyControllerWithRetry } from "../../src/shared/proxy-controller.js";

describe("proxy controller coordination", () => {
  it("retries a shared-controller lock collision", () => {
    let calls = 0;
    const result = runProxyControllerWithRetry("controller", ["reconcile"], {
      maxAttempts: 3,
      retryDelayMs: 0,
      run: () => {
        calls += 1;
        return calls === 1
          ? { status: 1, stderr: "Error: Lock file is already being held" }
          : { status: 0, stderr: "" };
      },
      sleep: () => undefined,
    });

    expect(result.status).toBe(0);
    expect(calls).toBe(2);
  });

  it("does not retry unrelated controller failures", () => {
    let calls = 0;
    const result = runProxyControllerWithRetry("controller", ["reconcile"], {
      maxAttempts: 3,
      retryDelayMs: 0,
      run: () => {
        calls += 1;
        return { status: 1, stderr: "invalid proxy configuration" };
      },
      sleep: () => undefined,
    });

    expect(result.status).toBe(1);
    expect(calls).toBe(1);
  });
});
