# AGENTS.md

Guidance for AI coding agents and reviewers in **omp-kiro-provider**.

Dependency-free OMP extension for the Kiro API (kiro.dev)

The PR review charter is in [`REVIEW.md`](REVIEW.md).

## Review guidelines

- Prioritize security, correctness, and contract stability.
- Flag credential leaks, auth bypass, and breaking API/CLI behavior.
- Do not flag formatting-only diffs or dependency pins managed deliberately.

## Pullfrog

Pullfrog runs in GitHub Actions with the organization-level Custom OAI
connection:

- Workflow: [`.github/workflows/pullfrog.yml`](.github/workflows/pullfrog.yml)
- Provider/model: `glm-5.3` through the Z.AI Coding Plan endpoint, selected
  in the Pullfrog console.
- Credentials and endpoint metadata are stored in the Pullfrog console; do not
  add a repository OpenCode provider config or pass the Z.AI key through this
  workflow.

Pullfrog honors this `AGENTS.md` and the review charter in [`REVIEW.md`](REVIEW.md). Dashboard triggers and per-repo instructions live in the Pullfrog console.
