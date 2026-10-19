# Carrefour Express recovery — 19 October 2026

## Confirmed causes

- The initial generation ran all six checks on the untouched example template and reported completion.
- Later generation replaced working authentication/runtime contracts with incompatible code and wrote multiline SQL in single-quoted strings.
- Repairs to `backend/src/routes/cart.ts` without `area: backend` created a shadow file below `frontend/`; the actual backend stayed broken.
- The frontend duplicated its API client, used optional response fields incorrectly, and sent absolute `/api` requests despite deployment below a path prefix.
- Generic authenticated verification required the example todo UI, preventing other domains from passing legitimately.

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

## Recovery copies

Server directory: `/home/ubuntu/appforge-backups/carrefour-20261019/`.
Original project: `project-before.tgz`. Original Studio image tag: `appforge-edu-studio:before-carrefour-20261019`.
No existing live Carrefour deployment existed before this repair.
