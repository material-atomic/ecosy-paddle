# Changelog

## 0.1.0

First cut, written for RunSnip's plans and kept free of it.

### Added

- `PaddleBilling({ apiKey, environment?, webhookSecret?, planKey?, taxCategory? })`
  — a class token, like the other `@ecosy` factories. The environment is read
  from the key and a mismatch is refused.
- Catalogue: `catalogue()`, `prices(planId)`, `product(plan)`,
  `addPrice(plan, { interval, amount, currency?, trialDays? })`,
  `archivePrice(priceId)`. A plan is one Paddle product found by
  `custom_data.plan_id`; its prices are tagged the same way.
- Webhooks: `webhook(rawBody, signature)` checks the signature and reduces
  `subscription.*` events to `planId`, `paidUntil`, `cancelsAt`, `customData`,
  `occurredAt`. Other events come back as `{ kind: "other" }`.
- `PaddleConfigError`, `WebhookSignatureError`, `CatalogError`.
