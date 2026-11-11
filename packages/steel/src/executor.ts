// Generated file — do not edit.
import { z } from "zod";

import type { BrowserPort } from "./browser.js";

/**
 * The protected execution boundary. Only this executor holds the
 * Steel session, its CDP socket and the merchant account credential. It is
 * reached exclusively through the Guardian tool adapter's record transport
 * (once, at commit, after capability redemption); the untrusted agent can
 * only propose `steel.checkout.submit` through Guardian.
 */
const Text = (max: number) => z.string().trim().min(1).max(max);

export const SteelCheckoutArgumentsSchema = z
  .object({
    merchantId: Text(128),
    sku: z.string().regex(/^[A-Z0-9-]{1,32}$/),
    quantity: z.number().int().min(1).max(10),
    expectedTotalCents: z.number().int().positive().max(10_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    shipTo: z
      .object({
        name: Text(128),
        line1: Text(256),
        city: Text(128),
        postalCode: Text(32),
        country: z.string().regex(/^[A-Z]{2}$/),
      })
      .strict(),
  })
  .strict();
export type SteelCheckoutArguments = z.infer<
  typeof SteelCheckoutArgumentsSchema
>;

export type SteelMerchantBinding = Readonly<{
  merchantId: string;
  /** Exact merchant origin the executor will navigate to. */
  origin: string;
  /** Protected merchant credential; never leaves the executor. */
  accountToken: string;
}>;

export type SteelCheckoutResult = Readonly<{
  merchantId: string;
  orderId: string;
  sku: string;
  quantity: number;
  totalCents: number;
  currency: string;
  steelSessionRef: string;
  confirmationUrl: string;
}>;

export type SteelCheckoutOutcome =
  | { ok: true; result: SteelCheckoutResult }
  | { ok: false; reason: string; reachedSubmit: boolean };

export interface SteelCheckoutExecutor {
  execute(args: SteelCheckoutArguments): Promise<SteelCheckoutOutcome>;
}

const READ_CHECKOUT = `(() => {
  const node = document.querySelector("[data-guardian-checkout]");
  return node ? { href: location.href, ...node.dataset } : null;
})()`;

const READ_ORDER = `(() => {
  const node = document.querySelector("[data-guardian-order]");
  return node ? { href: location.href, ...node.dataset } : null;
})()`;

function fillAndSubmit(fields: Record<string, string>): string {
  return `(() => {
  const form = document.getElementById("checkout");
  if (!form) return false;
  const fields = ${JSON.stringify(fields)};
  for (const [name, value] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    if (!input) return false;
    input.value = value;
  }
  form.requestSubmit();
  return true;
})()`;
}

type PageData = Record<string, string | undefined>;

function sameOrigin(href: string | undefined, origin: string): boolean {
  try {
    return (
      href !== undefined && new URL(href).origin === new URL(origin).origin
    );
  } catch {
    return false;
  }
}

export function createSteelCheckoutExecutor(input: {
  browser: BrowserPort;
  merchants: readonly SteelMerchantBinding[];
}): SteelCheckoutExecutor {
  const merchants = new Map(
    input.merchants.map((merchant) => [merchant.merchantId, merchant]),
  );
  return {
    async execute(args) {
      const merchant = merchants.get(args.merchantId);
      if (merchant === undefined) {
        return {
          ok: false,
          reason: "MERCHANT_NOT_BOUND",
          reachedSubmit: false,
        };
      }
      let session;
      try {
        session = await input.browser.open();
      } catch {
        return { ok: false, reason: "STEEL_UNAVAILABLE", reachedSubmit: false };
      }
      // Set immediately before the consequential click. Any failure
      // after it (for example the confirmation page outliving the navigation
      // timeout) leaves the order's fate unknown at the merchant: it is
      // reported as possibly submitted, never as "not submitted".
      let submitStarted = false;
      try {
        const checkoutUrl = new URL("/checkout", merchant.origin);
        checkoutUrl.searchParams.set("sku", args.sku);
        checkoutUrl.searchParams.set("qty", String(args.quantity));
        await session.page.navigate(checkoutUrl.toString());
        const checkout = (await session.page.evaluate(
          READ_CHECKOUT,
        )) as PageData | null;
        // The live page must match the authorized action exactly before the
        // consequential click; any drift aborts without submitting.
        if (
          checkout === null ||
          !sameOrigin(checkout.href, merchant.origin) ||
          checkout.merchantId !== args.merchantId ||
          checkout.sku !== args.sku ||
          checkout.quantity !== String(args.quantity) ||
          checkout.totalCents !== String(args.expectedTotalCents) ||
          checkout.currency !== args.currency
        ) {
          return {
            ok: false,
            reason: "CHECKOUT_MISMATCH",
            reachedSubmit: false,
          };
        }
        submitStarted = true;
        const submitted = await session.page.evaluateAndWaitForNavigation(
          fillAndSubmit({
            sku: args.sku,
            quantity: String(args.quantity),
            expectedTotalCents: String(args.expectedTotalCents),
            ship_name: args.shipTo.name,
            ship_line1: args.shipTo.line1,
            ship_city: args.shipTo.city,
            ship_postalCode: args.shipTo.postalCode,
            ship_country: args.shipTo.country,
            accountToken: merchant.accountToken,
          }),
        );
        if (submitted !== true) {
          return {
            ok: false,
            reason: "CHECKOUT_FORM_MISSING",
            reachedSubmit: false,
          };
        }
        const order = (await session.page.evaluate(
          READ_ORDER,
        )) as PageData | null;
        // The confirmation must show the authorized order exactly. Anything
        // else is not a confirmation of this order, but the submit happened,
        // so it is reported as possibly placed (reachedSubmit), never as a
        // clean refusal.
        if (
          order === null ||
          !sameOrigin(order.href, merchant.origin) ||
          order.status !== "confirmed" ||
          order.orderId === undefined ||
          order.orderId.length === 0 ||
          order.merchantId !== args.merchantId ||
          order.sku !== args.sku ||
          order.quantity !== String(args.quantity) ||
          order.totalCents !== String(args.expectedTotalCents) ||
          order.currency !== args.currency
        ) {
          return {
            ok: false,
            reason: "ORDER_NOT_CONFIRMED",
            reachedSubmit: true,
          };
        }
        // Built from what the merchant confirmed (each value checked equal
        // to the authorized one above).
        return {
          ok: true,
          result: {
            merchantId: order.merchantId,
            orderId: order.orderId,
            sku: order.sku,
            quantity: Number(order.quantity),
            totalCents: Number(order.totalCents),
            currency: order.currency,
            steelSessionRef: session.sessionRef,
            confirmationUrl: order.href!,
          },
        };
      } catch {
        return submitStarted
          ? { ok: false, reason: "SUBMIT_OUTCOME_UNKNOWN", reachedSubmit: true }
          : { ok: false, reason: "BROWSER_FAILURE", reachedSubmit: false };
      } finally {
        await session.release().catch(() => undefined);
      }
    },
  };
}
