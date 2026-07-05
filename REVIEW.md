# REVIEW.md

Canonical PR review guide for this repository. Human reviewers follow the same rules.

## Reviewer routing

| Reviewer | Config file it reads |
|----------|----------------------|
| OpenAI Codex (`chatgpt-codex-connector`) | `AGENTS.md` |
| Pullfrog (`pullfrog[bot]`) | `AGENTS.md` + Pullfrog dashboard |
| Google Jules (`google-labs-jules`) | `AGENTS.md` |

> Pullfrog and Jules honor `AGENTS.md` and are otherwise steered from their dashboards.

## Severity calibration

- **Critical:** credential leaks, auth bypass, data loss, broken security boundaries.
- **Warning:** missing validation, untested behavior changes, contract breaks.
- **Do not flag:** formatting-only diffs, dependency version pins managed deliberately, speculative refactors outside PR scope.

## Agent-Maintained Review Memory
Agents that open or update PRs in this repository must keep this section current when review history shows a repeated pattern. Add dated bullets only for durable repo-specific lessons, not one-off PR commentary.

- 2026-07-05: Pullfrog GLM 5.2 config must stay isolated at `.github/pullfrog-opencode.json`. Do not reintroduce repo-root `opencode.json` for Pullfrog; Kilo Code Reviews may load it and fail model resolution.
