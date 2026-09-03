# Trust, data controls, and customer accountability

Trialvisor's public trust surfaces are `/how-it-works`, `/security` (also `/trust`), `/providers`, `/subprocessors`, and `/contact/security`. Claims on these pages must stay aligned with deployed behavior.

## Authorization boundaries

- Connecting an inbox grants read-only discovery access; it does not authorize cancellation.
- A detected signal is stored as `REVIEW_REQUIRED`; it does not authorize cancellation.
- Protect is an explicit user action. Auto Cancel authority, when offered, is part of that explicit authorization and is recorded in the audit trail.
- A cancellation attempt is not a Verified Cancellation. Verification requires independent provider evidence.
- Estimated savings and Confirmed Savings remain distinct. Only verified avoided charges count as confirmed.

## Customer-visible records

Meaningful events are written to tenant-scoped persistent notifications and the customer-readable activity timeline. Timeline actors are classified as `USER ACTION`, `TRIALVISOR ACTION`, or `PROVIDER RESULT`. Neither surface exposes OAuth tokens, secrets, raw system traces, or complete email bodies.

## Data Controls

Settings describes what Trialvisor accesses, processes, stores, and retains. Account export excludes OAuth credentials and secrets. Disconnect revokes provider access where possible and destroys the local encrypted token, but does not silently delete unrelated normalized account history. Account deletion uses a two-step confirmation, attempts provider revocation, removes Trialvisor tenant records, and does not claim to delete the identity held by AppDeploy authentication.

## Feedback and security reports

Authenticated feedback accepts safe object identifiers, provider name, current screen, category, description, and timestamp. Token-like material is rejected. Public security reports accept a bounded category, description, and optional reply address, use a honeypot field, and reject common credential patterns. No public bug-bounty promise exists.

## Provider capability truthfulness

The provider directory must not label a provider `AUTOPILOT` until a production-grade cancellation adapter and independent verification path have passed production validation. Current capability labels are intentionally conservative.
