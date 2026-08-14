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

- 2026-08-14: Pullfrog uses the organization-level Custom OAI connection with
  `glm-5.3`. Keep its endpoint and credentials in the Pullfrog console; do
  not add a Pullfrog OpenCode config or a repo-root `opencode.json`.
