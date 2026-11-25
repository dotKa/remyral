# ADR-0001: Record architecture decisions

- **Status:** Accepted (mandated by the project onboarding notes and AGENTS.md)
- **Date:** 2026-10-12
- **Related:** p0-adrs

## Context
The project onboarding notes (now CONTRIBUTING.md) require an ADR for each consequential decision; AGENTS.md makes the blueprint binding for coding agents. Agents and humans need one place to find why the system is the way it is.

## Decision
Keep ADRs in `docs/adr/` using `template.md`. Agents may write ADRs as `Proposed`; only a human moves an ADR to `Accepted`, recording name and date. Code that depends on a `Proposed` ADR may be written but must not be released to production.

## Consequences
Every PR that changes a decision recorded here must reference or supersede the ADR. CI checks that the ADR index lists every ADR file.

## Verification
`docs/adr/README.md` index matches files (checked in CI once `p0-bootstrap` lands).
