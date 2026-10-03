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
- Runtime model discovery. With a Kiro OAuth or API credential, the account's live catalog is the model list, so new and retired Kiro models need no change here.
- `models.json` as hints for what the live catalog leaves out.
- Kiro credit usage in OMP's `/usage` and `omp usage`.
- Basic cost metadata set to zero because Kiro trial/subscription usage is not billed through OMP.
- Unit tests for converters, event-stream parsing, model catalog invariants, dynamic discovery, and usage.

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

Restart `omp` and [sign in](#authentication), then verify that your account's Kiro models are visible:

```sh
omp models kiro
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
omp -p --model kiro/auto "Reply briefly."
```

Any model id from `omp models kiro` can take the place of `auto`. Do not use `--provider kiro`; OMP resolves extension-defined providers through qualified `--model kiro/<model-id>` selectors.

Only one Kiro response streams at a time across every `omp` session on the machine; other
sessions and subagents wait their turn, because parallel streams on one account draw throttling.
Set `OMP_KIRO_STREAM_GATE=0` (or `KIRO_STREAM_GATE=0`) to let them stream in parallel.

### Credit usage

`/usage` in interactive OMP and `omp usage` (OMP 18.4.1 or newer) show the account's Kiro credits:
the monthly allowance with its reset date and, while a free trial lasts, its bonus credits with their
expiry. The provider reads them from
`GET https://management.{region}.kiro.dev/Get-Usage-Limits?origin=KIRO_CLI&profileArn=...&resourceType=CREDIT&isEmailRequired=false`,
using the same profile and region as model discovery. If the request fails, OMP keeps showing the
last report it received.

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

For each model the catalog returns, its name, token limits,
and reasoning support come from the catalog (reasoning from the `thinking` or effort fields of a
model's request schema). `models.json` fills in what the catalog leaves out and marks models whose
reasoning stays server-side. Every Claude model accepts images; other models do when the catalog
or `models.json` says so. A model in neither gets text-only input and conservative token defaults.

`omp models kiro` and the `/model` picker list exactly the account's live catalog: `models.json` is
not registered as a model list, so a new Kiro model appears and a retired one disappears with no
change here. Discovery requires auth; there is no public catalog, and OMP lists no Kiro models while
you are signed out. OMP caches the catalog and refreshes it once a day, after `/login`, and on
`omp models refresh kiro`. When discovery fails, `fetchDynamicModels` fails rather than returning an
empty list, because OMP would take an empty list as the account's whole catalog. OMP then keeps its
cached catalog; with none cached yet, it lists no Kiro models until discovery succeeds.

The provider does not write `models.json` at runtime. There is no weekly updater. An entry applies
only to a model the catalog lists, so one for a retired model is harmless and one for a model the
account lacks adds nothing. Edit `models.json` only to correct metadata the catalog gets wrong or
leaves out, in a reviewable PR, and run the test suite before merging.

Kiro often sends a model's id as its name. For a Claude or GPT model missing from `models.json`,
the provider then derives a readable name from the id: `claude-opus-5.5` is shown as
`Claude Opus 5.5`, and `gpt-5.6-sol` as `GPT-5.6 Sol`. Selectors do not change. Run
`omp models refresh kiro` to rename models already in OMP's cached catalog.

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
├── models.json              # committed capability overlay for the live catalog
├── src/models.ts            # small filesystem loader and catalog validation
├── src/dynamic-models.ts    # ListAvailableModels parse, merge, and fetch
├── src/usage.ts             # Get-Usage-Limits credit report for /usage
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
