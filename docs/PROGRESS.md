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
| File browse (card/list/tree views) | Done | `GET /api/files` + `GET /api/files/tree`, sort, search, pagination, flat tree view. |
| Upload (single file) | Done | Session-based with quota reservation. |
| Upload (multipart / large files) | Done | Resume + server-side part records. |
| Hard delete | Done | Metadata-first transaction, async object cleanup. |
| Rename | Done | `PUT /api/files/:id`. |
| Move (Saga) | Done | Source-delete + target-write permission checks. |
| Previews: image / video / audio / code | Done | Image zoom/rotate; video canvas thumbnails; highlight.js with pre-escaping. |
| Selection and multi-select | Done | Grid + list, range selection in list view. |
| Drag sort and drag move | In progress | Drag move works; verification notes pending. |
| View memory per folder | Done | Stored in `localStorage`. |
| Properties panel | Done | Right-side drawer at every size (no grid reflow); title/color/cover/emoji editing. |
| Mount view + bucket lane graph | Done | Admin all-files mount view and dashboard lane graph from `/api/admin/mount-tree`. |
| Announcement display policies | Done | §27 `display_mode`/`interval_seconds`/`kind`; banner policies + toast popups. |
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
| Download speed / monthly traffic quotas | Storage size and file-count quotas cover the need. |
| S3 / OSS protocol gateway | The product offers only WebDAV and the custom upload API. |
| 9 additional providers (B2, IDrive, GCS, COS, OSS, OBS, Scaleway, Filebase, Kodo) | Not in scope. |
| Client-side encryption | Out of scope; sensitive-path links require signed URLs instead. |
| Vercel / EdgeOne hosting | Cloudflare only. |

## Security audit closure

Each fix now has a regression test that locks it. See `workers/tests/security-regressions.test.ts`, `workers/tests/s3-provider.test.ts`, `frontend/src/lib/escape.test.ts`, and `frontend/src/pages/Register.test.tsx`.

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
| Owner isolation (user decision) | The data layer pins relay keys to `owner_id` (check.ts deny rule + repo owner filters + cross-owner 409/404); folders are a shared namespace | all suites |
| Naming (user decision) | "API 密钥" → 「网关密钥」/ Gateway Keys; settings page shows per-channel integration info | frontend build |

Migration: `workers/migrations/0006_s3_gateway.sql` adds `api_keys.secret_cipher` (AES-GCM-encrypted `sk_`); recreate legacy keys before S3 gateway use. Frontend: protocol checkbox `s3`, gateway-key naming, per-channel config cards.

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

Verification: workers `tsc --noEmit` clean; scoped suites green (permission 60, user-model 18, user-rules-api 14, api-files 7, fault-injection 3). See the parallel gateway work in the section above for full-suite status.

## Content-hash addressing (§F, 2026-09-21)

Writes place object bodies under their content SHA-256 (`<prefix>/picumet:blob/<h2>/<hash>`; the namespace segment contains `:`, which user virtual keys can never contain), and equal content reuses one copy across files.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Content write path | `services/storage/content.ts`: known hash (S3 gateway SigV4 full-body check) skips the object write on a dedupe hit or writes the content key directly; streaming writes stage + hash while streaming, delete the staging object on a hit, otherwise copy to the content key | `content-addressing.test.ts` |
| File rows | `file_metadata.object_key` stays the unique virtual key; new `physical_key` + `blob_hash` columns carry the provider key and content hash; every provider call resolves `physicalObjectKey(file)` | `content-addressing.test.ts`, gateway suites |
| Reference release | Deletes/overwrites release references inside the same SQL batch (`NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)` — no refcount column, no read-modify-write race); the last reference enqueues `blob_gc` | `content-addressing.test.ts` |
| Collection + reconciliation | `cleanupBlobObjects` deletes after a grace period, re-checks references first, retries on failure (`attempts`); `reconcileBlobs` restores missing index rows and queues unreferenced ones | `fault-injection.test.ts` |
| Move/rename | Content-addressed files move as pure metadata (no copy, provider and physical key unchanged); multipart/legacy rows keep copy + source cleanup | `content-addressing.test.ts` |
| Scope | Multipart upload sessions keep path keys (`blob_hash` NULL) — parts go straight to the provider, so the Worker never sees the bytes; the cleanup removes them as exclusive objects | upload-resume suite |

Logical quota accounting counts each file's own size, so capacity gates stay conservative.

## Read-path failover (§G, 2026-09-21)

When the bucket recorded for a file cannot return the object, reads automatically fall back to the other pool members of that mount. Cross-bucket **copy** (actually replicating objects into secondary buckets) remains future Go-backend work; this layer only makes reads survive a missing/unreachable bucket.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Candidate order | `services/storage/failover.ts`: KV location hint (only when its physical-key fingerprint matches) → the file's recorded provider → remaining pool members (weight desc, id asc), capped at 4 | `storage-failover.test.ts` |
| Circuit breaking (2026-09-22) | An upstream-failing bucket gets `pool:down:<providerId>` (45 s TTL) and drops to the end of the candidate list for that window — it keeps one last-resort attempt, which doubles as the recovery probe — and the marker clears on the first success; a missing object never trips it (data state, not bucket health) | `storage-failover.test.ts` |
| Content validation (2026-09-22) | A hit on a bucket other than the recorded one is checked against the metadata `size` (skipped when either side has no size); a mismatch counts as a miss, so stale or truncated mirror content is never served. Etags stay out of the decision — their semantics differ per backend and upload path | `storage-failover.test.ts` |
| Trigger conditions | Object missing (404) and upstream failure (502/`ProviderError`) fall through to the next candidate; semantic errors such as 416 propagate immediately | `storage-failover.test.ts` |
| Bounded attempts | The reader caps each candidate attempt at 8 s, so an unreachable bucket cannot stall the read | `storage-failover.test.ts` (real-stack check below) |
| Location hint | A replica hit writes `serve:loc:<fileId>` = `{providerId, physicalKey}` (10 min TTL, refreshed on every hit) so later reads go straight to the replica; a rewritten file invalidates it via the key fingerprint, and the recorded provider serving again clears it | `storage-failover.test.ts` |
| Mirror exemption (2026-09-22) | `services/cleanup.ts` only deletes from the file's recorded provider (old-object cleanup) or the provider registered in the blob index (blob GC) — other pool members hold externally synced mirror content and are never deletion targets | `storage-failover.test.ts` |
| Wiring | `serveFileObject` / `getFileObject` replace raw provider reads in path-serve, share gateway + preview, WebDAV GET/HEAD, S3 gateway GET/HEAD, AList direct links and the compat read endpoint | all gateway suites |

Real-stack check: a file whose recorded bucket was an unreachable S3 endpoint (connection hangs) still returned `200` after the 8 s candidate timeout by serving from the R2 pool member; follow-up requests took ~0.1 s (hint path), and `serve:loc:<fileId>` was present in KV.

Re-runnable acceptance: `scripts/verify-storage-failover.py` (builds the broken-primary mount and asserts both reads; cleans up after itself). See the development guide for prerequisites.

## Mount points are directories (§H, 2026-09-21)

The system materialises every non-root mount point as a real folder row in its **parent mount's namespace**, so the file page, share picker, public browser, WebDAV and AList all see it without any of them implementing mount synthesis.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Materialisation | `services/storage/mount-folders.ts`: row id `mountfolder:<mountId>`, `path` = absolute parent dir, `name` = last path segment, `object_key` = `folder:<absolute path>`, `custom_title` = mount display name | `mount-folders.test.ts` |
| Self-healing | Ensured on directory listing (child mounts of the listed path), on the admin mounts page, and by the scheduled task — all idempotent | `mount-folders.test.ts` |
| Mount lifecycle | Admin create/update/delete registers, migrates (path change) and removes the row; mount name changes refresh `custom_title` | `mount-folders.test.ts` |
| Protection | Renaming/moving/deleting a mount-point row, or a parent directory that contains a mount point, gets 409 | `mount-folders.test.ts` |

Rationale: the earlier behaviour left sub-mounts invisible in the file page (e.g. a mount at `/poolui` did not exist for listing code). Making the mount a folder row fixes every consumer at once and keeps a single source of truth.

**Failover candidates are buckets, never folders.** Read failover (§G) only ever considers `mount_providers` → `storage_providers` entries — real, independent buckets. Mount-point folders, user folders such as a "backup" directory, and copies inside the same bucket are not DR: they share the same failure domain. Cross-bucket replication remains the future Go-backend item below.

## Write-entry modes and the per-mount role matrix (§28, 2026-09-22)

Mounts gain two capabilities aimed at public upload areas (a `/public`-style mount): a write-entry mode and a per-mount default role permission matrix. Both default to today's behaviour — `upload_mode = 'free'` and no matrix rows — so existing mounts are untouched.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Write-entry mode | `mounts.upload_mode`: `free` (no extra constraint) / `user_space` (writes forced into `<mountPath>/<username>`, created on first use) / `flat` (folder creation rejected, uploads stay flat) | `upload-mode.test.ts` |
| Enforcement point | Every write channel funnels through the pre-write checks in `services/files/write.ts` — `/api/upload`, the compat upload endpoint, WebDAV PUT/MKCOL, the S3 gateway and AList behave identically | `upload-mode.test.ts` |
| Naming | Location uniqueness still comes from `object_key` (the mount-relative path, `UNIQUE (mount_id, object_key)`), never from content hashes: two users uploading `photo.jpg` into a flat mount collide by design (same row key → 409 "occupied by another user"), while equal content at different paths shares one physical object (§F) | `upload-mode.test.ts` |
| Owner semantics | Nobody can modify or delete another user's file (the owner fallback in `checkPermission`); directory owners get no inherited power over their subtree — admins cover that case | `mount-role-matrix.test.ts` |
| Role matrix | `mount_role_permissions(mount_id, role, permissions)`, evaluated after the file-owner fallback and before the role defaults: a present entry is a **closed set**, no entry falls back to the role defaults, `share` is excluded (the `can_share` capability bit governs sharing) and explicit `path_rules` of any origin always win | `mount-role-matrix.test.ts` |
| Admin surface | `GET /api/admin/mounts` returns `uploadMode` + `rolePermissions`; create and update accept both (`rolePermissions` replaces the whole matrix, `[]` clears it) | `mount-role-matrix.test.ts` |

Deliberately out of scope: MIME/size upload gates, per-mount upload quotas, and the review workflow — review only ever triggers for `visibility = 'public'` and its only consumer is the anonymous gallery, so a private-by-default upload area never reaches it.

## Pooled-mount placement strategies (§29, 2026-09-22)

The write-path bucket choice for a pooled mount (`mounts.pool_strategy`) grows from three options to five, and pool members gain a capacity cap and an upload order. All of it only affects **new** writes: reads and deletes resolve through `file_metadata.provider_id`, so existing objects stay where they are and no relocation job is needed.

| Strategy | Rule | Notes |
| :--- | :--- | :--- |
| `least_used` | Smallest `(used + 1) / weight` wins, ties by provider id | Unchanged; still the default |
| `round_robin` | KV cursor modulo member count | Unchanged |
| `hash` | FNV-1a of the **parent directory** modulo member count | Changed from whole-path hashing to directory-sticky, so one directory lands in one bucket and prefix listings stay contiguous |
| `free_weighted` | Largest `(capacity − used) × weight`; members without a capacity count as unlimited and rank first; every member full → `413 MOUNT_QUOTA_EXCEEDED`; no capacities configured at all degrades to `least_used` | New; needs `mount_providers.capacity_bytes` |
| `ordered` | Fills members by `sort_order` (ties by provider id), moving on only once the current member is full; no capacity means unlimited, so the first member always wins | New; needs `mount_providers.sort_order` |

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Schema | `001_initial.sql` §29: `mount_providers.capacity_bytes` (NULL = unlimited) and `mount_providers.sort_order` (default 0) | `storage-pool.test.ts` |
| Placement | `services/storage/pool.ts` `chooseMemberId` covers all five; `pickWriteProvider` keeps its signature so a full pool surfaces as a 413 to the caller | `storage-pool.test.ts` |
| Admin surface | `GET /api/admin/mounts` returns each member with `capacityBytes` + `sortOrder`; create/update accept `poolMembers: [{ providerId, weight?, capacityBytes?, sortOrder? }]` as a full replacement (a plain provider-id array stays supported as a shorthand) | `storage-pool.test.ts` |
| UI | Mount form: five-option strategy select plus per-member capacity and upload-order inputs | browser check |

## Pool-member capacity is a hard cap (§30, 2026-09-22)

A code-review finding on §29: the capacity check only asked whether a member was full **right now**, the placement functions never received the incoming size (a member with `capacity_bytes = 100` and nothing in it happily accepted a 180-byte object), and no member-level reservation existed, so two concurrent uploads could both pass the check and overshoot together. `storage-pool.test.ts` had pinned that wrong semantics (a 100-byte capacity accepting an 180-byte first write); the assertion was replaced, not preserved.

| Area | Change |
| :--- | :--- |
| Schema | `mount_providers.quota_reserved` (§30) — in-flight reserved bytes per member, same semantics as `mounts.quota_reserved` |
| Fit rule | `used (aggregated from file_metadata) + quota_reserved + incoming size <= capacity_bytes`; a `NULL` capacity means unlimited (never full, never reserved) — replacing the "is it currently full" test |
| Reservation | Conditional atomic UPDATE; zero affected rows means the member cannot take the object right now, so the next candidate in the strategy's order is tried and a 413 is raised only when none fits |
| Strategy scope | Capacity is a hard cap for **every** strategy: `hash`, `round_robin` and `least_used` fall back when their preferred member is out of room — a strategy only orders candidates |
| Lifecycle | Reserve on the write path and at upload-session init; release on success, failure, compensation and session expiry |
| Tests | Boundary (`used + size == capacity` passes, `+1` fails), size awareness (80 then 30 rejected, 80 then 20 accepted), concurrent reservation, release paths, unlimited-member regression, and a fallback/413 case per strategy |

## Bucket-scoped role matrices, explicit standby flag, two-layer capacity (§31, 2026-09-22)

The default role matrix can be configured per **bucket** instead of only per mount, "serves as a standby bucket" becomes an explicit flag, and capacity is split into two validated layers.

| Area | Implementation |
| :--- | :--- |
| Bucket matrices | `mount_provider_role_permissions(mount_id, provider_id, role)`; resolution order **bucket → mount → role defaults**, so an entry only changes behaviour where it exists |
| Read paths | Read, update, delete, download and share are judged against the **file's recorded bucket**, which the permission check now receives |
| Write paths | Placed inside the §30 candidate loop: a candidate whose bucket matrix forbids the action is skipped, so a strategy still only orders candidates and a 403 is raised only when every candidate refuses |
| Standby flag | `mount_providers.standby` replaces the "zero files for this mount" inference, which has been removed entirely: a flagged bucket stays a standby even when it holds files, and an unflagged empty member is no longer one |
| Standby rows | A standby lane renders one non-expandable node row per standby mount (amber hollow ring, no trunk connection) that scrolls to and highlights the mount row on the primary lane |
| Capacity layers | Per bucket `mount_providers.capacity_bytes` (placement hard cap, §30) plus the mount total `mounts.max_storage`; the total must not exceed the sum of bucket caps (uncapped buckets excluded) or the request is rejected with 400 |

## Sharing rework: multi-item shares (`§I`, 2026-09-21)

A share now carries 1..50 items (files, folders, or a mix) and you create it **only from the files page**; the share list became read/manage-only and surfaces every setting.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Data model | `share_items` (per-item order, cascades with share/file); `shares.file_id` keeps the first item for single-file compatibility and FK cascade | `share-items.test.ts` |
| Creation | `POST /api/shares { fileIds[] }`: de-duplicated, per-file `share` permission, `title` defaults to the item name (single) or "N 个项目" | `share-items.test.ts` |
| Public detail | `GET /api/shares/:id` returns `items` (display names from `file_metadata.name`); object keys and content hashes are never exposed | `share-items.test.ts` |
| Folder browsing | `GET /api/shares/:id/list?root=&sub=` lists a shared folder; the server normalises `sub` and requires it to stay inside the root subtree (403 otherwise) | `share-items.test.ts` |
| Item-scoped transfers | `download` / `preview` accept `itemId` (defaults to the first item) and accept descendants of a folder item (same mount, same owner, subtree) | `share-items.test.ts` |
| Creation entry | Files page row menu + bulk bar open `ShareDialog` (multi-select incl. folders); the settings page no longer offers creation and the update removed the dead `?create=` route | manual/browser |
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
| Leak handling | `finally` releases the slots (errors included); the code treats slots older than 30 minutes as a leak and sweeps them opportunistically | `concurrency-limit.test.ts` |

## Role permissions, aliases and guest visibility (§K, 2026-09-21)

The role model became explicit in the database so the admin UI shows what actually governs behaviour.

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Role defaults | `role_defaults.permissions` (JSON array of `read`/`write`/`update`/`delete`/`download`; `share` deliberately excluded because sharing is the `can_share` capability). Seeds: `admin` and `user` = all five, `guest` = `download` only; built-in roles also seed `capabilities=['can_share']` so "shareable by default" is visible | `role-permissions.test.ts` |
| Per-user overrides | `users.permissions` (NULL = follow the role). Precedence: `users.permissions` → `role_defaults.permissions` → `DEFAULT_ROLE_PERMISSIONS`. Saving role defaults overwrites every member's individual value (explicit requirement) | `role-permissions.test.ts` |
| Aliases | `role_defaults.alias` is a display alias that permission rules may target: `loadPrincipalRules` resolves role + aliases into the rule candidates (`role IN (...)`) | `role-permissions.test.ts` |
| Guest visibility | `file_metadata.guest_visibility` (`NULL` / `none` / `download` / `view`), edited in the file properties panel under "Default user permissions". Anonymous access additionally requires the site-level `allow_guest_access` switch; `NULL` never opens a file by itself, so private files stay private | `role-permissions.test.ts` |

Terminology note: the **guest role** (a signed-in account with `role='guest'`) defaults to download-only; the file's `guest_visibility` plus the site switch governs **anonymous visitors**. The two are independent.

## Share forwarding panel and password recall (§L, 2026-09-21)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Password recall | Creating a share stores `password_hash` (verification) **and** `password_cipher` (AES-GCM, `enc:` prefix). Only the creator's `GET /api/shares` decrypts and returns `password`; public endpoints never expose the plaintext or the cipher, and a failed decryption omits the field | `share-password.test.ts` |
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
| Direct-link prefix | `direct_prefix` (`''` / `/d` / `/download` / `/raw`) scopes public and signed direct links, and `root_target` decides whether `/` serves the landing page, the file page or the direct-link namespace — both are selectable in admin → System settings and validated together (a non-empty direct prefix cannot own `/`). The file browser stays at `/files`: a configurable files-page prefix failed review as too risky | `route-prefixes.test.ts` |

## File ban governance, dashboard rework and admin files columns (§N, 2026-09-22)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| File ban | `file_metadata.banned` (migration §26) + `PUT /api/admin/files/:id/ban`; `assertNotBanned` (`services/files/ban.ts`) gates all content outlets (file download, path-serve, share download/preview, gateway) with `429 FILE_BANNED`; delete is intentionally not blocked; owner-side ghost state is presentation-only (dimmed row, delete-only menu) | `files-ban.test.ts` (22 cases) |
| Admin files columns & filters | Storage bucket / mount point / content-hash columns, per-page batched `IN` enrichment (mounts, `blob_objects`, providers — no N+1); filters `mount` / `bucket` / `hash` (substring) / `user` / `visibility` / `banned`; ban/unban entry with `ConfirmDialog`; rows with banned selections collapse the bulk bar to delete-only | `files-ban.test.ts` |
| Mount capacity | `mounts.capacity_bytes` persisted via create/update; `Mount.capacityBytes` in shared types; dashboard aggregates Σ capacity (null when all unset) | `mount-quota.test.ts` |
| Dashboard rework | `DashboardRepo.stats()` (role counts, files, used space, providers, active mounts, total capacity) + `DashboardRepo.mounts()` (primary provider, standby pool members, per-mount usage/file count) in `db/repos/dashboard.ts` — batched queries, no N+1; UI: four single-row stat cards, mount relation diagram (primary solid pill + standby outline pills), storage usage with capacity bars, recent activity (6) | `dashboard.test.ts` |
| Admin settings restructure | System settings page split into Site / Security / SMTP / Announcements cards; settings Appearance/Profile/Security merged into Personalization with files-per-row slider | frontend |

## Flat tree views, bucket lane graph and announcement display policies (2026-09-22)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Display policy storage (migration §27) | `announcements.display_mode` / `interval_seconds` / `kind`; `AnnouncementSchema` gains `displayMode` / `intervalSeconds` / `endsAt` / `kind` (replaces `expiresIn`); `PUT` keeps title/content/level/active | `mount-tree.test.ts` |
| Bucket tree repos | `DashboardRepo.bucketTree()` (per-bucket mounts from `file_metadata.provider_id`, role primary/member, standby entries for zero-file backups) + `DashboardRepo.mountFolderSummary()` (top-level folders with recursive counts, bucket-filtered, zero-count folders dropped) | `mount-tree.test.ts` |
| Flat tree repos and routes | `FileRepo.listTree()` (path-prefix rows, LIKE-escaped, owner join, structural filters keep folder rows, 5000-row cap) + routes `GET /api/admin/mount-tree`, `GET /api/admin/dashboard/mount-folders`, `GET /api/admin/files/tree`, `GET /api/files/tree` (entry-path read check, per-nested-mount re-check, §4.4a private-folder filter for non-admins) | `mount-tree.test.ts` (6 cases) |
| Tree and mount views | `TreeView.tsx` (single-child chain flattening, virtual rows, folder-row click expands), admin tree view with server filters plus a client name search, admin mount view (bucket → mount → folder → file, per-level guides), files page gains the tree mode and hides breadcrumb/pagination there | frontend |
| Bucket lane graph | Dashboard active-mounts card becomes bucket lanes with level-1 mount nodes (hollow/solid dots, fork connectors, per-level guide lines), collapsible buckets (default open), multi-open mounts, standby badge highlights the primary lane for 3s | frontend |
| Banner policies and toasts | Client policy renderer (always/daily/interval/until/duration plus a local timestamp map), `kind=toast` temporary popups with title/content through the toast system, left color stripe removed; admin form adds kind/mode selects with conditional interval/until/duration inputs and per-row policy summaries | frontend |
| Layout and tokens | Bounded height chain (`h-screen` shell, banner-aware table shrink, `flex-1 min-h-0` replacing viewport-`calc` caps), native scrollbars removed, sidebar indicator `inset-x-2` plus primary hover tokens, dropdown/select accent tokens, drawer entrance on the Dialog transition pattern, per-device cards-per-row (mobile 2–4 default 3) | frontend |

## Motion tiers, entrance animations and admin table headers (§33, 2026-09-22)

| Area | Implementation | Tests |
| :--- | :--- | :--- |
| Motion tiers | `theme.motionLevel` (`off` / `default` / `all`) on `<html data-motion>` with centralized CSS gating in `index.css`: `off` kills all animation/transition, `default` keeps functional animations (charts, tabs, dialogs, drawers, loading) and drops decorative entrances, `all` adds them; `prefers-reduced-motion` falls back to the same 0.01ms + zero-delay treatment; `MotionSlider` in appearance settings | frontend |
| Reveal primitives | `components/ui/reveal.tsx`: `.reveal` (fade + 8px rise) and `.reveal-row` (fade only, no row translation) keyframes, `revealDelay` / `innerDelay` delay helpers (block step 40ms, fine step 25ms, inner base 60ms, capped at the tenth item), `animation-fill-mode: both` so the first frame reserves space | frontend |
| Page coverage | Two-layer entrance ordering (toolbar → card → header → rows) on dashboard, users, all files, logs, permissions, shares, mounts, providers, access rules, API keys, personalization, settings, shares settings; card-inner fields fade row by row via `innerDelay`; dashboard spacing unified with settings (16px vertical, 24px column rhythm) | frontend |
| Flat tree entrance | Tree rows stagger once per view mount behind a settled gate (~700ms) so virtual-scroll remounts never replay; view switching (`key={view}`) re-runs the entrance | frontend |
| Dropdown cascade | Direct children of `.animate-dropdown` fade in one by one in the `all` tier (30ms base, 20ms step, capped at the twelfth item) | frontend |
| Table headers | Admin files/logs keep the committed two-part header (header table outside the scroll container on card glass) — the sticky frosted-header experiment was reverted after Chromium's `backdrop-filter` proved not to sample content scrolled under sticky elements; body horizontal scroll syncs the header via `translateX(-scrollLeft)`; name/path columns gained `minmax` floors so narrow containers overflow into horizontal scrolling instead of collapsing tracks onto neighboring columns; headers are `whitespace-nowrap` single-line (shares table header collapsed from two lines to one) | frontend |
| Trends endpoint docs | `GET /api/admin/dashboard/trends` documented in both API references (metric/granularity/from/to, 2-year cap, 400-bucket ceiling) | docs |

## Current baseline

- Backend: 40 test files / 359 Vitest tests pass; `tsc --noEmit` clean.
- Frontend: 3 test files / 14 Vitest tests pass; coverage gate passes (91.8% statements / 72.7% branches / 83.3% functions / 93.2% lines); build succeeds; `tsc --noEmit` clean.
- Language: zh + en.

## What's next

- Oracle Cloud provider implementation.
- Configurable **direct-link prefix** (implemented): the prefix applies to public/signed file direct links only (`direct_prefix`: `''` / `/d` / `/download` / `/raw`) plus a `root_target` choice for what `/` serves — both editable in admin → System settings. The file browser page stays fixed at `/files`; a configurable files-page prefix failed review as too risky (it competes with the landing page, the guest catch-all route and the direct-link namespace).
- Same-path multi-mount: spread across providers ships in `mount_providers`; the future Go backend owns replication/backup — see below.
- Path-variable DSL (`{year}/{month}`).
- Admin analytics.
- Hot-file detection and forced signed URLs.
- Ongoing verification notes for drag interactions and property-panel editing.

## Planned: future high-performance backend (2026-09-21)

A future Go backend owns cross-bucket replication (copying objects into secondary buckets) ("high-performance version"). The current Workers implementation spreads each object across pool members (`least_used` / `hash` / `round_robin`) and reads fail over across those members (§G), but it never copies objects between buckets.

Planned admin surface for it: a per-mount **"automatic cross-bucket sync"** switch on the admin storage page. The switch is **only selectable in a Go-backend environment**; the current Node/Workers backend does not implement the capability, so the control is documented as environment-gated and must render disabled (not hidden) there. Pooling (§E) and read-path failover (§G) work today without it — the switch only turns on background replication.

| Item | Decision | Target |
| :--- | :--- | :--- |
| Same-path multi-storage backup / DR | Same-path multi-mount becomes replication (mirror), not spread | Future Go backend |

### Same-path multi-storage backup / DR

- Today: `mount_providers` spreads each object across members — one copy per file. Reads already fail over across members (§G), but without replication a bucket loss means the objects it held are gone. Two mounts on the same path do not merge: `MountRepo.findMountForPath` picks one by priority then depth, so only the first mount ever serves that path.
- Target model: `file_replicas(file_id, provider_id, etag, size, status, verified_at)` with `file_metadata.provider_id` kept as the primary replica. Write fan-out (primary synchronous, replicas asynchronous through a queue), read failover, per-replica delete and GC, verification/repair job.
- Prior art to borrow from: rclone's `union` backend (`create_policy=all` mirrors writes to every upstream, `epmfs`/`lus` spread, `:ro`/`:nc`/`:writeback` tags), MinIO site replication (active-active / active-passive with an async scanner that re-queues failed objects), SeaweedFS rack-/DC-aware replication placement.
- Why this is not a simple switch:
  - No cross-provider transactions or atomic compare-and-swap: partial replica writes need compensation/repair jobs, and concurrent overwrites can diverge without generation/ETag checks.
  - Failover reads may serve stale replicas; strict freshness costs a HEAD per read.
  - Presigned/direct links are bound to a single provider's domain (`buildFileAccessUrl`); switching replicas invalidates them unless every link goes through one proxy domain (R2 worker egress is free; S3/Oracle would incur Worker egress).
  - Multipart uploads must write every part to every replica, or re-transfer afterwards (CopyObject is same-provider in practice).
  - N× physical storage cost; pool heuristics such as `least_used` are meaningless for a mirrored mount (every member needs the full data set).
- Preferred platform-level path: provider-side replication (R2 durability is replication + erasure coding; use bucket replication/versioning where available) plus the existing reconciliation job; application-level fan-out belongs to the future backend, where the write path allows optimization (streaming multi-write, checksums).

Related guides: [architecture](ARCHITECTURE.md), [API reference](API.md), [frontend guide](UI.md), [development guide](DEVELOPMENT.md), [deployment guide](DEPLOYMENT.md).
