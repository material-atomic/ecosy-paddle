# @ecosy/paddle

Paddle Billing for an app whose users are on plans.

The plan is the app's — its id, its limits, who is on it. Paddle holds what it
costs. This package keeps the two joined without a table of its own:

- **Catalogue.** Each plan is one Paddle product, tagged `custom_data.plan_id`.
  Add a monthly or yearly price to a plan, archive one, read every plan's
  prices for a pricing page.
- **Webhooks.** Check the signature, and read a subscription event as the
  three things an app acts on: whose it is, which plan, and until when it is
  paid for.

```ts
import { PaddleBilling } from "@ecosy/paddle";

export const Billing = PaddleBilling({
  apiKey: process.env.PADDLE_API_KEY!,          // pdl_sdbx_… or pdl_live_…
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
});

const billing = new Billing();
```

The environment is read from the key; pass `environment` to insist on one, and
a key for the other is refused rather than answered with a bare 401.

## Catalogue

```ts
await billing.addPrice({ id: "pro", name: "Pro" }, { interval: "month", amount: 900, trialDays: 14 });
await billing.addPrice({ id: "pro", name: "Pro" }, { interval: "year", amount: 9000 });

await billing.catalogue();      // [{ planId: "pro", productId, name, prices: [...] }]
await billing.prices("pro");    // newest first
await billing.archivePrice(id); // no longer offered; subscriptions on it carry on
```

- Amounts are in the currency's lowest unit: `900` is $9.00. Currency defaults
  to USD.
- A price's amount is never edited. Changing what a plan costs is a new price
  and the old one archived — the people already paying it keep paying it.
- `addPrice` makes the plan's product the first time, and renames it when the
  plan's name has changed since.
- `archivePrice` refuses a price that no plan owns, so an admin screen built on
  it cannot archive whatever else is in the account.

## Checkout and portal

```ts
const { transactionId } = await billing.checkout({
  priceId,
  email: user.email,
  customData: { order_id: order.id, user_id: user.id },
});
// Paddle.js: Paddle.Checkout.open({ transactionId })

const url = await billing.portal(customerId, [subscriptionId]); // card, invoices, cancelling
```

The transaction is made on the server, so the custom data is the app's. Only
active prices that belong to a plan can be bought.

## Signed custom data

Paddle signs every webhook, which says the event came from Paddle. It does not
say the custom data in it came from the app: anyone holding the public client
token can open a checkout with custom data of their own. Give the package a
secret Paddle never sees:

```ts
PaddleBilling({ apiKey, webhookSecret, customDataSecret: process.env.ORDER_SECRET });
```

`checkout()` then signs the custom data it writes (`sig`, HMAC-SHA256 over the
sorted fields), and every event reports what still carries that signature as
`signed` — `null` when it is missing, wrong, or any field was changed, added
or dropped. Paddle copies custom data from the checkout's transaction to the
subscription and on to every renewal, so the signature comes back on all of
them. Act on `event.signed`, not on `event.customData`.

`signCustomData` and `verifyCustomData` are exported for anything else.

## Webhooks

```ts
// A Next.js route handler; any framework that gives you the raw body works.
export async function POST(request: Request) {
  const body = await request.text();   // the exact text — not parsed and re-serialised

  let event;
  try {
    event = await billing.webhook(body, request.headers.get("paddle-signature"));
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  if (event.kind === "subscription") {
    const userId = event.customData.user_id;   // put there when you opened the checkout
    // event.planId, event.paidUntil — null means access ends now
  }

  return new Response("ok");
}
```

A `SubscriptionEvent` carries:

| Field | |
|---|---|
| `planId` | From the custom data on the item's price, else its product. |
| `paidUntil` | End of the current period for `active`, `trialing` and `past_due`; `null` for `paused` and `canceled`. |
| `cancelsAt` | When a scheduled cancellation takes effect. Access runs until then. |
| `customData` | The subscription's own — where the app's user id goes. |
| `occurredAt` | Webhooks arrive out of order: ignore one older than the newest you acted on. |
| `eventId` | The same event redelivered has the same id. |

`transaction.paid` and `transaction.completed` come back as a
`TransactionEvent` — `transactionId`, `origin` (`web`/`api` for a checkout,
`subscription_recurring` for a renewal), `total`, `currency`, `signed`. One
payment sends both events and Paddle retries either, so record payments by
`transactionId` and act the first time only.

Everything else comes back as `{ kind: "other" }`.

## Tests

`node --test test/*.test.mjs`. The webhook tests sign their own payloads and
need nothing. The catalogue tests run against Paddle's sandbox when
`PADDLE_SANDBOX_API_KEY` is set, and archive what they made.
