# Configuration

All credentials must be entered through AppDeploy private secret entry. Never commit secret values, `.env` files, OAuth tokens, webhook secrets, or copied AppDeploy secret payloads.

## Current production secrets

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

The encryption key must decode to exactly 32 bytes. Google access and refresh tokens are persisted only as AES-256-GCM ciphertext with a unique IV.

## Planned Microsoft configuration

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TOKEN_ENCRYPTION_KEY`

Microsoft access should request only the minimum read-only mail and offline-access scopes required for discovery. Do not request send, delete, modify, mailbox-settings, contacts, files, or calendar permissions.

## Planned Stripe configuration

- `STRIPE_RESTRICTED_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_PRICE_PRO_ANNUAL`

Use separate test and live credentials. Prefer a restricted API key with only the permissions required for Checkout Sessions, Customers, Subscriptions, and Billing Portal sessions. Webhook signatures must be verified before processing events. Stripe entitlement state must be derived server-side and must never trust a browser redirect alone.

Do not enable Stripe automatic tax until applicable registrations are active and the commercial tax decision has been reviewed.

## Public configuration

Frontend responses may expose only derived booleans such as whether an integration is configured. They must never include credentials, OAuth tokens, encryption material, or webhook secrets.

