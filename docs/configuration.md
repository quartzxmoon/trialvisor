# Configuration

All credentials must be entered through AppDeploy private secret entry. Never commit secret values, `.env` files, OAuth tokens, webhook secrets, or copied AppDeploy secret payloads.

## Current production secrets

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`
- `STRIPE_RESTRICTED_KEY`
- `STRIPE_WEBHOOK_SECRET`

The encryption key must decode to exactly 32 bytes. Google access and refresh tokens are persisted only as AES-256-GCM ciphertext with a unique IV.

## Planned Microsoft configuration

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TOKEN_ENCRYPTION_KEY`

Microsoft access should request only the minimum read-only mail and offline-access scopes required for discovery. Do not request send, delete, modify, mailbox-settings, contacts, files, or calendar permissions.

## Current Stripe sandbox configuration

The deployed test-mode backend reads only `STRIPE_RESTRICTED_KEY` and `STRIPE_WEBHOOK_SECRET`. The two approved Trialvisor Pro sandbox Price IDs are backend allowlist identifiers, not secrets, and are configured in `backend/billing.ts`.

Use separate test and live credentials. The restricted key grants Write only for Checkout Sessions and Customer/Billing Portal Sessions; all other Stripe resources remain None. The backend does not directly call Customers, Subscriptions, Products, Prices, Events, Webhook Endpoints, Connect, payouts, balances, or disputes. Webhook signatures must be verified before processing events. Stripe entitlement state is derived server-side and never trusts a browser redirect alone.

Stripe webhook URL:

`https://api-v2.appdeploy.ai/app/trialvisor-m8vrsu/api/billing/webhook`

Subscribe at minimum to:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

The Customer Portal is configured separately in the Trialvisor sandbox with payment-method updates, invoice history, end-of-period cancellation, and cancellation reasons enabled. Plan switching remains disabled.

Do not enable Stripe automatic tax until applicable registrations are active and the commercial tax decision has been reviewed.

## Public configuration

Frontend responses may expose only derived booleans such as whether an integration is configured. They must never include credentials, OAuth tokens, encryption material, or webhook secrets.
