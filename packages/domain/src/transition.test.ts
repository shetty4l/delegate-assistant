import { describe, expect, test } from "bun:test";

import { transitionStatus } from "./index";

describe("transitionStatus", () => {
  test("allows delegated to triaged", () => {
    const result = transitionStatus("delegated", "triaged");
    expect(result).toEqual({ ok: true, next: "triaged" });
  });

  test("rejects delegated to delegated", () => {
    const result = transitionStatus("delegated", "delegated");
    expect(result).toEqual({ ok: false, reason: "NO_OP" });
  });

  test("rejects cancelled to delegated", () => {
    const result = transitionStatus("cancelled", "delegated");
    expect(result).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
  });
});
