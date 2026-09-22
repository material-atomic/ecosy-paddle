# Changelog

## Unreleased

### Added

- `checkout({ priceId, email, name?, customData })` — a draft transaction made
  on the server for Paddle.js to open; the customer is found by email or made.
  Refuses prices no plan owns and archived ones.
- `portal(customerId, subscriptionIds?)` — a customer portal link.
- `invoiceUrl(transactionId)` — a short-lived link to a payment's invoice PDF.
- `customDataSecret` — custom data written by `checkout()` is signed, and
  events report the verified fields as `signed`. `signCustomData` and
  `verifyCustomData` are exported.
- `TransactionEvent` for `transaction.paid` and `transaction.completed`.

### Changed

- The source is one file, so an app can compile it directly without mapping
  `./x.js` imports to `x.ts`.

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
