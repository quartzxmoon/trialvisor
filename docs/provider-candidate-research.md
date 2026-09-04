# First production provider candidate

Reviewed September 3, 2026. Capability labels must describe deployed, tested behavior—not vendor familiarity or a browser automation prototype.

## Decision

No reviewed consumer provider offers a customer-wide cancellation API suitable for a truthful Trialvisor Autopilot adapter. Trialvisor therefore implements Canva as the first **Guided** workflow, not Autopilot:

1. Trialvisor preserves the customer’s explicit Protect authorization and Safe Cancel Deadline.
2. At execution time it raises persistent Action Required and links to Canva’s official, purchase-channel-aware cancellation instructions.
3. A customer report that the steps were completed remains unverified.
4. A connected Gmail sync may verify a later Canva confirmation only when the sender domain is Canva, Gmail reports a passing Canva DKIM identity, the language describes completed cancellation, the message postdates Protect authorization, and exactly one eligible protected Canva item exists.
5. Trialvisor stores the provider/message/thread reference and normalized evidence timestamp, not the complete email body.

Official source: [Canva cancellation help](https://www.canva.com/help/cancel-canva-plan/).

## Candidate assessment

| Provider | Current truthful tier | Reason |
| --- | --- | --- |
| Canva | Guided, validation pending | Official instructions vary by purchase channel and require the customer to perform the cancellation. Canva documents a confirmation email, which creates a narrow independent-verification candidate. |
| Zoom | Not yet supported | The official web-portal flow still requires account-holder action and may vary for third-party purchases. |
| Dropbox | Not yet supported | Cancellation and consequences vary by purchase channel; mobile purchases are managed by Apple or Google. |
| Adobe | Not yet supported | Account-holder action is required, third-party purchases follow other paths, and some annual plans can involve early-termination fees. |

Official research sources:

- [Zoom cancellation instructions](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0083524)
- [Dropbox mobile-plan cancellation](https://help.dropbox.com/plans/cancel-mobile)
- [Adobe cancellation instructions](https://helpx.adobe.com/manage-account/using/cancel-subscription.html)
- [Adobe subscription terms](https://helpx.adobe.com/account/individual/terms-policies-and-regulations/adobe-subscription-terms.html)

## Promotion gate

Canva stays Guided and “implementation validation pending” until a real protected Canva item is canceled through the official flow and a real authenticated confirmation is detected, tenant-matched, persisted without a full body, surfaced in the dashboard, and shown to revoke remaining scheduled jobs. This test does not promote Canva to Autopilot because Trialvisor still does not execute the provider action.
