# Stripe test-mode setup

Trialvisor billing is deployed but intentionally disabled until all four AppDeploy secrets are attached. Complete this in a Stripe sandbox before considering live mode.

## 1. Create the Trialvisor Pro product

1. Open Stripe Dashboard and select a sandbox/test environment.
2. Open **Product catalog** and select **Add product**.
3. Name the product **Trialvisor Pro**.
4. Add one recurring monthly Price and one recurring annual Price.
5. Record both `price_...` identifiers. Do not copy them into chat or source control.

Pricing is a commercial decision. Keep the monthly and annual Prices attached to the same Trialvisor Pro Product because they are billing variants of one plan.

## 2. Configure the Customer Portal

1. Open **Settings → Billing → Customer portal** in the same sandbox.
2. Enable payment-method updates, invoice history, and subscription cancellation.
3. Configure cancellation to take effect at the end of the paid period unless Trialvisor deliberately adopts a different refund policy.
4. Leave plan switching disabled initially. It can be enabled after monthly/annual switching and proration behavior are tested.
5. Save the sandbox portal configuration.

## 3. Create a restricted API key

1. Open **Developers → API keys → Restricted keys** in the sandbox.
2. Create a key named **Trialvisor AppDeploy test billing**.
3. Grant only the permissions required to create Checkout Sessions and Billing Portal Sessions and to access supporting Customers, Subscriptions, Products, and Prices.
4. Do not grant access to payouts, balances, disputes, issuing, treasury, connect accounts, or unrelated payment operations.
5. Add an IP restriction if AppDeploy provides stable outbound IP addresses. Otherwise retain the least-privilege resource restrictions.
6. Store the resulting `rk_...` value only through AppDeploy private secret entry as `STRIPE_RESTRICTED_KEY`.

## 4. Register the webhook

1. Open **Developers → Webhooks** in the same sandbox.
2. Add this endpoint:

   `https://api-v2.appdeploy.ai/app/trialvisor-m8vrsu/api/billing/webhook`

3. Subscribe to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Save the endpoint.
5. Reveal its `whsec_...` signing secret and store it only through AppDeploy private secret entry as `STRIPE_WEBHOOK_SECRET`.

## 5. Attach AppDeploy secrets

Use four separate AppDeploy private secret-entry links:

- `STRIPE_RESTRICTED_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_PRICE_PRO_ANNUAL`

Never paste any of these values into chat, GitHub, Figma, logs, or frontend configuration.

## 6. Required validation before live mode

1. Complete monthly sandbox Checkout.
2. Confirm the signed webhook changes the tenant entitlement from Free to Pro.
3. Refresh and verify Pro remains durable.
4. Open Customer Portal and update the payment method.
5. Cancel at period end and verify the portal webhook updates Trialvisor.
6. Send the same Stripe event twice and confirm the second delivery is idempotent.
7. Trigger a failed sandbox payment and confirm a persistent billing state plus user notification.
8. Confirm another Trialvisor tenant cannot access the customer or subscription.
9. Repeat the complete test for the annual Price.

## Tax safety

Trialvisor does not enable Stripe automatic tax. Before enabling it, confirm the business head-office address, the correct SaaS product tax code, and active registrations for every jurisdiction where tax must be collected. Stripe silently collects zero tax where no active registration exists.
