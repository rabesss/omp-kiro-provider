# Security Policy

## Secrets

This repository does not require or contain credentials. Never commit local credential material, including API keys, environment files, OMP auth files, Kiro CLI local databases, AWS SSO cache files, exported session tokens, browser callback payloads, or prompt logs containing private code.

Recommended local credential files should be readable only by the current user, for example permission mode `600` for files and `700` for credential directories.

## Dependency Posture

The extension is intended to be loaded directly from its checked-out TypeScript source by OMP.

- Runtime dependencies: none.
- Install-time dependencies: none for normal use.
- Avoid package-manager installation hooks or published package workflows unless they are reviewed separately.
- Keep tests offline by default. Live smoke tests must be opt-in and must not print credentials.

## Sensitive Areas

Changes to these areas need careful review:

- OAuth/OIDC device-code flow
- token refresh logic
- Kiro CLI / AWS SSO session reuse
- stream request headers
- retry and timeout behavior
- tool-call conversion
- prompt/log redaction

## Reporting

Report suspected vulnerabilities through GitHub private vulnerability reporting when available. Do not include real keys, session material, private prompts, or private repository content in public issues.