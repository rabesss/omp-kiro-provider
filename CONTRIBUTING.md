# Contributing

Thanks for helping improve `omp-kiro-provider`.

## Local Setup

Normal usage does not require installing dependencies. The provider is loaded by OMP from the checked-out source tree.

For development, use Node.js 22 or newer and run:

```sh
node --test tests/test-converters.ts
```

## PR Guidelines

- Keep PRs small and focused.
- Include tests for converter, auth, stream, retry, or registry behavior when possible.
- Do not add live-network tests to the default test command.
- Do not commit local auth material, prompt logs, or private traces.
- Keep `models.json` changes reviewable and explain where the model metadata came from.
- Document any change that affects OMP install paths, auth behavior, request headers, or stream parsing.

## Coding Style

- Prefer dependency-free TypeScript and Node.js built-ins.
- Keep runtime imports explicit and local.
- Avoid package-manager lifecycle scripts.
- Keep user-facing errors actionable.

## Security-sensitive Changes

Auth, session refresh, stream headers, and tool-call conversion should receive extra review. When in doubt, open an issue first with sanitized details.