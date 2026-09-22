/** The public surface, as an app uses it — events narrow by kind, and act on `signed`. */
import { PaddleBilling, signCustomData, type BillingEvent, type PlanPrice } from "../src/index";

const Billing = PaddleBilling({ apiKey: "pdl_sdbx_apikey_x", webhookSecret: "pdl_ntfset_x", customDataSecret: "s" });
const billing = new Billing();

export const environment: "sandbox" | "production" = Billing.environment;

export async function prices(): Promise<PlanPrice[]> {
  return billing.prices("pro");
}

export async function handle(body: string, signature: string | null): Promise<string | null> {
  const event: BillingEvent = await billing.webhook(body, signature);

  if (event.kind === "subscription") {
    const until: string | null = event.paidUntil;
    const userId: string | undefined = event.signed?.user_id;
    return until && userId ? `${userId} until ${until}` : null;
  }

  if (event.kind === "transaction") {
    const id: string = event.transactionId;
    // @ts-expect-error — a payment has no billing period
    void event.paidUntil;
    return id;
  }

  // @ts-expect-error — anything else carries no data
  void event.customData;
  return null;
}

export const signed: Record<string, string> = signCustomData({ order_id: "ord_1" }, "s");

// @ts-expect-error — custom data values are strings, so a signature covers exactly what comes back
signCustomData({ order_id: 1 }, "s");
