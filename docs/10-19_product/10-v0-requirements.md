# Personal Assistant v0 - High-Level Requirements

Status: active

## 1. Purpose
Build a personal AI assistant that acts as a delegated operator, not an autonomous actor. Telegram is the user interface and pi-agent (via OpenRouter) is the execution engine. The wrapper runtime should stay minimal while preserving auditability, continuity, and evolvability.

This document defines what the system must do, not how it is implemented.

## 2. Core Principles

### 2.1 Explicit Delegation
- The assistant only works on items explicitly delegated by the user.
- Delegation happens via:
  - direct chat messages, or
  - forwarding content (e.g. emails) to the assistant.

### 2.2 Approval-Gated Action
- No irreversible or externally visible side effects occur without explicit user approval.
- The assistant may draft, plan, stage, and propose actions freely.
- Safety and approval behavior are owned primarily by the model adapter (pi-agent) in the active runtime.

### 2.3 Clear Separation of Identity
- The assistant has its own identity across services.
- The assistant never impersonates the user.

### 2.4 Auditability and Traceability
- Every significant step is recorded:
  - input received
  - interpretation
  - proposed actions
  - approvals or denials
  - execution results

### 2.5 Minimalism First
- Start with the smallest viable foundation.
- Capabilities are added incrementally via modules.
- No single integration should be required for core operation.

### 2.6 Language-First Interaction
- The assistant should default to natural language, not command-heavy UX.
- Telegram `/start` is the only wrapper-level command in v0.
- All other interactions should be plain conversational turns.

### 2.7 Adaptive Chief-of-Staff Behavior
- The assistant should evolve its collaboration style over time based on high-confidence observed preferences.
- Behavioral updates should be proposed conversationally and adopted only with user confirmation.
- Users must be able to ask the assistant to forget previously learned preferences.

## 3. Communication Surface

### 3.1 Primary Interface
- Telegram is the primary interaction surface for user to assistant communication.
- The assistant must be reachable from anywhere.

### 3.2 Interaction Model
- Conversations are treated as requests, not commands.
- The assistant may ask clarifying questions when intent is ambiguous.
- Responses default to concise summaries and next steps.
- Planning should be collaborative by default; execution should happen only after explicit user intent.
- Approval prompts should consistently present `Approve`, `Revise`, and `Deny` choices.

## 4. Assistant Identity

### 4.1 Email Identity
- The assistant has its own email address and mailbox.
- The assistant reads only its own mailbox by default.
- Emails forwarded to the assistant are treated as delegated work items.
- Delivery is phased:
  - phase 1: delegated email interpretation and draft generation
  - phase 2: approval-gated outbound email sending
- The assistant may:
  - classify emails
  - draft replies
  - propose action items
- Sending emails requires explicit approval.

### 4.2 GitHub Identity
- The assistant has its own GitHub user account.
- Repository access is granted explicitly and revocable independently of the user.
- Assistant-authored code changes must be attributable to the assistant identity.

### 4.3 Future Identities
- Additional services (calendar, issue trackers, etc.) may be added later under the assistant's identity using the same delegation and approval model.

## 5. Delegation and Safety Model

### 5.1 Allowed by Default
- Reading delegated content
- Summarizing and interpreting
- Drafting artifacts (emails, plans, patches)
- Asking clarifying questions

### 5.2 Always Requires Approval
- Sending emails
- Publishing or merging code
- Creating or deleting external resources
- Installing software or modifying system configuration
- Using or rotating credentials

### 5.3 Explicit Denials
- The assistant must respect denials and not retry unless explicitly asked.

## 6. Self-Building Capability

### 6.1 Definition
- The assistant can be tasked with improving or extending itself.
- Self-building means:
  - proposing changes
  - producing reviewable artifacts
  - executing changes only after approval

### 6.2 Constraints
- The assistant must not silently modify its own safety, approval, or identity constraints.
- Changes to core guardrails require explicit, high-signal approval.
- In early phases, applying assistant self-update code to the running assistant remains operator-managed (manual apply), even when assistant-generated PRs are merged.

## 7. Credentials and Secrets

### 7.1 Handling Rules
- Secrets are never transmitted via chat.
- Secrets are never committed to source control.
- Secrets are not stored in conversational memory.

### 7.2 Scope
- Credentials are scoped per service and per capability.
- Revoking one credential must not break unrelated capabilities.

## 8. Audit and Observability

### 8.1 Logging
- The assistant maintains local logs under user control.
- Logs must support:
  - debugging
  - replay
  - post-mortem analysis

### 8.2 Transparency
- On request, the assistant must be able to explain:
  - why it took an action
  - what information it used
  - what alternatives were considered
- If memory infrastructure is degraded, the assistant should disclose that condition without overwhelming the conversation.

## 9. v0 Scope Boundaries

### 9.1 Must Have
- Telegram interaction
- Assistant identity (email + GitHub accounts exist)
- Forwarded-email delegation with summary and draft-reply support
- Delegation + safety model
- Audit logging
- Support for self-building workflows

### 9.2 Explicitly Out of Scope (v0)
- Autonomous inbox monitoring
- Automatic email sending
- Automatic PR merging
- Multi-user collaboration
- Full project management system
- Fully predefined reminder/scheduling UX (should emerge through iterative collaboration)

Note:
- "Assistant email identity exists" means credentials and account can be provisioned for delegated use; it does not imply autonomous inbox operations in v0.

## 10. Open Decisions (Deferred)
- Assistant name / handle
- Email provider
- GitHub org vs personal repo strategy
- Model provider (hosted vs local)

These decisions are intentionally deferred and should not block v0 progress.

## 11. Success Criteria
The v0 assistant is considered successful if:
- The user can delegate work via Telegram.
- The assistant produces useful drafts and plans with low-friction conversational UX.
- No side effects occur without approval.
- The assistant can be tasked with improving itself and produce reviewable changes.
