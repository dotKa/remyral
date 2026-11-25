# ADR-0005: Outbound WSS transport and worker device identity

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p2-transport, p2-pairing, p2-identity-rotation, A-FLEET-1, A-FLEET-2, A-SEC-2, AGENTS.md rule 3

## Context
Workers sit behind NAT on residential networks with no stable IP; connections must be outbound only. Identities must be approvable, revocable and rotatable with immediate enforcement.

## Decision
1. **Transport:** worker opens a single WSS connection (TLS 1.3) to `wss://<master>/v1/worker` through the public HTTPS ingress. No listening sockets on workers except loopback-bound runtime ports. Tailscale is for administrators only, not for the worker data path (so a worker never depends on tailnet health).
2. **Device key:** on first start the worker generates an Ed25519 key pair; the private key is stored in the OS keystore where available (macOS Keychain, Windows DPAPI/Credential Manager, Linux file 0600 owned by the service user, optional TPM later), never exported.
3. **Pairing:** worker displays a short one-time pairing code and its key fingerprint; it connects with `HELLO{pairingCode, publicKey, facts}`. The master shows the pending worker; an admin approves after matching the fingerprint. Pairing codes are single-use, expire in 10 minutes, and are rate limited.
4. **Session auth:** after approval, every connection authenticates by signing a server-issued nonce (challenge-response) with the device key. The master issues a short-lived session token (≤15 min) bound to the connection; no long-lived bearer secret exists on the worker.
5. **Revocation:** revoking a worker marks its credential revoked in Postgres, closes its live socket immediately and fails future challenges. Rotation = worker generates a new key, signs the new public key with the old one, admin policy decides whether rotation needs re-approval.
6. **mTLS** is not used at the ingress (Coolify/Traefik termination complicates it); the application-layer signature provides equivalent device binding. Revisit if the ingress changes.

## Alternatives considered
- Static bearer tokens per worker — rejected: theft = full impersonation, rotation is manual.
- Tailscale-only data path — rejected: adds a hard dependency and a second identity system.
- Inbound agent servers on workers — forbidden by AGENTS.md.

## Consequences
Need a pairing UI (p5-fleet-ui) and audit of approve/revoke/rotate events. Lost keystore ⇒ worker re-pairs.

## Verification
P2 gate: 7 workers on distinct networks; revoke test shows disconnect within 1 s and refused reconnect; replayed HELLO with old nonce rejected.
