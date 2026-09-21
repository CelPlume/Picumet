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
| Future | High-performance Go backend: same-path multi-storage replication/DR | Planned |

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
| Three-tier file visibility | Done | `private` / `users` / `public`; `public` requires `can_publish` plus review approval; folder-level cascade. |
| User-authored access rules | Done | Single-file allow/deny for other users (`read`/`download`); requires `can_grant`; origin-aware sorting admin > user > system. |
| Capability bits | Done | `can_publish` / `can_share` / `can_grant` stored on users, editable by admins, enforced server-side. |
| Public gallery | Done | Anonymous list / download link / password verify for approved public files; owner and admin download password-exempt. |
| Appearance | Done | Light/dark/system, accent color (HSL + YIQ foreground), blur, background image/URL, folder preview switch. Solid-color background removed. |
| i18n (zh / en) | Done | |
| Responsive layout | Done | Desktop/tablet/mobile; floating action bar tested at 350-1080 px. |
| Users | Done | Register, login, email verify, guest role, free mode. |
| Permissions and quotas | Done | 3 roles, path ACLs, file/path passwords, storage and file-count quotas. Download speed and monthly traffic quotas rejected. |
| Storage configuration | Done | Mounts, CDN domain, path prefix, sort, signing; content-hash addressing (§F) dedupes equal content; storage pool (§E) spreads across providers. Replication/DR and path DSL pending. |
| Storage core hardening | Done | Ranged reads (206/416 via unified `serveObject`), `ProviderError` classification, batched delete (≤1000/batch with per-object fallback), delimiter listing, `UploadPartCopy` for >5 GB moves. |
| Provider unification | Done | Type derived from `endpoint` (`r2` / `s3`; `oracle` folded into `s3`); migration `0005`; `upload_domain` removed. |
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

## User model and storage core (2026-09-20)

Implements the user-model and storage-core items from the OpenList comparison report (`docs/OPENLIST_COMPARISON_CN.md`): three-tier visibility with review, user-authored access rules, capability bits, a hardened storage core, and provider-form unification.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Ranged reads | `storage/range.ts` + `serve.ts`: unified object egress (200/206/416/502) consumed by gateway, path-serve, WebDAV and compat | `storage-range.test.ts`, `fault-injection.test.ts` |
| Error classification | `storage/errors.ts` `ProviderError` (not-found / auth / throttled / other) replaces provider-specific string matching | `fault-injection.test.ts` |
| Batched ops | `deleteObjects` ≤1000/batch with `Errors` surfaced and per-object fallback; virtual-directory listing via `Delimiter` | `fault-injection.test.ts` |
| Large-file moves | `UploadPartCopy` part-copy above 5 GB with abort compensation | `fault-injection.test.ts` |
| Provider unification | Type derived from `endpoint` (empty = R2 binding); `oracle` folded into `s3`; migration `0005` is UPDATE-only (no table rebuild) | `free-mode-security.test.ts` |
| Visibility + review | `file_metadata.visibility` / `review_status`; `users` tier opens signed-in reads; `public` tier gated by `can_publish` + admin review (`PATCH /api/admin/files/:id/review`); folder cascade | `user-model.test.ts` |
| User access rules | `GET/POST/DELETE /api/users/rules` behind `rule-guard.ts` gates; visibility rules injected into the same sort pipeline with origin priority admin > user > system | `user-rules-api.test.ts`, `permission.test.ts` |
| Capabilities | `users.capabilities` bits (`can_publish` / `can_share` / `can_grant`) enforced server-side, editable via admin user update | `user-model.test.ts` |
| Gallery | `/api/gallery` anonymous list / download / verify-password reusing gateway download tokens; no second auth surface | `user-model.test.ts` |
| Frontend | Storage presets (flat single forms, R2/AWS/Oracle/MinIO/custom), properties-panel visibility + inline rule composer, settings access-rules page, admin review/capabilities/origin surfaces | frontend typecheck, tests, coverage gate and build green |

Verification: workers `tsc --noEmit` clean; scoped suites green (permission 60, user-model 18, user-rules-api 14, api-files 7, fault-injection 3). Full-suite status is tracked together with the parallel gateway work in the section above.

## Content-hash addressing (§F, 2026-09-21)

Object bodies are stored under their content SHA-256 (`<prefix>/picumet:blob/<h2>/<hash>`; the namespace segment contains `:`, which user virtual keys can never contain), and equal content is shared across files.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Content write path | `services/storage/content.ts`: known hash (S3 gateway SigV4 full-body check) skips the object write on a dedupe hit or writes the content key directly; streaming writes stage + hash while streaming, delete the staging object on a hit, otherwise copy to the content key | `content-addressing.test.ts` |
| File rows | `file_metadata.object_key` stays the unique virtual key; new `physical_key` + `blob_hash` columns carry the provider key and content hash; every provider call resolves `physicalObjectKey(file)` | `content-addressing.test.ts`, gateway suites |
| Reference release | Deletes/overwrites release references inside the same SQL batch (`NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)` — no refcount column, no read-modify-write race); the last reference enqueues `blob_gc` | `content-addressing.test.ts` |
| Collection + reconciliation | `cleanupBlobObjects` deletes after a grace period, re-checks references first, retries on failure (`attempts`); `reconcileBlobs` restores missing index rows and queues unreferenced ones | `fault-injection.test.ts` |
| Move/rename | Content-addressed files move as pure metadata (no copy, provider and physical key unchanged); multipart/legacy rows keep copy + source cleanup | `content-addressing.test.ts` |
| Scope | Multipart upload sessions keep path keys (`blob_hash` NULL) — parts go straight to the provider, so the Worker never sees the bytes; they are deleted as exclusive objects | upload-resume suite |

Logical quota accounting is unchanged (each file counts its own size), so capacity gates stay conservative.

## Read-path failover (§G, 2026-09-21)

When the bucket recorded for a file cannot return the object, reads automatically fall back to the other pool members of that mount. Cross-bucket **copy** (actually replicating objects into secondary buckets) remains future Go-backend work; this layer only makes reads survive a missing/unreachable bucket.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Candidate order | `services/storage/failover.ts`: KV location hint (only when its physical-key fingerprint matches) → the file's recorded provider → remaining pool members (weight desc, id asc), capped at 4 | `storage-failover.test.ts` |
| Trigger conditions | Object missing (404) and upstream failure (502/`ProviderError`) fall through to the next candidate; semantic errors such as 416 propagate immediately | `storage-failover.test.ts` |
| Bounded attempts | Each candidate attempt is capped at 8 s, so an unreachable bucket cannot stall the read | `storage-failover.test.ts` (real-stack check below) |
| Location hint | A replica hit writes `serve:loc:<fileId>` = `{providerId, physicalKey}` (1 h TTL) so later reads go straight to the replica; a rewritten file invalidates it via the key fingerprint | `storage-failover.test.ts` |
| Wiring | `serveFileObject` / `getFileObject` replace raw provider reads in path-serve, share gateway + preview, WebDAV GET/HEAD, S3 gateway GET/HEAD, AList direct links and the compat read endpoint | all gateway suites |

Real-stack check: a file whose recorded bucket was an unreachable S3 endpoint (connection hangs) still returned `200` after the 8 s candidate timeout by serving from the R2 pool member; follow-up requests took ~0.1 s (hint path), and `serve:loc:<fileId>` was present in KV.

Re-runnable acceptance: `scripts/verify-storage-failover.py` (builds the broken-primary mount and asserts both reads; cleans up after itself). See the development guide for prerequisites.

## Mount points are directories (§H, 2026-09-21)

Every non-root mount point is materialised as a real folder row in its **parent mount's namespace**, so the file page, share picker, public browser, WebDAV and AList all see it without any of them implementing mount synthesis.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Materialisation | `services/storage/mount-folders.ts`: row id `mountfolder:<mountId>`, `path` = absolute parent dir, `name` = last path segment, `object_key` = `folder:<absolute path>`, `custom_title` = mount display name | `mount-folders.test.ts` |
| Self-healing | Ensured on directory listing (child mounts of the listed path), on the admin mounts page, and by the scheduled task — all idempotent | `mount-folders.test.ts` |
| Mount lifecycle | Admin create/update/delete registers, migrates (path change) and removes the row; mount name changes refresh `custom_title` | `mount-folders.test.ts` |
| Protection | Renaming/moving/deleting a mount-point row, or a parent directory that contains a mount point, is rejected with 409 | `mount-folders.test.ts` |

Rationale: the earlier behaviour left sub-mounts invisible in the file page (e.g. a mount at `/poolui` simply did not exist for listing code). Making the mount a folder row fixes every consumer at once and keeps a single source of truth.

**Failover candidates are buckets, never folders.** Read failover (§G) only ever considers `mount_providers` → `storage_providers` entries — real, independent buckets. Mount-point folders, user folders such as a "backup" directory, and copies inside the same bucket are not DR: they share the same failure domain. Cross-bucket replication remains the future Go-backend item below.

## Sharing rework: multi-item shares (§I, 2026-09-21)

A share now carries 1..50 items (files, folders, or a mix) and is created **only from the files page**; the share list became read/manage-only and surfaces every setting.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Data model | `share_items` (per-item order, cascades with share/file); `shares.file_id` keeps the first item for single-file compatibility and FK cascade | `share-items.test.ts` |
| Creation | `POST /api/shares { fileIds[] }`: de-duplicated, per-file `share` permission, `title` defaults to the item name (single) or "N 个项目" | `share-items.test.ts` |
| Public detail | `GET /api/shares/:id` returns `items` (display names from `file_metadata.name`); object keys and content hashes are never exposed | `share-items.test.ts` |
| Folder browsing | `GET /api/shares/:id/list?root=&sub=` lists a shared folder; `sub` is normalised and must stay inside the root subtree (403 otherwise) | `share-items.test.ts` |
| Item-scoped transfers | `download` / `preview` accept `itemId` (defaults to the first item) and accept descendants of a folder item (same mount, same owner, subtree) | `share-items.test.ts` |
| Creation entry | Files page row menu + bulk bar open `ShareDialog` (multi-select incl. folders); the settings page no longer offers creation and the dead `?create=` route was removed | manual/browser |
| Share list | Cards and rows show every setting: status (icon + label), access mode (public/login/N users), password protection, preview/download switches, view/download counters, item count | `share-items.test.ts` |
| Share page | Item list in the file page's visual language, folder breadcrumbs, a single Share button (QR + copy link menu), lucide icons instead of emoji | browser |

Also fixed: the share page previously showed 「分享已撤销」 for shares whose `expires_at` was NULL — that message only reflects `status`; expiry and revocation are independent. The reason a link dies while still reading "永久有效" is an explicit revoke (`DELETE /api/shares/:id`, creator or admin), which the share list now shows as a red `已撤销` badge. Re-runnable acceptance: `scripts/verify-share-items.py`.

## Rate limiting visibility and transfer concurrency (§J, 2026-09-21)

The admin settings page now states the effective limits instead of only offering an on/off switch, and a new concurrency limit protects transfer surfaces.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Stated limits | Settings UI shows requests-per-minute plus a hint listing every effective rule: per-IP value, 2x for signed-in users, 5/min for auth endpoints, 60/120 per minute for free mode, and the concurrency limit | browser |
| Concurrency | `middleware/concurrency.ts` + `transfer_slots`: at most `max_concurrent_transfers` (default 4, 0 = unlimited) in-flight transfer requests per user (per IP when anonymous) on the upload channels and the download gateway; exceeding it returns 429 `CONCURRENCY_LIMIT_EXCEEDED` | `concurrency-limit.test.ts` |
| Why D1 | KV has no atomic increment and caches reads for up to 60 s, so an in-flight counter there would read stale values; D1 serialises writes, making the count trustworthy | — |
| Leak handling | Slots are released in `finally` (errors included); slots older than 30 minutes are ignored and swept opportunistically | `concurrency-limit.test.ts` |

## Role permissions, aliases and guest visibility (§K, 2026-09-21)

The role model became explicit in the database so the admin UI shows what actually governs behaviour.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Role defaults | `role_defaults.permissions` (JSON array of `read`/`write`/`update`/`delete`/`download`; `share` deliberately excluded because sharing is the `can_share` capability). Seeds: `admin` and `user` = all five, `guest` = `download` only; built-in roles also seed `capabilities=['can_share']` so "shareable by default" is visible | `role-permissions.test.ts` |
| Per-user overrides | `users.permissions` (NULL = follow the role). Precedence: `users.permissions` → `role_defaults.permissions` → `DEFAULT_ROLE_PERMISSIONS`. Saving role defaults overwrites every member's individual value (explicit requirement) | `role-permissions.test.ts` |
| Aliases | `role_defaults.alias` is a display alias that permission rules may target: `loadPrincipalRules` resolves role + aliases into the rule candidates (`role IN (...)`) | `role-permissions.test.ts` |
| Guest visibility | `file_metadata.guest_visibility` (`NULL` / `none` / `download` / `view`), edited in the file properties panel under "Default user permissions". Anonymous access additionally requires the site-level `allow_guest_access` switch; `NULL` never opens a file by itself, so private files stay private | `role-permissions.test.ts` |

Terminology note: the **guest role** (a signed-in account with `role='guest'`) defaults to download-only; **anonymous visitors** are governed by the file's `guest_visibility` plus the site switch. The two are independent.

## Share forwarding panel and password recall (§L, 2026-09-21)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Password recall | Creating a share stores `password_hash` (verification) **and** `password_cipher` (AES-GCM, `enc:` prefix). Only the creator's `GET /api/shares` decrypts and returns `password`; public endpoints never expose the plaintext or the cipher, and a failed decryption simply omits the field | `share-password.test.ts` |
| Link with password | `GET /api/shares/:id?password=…` grants access directly (401 on a wrong value); the share page auto-fills and submits when the parameter is present | `share-password.test.ts` |
| Single share button | The share page has one Share button whose menu holds the QR code, copy link, copy link with password, show password (click to copy) and copy share message; the share list menu offers the same items. Message format: `来自<user>的<title>` + `链接：` + `密码：` (password line omitted when unknown) | browser |
| Card layout | Share cards show settings in three fixed rows: access mode / preview+download switches / view and download counters | browser |

## Download limit and admin-level settings (§M, 2026-09-21)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Download limit | `middleware/download-limit.ts` counts only download requests (download gateway, share download/preview, file download links, public directory links) per minute per user (per IP when anonymous), `rate_limit_downloads_per_minute` (default 120, 0 = unlimited), 429 on excess; the settings page now also states the effective rate-limit numbers | `download-limit.test.ts` |
| Transfer concurrency | `max_concurrent_transfers` (default 4) with D1-backed slots (see §J) | `concurrency-limit.test.ts` |
| Admin share settings | `GET/PATCH /api/admin/shares/:id`: creator name, items, access mode, password protection, limits, preview/download switches, status and expiry; password can be reset (hash + cipher) or cleared | `admin-shares.test.ts` |
| Admin file properties | `PUT /api/files/:id` accepts `cascade` (default true); the admin files page gained a visibility column and a properties dialog that submits `cascade: false` by default, so publishing one folder no longer cascades the whole subtree by surprise | `admin-shares.test.ts` |
| Direct-link prefix | `direct_prefix` (`''` / `/d` / `/download` / `/raw`) scopes public and signed direct links, and `root_target` decides whether `/` serves the landing page, the file page or the direct-link namespace — both are selectable in admin → System settings and validated together (a non-empty direct prefix cannot own `/`). The file browser stays at `/files`: a configurable files-page prefix was evaluated and dropped as too risky | `route-prefixes.test.ts` |

## File ban governance, dashboard rework and admin files columns (§N, 2026-09-22)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| File ban | `file_metadata.banned` (migration §26) + `PUT /api/admin/files/:id/ban`; `assertNotBanned` (`services/files/ban.ts`) gates all content outlets (file download, path-serve, share download/preview, gateway) with `429 FILE_BANNED`; delete is intentionally not blocked; owner-side ghost state is presentation-only (dimmed row, delete-only menu) | `files-ban.test.ts` (22 cases) |
| Admin files columns & filters | Storage bucket / mount point / content-hash columns, per-page batched `IN` enrichment (mounts, `blob_objects`, providers — no N+1); filters `mount` / `bucket` / `hash` (substring) / `user` / `visibility` / `banned`; ban/unban entry with `ConfirmDialog`; rows with banned selections collapse the bulk bar to delete-only | `files-ban.test.ts` |
| Mount capacity | `mounts.capacity_bytes` persisted via create/update; `Mount.capacityBytes` in shared types; dashboard aggregates Σ capacity (null when all unset) | `mount-quota.test.ts` |
| Dashboard rework | `DashboardRepo.stats()` (role counts, files, used space, providers, active mounts, total capacity) + `DashboardRepo.mounts()` (primary provider, standby pool members, per-mount usage/file count) in `db/repos/dashboard.ts` — batched queries, no N+1; UI: four single-row stat cards, mount relation diagram (primary solid pill + standby outline pills), storage usage with capacity bars, recent activity (6) | `dashboard.test.ts` |
| Admin settings restructure | System settings page split into Site / Security / SMTP / Announcements cards; settings Appearance/Profile/Security merged into Personalization with files-per-row slider | frontend |

## Current baseline

- Backend: 39 test files / 353 Vitest tests pass; `tsc --noEmit` clean.
- Frontend: 3 test files / 14 Vitest tests pass; coverage gate passes (91.8% statements / 72.7% branches / 83.3% functions / 93.2% lines); build succeeds; `tsc --noEmit` clean.
- Language: zh + en.

## What's next

- Oracle Cloud provider implementation.
- Configurable **direct-link prefix** (implemented): the prefix applies to public/signed file direct links only (`direct_prefix`: `''` / `/d` / `/download` / `/raw`) plus a `root_target` choice for what `/` serves — both editable in admin → System settings. The file browser page stays fixed at `/files`; a configurable files-page prefix was evaluated and dropped as too risky (it competes with the landing page, the guest catch-all route and the direct-link namespace).
- Same-path multi-mount: spread across providers is implemented (`mount_providers`); replication/backup is planned for the future Go backend — see below.
- Path-variable DSL (`{year}/{month}`).
- Admin analytics.
- Hot-file detection and forced signed URLs.
- Ongoing verification notes for drag interactions and property-panel editing.

## Planned: future high-performance backend (2026-09-21)

Cross-bucket replication (copying objects into secondary buckets) is deferred to a future Go backend ("high-performance version"). The current Workers implementation spreads each object across pool members (`least_used` / `hash` / `round_robin`) and reads fail over across those members (§G), but it never copies objects between buckets.

Planned admin surface for it: a per-mount **"automatic cross-bucket sync"** switch on the admin storage page. The switch is **only selectable in a Go-backend environment**; the current Node/Workers backend does not implement the capability, so the control is documented as environment-gated and must render disabled (not hidden) there. Pooling (§E) and read-path failover (§G) work today without it — the switch only turns on background replication.

| Item | Decision | Target |
| :--- | :--- | :--- |
| Same-path multi-storage backup / DR | Same-path multi-mount becomes replication (mirror), not spread | Future Go backend |

### Same-path multi-storage backup / DR

- Today: `mount_providers` spreads each object across members — one copy per file. Reads already fail over across members (§G), but without replication a bucket loss means the objects it held are gone. Two mounts on the same path do not merge: `MountRepo.findMountForPath` picks one by priority then depth, so the second is shadowed.
- Target model: `file_replicas(file_id, provider_id, etag, size, status, verified_at)` with `file_metadata.provider_id` kept as the primary replica. Write fan-out (primary synchronous, replicas asynchronous through a queue), read failover, per-replica delete and GC, verification/repair job.
- Prior art to borrow from: rclone's `union` backend (`create_policy=all` mirrors writes to every upstream, `epmfs`/`lus` spread, `:ro`/`:nc`/`:writeback` tags), MinIO site replication (active-active / active-passive with an async scanner that re-queues failed objects), SeaweedFS rack-/DC-aware replication placement.
- Why this is not a simple switch:
  - No cross-provider transactions or atomic compare-and-swap: partial replica writes need compensation/repair jobs, and concurrent overwrites can diverge without generation/ETag checks.
  - Failover reads may serve stale replicas; strict freshness costs a HEAD per read.
  - Presigned/direct links are bound to a single provider's domain (`buildFileAccessUrl`); switching replicas invalidates them unless every link goes through one proxy domain (R2 worker egress is free; S3/Oracle would incur Worker egress).
  - Multipart uploads must write every part to every replica, or re-transfer afterwards (CopyObject is same-provider in practice).
  - N× physical storage cost; pool heuristics such as `least_used` are meaningless for a mirrored mount (every member needs the full data set).
- Preferred platform-level path: provider-side replication (R2 durability is replication + erasure coding; use bucket replication/versioning where available) plus the existing reconciliation job; application-level fan-out belongs to the future backend, where the write path can be optimized (streaming multi-write, checksums).

Related guides: [architecture](ARCHITECTURE.md), [API reference](API.md), [frontend guide](UI.md), [development guide](DEVELOPMENT.md), [deployment guide](DEPLOYMENT.md).
