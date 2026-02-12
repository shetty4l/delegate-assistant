import { describe, expect, test } from "bun:test";
import { classifyModelError, ModelError } from "../src/index";

describe("classifyModelError", () => {
  test("classifies 'insufficient credits' as billing", () => {
    expect(classifyModelError("Insufficient credits")).toBe("billing");
  });

  test("classifies '402' as billing", () => {
    expect(classifyModelError("HTTP 402 Payment Required")).toBe("billing");
  });

  test("classifies 'unauthorized' as auth", () => {
    expect(classifyModelError("Unauthorized")).toBe("auth");
  });

  test("classifies 'invalid key' as auth", () => {
    expect(classifyModelError("invalid API key provided")).toBe("auth");
  });

  test("classifies '401' as auth", () => {
    expect(classifyModelError("HTTP 401")).toBe("auth");
  });

  test("classifies 'rate limit' as rate_limit", () => {
    expect(classifyModelError("rate limit exceeded")).toBe("rate_limit");
  });

  test("classifies '429' as rate_limit", () => {
    expect(classifyModelError("HTTP 429 Too Many Requests")).toBe("rate_limit");
  });

  test("classifies 'capacity' as capacity", () => {
    expect(classifyModelError("No capacity available")).toBe("capacity");
  });

  test("classifies 'overloaded' as capacity", () => {
    expect(classifyModelError("Server overloaded")).toBe("capacity");
  });

  test("classifies '503' as capacity", () => {
    expect(classifyModelError("HTTP 503 Service Unavailable")).toBe("capacity");
  });

  test("classifies unknown errors as internal", () => {
    expect(classifyModelError("something completely unexpected")).toBe(
      "internal",
    );
  });

  test("is case-insensitive", () => {
    expect(classifyModelError("INSUFFICIENT CREDITS")).toBe("billing");
    expect(classifyModelError("Rate Limit")).toBe("rate_limit");
  });
});

describe("ModelError", () => {
  test("extends Error with name, classification, and upstream", () => {
    const err = new ModelError("billing", "Insufficient credits");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ModelError");
    expect(err.classification).toBe("billing");
    expect(err.upstream).toBe("Insufficient credits");
    expect(err.message).toContain("billing");
    expect(err.message).toContain("Insufficient credits");
  });

  test("supports cause via ErrorOptions", () => {
    const cause = new Error("original");
    const err = new ModelError("auth", "401 Unauthorized", { cause });
    expect((err as any).cause).toBe(cause);
  });
});
