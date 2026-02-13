import { describe, expect, test } from "bun:test";
import {
  buildRelayFailureText,
  classifyRelayError,
  withTimeout,
} from "@assistant-core/src/relay";
import { ModelError } from "@delegate/domain";

describe("classifyRelayError", () => {
  test("classifies ModelError with billing as model_error", () => {
    const err = new ModelError("billing", "Insufficient credits");
    expect(classifyRelayError(err)).toBe("model_error");
  });

  test("classifies ModelError with auth as model_error", () => {
    const err = new ModelError("auth", "401 Unauthorized");
    expect(classifyRelayError(err)).toBe("model_error");
  });

  test("classifies ModelError with internal as model_error", () => {
    const err = new ModelError("internal", "unknown error");
    expect(classifyRelayError(err)).toBe("model_error");
  });

  test("classifies ModelError with failed_generation as tool_call_error", () => {
    const err = new ModelError(
      "internal",
      "failed_generation: tool call validation failed",
    );
    expect(classifyRelayError(err)).toBe("tool_call_error");
  });

  test("classifies ModelError with tool_use_failed as tool_call_error", () => {
    const err = new ModelError(
      "internal",
      "tool_use_failed: invalid parameters",
    );
    expect(classifyRelayError(err)).toBe("tool_call_error");
  });

  test("classifies ModelError with rate_limit as model_transient", () => {
    const err = new ModelError("rate_limit", "429 Too Many Requests");
    expect(classifyRelayError(err)).toBe("model_transient");
  });

  test("classifies ModelError with capacity as model_transient", () => {
    const err = new ModelError("capacity", "503 overloaded");
    expect(classifyRelayError(err)).toBe("model_transient");
  });

  test("classifies 'already processing' as session_invalid", () => {
    expect(classifyRelayError(new Error("already processing"))).toBe(
      "session_invalid",
    );
  });

  test("classifies 'agent is busy' as session_invalid", () => {
    expect(classifyRelayError(new Error("agent is busy"))).toBe(
      "session_invalid",
    );
  });

  test("still classifies timeout errors", () => {
    expect(classifyRelayError(new Error("relay timed out"))).toBe("timeout");
  });

  test("still classifies transport errors as default", () => {
    expect(classifyRelayError(new Error("ECONNREFUSED"))).toBe("transport");
  });
});

describe("buildRelayFailureText", () => {
  test("model_error includes upstream message from ModelError", () => {
    const err = new ModelError("billing", "Insufficient credits");
    const text = buildRelayFailureText("model_error", 300_000, err);
    expect(text).toContain("⚠️");
    expect(text).toContain("billing");
    expect(text).toContain("Insufficient credits");
  });

  test("model_transient returns unavailable message", () => {
    const text = buildRelayFailureText("model_transient", 300_000);
    expect(text).toContain("temporarily unavailable");
    expect(text).toContain("try again later");
  });

  test("tool_call_error returns rejected message", () => {
    const text = buildRelayFailureText("tool_call_error", 300_000);
    expect(text).toContain("rejected by the provider");
  });

  test("timeout includes timeout duration", () => {
    const text = buildRelayFailureText("timeout", 60_000);
    expect(text).toContain("60s");
  });
});

describe("withTimeout", () => {
  test("calls onTimeout callback when timeout fires", async () => {
    let abortCalled = false;
    const neverResolves = new Promise<string>(() => {});

    await expect(
      withTimeout(neverResolves, 10, "test", () => {
        abortCalled = true;
      }),
    ).rejects.toThrow(/timed out/);

    expect(abortCalled).toBe(true);
  });

  test("does not call onTimeout when promise resolves in time", async () => {
    let abortCalled = false;
    const fast = Promise.resolve("ok");

    const result = await withTimeout(fast, 1000, "test", () => {
      abortCalled = true;
    });

    expect(result).toBe("ok");
    expect(abortCalled).toBe(false);
  });
});
