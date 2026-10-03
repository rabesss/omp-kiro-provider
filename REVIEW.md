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
- 2026-10-03: fetch rejects a header value with CR, LF or other control
  characters and quotes the whole value in its error, so a bad token leaks into
  OMP's log and session. Build credential headers only with `kiroAuthHeaders`
  (`src/auth/token-type.ts`), which throws first without the token.
- 2026-10-03: Droid Auto Review cannot run on pull requests from forks (GitHub
  gives them no OIDC token), so its failure there says nothing about the code.
- 2026-10-03: OMP lists every `models.json` entry for every account, beside the
  discovered models. Flag an added model that only some accounts can use, and a
  kept one Kiro no longer lists: both fail with `INVALID_MODEL_ID`.
