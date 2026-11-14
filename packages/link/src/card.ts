import { inspect } from "node:util";

import type { LinkCardData } from "./adapter.js";

const REDACTED = "[guardian-link card: redacted]";

/**
 * Card details for one approved spend request, usable only inside the
 * `withCard` callback. It never prints its details: `JSON.stringify`,
 * `String()`, template strings and `console.log`/`util.inspect` all show a
 * redacted placeholder. After the callback ends, reading a detail throws.
 */
export class LinkCard {
  readonly #data: LinkCardData;
  #open = true;
  /** The spend request this card was issued for. Not a card detail. */
  readonly spendRequestId: string;

  /** @internal */
  constructor(spendRequestId: string, data: LinkCardData) {
    this.spendRequestId = spendRequestId;
    this.#data = Object.freeze({ ...data });
  }

  #read(): LinkCardData {
    if (!this.#open) throw new Error("guardian-link: card details are only readable inside withCard.");
    return this.#data;
  }

  get number(): string {
    return this.#read().number;
  }
  get cvc(): string | undefined {
    return this.#read().cvc;
  }
  get expMonth(): number {
    return this.#read().expMonth;
  }
  get expYear(): number {
    return this.#read().expYear;
  }
  get billingAddress(): LinkCardData["billingAddress"] {
    return this.#read().billingAddress;
  }
  get validUntil(): string | undefined {
    return this.#read().validUntil;
  }

  /** @internal */
  close(): void {
    this.#open = false;
  }

  toJSON(): string {
    return REDACTED;
  }
  toString(): string {
    return REDACTED;
  }
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}
