# omp-kiro-provider

Dependency-free [OMP](https://github.com/can1357/oh-my-pi) extension for using Kiro-compatible models from `omp`.

This is an unofficial, community-maintained provider. It is not affiliated with, sponsored by, or endorsed by Kiro, Amazon, AWS, or OMP.

## Why this exists

`omp-kiro-provider` lets OMP talk to the Kiro streaming API through OMP's native extension interface. It is built for local coding-agent workflows where you want the same terminal UX as other OMP providers, but without installing a package manager bundle or running browser automation inside the provider.

## Features

- Native OMP provider registration under `kiro/*` model selectors.
- Dependency-free runtime: TypeScript source plus Node.js built-ins.
- Supports API keys, Kiro CLI token reuse, Kiro IDE token fallback, and Builder ID or organization device-code login.
- Automatic token refresh for supported OAuth/OIDC sessions.
- AWS Event Stream decoding with frame checksums, routed on each frame's event type.
- Streaming text, reasoning (`<thinking>` tags and Kiro 5.x reasoning events), and tool-call conversion. OMP's `--thinking` level, `off` through `max`, sets the thinking budget. Redacted reasoning is never shown; models that reason server-side show a "Reasoning hidden by provider" placeholder while they think.
- Retry handling for capacity errors, empty responses, 5xx responses and server-side stream failures, only while nothing has reached the screen. Errors Kiro sends mid-stream are reported, not swallowed.
- Runtime model discovery. With a Kiro OAuth or API credential, the account's live catalog is the model list, so new Kiro models need no change here.
- `models.json` as the offline catalog and as hints for what the live catalog leaves out.
- Basic cost metadata set to zero because Kiro trial/subscription usage is not billed through OMP.
- Unit tests for converters, event-stream parsing, model catalog invariants, and dynamic discovery.

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
4. **Builder ID or organization (IAM Identity Center) device-code flow** through OMP's provider login interface.

### API key

Create or edit `~/.omp/agent/.env`:

```sh
mkdir -p ~/.omp/agent
printf '%s\n' 'KIRO_API_KEY=ksk_...' >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env
```

Requests made with an API key carry `TokenType: API_KEY`, as kiro-cli sends; without it Kiro
rejects the key as an invalid bearer token.

Do not commit `.env` files, API keys, exported OAuth tokens, browser callback payloads, or SQLite auth databases.

### OMP `/login`

In interactive OMP, run:

```text
/login
```

Select **Kiro**. Depending on what credentials already exist locally, the provider may reuse a Kiro CLI/IDE session, accept an API key, or start a browser device-code login flow.

For organization accounts, choose **5 · Your organization (IAM Identity Center)**.
Enter your organization's HTTPS start URL (for example, `https://your-organization.awsapps.com/start`)
and the AWS region of your IAM Identity Center instance (leave blank to use `us-east-1`).
This is the SSO region, not necessarily the Kiro API region.
Open the authorization link, approve access with your organization account,
and return to OMP to complete login.

Organization login does not require a Kiro CLI or IDE installation. The provider stores the OIDC
client registration and SSO region in its local auth metadata so the existing OIDC refresh flow
can renew the session. AWS Builder ID remains option **4**.

## Usage

Use a qualified OMP model selector:

```sh
omp --model kiro/auto
omp --model kiro/claude-sonnet-4-6
omp -p --model kiro/qwen3-coder-next "Reply briefly."
```

Do not use `--provider kiro`; OMP resolves extension-defined providers through qualified `--model kiro/<model-id>` selectors.

## Models

With a Kiro OAuth or API credential, the provider resolves the account profile and calls
`GET https://management.{region}.kiro.dev/List-Available-Models?origin=KIRO_CLI&profileArn=...`.
OAuth sessions use the saved profile ARN or `POST /List-Available-Profiles`; API keys resolve
their own profile through the `AmazonCodeWhispererService.GetProfile` RPC in `us-east-1`, where
Kiro issues API keys, without reusing a saved OAuth profile. `KIRO_REGION` selects the API region
and defaults to `us-east-1`.

Inference uses `https://runtime.{region}.kiro.dev/generateAssistantResponse` with the resolved
profile ARN. A profile belongs to one region, so model discovery and inference go to the region in
the profile ARN. `KIRO_API_BASE` overrides the inference base URL; a non-`kiro.dev` override is used
as given, and it does not override model discovery.

Profile resolution order for OAuth tokens: `KIRO_PROFILE_ARN`, the profile stored at login,
`List-Available-Profiles` (first profile listed; set `KIRO_PROFILE_ARN` to pick another one in
an organization with several). A profile can live in the other canonical region
(`us-east-1` or `eu-central-1`), so both are queried, starting with `KIRO_REGION`. Builder ID
tokens are not allowed to list profiles, so the provider uses the shared Builder ID profile only
when every canonical region answers "not authorized". If a region fails instead, the request
reports that error and the lookup is retried on the next request.

The live catalog is authoritative: OMP lists exactly the models it returns. Names, token limits,
and reasoning support come from the catalog (reasoning from the `thinking` or effort fields of a
model's request schema). `models.json` fills in what the catalog leaves out and marks models whose
reasoning stays server-side. Every Claude model accepts images; other models do when the catalog
or `models.json` says so. A model in neither gets text-only input and conservative token defaults.

`models.json` is also OMP's static `models` catalog, used before the first discovery and whenever
it fails. Discovery requires auth; there is no public catalog. When you are signed out or discovery
fails, `fetchDynamicModels` fails rather than returning an empty list, because OMP would take an
empty list as the account's whole catalog and drop every model discovered so far. OMP then keeps
its cached catalog or `models.json`.

The provider does not write `models.json` at runtime. There is no weekly updater.

The registry currently includes selectors such as:

- `kiro/auto`
- `kiro/claude-sonnet-4-5`
- `kiro/claude-sonnet-4-6`
- `kiro/claude-sonnet-5`
- `kiro/claude-opus-4-5`
- `kiro/claude-opus-4-8`
- `kiro/claude-opus-5-5` (when available in the authenticated account's live catalog)
- `kiro/kimi-k2-5`
- `kiro/qwen3-coder-next`
- `kiro/qwen3-coder-480b`
- `kiro/minimax-m2-5`
- `kiro/agi-nova-beta-1m`
- `kiro/gpt-5-6-sol`
- `kiro/gpt-5-6-terra`
- `kiro/gpt-5-6-luna`

New models such as Opus 5.5 appear when the account catalog includes them, and retired ones
disappear, with no change to `models.json`. Edit it only to correct metadata the catalog gets
wrong or leaves out, in a reviewable PR, and run the test suite before merging.

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
├── models.json              # committed capability overlay and fallback catalog
├── src/models.ts            # small filesystem loader and catalog validation
├── src/dynamic-models.ts    # ListAvailableModels parse, merge, and fetch
├── src/core.ts              # streaming, retries, headers, token selection
├── src/converters.ts        # OMP message/tool payload conversion
├── src/eventstream.ts       # AWS Event Stream decoder
├── src/oauth.ts             # OMP login + token reuse/refresh
├── src/auth/                # device flow and refresh helpers
└── tests/                   # pure unit tests; tests/fixtures holds a captured Kiro response
```

### Running a local checkout

- OMP runs the extension from a transpiled copy cached in
  `~/.omp/cache/legacy-pi-extension-cache.db`. After editing the source, quit every `omp`
  session and remove `~/.omp/cache/legacy-pi-extension-cache.db*` so the next run rebuilds it.
  If an edit still has no effect, an OMP worker daemon may still hold the old build: find it with
  `pgrep -af omp_worker` and stop it by PID.
- Check which copy OMP loads. The `extensions:` path in `~/.omp/agent/config.yml` runs that
  directory; a plugin install runs `~/.omp/plugins/node_modules/omp-kiro-provider`. To try a
  checkout, point that path at it, or replace the plugin directory with a symlink to it.

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
