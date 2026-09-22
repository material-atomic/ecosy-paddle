---
name: ecosy-paddle
description: Guides the AI on selling an app's plans through Paddle with @ecosy/paddle — prices per plan, server-made checkouts with signed custom data, and webhooks read as who has which plan until when.
---

# `ecosy-paddle` Skill

When a project that uses `@ecosy/paddle` needs to sell plans, take payments, or react to Paddle webhooks, use the package instead of calling Paddle's SDK directly for these jobs. It keeps the plan the app's own, keeps prices in Paddle, and refuses the mistakes that are easy to make by hand.

## 1. One client, configured once

```typescript
import { PaddleBilling } from "@ecosy/paddle";

export const Billing = PaddleBilling({
  apiKey: process.env.PADDLE_API_KEY!,             // pdl_sdbx_… (sandbox) or pdl_live_… (live)
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET, // the notification destination's secret
  customDataSecret: process.env.ORDER_SECRET,       // the app's own, never given to Paddle
});
```

- Do **not** pass `environment` unless you must: it is read from the key, and a mismatch is refused.
- `Billing.environment` says sandbox or production — show it wherever prices are edited.

## 2. Prices belong to plans, and are never edited

```typescript
const billing = new Billing();

await billing.addPrice({ id: "pro", name: "Pro" }, { interval: "month", amount: 900, trialDays: 14 });
await billing.prices("pro");        // newest first
await billing.archivePrice(priceId); // stops new checkouts; subscribers keep paying it
```

- Amounts are in the currency's lowest unit: `900` is $9.00.
- To change what a plan costs, **add** the new price and **archive** the old one. Never update a price's amount.

## 3. Checkouts are made on the server

```typescript
const { transactionId } = await billing.checkout({
  priceId,
  email: user.email,
  customData: { order_id: order.id, user_id: user.id }, // strings only; signed automatically
});
// Browser: Paddle.Checkout.open({ transactionId })
```

- Do **not** open checkouts in the browser from a price id with `customData` — anyone with the public client token could write their own. The server makes the transaction, and `customDataSecret` signs it.
- Create your own order record before calling `checkout()` and put its id in the custom data.

## 4. Webhooks: act on `signed`, record payments once

```typescript
const body = await request.text(); // the raw text — never parse and re-stringify
const event = await billing.webhook(body, request.headers.get("paddle-signature")); // throws WebhookSignatureError

if (event.kind === "subscription" && event.signed) {
  // event.signed.user_id, event.planId, event.paidUntil (null = end access now), event.cancelsAt
  // Ignore an event whose occurredAt is older than the newest one applied.
}

if (event.kind === "transaction" && event.signed) {
  // Record by event.transactionId, first time only: paid and completed both arrive, and Paddle retries.
}
```

- Read `event.signed`, **not** `event.customData`. `signed` is `null` when the signature is missing or anything was changed.
- Answer a `WebhookSignatureError` with a 4xx and act on nothing.

## 5. Letting customers manage what they pay for

```typescript
await billing.cancel(subscriptionId);        // at the end of the paid period
await billing.keep(subscriptionId);          // take a pending cancellation back
await billing.portal(customerId, [subId]);   // Paddle's portal: card, invoices
await billing.invoiceUrl(transactionId);     // short-lived PDF link — redirect, do not store
```

Always look the subscription or payment up from the signed-in user's own records; never take its id from the request.
