# ADR-0008: Truthful runtime adapter capabilities

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p3-adapter-contract, p0-compat-matrix, A-RT-TRUTH

## Context
Five runtimes differ in streaming, approvals, resume, cancel semantics and cost reporting. The product must not pretend parity.

## Decision
Each adapter reports a capability set where every capability has one of:
`supported` (contract-tested on this worker), `unsupported` (known absent), `degraded` (works with documented limits, e.g. cancel = process kill), `unverified` (not yet tested on this OS/arch/version). Only `supported`/`degraded` capabilities are offered in the UI/API; others are shown disabled with the reason. Capabilities are reported per (runtime, version, OS, arch) by `probe()` and cached by the master; a version change invalidates them. Cost values carry provenance (`reported-by-runtime`, `estimated-from-tokens`, `unknown`).

## Consequences
The contract test kit is the source of `supported`; a capability cannot be marked supported by configuration alone.

## Verification
UI/API tests assert that invoking an unsupported capability returns a typed `capability_unsupported` error, never success.
