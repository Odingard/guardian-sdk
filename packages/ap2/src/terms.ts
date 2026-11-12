// The canonical terms Guardian decides on and the person sees, in full.
// Plain JSON, built by the guard from verified data only, deep-copied and
// frozen. The approval binds to `termsDigest` = sha256(JCS(terms)).
import { AP2_VERSION } from "./constants.js";
import { jwkThumbprint, type PublicJwk } from "./jose.js";
import {
  budgetMinor,
  formatMinor,
  type CheckoutConstraint,
  type ClosedCheckoutContent,
  type ClosedPaymentContent,
  type Merchant,
  type OpenCheckoutContent,
  type OpenMandate,
  type OpenPaymentContent,
  type PaymentConstraint,
  type ReadCheckout,
} from "./mandates.js";
import { termsDigestOf } from "./util.js";

export type Mode = "human-not-present" | "human-present";

export type HopTerms = Readonly<{
  /** Audience the verifier named (merchant or credential provider). */
  aud: string;
  nonce: string;
  /** `sd_hash` of the open mandate this hop binds to. */
  bindsToOpenMandate: string;
}>;

export type PayTerms = Readonly<{
  schema: "odingard.guardian.ap2.pay.v1";
  ap2Version: typeof AP2_VERSION;
  mode: Mode;
  merchant: Merchant;
  /** Integer minor units of `currency`, equal to the checkout total. */
  amount: number;
  currency: string;
  /** From the guard's ISO 4217 exponents, e.g. "19.99 USD". */
  amountDisplay: string;
  payment: Readonly<Record<string, unknown>>;
  checkout: Readonly<Record<string, unknown>>;
  keyBinding: Readonly<{
    agentKeyThumbprint: string;
    checkout: HopTerms;
    payment: HopTerms;
  }> | null;
  openMandates: Readonly<{
    checkout: Readonly<Record<string, unknown>>;
    payment: Readonly<Record<string, unknown>>;
  }> | null;
}>;

export type DelegateTerms = Readonly<{
  schema: "odingard.guardian.ap2.delegate.v1";
  ap2Version: typeof AP2_VERSION;
  mode: "human-not-present";
  recurring: boolean;
  agentKeyThumbprint: string;
  currency: string;
  amountMax: number;
  amountMaxDisplay: string;
  openCheckout: Readonly<Record<string, unknown>>;
  openPayment: Readonly<Record<string, unknown>>;
}>;

const iso = (sec: number | undefined) => (sec === undefined ? null : new Date(sec * 1000).toISOString());

export function checkoutConstraintsView(cs: readonly CheckoutConstraint[]): unknown[] {
  return cs.map((c) => ({ ...c }));
}

export function paymentConstraintsView(cs: readonly PaymentConstraint[]): unknown[] {
  return cs.map((c) => {
    switch (c.type) {
      case "payment.amount_range":
        return {
          ...c,
          maxDisplay: formatMinor(c.max, c.currency),
          ...(c.min !== undefined ? { minDisplay: formatMinor(c.min, c.currency) } : {}),
        };
      case "payment.budget":
        return { ...c, maxDisplay: formatMinor(budgetMinor(c.max, c.currency), c.currency) };
      default:
        return { ...c };
    }
  });
}

function presetsView(p: OpenPaymentContent): Record<string, unknown> {
  return {
    payee: p.payee ?? null,
    paymentAmount: p.payment_amount
      ? { ...p.payment_amount, display: formatMinor(p.payment_amount.amount, p.payment_amount.currency) }
      : null,
    paymentInstrument: p.payment_instrument ?? null,
    pisp: p.pisp ?? null,
    executionDate: p.execution_date ?? null,
    riskDataKeys: p.risk_data ? Object.keys(p.risk_data).sort() : [],
  };
}

export function openCheckoutView(m: OpenMandate<OpenCheckoutContent>, issuerKey: PublicJwk): Record<string, unknown> {
  return {
    vct: m.content.vct,
    sdHash: m.token.sdHash,
    issuedAt: iso(m.content.iat),
    expiresAt: iso(m.content.exp),
    exp: m.content.exp,
    cnfThumbprint: jwkThumbprint(m.content.cnf.jwk),
    signedByKey: jwkThumbprint(issuerKey),
    constraints: checkoutConstraintsView(m.content.constraints),
  };
}

export function openPaymentView(m: OpenMandate<OpenPaymentContent>, issuerKey: PublicJwk): Record<string, unknown> {
  return {
    vct: m.content.vct,
    sdHash: m.token.sdHash,
    issuedAt: iso(m.content.iat),
    expiresAt: iso(m.content.exp),
    exp: m.content.exp,
    cnfThumbprint: jwkThumbprint(m.content.cnf.jwk),
    signedByKey: jwkThumbprint(issuerKey),
    constraints: paymentConstraintsView(m.content.constraints),
    presets: presetsView(m.content),
  };
}

function refundTermsOf(read: ReadCheckout): string {
  const links = read.checkout.links.filter((l) => /refund|return/i.test(l.type));
  if (links.length === 0) return "Refund terms: not stated by the merchant";
  return `Refund terms: see ${links.map((l) => l.url).join(", ")}`;
}

export function checkoutView(read: ReadCheckout, closed: ClosedCheckoutContent): Record<string, unknown> {
  const c = read.checkout;
  const money = (amount: number) => formatMinor(amount, c.currency);
  return {
    vct: closed.vct,
    checkoutHash: read.checkoutHash,
    id: c.id,
    status: c.status,
    currency: c.currency,
    expiresAt: c.expires_at ?? null,
    lineItems: c.line_items.map((li) => ({
      id: li.id,
      itemId: li.item.id,
      title: li.item.title,
      unitPrice: li.item.price,
      unitPriceDisplay: money(li.item.price),
      quantity: li.quantity,
      totals: li.totals.map((t) => ({ ...t, display: money(t.amount) })),
      ...(li.parent_id !== undefined ? { parentId: li.parent_id } : {}),
      ...(li.item.image_url !== undefined ? { imageUrl: li.item.image_url } : {}),
    })),
    totals: c.totals.map((t) => ({ ...t, display: money(t.amount) })),
    total: read.total,
    totalDisplay: money(read.total),
    messages: c.messages ?? [],
    links: c.links,
    refundTerms: refundTermsOf(read),
    buyerFields: c.buyer ? Object.keys(c.buyer).sort() : [],
    continueUrl: c.continue_url ?? null,
    otherFieldNames: c.otherFieldNames,
  };
}

export function paymentView(closed: ClosedPaymentContent): Record<string, unknown> {
  return {
    vct: closed.vct,
    transactionId: closed.transaction_id,
    payee: closed.payee,
    paymentAmount: closed.payment_amount,
    amountDisplay: formatMinor(closed.payment_amount.amount, closed.payment_amount.currency),
    paymentInstrument: closed.payment_instrument,
    pisp: closed.pisp ?? null,
    executionDate: closed.execution_date ?? "now",
    riskDataKeys: closed.risk_data ? Object.keys(closed.risk_data).sort() : [],
    /** Binds the values without showing or logging them. */
    riskDataDigest: closed.risk_data ? termsDigestOf(closed.risk_data) : null,
  };
}

export { iso as isoFromEpoch };
