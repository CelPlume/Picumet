# Picumet implementation progress

This document tracks the product scope and implementation status. The requirements that were previously tracked in a standalone matrix now live here, marked with their current progress.

## Status legend

| Mark | Meaning |
| :--- | :--- |
| Done | Implemented, tested, and verified. |
| In progress | Implemented; verification or polish is pending. |
| Planned | Scoped but not yet built. |
| Rejected | Explicitly out of scope. |

## Roadmap

| Phase | Scope | Status |
| :--- | :--- | :--- |
| Phase 1 | Core platform: auth, files, quotas, roles, storage sources, system settings | Done |
| Phase 2 | Uploads (multipart/resume), previews, shares, admin panels, API keys, WebDAV, free mode | Done |
| Phase 3 | AWS S3, appearance theming, admin logins, announcement dismissal | Mostly done; Oracle provider pending |
| Phase 4 | Path-variable DSL (`{year}/{month}`), analytics | Planned |

## Feature areas

| Area | Status | Notes |
| :--- | :--- | :--- |
| Deployment: Cloudflare Pages + Workers | Done | Vercel and EdgeOne rejected. |
| Storage providers | Done | R2 and S3 implemented; Oracle pending; 9 other providers rejected. |
| File browse (card/list views) | Done | `GET /api/files`, sort, search, pagination. |
| Upload (single file) | Done | Session-based with quota reservation. |
| Upload (multipart / large files) | Done | Resume + server-side part records. |
| Hard delete | Done | Metadata-first transaction, async object cleanup. |
| Rename | Done | `PUT /api/files/:id`. |
| Move (Saga) | Done | Source-delete + target-write permission checks. |
| Previews: image / video / audio / code | Done | Image zoom/rotate; video canvas thumbnails; highlight.js with pre-escaping. |
| Selection and multi-select | Done | Grid + list, range selection in list view. |
| Drag sort and drag move | In progress | Drag move works; verification notes pending. |
| View memory per folder | Done | Stored in `localStorage`. |
| Properties panel | Done | Sticky sidebar (desktop) and right drawer (mobile); title/color/cover/emoji editing. |
| Copy links | Done | Multi-file dialog; direct/HTML/Markdown/BBCode; direct public path or signed URL. |
| Shares | Done | Password, expiry, download limits, QR code. |
| Appearance | Done | Light/dark/system, accent color (HSL + YIQ foreground), blur, background image/URL, folder preview switch. Solid-color background removed. |
| i18n (zh / en) | Done | |
| Responsive layout | Done | Desktop/tablet/mobile; floating action bar tested at 350-1080 px. |
| Users | Done | Register, login, email verify, guest role, free mode. |
| Permissions and quotas | Done | 3 roles, path ACLs, file/path passwords, storage and file-count quotas. Download speed and monthly traffic quotas rejected. |
| Storage configuration | Done | Mounts, upload/CDN domains, path prefix, sort, signing. Same-path multi-mount and path DSL pending. |
| Admin | Done | Dashboard, users, storage, mounts, rules, shares, files, logs. Analytics pending. |
| System settings | Done | Site info, registration/guest toggles, Turnstile. |
| API keys + compatible protocols | Done | `pk_x.sk_y` opaque tokens, WebDAV, PicGo/PicList. S3/OSS protocol gateway rejected. |
| Security | Done | CSP, CSRF, rate limiting, path traversal, SSRF, SQL parameterization, atomic download tokens. Hot-file detection and forced signed URLs planned. |
| Image editor link (Squoosh) | Done | |
| Video/audio players | Done | |

## Rejected decisions

| Decision | Reason |
| :--- | :--- |
| Recycle bin | Removed to avoid soft-delete inconsistency between object storage and database. |
| Download speed / monthly traffic quotas | Only storage size and file-count quotas are needed. |
| S3 / OSS protocol gateway | Only WebDAV and the custom upload API are provided. |
| 9 additional providers (B2, IDrive, GCS, COS, OSS, OBS, Scaleway, Filebase, Kodo) | Not in scope. |
| Client-side encryption | Out of scope; sensitive-path links require signed URLs instead. |
| Vercel / EdgeOne hosting | Cloudflare only. |

## Security audit closure

Findings were remediated and locked with regression tests. See `workers/tests/security-regressions.test.ts`, `workers/tests/s3-provider.test.ts`, `frontend/src/lib/escape.test.ts`, and `frontend/src/pages/Register.test.tsx`.

| Risk | Fix | Evidence |
| :--- | :--- | :--- |
| Free-mode credentials stored in plaintext in KV (high) | AES-256-GCM encryption with short TTL, random `sid` cookie, IP binding | Encrypt/decrypt/tamper cases |
| API-key IP allowlist not enforced (high) | `apiKeyAuthMiddleware` returns `403` for non-allowlisted IPs | In/out allowlist cases |
| Multipart parts always empty, no resume contract (high) | Server-side `parts_completed`, `GET /parts` resume contract, skip pre-HEAD merge | Resume flow: gap → reject → complete |
| `/register` missing, forgot-password placeholder (high) | Standalone `/register` and `/reset-password` pages calling the real APIs | Register submit/error cases |
| Download token consumed non-atomically (medium) | KV get→delete replaced with atomic `DELETE ... RETURNING` | Single-consumption and duplicate-401 case |
| Rate limiting fail-open (medium) | Auth/sensitive write endpoints fail closed (`503`) on KV failure | KV failure in production case |
| S3/Oracle provider tests + capability matrix (medium) | Presigned multipart URL unit tests (local signing); Oracle pending | S3 provider cases |
| highlight.js escaping + frontend regression (medium) | `escapeHtml` pre-escaping as defense in depth | Escape cases |
| CI/CD + coverage gate (medium) | `.github/workflows/ci.yml` (bun, CI only), frontend coverage gate, route lazy loading | Coverage lines 100% |

## Gateway access implementation (2026-09-20, docs/PICLIST_COMPAT_CN.md)

Implements the outward relay surface identified by the PicList compatibility report. Scope decision: only the outward-facing relay; the storage-provider backend ("inbound") remains as-is.

| Report item | Implementation | Tests |
| :--- | :--- | :--- |
| P0-1 unusable direct URL | `buildFileAccessUrl`: provider CDN URL, else `{origin}{path}?sign=` capability signature (`signPath`/`verifyPathSign`, HMAC-SHA256) accepted by path-serve | `gateway-compat.test.ts` |
| P0-2 same-name data loss | Shared `upsertFileObject` (files/write.ts): overwrite branch w/ quota delta; overwrite-path failure never deletes the object (reconciliation entry) | `gateway-compat.test.ts`, `fault-injection.test.ts` |
| P0-3 invisible files (missing ancestor rows) | `ensureFolders` for compat/WebDAV/S3/AList writes | `gateway-compat.test.ts`, `webdav-piclist.test.ts` |
| P1-1 Lsky V2 | `POST /api/v1/upload` shell (`uploads/lsky.ts`), bare-token/Bearer auth | `gateway-compat.test.ts` |
| P1-2 dead `protocols` | Enforced per surface (`assertApiKeyProtocol`); enum gains `s3` | `gateway-compat.test.ts` |
| P1-3 WebDAV gaps | href per-segment encoding, real PROPFIND self item + `getcontenttype`/`getetag`, OPTIONS drops COPY, MOVE `Overwrite` header, recursive MKCOL, nested filename support | `webdav-piclist.test.ts` |
| P1-4 key REST read | `GET /api/compat/file?path=` (read permission, upload-root scoped) | `gateway-compat.test.ts` |
| P2-1 AList shim | `/openlist` prefix: login / fs/form / fs/list / fs/get / fs/remove + `/d` direct links with signature | `alist.test.ts` |
| P2-2 S3 SigV4 gateway | `services/s3gw/` (sigv4.ts + handlers.ts): PUT/GET/HEAD/DELETE object, ListBuckets, ListObjectsV2, DeleteObjects, presigned GET query auth; verified end-to-end with the real `@aws-sdk/client-s3` via a local HTTP bridge | `s3gw.test.ts` |
| P2-3 key UX (partial) | Create-key response adds `configs.s3` / `configs.openlist`; WebDAV snippet gains customUrl/webpath hints | `gateway-compat.test.ts` |
| Owner isolation (user decision) | Relay keys are scoped to `owner_id` at the data layer (check.ts deny rule + repo owner filters + cross-owner 409/404); folders are a shared namespace | all suites |
| Naming (user decision) | "API 密钥" → 「网关密钥」/ Gateway Keys; settings page shows per-channel integration info | frontend build |

Migration: `workers/migrations/0006_s3_gateway.sql` adds `api_keys.secret_cipher` (AES-GCM-encrypted `sk_`); legacy keys must be recreated for S3 gateway use. Frontend: protocol checkbox `s3`, gateway-key naming, per-channel config cards.

## Current baseline

- Backend: 177 Vitest tests pass; `tsc --noEmit` clean.
- Frontend: 10 Vitest tests pass; build succeeds; `tsc --noEmit` clean.
- Language: zh + en.

## What's next

- Oracle Cloud provider implementation.
- Same-path multi-mount support.
- Path-variable DSL (`{year}/{month}`).
- Admin analytics.
- Hot-file detection and forced signed URLs.
- Ongoing verification notes for drag interactions and property-panel editing.

Related guides: [architecture](ARCHITECTURE.md), [API reference](API.md), [frontend guide](UI.md), [development guide](DEVELOPMENT.md), [deployment guide](DEPLOYMENT.md).
