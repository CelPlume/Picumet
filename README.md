<div align="center">

<img src="assets/logo.svg" alt="Picumet Logo" width="128" />

# Picumet

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002.svg)](https://hono.dev/)
[![React](https://img.shields.io/badge/React-18-61DAFB.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF.svg)](https://vitejs.dev/)
[![D1](https://img.shields.io/badge/D1-SQLite-9E4CFF.svg)](https://developers.cloudflare.com/d1/)
[![R2](https://img.shields.io/badge/R2-S3%20Compatible-0B7ECF.svg)](https://developers.cloudflare.com/r2/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://www.docker.com/)

**Multi-cloud object storage with fine-grained access control**

English | [中文](README_CN.md)

</div>

Picumet is a multi-cloud object storage management platform. It gives you a unified file manager and fine-grained access control over your cloud files, with share links and PicGo/PicList integration, all running on the Cloudflare edge network.

## Before you begin

- Node.js 22 or later.
- [bun](https://bun.sh/) 1.3 or later. This project uses bun as the package manager.
- A Cloudflare account if you plan to deploy to production.

## Set up for local development

1. Install the backend dependencies.

   ```sh
   cd workers
   bun install
   ```

2. Install the frontend dependencies.

   ```sh
   cd ../frontend
   bun install
   ```

3. Configure the environment variables.

   ```sh
   cp workers/.dev.vars.example workers/.dev.vars
   ```

4. Start the Workers API. The API listens on port 8787.

   ```sh
   cd workers
   bun run dev
   ```

5. Initialize the database on the first run.

   ```sh
   bunx wrangler d1 execute picumet-db --local --file=migrations/0001_initial.sql
   ```

6. Start the frontend. The dev server listens on port 5173 and proxies `/api` to port 8787.

   ```sh
   cd frontend
   bun run dev
   ```

Open `http://localhost:5173` for the app and `http://localhost:8787` for the API.

Seed accounts (development only):

| Role | Email | Password |
| :--- | :--- | :--- |
| Admin | `admin` | `admin123456` |
| Demo user | `demo` | `demo123456` |

In production, inject the admin password through `ADMIN_PASSWORD` with at least 12 characters. The build ships no fixed default credentials.

## Run the tests

```sh
cd workers && bun run test            # backend: 127 tests
cd workers && bun run typecheck       # backend type check
cd frontend && bun run test           # frontend: 7 tests
cd frontend && bun run test:coverage  # frontend coverage gate, security-critical modules >= 80%
cd frontend && bun run typecheck      # frontend type check
cd frontend && bun run build          # frontend build
```

CI runs `bun install`, typecheck, tests, and the coverage gate on every push or PR to `main`. It never deploys automatically. Deploy with `wrangler deploy` or through the Cloudflare side.

## Feature overview

| Area | Highlights |
| :--- | :--- |
| Auth | Register, login (HttpOnly cookie + JWT), email verification, password reset. |
| Permissions | Admin/user/guest roles, path-level ACLs, file and path passwords. |
| Files | Card/list views, upload (single and multipart), resume, hard delete, rename, move (Saga), batch operations, search, sort. |
| Previews | Image zoom/rotate, video/audio players, code highlighting (highlight.js, pre-escaped). File cards render video thumbnails and folder previews. |
| Copy links | Multi-file dialog with direct/HTML/Markdown/BBCode formats, direct public path or signed URLs. |
| Shares | Password, expiry, download limits, public page, QR code. |
| Appearance | Light/dark/system themes, accent color with dynamic foreground, blur, background image/URL, folder preview switch, custom file emoji. |
| API keys | `pk_x.sk_y` opaque tokens (hash only), IP allowlist, WebDAV Basic auth, PicGo upload at `/api/upload`. |
| Admin | Dashboard, users, quotas, storage sources, mounts, rules, shares, files, logs, settings. |
| Free mode | Temporary sessions with user-provided storage credentials (AES-256-GCM in KV, short TTL). |
| Security | CSP, CSRF tokens, rate limiting (fail closed), path traversal protection, dangerous file blocking, SSRF checks, SQL parameterization, atomic download tokens. |

## Architecture principles

Organize code by business domain, not by technical layer.

- Backend business code lives in `workers/src/services/<domain>/`. Each service is self-contained with `handlers.ts`, `schemas.ts`, `types.ts`, domain logic, and a `README.md`. The `index.ts` file only assembles routes and middleware.
- Every service depends on the Permissions service for authorization and the Storage service for object access. Avoid circular dependencies.
- Middleware (`auth`, `csrf`, `rate-limit`), the data layer (`db/repos/`), utilities (`utils/`), and shared contracts (`shared/`) are thin infrastructure layers. They carry no business logic.
- The frontend follows the same rule. `pages/` holds one page per route, and page sub-features live in `components/files/` and `components/layout/`. The `components/ui/` folder holds reusable UI primitives only.

See the [architecture guide](docs/ARCHITECTURE.md) for the full design, and the [implementation progress](docs/PROGRESS.md) for scope and status.

## Project structure

```
picumet/
├── assets/logo.svg          # Brand mark
├── frontend/                # React app (Vite + TypeScript + Tailwind)
│   └── src/
│       ├── pages/           # One page per route
│       ├── components/      # files/ · layout/ · ui/
│       ├── lib/             # api · utils · i18n
│       └── stores/          # theme · auth · site
├── workers/                 # Cloudflare Workers API (Hono + D1/KV/R2)
│   └── src/
│       ├── services/        # auth · files · uploads · shares · storage · webdav · ...
│       ├── middleware/      # auth · csrf · rate-limit · global
│       ├── db/repos/        # D1 data access
│       ├── utils/           # path · crypto · ssrf · smtp
│       └── shared/          # schemas · types · errors · response
├── shared/                  # Shared types between frontend and backend
└── docs/                    # Documentation
```

## Documentation

| Guide | Contents |
| :--- | :--- |
| [Architecture](docs/ARCHITECTURE.md) | Services, data model, security design. |
| [API reference](docs/API.md) | Auth, endpoints, errors. |
| [Frontend guide](docs/UI.md) | Routes, layout, responsive design, accessibility. |
| [Development guide](docs/DEVELOPMENT.md) | Local setup, testing, coding conventions. |
| [Deployment guide](docs/DEPLOYMENT.md) | Cloudflare deployment, CI, secrets. |
| [Implementation progress](docs/PROGRESS.md) | Scope, status, audit closure. |

## What's next

- Read the [architecture guide](docs/ARCHITECTURE.md) to understand the service design.
- Set up a local environment with the steps above.
- Review the [implementation progress](docs/PROGRESS.md) for planned work such as the Oracle provider and path-variable DSL.
