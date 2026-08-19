<div align="center">

<img src="../assets/logo.svg" alt="Picumet Logo" width="128" />

# Development guide

**Multi-cloud object storage with fine-grained access control**

English | [中文](DEVELOPMENT_CN.md)

</div>

This guide covers local development for Picumet: environment setup, tests, code conventions, and the pitfalls that tend to trip up contributors. It assumes you have a working clone of the repository and focuses on the `workers/` and `frontend/` directories.

## Before you begin

Install the following tools before you start.

| Tool | Version | Purpose |
| :--- | :--- | :--- |
| Node.js | 22 or later | JavaScript runtime for build tooling |
| bun | 1.3 or later | Package manager for both `workers/` and `frontend/` (`packageManager: bun@1.3.14`) |
| wrangler | 4 or later | Cloudflare Workers CLI for local API development |

Install bun before you continue:

```bash
curl -fsSL https://bun.sh/install | bash
```

The project uses bun as the single package manager. Do not mix npm, pnpm, or yarn lockfiles into the repository.

## Set up a local environment

### Install dependencies

Open two terminals. In the first, install the API dependencies; in the second, install the frontend dependencies.

```bash
cd workers && bun install
cd ../frontend && bun install
```

### Configure environment variables

Copy the example file and edit the values that matter for local development:

```bash
cp workers/.dev.vars.example workers/.dev.vars
```

Set at least `JWT_SECRET` and `ENCRYPTION_KEY` to unique values. The file includes development defaults for the other settings, such as SMTP, Turnstile, and the initial administrator credentials.

### Apply database migrations

Run the migrations against the local D1 database:

```bash
cd workers
bunx wrangler d1 migrations apply picumet-db --local
```

This command applies every pending migration in `workers/migrations/` in order. Name new migration files `NNNN_description.sql` so the apply order stays deterministic.

### Start the API

Start the Workers API from the `workers/` directory:

```bash
cd workers && bun run dev
```

The API listens on `http://localhost:8787`.

### Start the frontend

Start the frontend dev server from the `frontend/` directory in the second terminal:

```bash
cd frontend && bun run dev
```

The frontend listens on `http://localhost:5173`. Vite proxies `/api/*` and `/webdav/*` requests to `http://localhost:8787`, so you do not need CORS configuration locally.

### Verify the setup

Open the following URLs:

- Frontend: `http://localhost:5173`
- API: `http://localhost:8787`

On first startup, `workers/src/seed.ts` creates the default administrator, a demo user, the default R2 provider with a root mount, and a demo folder. The seed runs once, guarded by the `seed:done` KV key.

The development seed accounts are:

| Role | Username | Password |
| :--- | :--- | :--- |
| Administrator | `admin` | `admin123456` |
| Demo user | `demo` | `demo123456` |

Override the development passwords with `ADMIN_PASSWORD` and `DEMO_PASSWORD` in `.dev.vars`. In production, supply a strong `ADMIN_PASSWORD`. Without one, the seed skips the administrator and the business API returns `503` until initialization completes.

## Run tests and type checks

Run these commands from each package root.

| Task | Command | Directory |
| :--- | :--- | :--- |
| Backend tests | `bun run test` | `workers/` |
| Backend type check | `bun run typecheck` | `workers/` |
| Frontend tests | `bun run test` | `frontend/` |
| Frontend coverage gate | `bun run test:coverage` | `frontend/` |
| Frontend type check | `bun run typecheck` | `frontend/` |
| Frontend build | `bun run build` | `frontend/` |

The backend suite contains 127 test cases and runs against in-memory `node:sqlite` mocks for D1, KV, and R2 (see `tests/helpers.ts`), so it does not require `workerd`. The frontend suite contains 7 test cases plus a coverage gate that focuses on the security-critical modules `src/lib/escape.ts` and `src/pages/Register.tsx` (80% lines, 60% functions, 40% branches).

Continuous integration runs `.github/workflows/ci.yml` on push and pull requests to `main`. The `workers` job runs install, type check, and tests; the `frontend` job adds the coverage gate and a production build. CI never deploys; deploy with `wrangler deploy` manually.

## Code conventions

Follow these conventions so the codebase stays consistent.

### Naming

- Files: `kebab-case`
- React components: `PascalCase`
- Functions and variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Types and interfaces: `PascalCase`

### Import order

Order imports as follows: external libraries first, then Cloudflare bindings, then project-internal modules, and type-only imports last.

### TypeScript

- Keep `strict` mode enabled.
- Avoid `any`; if you must use it, add a comment that explains why.
- Add an explicit return type to every function.
- Run `bun run typecheck` in both packages after you change types.

## Testing requirements

Cover the following modules whenever you change them.

### Permission decision algorithm

The permission algorithm in `services/permissions/check.ts` decides access with a priority order: administrator privilege, mount boundary, user root path, API-key permission scope, path rules, owner fallback, and default deny. Tests must lock in path segment boundaries: `/users/alice` must never match `/users/alice2`. Add cases for rule priority, wildcard patterns, and default deny.

### File state machine

Upload sessions transition through `pending → uploading → verifying → completed`, with `failed`, `expired`, and `aborted` terminal states. Multipart uploads add `parts_uploaded` and `completing`. Cover resume, abort, and the completion check that verifies part coverage and the final HEAD size.

### Quota atomicity

Quota updates must be atomic. Test that concurrent uploads never exceed the configured limit and that delete and abort paths release reservations exactly once. Use the atomic `UPDATE` form instead of a read-modify-write sequence.

### Security regression

Re-run the security regression suite after any change to authentication, uploads, or storage: free-mode credential handling, WebDAV auth, SSRF checks, encryption, rate limiting fail-closed behavior, and one-time download token consumption.

## Commit convention

Use Conventional Commits: `type(scope): subject`. Add the body with multiple `-m` flags, each flag one bullet point.

```bash
git commit -m "feat(upload): add multipart upload support for large files" \
  -m "- Implement the multipart session API and the resume contract" \
  -m "- Record part ETags server-side for completion verification"
```

```bash
git commit -m "fix(permission): fix a path boundary bypass in rule matching" \
  -m "- Replace startsWith with isPathWithinBoundary" \
  -m "- Add boundary tests for /users/alice and /users/alice2"
```

The examples above use English; commit messages in Chinese are equally welcome. Use these types and scopes.

| Type | Meaning |
| :--- | :--- |
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no behavior change |
| `refactor` | Code change with no behavior change |
| `perf` | Performance improvement |
| `test` | Test additions or changes |
| `chore` | Maintenance |

| Scope | Area |
| :--- | :--- |
| `auth` | Authentication and sessions |
| `permission` | Permission algorithm and rules |
| `storage` | Storage providers |
| `upload` | Upload and multipart flows |
| `download` | Download gateway and tokens |
| `ui` | Frontend components and pages |
| `api` | API routes and schemas |
| `db` | Migrations and repos |

## Quality gates checklist

Review each change against this checklist before you push.

### Functionality

- The feature works end to end through the actual UI or API.
- Edge cases and error paths behave as documented.

### Code quality

- TypeScript `strict` passes; no undocumented `any`.
- Naming and import order follow the conventions above.
- No dead code, leftover debug logging, or commented-out blocks.

### Tests

- New behavior has tests that would fail on a plausible regression.
- `bun run test` and `bun run typecheck` pass in both packages.

### Security

- Permission checks run on the canonical, normalized path.
- Object storage keys and credentials never reach the client or logs.
- Fail-closed paths stay closed: rate limits, free-mode, SSRF.

### Performance

- Database writes use atomic statements; no read-modify-write on quota.
- Avoid unnecessary allocations or copies in hot request paths.

### Documentation

- Update `docs/API.md` when you add or change an endpoint.
- Update this guide and `docs/ARCHITECTURE.md` when conventions or structure change.

## Common pitfalls

### Use `isPathWithinBoundary`, not `startsWith`

`startsWith` compares string prefixes and lets `/users/alice` match `/users/alice2`. The helper `isPathWithinBoundary` in `utils/path.ts` compares path segments instead.

### Delete metadata first, then clean objects

Delete the database metadata inside a transaction first. Clean the object storage asynchronously afterwards. Record any cleanup failures in `orphan_objects` for reconciliation. Deleting the object first risks losing it when the metadata delete fails.

### Update quota atomically

Do not read the quota, modify it, and write it back. Concurrency makes that sequence racy. Use a single `UPDATE user_quotas SET used_storage = used_storage + ? ...` statement.

### Normalize paths before authorization

Call `normalizePath` on every incoming path before permission checks, so that `/users/../admin/secrets` resolves to `/admin/secrets` and cannot bypass rules.

### Restart `wrangler dev` after edits

Hot reload is unreliable for the Workers API. After you change workers source, restart the process; to be safe, remove `.wrangler` and re-apply migrations to start from a clean state.

## Development roadmap

The codebase builds in dependency order. Each phase depends on the previous one, and each phase is complete when its acceptance criteria pass.

| Phase | Focus | Depends on |
| :--- | :--- | :--- |
| 0 | Environment setup | — |
| 1 | Authentication | 0 |
| 2 | Permission system | 1 |
| 3 | R2 object storage | 2 |
| 4 | Basic file management | 3 |
| 5 | Quota management | 4 |
| 6 | Move and rename | 5 |
| 7 | Password protection and shares | 6 |
| 8 | API keys and WebDAV | 7 |
| 9 | Advanced UI | 8 |
| 10 | Themes and i18n | 9 |
| 11 | Admin features | 10 |
| 12 | Security hardening | 11 |
| 13 | Multipart upload | 12 |
| 14 | Extra storage sources | 13 |
| 15 | Free mode | 14 |
| 16 | Testing and deployment | 15 |

Milestones along this order:

- **M1** (phase 4): a usable file management system
- **M2** (phase 8): complete API and sharing features
- **M3** (phase 11): multi-user production system
- **M4** (phase 15): full-featured release
- **M5** (phase 16): public release

Each phase ends when its acceptance criteria pass. Use this ordering as a guide for planning work on the remaining features.

## What's next

- [System architecture](ARCHITECTURE.md)
- [API reference](API.md)
- [Frontend design](UI.md)
- [Deployment guide](DEPLOYMENT.md)
- [Project readme](../README.md)
- [Progress notes](PROGRESS.md)
