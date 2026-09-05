# Trialvisor

Trialvisor is a free-trial protection SaaS. It discovers trial and subscription signals, keeps discovery separate from cancellation authority, schedules explicitly authorized actions, and records evidence only after cancellation is verified.

## Production

- AppDeploy app ID: `trialvisor-m8vrsu`
- Production URL: <https://trialvisor-m8vrsu.v2.appdeploy.ai/>
- Applied snapshot: inspect AppDeploy version history before each release; do not rely on a stale hard-coded identifier.
- Figma source of truth: <https://www.figma.com/design/bEVDjkOG5a6zYvE0iaHtEa>

This repository is a secret-free copy of the AppDeploy production source. AppDeploy remains the application runtime and deployment source of truth until an automated, verified repository-to-AppDeploy release workflow is established.

## Product invariants

- Inbox detection creates `REVIEW_REQUIRED` findings only.
- `PROTECT` is an explicit, tenant-scoped cancellation authorization.
- Cancellation jobs are durable and execute server-side.
- Provider completion is not treated as success until independently verified.
- Connected-inbox tokens remain backend-only and encrypted at rest.
- Retained Gmail data is limited to normalized signals and necessary message/thread references; full message bodies are not stored.
- Gmail discovery uses bounded focused searches for initial/validation runs, paginated incremental history after checkpoints, versioned candidate reprocessing, and thread/provider/date deduplication. Every match remains `REVIEW_REQUIRED`.
- Stripe Checkout and Customer Portal remain backend-created; Pro entitlement is webhook-authoritative, requires a server-created Checkout record, is globally tenant/customer-bound, Price-allowlisted, replay-aware, and grants new Protect authorization only while the verified subscription remains active or trialing.
- Billing changes must never silently cancel or abandon an already-authorized protection obligation.

## Local validation

```sh
npm install
npm run verify
```

`@appdeploy/client` is injected by AppDeploy during its production build and is deliberately not installed from npm. The repository includes an ambient type declaration for local type validation; AppDeploy deployment QA is the authoritative bundle and runtime test.

The production-facing QA scenarios are documented in `tests/tests.txt`. AppDeploy can use them for deployment QA, but a release must inspect the returned QA status because some deployments may return no automated E2E job. Executable provider parsing, confidence, and DKIM regression tests live under `tests/*.test.ts`; `npm run verify` runs them with all typechecks and the production build.

## Trust and customer controls

- Public lifecycle guide: `/how-it-works`
- Security architecture and reporting: `/security` and `/contact/security`
- Truthful provider capability directory: `/providers`
- Confirmed production subprocessors: `/subprocessors`
- Authenticated Notification Center, activity timeline, data export, feedback, disconnect, and guarded account deletion

Implementation boundaries and the future status-page gate are documented in `docs/trust-data-controls.md` and `docs/system-status-readiness.md`.

## Current launch gates

- Complete one controlled real-mailbox Gmail detection and verify persistence/rendering.
- Complete the real-world validation gate for the deployed Canva Guided workflow and Gmail-authenticated confirmation evidence; keep Canva out of Autopilot because the customer still performs the provider action.
- Configure Microsoft OAuth and validate Microsoft Graph discovery.
- Complete authenticated Customer Portal navigation plus Stripe test-clock renewal, failed-payment, replay, and final-expiration validation before any live-mode migration.
- Publish final privacy policy, terms, data-retention policy, support process, and incident-response runbook.

See `docs/configuration.md`, `docs/deployment.md`, and `docs/stripe-setup.md` before changing production.
