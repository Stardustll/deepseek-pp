# DeepSeek++ CI/CD

This repository uses a gated GitHub Actions pipeline for extension quality,
release packaging, and Chrome Web Store uploads.

## Required Checks

Protect `main` and require the `Quality gates` job from `.github/workflows/ci.yml`
before merge. The job runs:

- GitHub Actions workflow lint via `actionlint`.
- Production dependency audit: `npm audit --audit-level=high --omit=dev`.
- Prompt contract freeze check.
- TypeScript compile.
- Automation, MCP, shell host, MCP mock, and DeepSeek PoW smoke checks.
- Chrome, Edge, and Firefox builds.
- Manifest policy checks for permissions and Web Store documentation alignment.
- Chrome, Edge, Firefox, and source zip packaging with release asset validation.

## Release Flow

1. Update the version truth sources and release notes.
2. Push a `v*.*.*` tag.
3. `.github/workflows/release.yml` runs the same quality gates as CI.
4. The release workflow publishes exactly four GitHub Release assets:
   Chrome zip, Edge zip, Firefox zip, and source zip.
5. Confirm the remote GitHub Release and assets before treating the release as closed.

## Shell Host npm Publish (trusted publishing)

`packages/shell-host` is published from `release.yml` using npm **trusted
publishing** (OIDC). No long-lived npm token is stored in this repository.

Setup that must exist outside the repository:

1. On npmjs.com, open the package's settings and add a **Trusted Publisher** for
   GitHub Actions with:
   - Organization or user: the repository owner
   - Repository: this repository's name
   - Workflow filename: `release.yml` (filename only, with the extension)
2. Enable the **`npm publish`** allowed action for that publisher. `npm stage
   publish` is always permitted; direct publishing is a separate opt-in.

What the workflow needs, and why:

- `permissions: id-token: write` — the OIDC token itself. The job-level
  `permissions` block replaces the workflow-level one, so `contents: write` is
  repeated there deliberately.
- `npm install --global npm@^11` — trusted publishing requires npm CLI
  **>= 11.5.1**, but Node 22 bundles npm 10.x. The publish step re-checks the
  version and fails loudly rather than silently falling back to token auth.
- The `_authToken` line is stripped from `.npmrc` — `actions/setup-node` writes
  `_authToken=${NODE_AUTH_TOKEN}` for `registry-url`, and with OIDC there is no
  such secret, so the unresolved placeholder would abort before the OIDC
  exchange runs.

Do not add an `NPM_TOKEN` secret: an empty `NODE_AUTH_TOKEN` in the environment
is what breaks the exchange.

## Chrome Web Store Flow

`.github/workflows/chrome-web-store.yml` is manual by design. It runs the same
quality gates before calling `wxt submit`.

Required repository secrets:

- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`

Use dry run first. Submit for review only after the generated Chrome package and
manifest policy checks are green.

## Local Gate

Run the full local equivalent before release work:

```sh
npm run ci:quality
```

`npm run smoke:web` is a live network smoke against Bing-backed web search. Run
it for release readiness when network conditions are reliable; keep it outside
the required PR gate to avoid blocking merges on third-party availability.
