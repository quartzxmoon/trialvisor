# Deployment and operations

## Platform

Trialvisor deploys through AppDeploy as a React/Vite frontend plus an AppDeploy backend. Persistent data, authentication, secrets, notifications, and the durable cron worker use AppDeploy-native facilities.

## Release procedure

1. Inspect the currently applied AppDeploy source version before editing.
2. Review AppDeploy deployment instructions and the SDK references for every changed capability.
3. Apply the smallest source diff that preserves authentication, tenant isolation, the state machine, scheduling, and audit behavior.
4. Deploy to app ID `trialvisor-m8vrsu`.
5. Poll until AppDeploy reports a terminal status.
6. Inspect frontend, backend, network, worker, desktop, and mobile QA results.
7. Automatically fix material defects before declaring a release ready.
8. Export the final applied snapshot into this repository and commit the exact version identifier.

## Rollback

Use AppDeploy version history to apply the last known-good snapshot. Do not use destructive Git resets or delete production data. After rollback, verify authentication, dashboard loading, Google connection state, Protect authorization, and the durable worker.

## Durable worker

The `durable-actions` cron runs every five minutes. Jobs must be idempotent, tenant-scoped, and bounded per invocation. Frontend availability must never control scheduled protection.

## External-integration release gates

- Google: complete OAuth plus at least one real detected, normalized, persisted, and rendered Gmail signal.
- Microsoft: complete OAuth plus at least one real Graph-discovered signal.
- Stripe: complete test Checkout, signed webhook processing, entitlement persistence, Customer Portal, cancellation, and failed-payment behavior before live mode.
- Cancellation providers: verify the remote postcondition independently; a click or HTTP 200 alone is not evidence of cancellation.

