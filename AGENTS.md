# AGENTS.md

Guidance for AI coding agents and reviewers in **omp-kiro-provider**.

Dependency-free OMP extension for the Kiro API (kiro.dev)

The PR review charter is in [`REVIEW.md`](REVIEW.md).

## Review guidelines

- Prioritize security, correctness, and contract stability.
- Flag credential leaks, auth bypass, and breaking API/CLI behavior.
- Do not flag formatting-only diffs or dependency pins managed deliberately.

## Pullfrog

Pullfrog runs in GitHub Actions with BYOK via Z.AI GLM-5.2:

- Workflow: [`.github/workflows/pullfrog.yml`](.github/workflows/pullfrog.yml)
- Provider config: [`opencode.json`](opencode.json) (`zai/glm-5.2` via the Z.AI **Coding Plan** endpoint)
- GitHub Actions secret: `ZAI_API_KEY`
- Workflow env (not a secret): `PULLFROG_MODEL=zai/glm-5.2`

Pullfrog honors this `AGENTS.md` and the review charter in [`REVIEW.md`](REVIEW.md). Dashboard triggers and per-repo instructions live in the Pullfrog console.