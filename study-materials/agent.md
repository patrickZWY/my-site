# Architecture Agent Guide

This guide distills the study materials into abstract software-engineering
rules an agent can apply to unfamiliar systems.  It intentionally avoids
project-specific details.  Use it as a review and design checklist for systems
that need durable APIs, controlled risk, clear error behavior, observability,
testability, and maintainable evolution.

## 1. Operating Rule

Before changing a system, identify:

- the boundary being changed;
- who calls it;
- who owns the data crossing it;
- what can fail;
- what must remain compatible;
- what must be observable;
- what tests prove the behavior.

If any of these are unclear, the design is not ready.  Do not hide missing
answers behind abstractions.

## 2. Architecture First Principles

Good architecture makes important constraints visible.

Prefer designs where:

- trust boundaries are explicit;
- lifecycle phases are explicit;
- state transitions are explicit;
- ownership is explicit;
- errors have stable meaning;
- unsupported behavior is reported directly;
- dangerous operations pass through narrow gates;
- cross-cutting behavior is composed, not copied;
- fast paths stay small;
- slow paths carry diagnostics and cleanup;
- platform-specific or backend-specific reality is isolated, not denied.

Avoid designs where:

- one object silently owns too many responsibilities;
- privilege, authority, or capability is checked by scattered booleans;
- callers must know undocumented ordering or lifetime rules;
- errors are only strings;
- logs are the only way to understand behavior;
- tests only cover helpers while the main workflow is untested;
- abstraction hides performance, locking, durability, or security constraints.

## 3. Boundary Design

Every important boundary should answer these questions:

- What input is accepted?
- What input is rejected?
- Who validates normalization?
- What capabilities are available?
- What operations are intentionally unsupported?
- Which errors are retryable?
- Which errors are permanent?
- Which state transitions are legal?
- What context is required to call this API?
- Who frees or closes returned resources?

### Boundary Metrics

Use these as review metrics:

- Each public operation documents preconditions, postconditions, and failure
  modes.
- Each resource returned by an API has a documented owner.
- Each stateful API has an explicit state diagram or equivalent tests.
- Every unsupported operation returns a structured unsupported error.
- Every privileged or dangerous operation has one narrow entry point.
- Every boundary has tests for invalid input, unsupported behavior, and cleanup.

## 4. API Design

Good APIs have a stable grammar.  Users should be able to predict how related
operations behave.

Prefer:

- a simple path for common use;
- an options or builder path for advanced use;
- typed capabilities instead of implicit feature guessing;
- structured configuration instead of stringly typed global state;
- immutable handles when concurrent sharing is expected;
- explicit context objects for runtime resources;
- small traits/interfaces that match real operation boundaries.

Avoid:

- many unrelated variants of the same operation;
- boolean parameter piles;
- global mutable configuration for per-operation behavior;
- hidden retries inside APIs that cannot safely retry;
- returning partial success without making it visible;
- exposing backend-specific details through a supposedly generic API unless the
  abstraction explicitly permits it.

### API Metrics

- Related operations share naming and option patterns.
- Common use needs minimal ceremony.
- Advanced use does not require bypassing the abstraction.
- Capabilities can be inspected at runtime or compile time.
- No operation requires callers to parse error strings.
- New implementations can be added without changing the user-facing API unless
  the capability model itself changes.

## 5. Capability Design

Do not pretend all implementations support the same behavior.

Use capability declarations when implementations vary:

- read/write/list/delete support;
- atomicity guarantees;
- streaming support;
- transactional support;
- conditional operation support;
- concurrency guarantees;
- durability guarantees;
- security or privilege requirements.

Capabilities should be:

- inspectable;
- precise;
- conservative;
- affected by wrappers/layers when wrappers change behavior;
- tested against actual behavior.

### Capability Metrics

- A capability is never advertised unless tested or enforced.
- Callers can distinguish unsupported from failed.
- Wrappers update capabilities when they add, remove, or restrict behavior.
- Capability documentation includes edge cases and invariants.

## 6. Error Design

Errors are part of the API.  They should drive correct behavior, not just
describe failure after the fact.

Good error systems separate:

- category: what kind of failure happened;
- status: temporary, persistent, permanent, unsupported, invalid input;
- operation: what was being attempted;
- context: key facts needed to diagnose;
- source: lower-level cause;
- user message: safe explanation for humans.

Prefer:

- stable error kinds;
- structured context;
- explicit retryability;
- direct propagation helpers;
- cleanup paths that preserve the original error;
- fail-closed behavior for impossible or corrupted control messages.

Avoid:

- catching all errors and returning generic failure;
- retrying all errors;
- logging and continuing after invariant corruption;
- losing the operation name during propagation;
- exposing secrets in error messages;
- making callers match free-form strings.

### Error Metrics

- Every error path either returns, retries by policy, or terminates deliberately.
- Retry code only retries explicitly temporary errors.
- Final retry failure is distinguishable from an untried failure.
- Errors carry enough context to diagnose without reproducing immediately.
- Security boundary violations fail closed.
- Cleanup errors do not hide the primary failure unless policy says they must.

## 7. Danger Handling

Dangerous operations should be isolated.

Danger includes:

- untrusted input;
- privilege changes;
- filesystem writes;
- network parsing;
- raw pointers;
- syscalls;
- concurrency;
- cancellation;
- cross-process communication;
- serialization/deserialization;
- dynamic loading;
- cryptographic key use;
- resource exhaustion.

Use these patterns:

- parse with checked helpers;
- validate before authority is granted;
- make privileged operations request-based and enumerable;
- separate pre-auth/pre-validation phases from trusted phases;
- constrain syscalls or backend operations where possible;
- publish state only after initialization;
- make one-shot actions one-shot in code;
- treat impossible states as bugs, not user errors.

### Danger Metrics

- All untrusted input crosses a named validation function.
- Privileged operations are centralized and auditable.
- Every state transition has a legal caller and legal phase.
- Resource limits exist for input size, retries, queues, and logs.
- The system has tests for malformed input and invalid operation order.
- Dangerous debug modes are off by default and documented.

## 8. State And Lifecycle

State machines should be deliberate.  Lifecycle bugs usually come from
implicit states.

For every stateful component, define:

- initial state;
- valid transitions;
- terminal states;
- who may transition it;
- what happens on failure;
- what happens on cancellation;
- whether operations are idempotent;
- what cleanup is required.

Prefer:

- enums or tables for states;
- one-shot flags for one-shot operations;
- immutable handles with replayable composition;
- explicit ownership transfer;
- acquire/release ordering where concurrent state is published;
- reverse-order cleanup.

Avoid:

- "initialized enough" states;
- cleanup paths that depend on guessing what completed;
- shared mutable global phase flags without narrow access;
- state transitions hidden in logging, callbacks, or destructors.

### Lifecycle Metrics

- Each resource acquisition has a matching release path.
- Failure at every acquisition step has a test or review note.
- Concurrent publication uses documented memory ordering or synchronization.
- No caller can observe a partially initialized object unless that is the API.
- Terminal states reject further operations predictably.

## 9. Concurrency Design

Concurrency is an API constraint, not an implementation detail.

Document:

- whether the type is thread-safe;
- whether operations can run concurrently;
- which locks protect which fields;
- whether callbacks may re-enter;
- whether cancellation is allowed;
- whether blocking is allowed in the current context;
- how lifetime is protected while readers run.

Prefer:

- immutable shared handles;
- reference-counted ownership where sharing is needed;
- small critical sections;
- lock-order documentation;
- runtime validators in debug builds;
- clear fast path and slow path separation.

Avoid:

- holding locks while calling user callbacks;
- unknown lock ordering;
- assuming wakeup order unless guaranteed;
- hidden blocking in APIs that may be called from non-blocking contexts;
- mixing ownership transfer with unrelated state changes.

### Concurrency Metrics

- Lock order is documented for multi-lock operations.
- Shared objects have a visible lifetime strategy.
- Blocking behavior is documented for each public operation.
- Tests or debug tooling cover contention and cancellation paths.
- No callback is invoked while holding a lock unless documented and required.

## 10. Observability

Observability should match the path's frequency and risk.

Use:

- structured logs for human diagnosis;
- metrics for aggregate behavior;
- traces for high-frequency paths;
- probes/hooks for low-overhead internal visibility;
- debug assertions for invariants;
- rate limiting for noisy events;
- context propagation for request-scoped diagnosis.

Logs should include:

- operation;
- component;
- phase;
- stable error kind;
- relevant identifiers;
- duration where useful;
- retry attempt where useful.

Logs should not include:

- secrets;
- raw untrusted data without escaping;
- excessive hot-path detail by default;
- misleading success messages before commit;
- repeated messages without rate limiting.

### Observability Metrics

- Each public operation has at least one observable failure path.
- High-frequency diagnostics use trace/metrics/rate-limited logs.
- Retry attempts are observable separately from final failure.
- Logs preserve original error context.
- Debug-only diagnostics cannot be required for normal operations.
- Sensitive values are redacted or never logged.

## 11. Testing Strategy

Tests should match risk.

Use multiple layers:

- unit tests for pure parsing, formatting, and utility logic;
- behavior tests for public API contracts;
- integration tests for process, network, storage, or subsystem workflows;
- fuzz tests for parsers and serialization;
- compatibility tests for stable APIs;
- failure-injection tests for cleanup and retry;
- concurrency tests for locks, cancellation, and lifetime;
- property tests for invariants where useful.

Avoid:

- only testing happy paths;
- mocking away the boundary being tested;
- tests that require hidden global machine state when a skip is possible;
- fragile timing tests without bounded timeouts;
- broad integration tests with no focused failure assertions.

### Test Metrics

- Every public operation has success, invalid input, unsupported, and failure
  tests.
- Every parser has malformed-input tests.
- Every retry policy has tests for temporary, permanent, and exhausted retry.
- Every resource acquisition sequence has at least one cleanup failure test.
- Every compatibility promise has regression tests.
- Long-running or privileged tests skip gracefully when prerequisites are absent.

## 12. Refactoring Rules

Refactor to make constraints clearer, not merely to reduce line count.

Good reasons to refactor:

- duplicated policy exists in multiple places;
- ownership is unclear;
- error handling is inconsistent;
- tests cannot target the current shape;
- a boundary has too many responsibilities;
- a platform/backend difference is leaking everywhere;
- observability is scattered or missing.

Bad reasons to refactor:

- making unlike things look uniform;
- replacing clear local code with premature generic abstractions;
- hiding important context constraints;
- changing stable APIs for internal neatness;
- reducing files at the cost of boundary clarity.

### Refactor Metrics

- The refactor removes duplicated decisions, not just duplicated text.
- Public behavior is unchanged unless intentionally documented.
- Error semantics are preserved or improved.
- Tests describe the old and new expected behavior.
- The new abstraction has at least two real users or isolates a real boundary.
- Platform/backend-specific logic becomes more localized.

## 13. Reuse Rules

Reuse mechanics when they are truly common.  Do not reuse policy when the
policy differs.

Good reuse targets:

- buffer parsing;
- error construction;
- logging/tracing wrappers;
- retry policy;
- capability checks;
- resource cleanup helpers;
- intrusive/container data structures;
- configuration loading;
- serialization format helpers;
- test harnesses.

Poor reuse targets:

- security policy that differs by phase;
- backend-native behavior;
- hardware-specific paths;
- lifecycle rules with different ownership;
- performance-sensitive fast paths with different constraints;
- APIs that only look similar by name.

### Reuse Metrics

- Shared code has a single clear responsibility.
- Shared code does not require callers to pass many flags to recover local
  behavior.
- Shared code improves testability.
- Shared policy has identical invariants across all users.
- Removing the abstraction would duplicate decisions, not just lines.

## 14. Configuration And Feature Control

Configuration should be explicit and validated early.

Prefer:

- typed config objects;
- clear defaults;
- feature flags for optional build surface;
- validation before runtime operations;
- environment or file config parsed through one path;
- diagnostic output that identifies invalid keys and values.

Avoid:

- silent fallback on invalid configuration;
- global config mutation after operations start;
- optional features that change behavior invisibly;
- parsing configuration in many unrelated modules.

### Configuration Metrics

- Invalid config fails before side effects when possible.
- Defaults are documented.
- Feature-dependent behavior is visible to callers.
- Config parsing has tests for unknown, duplicate, invalid, and boundary values.

## 15. Compatibility And Evolution

Stable interfaces require discipline.

Before changing an API, ask:

- Is this public, internal, or private?
- Is there a compatibility promise?
- Can old callers still compile or run?
- Is the behavior change observable?
- Is a migration path available?
- Do errors remain compatible?
- Are docs and tests updated?

Prefer:

- additive changes;
- non-exhaustive enums where future growth is expected;
- deprecation before removal;
- adapters for old behavior;
- compatibility tests.

Avoid:

- changing serialized formats without versioning;
- changing error categories casually;
- repurposing existing fields;
- weakening documented guarantees.

### Compatibility Metrics

- Stable formats have versions or extension rules.
- Public enum growth is planned.
- Deprecated APIs point to replacements.
- Behavior changes include migration notes.
- Compatibility-sensitive paths have regression tests.

## 16. Security Review Checklist

For security-sensitive code:

- Identify trusted and untrusted inputs.
- Identify privilege boundaries.
- Identify secrets and key material.
- Check logs for secret leakage.
- Enforce least privilege.
- Validate message order and phase.
- Limit input size and resource usage.
- Use constant-time comparison where timing matters.
- Fail closed on corrupted control protocols.
- Test malformed input and invalid state transitions.

Security metrics:

- No privileged operation is reachable without a named authorization path.
- Secrets are not stored longer than needed.
- Untrusted data is escaped before logging.
- Default behavior is deny or unsupported, not allow.
- Tests include hostile inputs, not only invalid user mistakes.

## 17. Performance Review Checklist

For performance-sensitive code:

- Identify hot path and cold path.
- Keep hot path allocation-light.
- Avoid logging in hot path by default.
- Avoid unnecessary dynamic dispatch in hot path.
- Separate parsing/setup from repeated operation.
- Use batching where it preserves semantics.
- Measure before and after.

Performance metrics:

- Hot path allocations are counted and justified.
- Hot path locks are identified.
- Retry/backoff has limits.
- Large data paths support streaming or chunking.
- Observability has low-overhead modes.

## 18. Documentation Standards

Document what future maintainers cannot infer safely.

Good documentation includes:

- invariants;
- ownership transfer;
- caller context;
- legal state transitions;
- failure semantics;
- compatibility promises;
- why an unusual design exists.

Avoid comments that restate code.

Documentation metrics:

- Every non-obvious invariant is written near the code.
- Public APIs include examples for common and advanced use.
- Dangerous order dependencies are documented.
- Debugging instructions exist for common failures.

## 19. Agent Review Protocol

When reviewing a change, produce findings in this order:

1. Boundary or API contract changes.
2. Safety/security regressions.
3. Error semantics and cleanup issues.
4. Concurrency/lifetime risks.
5. Observability gaps.
6. Test gaps.
7. Refactor or reuse concerns.

For each finding, include:

- impacted file/function;
- violated invariant or missing contract;
- concrete failure scenario;
- suggested fix;
- test that would catch it.

## 20. Minimum Definition Of Done

A change is not done until:

- behavior is implemented;
- error paths are handled;
- cleanup paths are correct;
- observability is sufficient;
- tests match the risk;
- docs are updated for new contracts;
- public compatibility is considered;
- no unrelated refactor is mixed in.

If a change cannot satisfy one of these, record why explicitly.

