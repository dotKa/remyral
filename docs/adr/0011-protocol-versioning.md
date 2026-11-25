# ADR-0011: Worker protocol versioning

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p0-protocol-v1, p2-transport, p2-signed-updates

## Context
Workers update independently of the master (and some may be offline for days). The protocol (ARCHITECTURE.md "Worker protocol") must evolve without breaking the fleet.

## Decision
1. Messages are JSON envelopes validated by Zod schemas in `packages/protocol`: `{protocolVersion, type, messageId, workerId, jobId?, seq, ts, correlationId, payload}`.
2. `protocolVersion` is `MAJOR.MINOR`. Minor bumps are additive (new optional fields / new message types the peer may ignore). Major bumps break; the master supports the current and previous major concurrently.
3. Handshake: worker sends the versions it speaks in `HELLO`; master picks the highest common one or replies with an `UPGRADE_REQUIRED` error and the worker stays in `updating`.
4. Unknown message types on a supported version are logged and acknowledged-as-ignored, never crash the connection. Unknown fields are stripped (schemas are not passthrough) to avoid smuggling data into storage.
5. JSON Schema is generated from the Zod schemas and published with each release for contract tests.

## Verification
Contract tests run the previous release's worker against the current master in CI (p2-signed-updates).
