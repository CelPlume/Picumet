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

Set at least `JWT_SECRET` and `ENCRYPTION_KEY` to unique values. The file includes development defaults for the other settings, such as SMTP and the initial administrator credentials.

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

The backend suite runs against in-memory `node:sqlite` mocks for D1, KV, and R2 (see `tests/helpers.ts`), so it does not require `workerd`. The frontend suite adds a coverage gate that focuses on the security-critical modules `src/lib/escape.ts` and `src/pages/Register.tsx` (80% lines, 60% functions, 40% branches).

Continuous integration runs `.github/workflows/ci.yml` on push and pull requests to `main`. The `workers` job runs install, type check, and tests; the `frontend` job adds the coverage gate and a production build. CI never deploys; deploy with `wrangler deploy` manually.

### Local acceptance scripts (cross-system behaviour)

Unit tests run in memory and cannot cover the real "D1 + R2 binding + scheduled task" combination. The repository's `scripts/` directory ships two Python acceptance scripts (standard library plus the `wrangler` CLI) that assert end-to-end behaviour against a **local dev stack**:

| Script | Covers | Key assertions |
| :--- | :--- | :--- |
| `scripts/verify-content-addressing.py` | §F content-hash addressing | Uploading the same content twice produces a single physical object with two rows sharing the physical key and content hash, both reading back identical bytes; deleting one file keeps the object, deleting the last one enqueues `blob_gc`; after the grace period a scheduled trigger deletes the object and drains the queue; overwriting enqueues the old content |
| `scripts/verify-storage-failover.py` | §G read-path failover (pool / secondary buckets) | With the file's recorded bucket set to a "broken primary" (unreachable S3 endpoint), the first read returns 200 from the R2 pool member after the 8 s candidate timeout, and the second read is markedly faster through the `serve:loc` hint |

Prerequisites and usage:

```bash
# 1) start the local stack (add --test-scheduled to exercise the collection path)
cd workers && bun run dev -- --test-scheduled

# 2) in another terminal (defaults: http://localhost:8787, admin/admin123456; overridable)
python3 scripts/verify-content-addressing.py --base-url http://localhost:8787
python3 scripts/verify-storage-failover.py --base-url http://localhost:8787
```

Both scripts clean up after themselves (uploaded paths, mount, provider, API key). Shared helpers live in `scripts/_picumet_e2e.py` (HTTP session, multipart body builder, local D1 queries, local R2 key enumeration). `verify-content-addressing.py` waits 65 s for the grace period before triggering the scheduled task; pass `--skip-gc` to skip that wait.

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

The permission algorithm in `services/permissions/check.ts` decides access with a fixed priority order: administrator privilege → mount boundary → user root-path limit (`users`/`public` visibility exempts only `read`/`download`) → API-key permission scope → path rules → owner fallback → bucket matrix (§31) → mount matrix (§28) → default-path role permissions → default deny. Two precedence rules are part of the contract and need cases of their own: the owner fallback and `user`-origin rules both run **before** the matrices (a matrix cannot restrict an owner's `read`/`update`/`delete`/`share`/`download`, while `write` is not in the owner fallback), and anonymous principals get no default-path fallback — a `role='guest'` rule, a mount-matrix guest entry or an explicit public channel is required. Tests must lock in path segment boundaries: `/users/alice` must never match `/users/alice2`. Add cases for rule priority, wildcard patterns, and default deny.

Password protection needs cases too. File-level passwords run through the verify-password endpoint, which first requires the `download` permission on the file (same gate as the download-link endpoint) and, on success, issues a gateway token carrying `passwordVerified`. Rule condition fields (`requirePassword`, `allowedIps`) are no longer accepted at rule creation; legacy rules that still carry conditions fail closed in the engine — deny unless explicit conditions are supplied (locked in by engine tests).

### File state machine

Upload sessions transition through `pending → uploading → verifying → completed`, with `failed`, `expired`, and `aborted` terminal states. Multipart uploads add `parts_uploaded` and `completing`. Cover resume, abort, and the completion check that verifies part coverage and the final HEAD size.

### Quota atomicity

Quota updates must be atomic. Test that concurrent uploads never exceed the configured limit and that delete and abort paths release reservations exactly once. Use the atomic `UPDATE` form instead of a read-modify-write sequence.

### Storage topology and the synthetic root

Lock in the mount placement validator: a second mount on the same normalized path (`400 ALREADY_EXISTS`), a nested mount whose priority would be shrouded by an ancestor (`400`), creating or re-pathing a mount where the parent mount already holds rows at that path (`409`), and a same-path user folder or file (`409`). Mount-point directory rows must always carry `id = mountfolder:<mountId>` and must never be reused from — or deleted in place of — a user row; `mount-folders.test.ts` asserts the `path` = own-absolute-path convention that keeps the file tree from recursing on the mount folder. Saving a mount configuration must keep `mount_providers.quota_reserved` for surviving members (differentiated upsert, not delete-and-insert), and `reconcileQuotas` must converge the user, mount and per-member reservation layers from the in-flight sessions.

For the synthetic root (`services/storage/root-view.ts`), assert that `vroot:<path>` items appear only when a readable mount exists below that level, that a level whose mounts are all unreadable stays `404` (no topology leak), and that row-addressed endpoints (upload, folder creation, detail, move, rename, delete, share) still answer `404` for a virtual path.

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

### Mount-point directory rows are system rows

A mount's directory row uses the deterministic id `mountfolder:<mountId>` and an owner of the oldest administrator, purely as a foreign-key placeholder. Never resolve one by `(mount_id, path, name, type)` and never reuse a user row for it: admin create/update refuses a same-path user row with `409`, the background self-healing pass warns and skips instead of rewriting data, and removal deletes by that id only — the old by-name delete could remove a user directory when a mount was dropped.

### Never synthesize a write at the synthetic root

The synthetic root only fills in directory listings when no mount covers the requested path. A virtual item (`vroot:<path>`) has no `file_metadata` row, so it cannot be moved, renamed, deleted or shared, and uploads must keep answering `404` for a path with no mount — do not add write support for virtual paths.

### Restart `wrangler dev` after edits

Hot reload is unreliable for the Workers API. After you change workers source, restart the process; to be safe, remove `.wrangler` and re-apply migrations to start from a clean state.

### A 302 redirect must go through `c.redirect()`, not `new Response.redirect()`

Helpers such as `setAuthCookie()` that write `Set-Cookie` attach it to the Hono context via `c.header(...)`; if you then `return Response.redirect(url, 302)` and build a brand-new Response, the response headers **will not** carry the cookie just set — which shows up as "after the third-party login / registration completion page bounces back to `/files`, the user is still signed out". Always use `c.redirect(url, 302)` (it carries the response headers already prepared on the context). This bit us once on the SSO callback success branch: the unit test's `Set-Cookie` assertion caught it directly.

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
