# omp-kiro-provider

Dependency-free [OMP](https://github.com/can1357/oh-my-pi) extension for using Kiro-compatible models from `omp`.

This is an unofficial, community-maintained provider. It is not affiliated with, sponsored by, or endorsed by Kiro, Amazon, AWS, or OMP.

## Why this exists

`omp-kiro-provider` lets OMP talk to the Kiro/Amazon Q streaming API through OMP's native extension interface. It is built for local coding-agent workflows where you want the same terminal UX as other OMP providers, but without installing a package manager bundle or running browser automation inside the provider.

## Features

- Native OMP provider registration under `kiro/*` model selectors.
- Dependency-free runtime: TypeScript source plus Node.js built-ins.
- Supports API keys, Kiro CLI token reuse, Kiro IDE token fallback, and Builder ID device-code login.
- Automatic token refresh for supported OAuth/OIDC sessions.
- AWS Event Stream response decoding.
- Streaming text, reasoning/thinking markers, and tool-call conversion.
- Retry handling for transient capacity errors, empty responses, and selected 5xx failures.
- Validated, reviewable static model catalog.
- Basic cost metadata set to zero because Kiro trial/subscription usage is not billed through OMP.
- Unit tests for converters, event-stream parsing, and model catalog invariants.

## Install

Clone the extension into OMP's native extension directory:

```sh
mkdir -p ~/.omp/agent/extensions
git clone https://github.com/rabesss/omp-kiro-provider.git \
  ~/.omp/agent/extensions/omp-kiro-provider
```

Add the explicit extension path to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/agent/extensions/omp-kiro-provider
```

Restart `omp`, then verify that Kiro models are visible:

```sh
omp --list-models kiro
```

To update:

```sh
git -C ~/.omp/agent/extensions/omp-kiro-provider pull --ff-only
```

## Authentication

The provider tries auth sources in this order:

1. **Kiro CLI SQLite database** at `~/.local/share/kiro-cli/data.sqlite3` or `~/.local/share/amazon-q/data.sqlite3`.
2. **Kiro IDE token cache** under `~/.aws/sso/cache/kiro-auth-token*.json`.
3. **API key** from OMP auth, `KIRO_API_KEY`, or interactive `/login`.
4. **Builder ID device-code flow** through OMP's provider login interface.

### API key

Create or edit `~/.omp/agent/.env`:

```sh
mkdir -p ~/.omp/agent
printf '%s\n' 'KIRO_API_KEY=ksk_...' >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env
```

Do not commit `.env` files, API keys, exported OAuth tokens, browser callback payloads, or SQLite auth databases.

### OMP `/login`

In interactive OMP, run:

```text
/login
```

Select **Kiro**. Depending on what credentials already exist locally, the provider may reuse a Kiro CLI/IDE session, accept an API key, or start a browser device-code login flow.

## Usage

Use a qualified OMP model selector:

```sh
omp --model kiro/auto
omp --model kiro/claude-sonnet-4-6
omp -p --model kiro/qwen3-coder-next "Reply briefly."
```

Do not use `--provider kiro`; OMP resolves extension-defined providers through qualified `--model kiro/<model-id>` selectors.

## Models

Model metadata is committed in `models.json`. It includes context windows, max-token limits, reasoning flags, and text/image capability flags. The registry currently includes selectors such as:

- `kiro/auto`
- `kiro/claude-sonnet-4-5`
- `kiro/claude-sonnet-4-6`
- `kiro/claude-sonnet-5`
- `kiro/claude-opus-4-5`
- `kiro/claude-opus-4-8`
- `kiro/kimi-k2-5`
- `kiro/qwen3-coder-next`
- `kiro/qwen3-coder-480b`
- `kiro/minimax-m2-5`
- `kiro/agi-nova-beta-1m`
- `kiro/gpt-5-6-sol`
- `kiro/gpt-5-6-terra`
- `kiro/gpt-5-6-luna`

The provider validates and registers this catalog at startup. When Kiro changes its model list, update `models.json` in a normal reviewable PR and run the test suite before merging. Keeping availability and capabilities explicit avoids guessing metadata for models the provider has not verified.

## Development

No package-manager install is required for normal use. Contributors can run tests with Node.js 22 or newer:

```sh
node --version
npm test
```

Useful files:

```text
omp-kiro-provider/
├── index.ts                 # OMP extension entry point
├── models.json              # committed model registry
├── src/models.ts            # small filesystem loader and catalog validation
├── src/core.ts              # streaming, retries, headers, token selection
├── src/converters.ts        # OMP message/tool payload conversion
├── src/eventstream.ts       # AWS Event Stream parser
├── src/oauth.ts             # OMP login + token reuse/refresh
├── src/auth/                # device flow and refresh helpers
└── tests/                   # pure unit tests
```

## Security posture

- Runtime dependencies: **none**.
- Install-time dependencies: **none** for normal checked-out extension use.
- Credentials must stay local in OMP/Kiro/AWS config locations with restrictive permissions.
- Tests should use pure fixtures or local mocks; do not add tests that require live credentials by default.
- Review changes to auth, stream headers, token refresh, and retry behavior carefully.

## Contributing

Small, focused PRs are preferred. Before opening a PR:

```sh
npm test
```

Do not include real Kiro/AWS credentials, traces containing bearer tokens, or private prompts in issues or PRs.

## License

MIT. See [LICENSE](LICENSE).
