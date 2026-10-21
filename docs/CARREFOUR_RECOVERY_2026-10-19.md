# Carrefour Express recovery — 19 October 2026

## Confirmed causes

- The initial generation ran all six checks on the untouched example template and reported completion.
- Later generation replaced working authentication/runtime contracts with incompatible code and wrote multiline SQL in single-quoted strings.
- Repairs to `backend/src/routes/cart.ts` without `area: backend` created a shadow file below `frontend/`; the actual backend stayed broken.
- The frontend duplicated its API client, used optional response fields incorrectly, and sent absolute `/api` requests despite deployment below a path prefix.
- Generic authenticated verification required the example todo UI, preventing other domains from passing legitimately.
- The shared-host nginx proxy stripped `/appforge/` but did not rewrite the session cookie Path. Registration appeared successful publicly while subsequent authenticated requests failed.
- A successful deployment left its preview registered as ready. Since `/a/:id/` prefers that preview, public traffic still reached a temporary database. The pipeline now retires the preview after live health succeeds; failed builds preserve it.
- Subsequent deployment backups tried to chown the Studio's backup to application UID 1001, which fails when the Studio runs as UID 1000. Backups now retain Studio ownership with mode 0600; a Docker probe confirmed restore copies take the destination application's UID and remain writable.

## Platform changes

- Reject area prefixes in area-relative file paths with an actionable diagnostic, including when a shadow file already exists.
- Use consistent dynamic project instructions and include the actual backend/auth/API contracts in generation context.
- Track dynamic compiler failures during repair and include the concrete diagnostics in recovery prompts.
- Refuse completion of an unchanged starter, on the first run and on later retries.
- Generic authentication checks verify registration, session attributes, separate user identities, browser session recovery and logout independently of business domain and language. Mandatory project API tests remain responsible for domain CRUD, transactions and ownership.
- Dynamic completion messages describe verification/preview accurately and do not imply publication.

## Carrefour repair

Recover the template's configuration, Node SQLite, Argon2id and random revocable sessions; extend it with the supermarket domain. Keep integer cents, per-user carts, stock validation, transactional checkout, idempotent order requests, private order history, relative API URLs and a public 50-product catalog. Preserve the previous files in a recovery archive. Category photographs are illustrative and carry attribution; they are not exact product photographs.

## Validation

- Worker/server TypeScript checks pass.
- 50 targeted worker tests passed; the final additional repeated-starter regression passed in the 7-test completion-gate suite.
- Carrefour frontend/backend compile and 22 API tests pass, including invalid quantities, forged sessions, user isolation, idempotency, stock conflicts, rollback and session recovery.
- Final production verification is recorded separately with the maintenance run and deployment in AppForge.
- All six checks passed on the repaired sources. Docker deployment `959fba64-c276-419f-8eed-d40e3a8f184f` reached `live`.
- Public Chromium flow passed: catalog/filter/search, registration, cart quantity changes and reload, checkout totals/stock/cart clearing, logout protection and login history. Mobile layout has no horizontal overflow and its photographs load. No JavaScript errors or failed network requests occurred.
- Restarting `appforge-app-bdc402c3` preserved the browser session, order and inventory in the persistent database.

## Shared-host operational fixes

Within the existing `/appforge/` nginx location, add `proxy_cookie_path /a/ /appforge/a/;`. This retains each project's cookie scope while matching its external URL. On this host the active configuration is the regular file `/etc/nginx/sites-enabled/mi-gps`, not the stale copy in `sites-available`. Back up the active file, run `nginx -t`, and reload only after validation.

Build the Studio image from the Linux Git checkout. Copying a Windows checkout with CRLF line endings changed the trusted Dockerfile bytes; the deployment driver correctly refused the mismatch. Rebuilding from commit `0e07e9c` in Linux resolved it without weakening the trust check.

Public store: https://jpecina.duckdns.org/appforge/a/bdc402c3-9871-4024-abf1-823ab2c3a065/ . This educational store records orders and inventory; it does not process payments or shipments. Its seven category photographs are explicitly illustrative.

## Recovery copies

Server directory: `/home/ubuntu/appforge-backups/carrefour-20261019/`.
Original project: `project-before.tgz`. Original Studio image tag: `appforge-edu-studio:before-carrefour-20261019`.
No existing live Carrefour deployment existed before this repair.
