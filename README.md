# Trialvisor

Trialvisor is a free-trial protection SaaS. It discovers trial and subscription signals, keeps discovery separate from cancellation authority, schedules explicitly authorized actions, and records evidence only after cancellation is verified.

## Production

- AppDeploy app ID: `trialvisor-m8vrsu`
- Production URL: <https://trialvisor-m8vrsu.v2.appdeploy.ai/>
- Baseline snapshot: `1788408507917`
- Figma source of truth: <https://www.figma.com/design/bEVDjkOG5a6zYvE0iaHtEa>

This repository is a secret-free copy of the AppDeploy production source. AppDeploy remains the application runtime and deployment source of truth until an automated, verified repository-to-AppDeploy release workflow is established.

## Product invariants

- Inbox detection creates `REVIEW_REQUIRED` findings only.
- `PROTECT` is an explicit, tenant-scoped cancellation authorization.
- Cancellation jobs are durable and execute server-side.
- Provider completion is not treated as success until independently verified.
- Connected-inbox tokens remain backend-only and encrypted at rest.
- Retained Gmail data is limited to normalized signals and necessary message/thread references; full message bodies are not stored.

## Local validation

```sh
npm install
npm run typecheck
```

`@appdeploy/client` is injected by AppDeploy during its production build and is deliberately not installed from npm. The repository includes an ambient type declaration for local type validation; AppDeploy deployment QA is the authoritative bundle and runtime test.

The production-facing QA scenarios are documented in `tests/tests.txt`. They are executed by AppDeploy after deployment and cover public trust surfaces, onboarding, explicit Protect authorization, persistent notifications and activity, customer data controls, Gmail discovery safety, and responsive provider-failure behavior.

## Trust and customer controls

- Public lifecycle guide: `/how-it-works`
- Security architecture and reporting: `/security` and `/contact/security`
- Truthful provider capability directory: `/providers`
- Confirmed production subprocessors: `/subprocessors`
- Authenticated Notification Center, activity timeline, data export, feedback, disconnect, and guarded account deletion

Implementation boundaries and the future status-page gate are documented in `docs/trust-data-controls.md` and `docs/system-status-readiness.md`.

## Current launch gates

- Complete one controlled real-mailbox Gmail detection and verify persistence/rendering.
- Replace the demonstrative Tier 1 cancellation result with real provider adapters and independent verification.
- Configure Microsoft OAuth and validate Microsoft Graph discovery.
- Attach Stripe test credentials and Price IDs, configure the signed webhook endpoint, and complete Checkout/Portal end-to-end validation.
- Publish final privacy policy, terms, data-retention policy, support process, and incident-response runbook.

See `docs/configuration.md`, `docs/deployment.md`, and `docs/stripe-setup.md` before changing production.
