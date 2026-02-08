# RFC: Engram Integration for Concurrent, Resumable Assistant Workflows

## Status

- Proposed
- Authors: Delegate Assistant maintainers
- Last updated: 2026-02-08

## Why

Delegate Assistant currently operates with serial update handling and limited durable coordination state. Several workflows are not possible today (resumable approvals, safe replay, durable handoffs, and eventually parallel topic execution).

This RFC defines an opt-in integration with Engram to unlock those workflows without breaking current runtime behavior.

## Goals

- Preserve current behavior as default.
- Add optional context hydration before model turns.
- Add optional idempotency guard for inbound update handling.
- Add optional work-item lifecycle integration for resumable execution.
- Ensure graceful fallback when Engram capabilities are unavailable.

## Non-Goals

- No mandatory switch to multi-worker processing in first rollout.
- No removal of existing serial processing path.
- No hard dependency that prevents operation when Engram is unavailable.

## Current Constraints (Summary)

- Update processing is serial and blocks on long turns.
- Cursor handling and message processing are not protected by idempotent coordination primitives.
- `RespondInput.context` is not populated with durable memory context.
- Recovery paths for in-flight work are minimal.

## Target Workflows to Unlock

1. Safe retry/restart without duplicate side effects.
2. Resumable approval/revision flows across worker restarts.
3. Deterministic context handoff between turns/tasks.
4. Durable task lifecycle that can be recovered after failure.
5. Foundation for future per-topic parallel workers.

## Integration Design

### Capability detection first

- On startup, detect Engram capabilities.
- Enable only supported features.
- If unavailable, continue with current behavior.

### Context hydration (opt-in)

- Before `modelPort.respond`, request hydrated context from Engram (`context_hydrate`).
- Populate `RespondInput.context` with returned entries.
- On timeout/failure, continue with empty context (current behavior).

### Idempotency guard (opt-in)

- Use inbound identifiers (`updateId`, `sourceMessageId`) as idempotency keys.
- Check ledger before executing turn logic.
- Record completion marker to suppress duplicate processing/replies.

### Work-item lifecycle (opt-in)

- For long-running or approval-oriented turns, attach a work-item id.
- Emit lifecycle events: create, claim, heartbeat, complete/fail/cancel.
- On startup, recover in-flight work via Engram capability where available.

## Compatibility Strategy

1. Existing behavior remains default with all new flags disabled.
2. New behavior is additive and capability-gated.
3. Any Engram failure must degrade to existing local behavior unless strict mode is explicitly enabled.
4. Existing domain and adapter contracts remain source-compatible in first slice.

## Feature Flags

- `ASSISTANT_ENABLE_ENGRAM_CONTEXT`
- `ASSISTANT_ENABLE_ENGRAM_IDEMPOTENCY`
- `ASSISTANT_ENABLE_ENGRAM_WORK_ITEMS`

Default for all: disabled.

## Rollout Plan

1. **Phase 0: Baseline tests + behavior lock**
   - Capture baseline behavior for worker loop and retry semantics.
2. **Phase 1: Capability detection + fallback plumbing**
   - Add Engram capability checks and no-op fallback mode.
3. **Phase 2: Context hydration integration**
   - Hydrate `RespondInput.context` when enabled.
4. **Phase 3: Idempotency integration**
   - Add inbound dedup checks and completion markers.
5. **Phase 4: Work-item lifecycle slice**
   - Integrate lifecycle events and startup recovery hooks.
6. **Phase 5: Evaluate parallel topic execution**
   - Only after stability and observability targets are met.

## Acceptance Criteria

- Flags disabled: runtime behavior unchanged from baseline.
- Context hydration failure does not fail message handling.
- Idempotency suppresses duplicate processing in restart/retry scenarios.
- Work-item path can be toggled off instantly via flag.
- Existing test suite passes; new integration tests pass.

## Risks and Mitigations

- **Risk:** External dependency drift (Engram unavailable or outdated).
  - **Mitigation:** Capability checks + graceful fallback.
- **Risk:** Hidden latency from added calls.
  - **Mitigation:** bounded timeouts and async-safe fallback to current path.
- **Risk:** Operational complexity from mixed modes.
  - **Mitigation:** clear feature flags and explicit readiness diagnostics.

## Open Questions

- Should idempotency ledger keys be managed only in Engram or mirrored locally?
- Which turn types should be mandatory work-items vs optional?
- Should strict mode exist where Engram unavailability fails fast?
