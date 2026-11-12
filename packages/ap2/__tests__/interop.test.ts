// The AP2 specification's own example tokens (made by the AP2 reference
// implementation), read with the guard's SD-JWT code. This proves the
// guard's parsing, disclosure resolution, sd_hash binding and ES256
// verification on tokens the guard did not make, and records where the
// examples do not meet the AP2 schemas the guard enforces.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { delegateItemOf, parseCompactJws, parseSdJwt, publicJwkOf, resolveSdJwtPayload, verifyEs256 } from "../src/jose.js";
import { readOpenCheckoutContent, readOpenPaymentContent } from "../src/mandates.js";
import { Ap2GuardRefused } from "../src/util.js";

type Parts = { open: string[]; closedHop: string[]; chain: string[] };
const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/spec-examples.json", import.meta.url)), "utf8")) as {
  checkout: Parts;
  payment: Parts;
};
// The spec's example tokens are stored as short chunks and joined here.
const join = (p: Parts) => ({ open: p.open.join(""), closedHop: p.closedHop.join(""), chain: p.chain.join("") });
const fx = { checkout: join(raw.checkout), payment: join(raw.payment) };

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "OK";
  } catch (e) {
    return e instanceof Ap2GuardRefused ? e.code : "THREW";
  }
}

describe("interop: the AP2 specification's example tokens", () => {
  for (const kind of ["checkout", "payment"] as const) {
    it(`${kind}: the chain is open~~closed, the hop binds to the open mandate's sd_hash and verifies under its cnf key`, () => {
      const { open, closedHop, chain } = fx[kind];
      expect(chain).toBe(`${open.slice(0, -1)}~~${closedHop}`);
      const openTok = parseSdJwt(open);
      const openItem = delegateItemOf(resolveSdJwtPayload(openTok));
      expect(openItem.vct).toBe(kind === "checkout" ? "mandate.checkout.open.1" : "mandate.payment.open.1");
      const cnf = publicJwkOf((openItem.cnf as { jwk: unknown }).jwk);
      expect(cnf).not.toBeNull();

      const hop = parseSdJwt(closedHop);
      expect(hop.jws.header).toMatchObject({ alg: "ES256", typ: "kb+sd-jwt" });
      expect(hop.jws.payload.sd_hash).toBe(openTok.sdHash);
      expect(verifyEs256(cnf!, hop.jws.signingInput, hop.jws.signature)).toBe(true);
      const closed = delegateItemOf(resolveSdJwtPayload(hop));
      expect(closed.vct).toBe(kind === "checkout" ? "mandate.checkout.1" : "mandate.payment.1");
      expect("cnf" in closed).toBe(false);
      if (kind === "checkout") {
        // The reference discloses checkout_jwt as a nested property; resolved here.
        expect(typeof closed.checkout_jwt).toBe("string");
        // checkout_hash = base64url(sha256(checkout_jwt))
        expect(closed.checkout_hash).toBe(createHash("sha256").update(closed.checkout_jwt as string).digest("base64url"));
      } else {
        expect(closed.payment_amount).toEqual({ amount: 19900, currency: "USD" });
      }
    });
  }

  it("payment: transaction_id of the example equals the example checkout's checkout_hash", () => {
    const pay = delegateItemOf(resolveSdJwtPayload(parseSdJwt(fx.payment.closedHop)));
    const chk = delegateItemOf(resolveSdJwtPayload(parseSdJwt(fx.checkout.closedHop)));
    expect(pay.transaction_id).toBe(chk.checkout_hash);
  });

  // The JSON shown next to these tokens in the spec uses float prices and
  // total_price; the encoded tokens themselves follow the schemas (integer
  // minor units, a totals array), and the guard reads them.
  it("the example open mandates and checkout read under the guard's strict rules", () => {
    const openCheckout = delegateItemOf(resolveSdJwtPayload(parseSdJwt(fx.checkout.open)));
    const openPayment = delegateItemOf(resolveSdJwtPayload(parseSdJwt(fx.payment.open)));
    const checkoutJwt = delegateItemOf(resolveSdJwtPayload(parseSdJwt(fx.checkout.closedHop))).checkout_jwt as string;
    const checkout = parseCompactJws(checkoutJwt).payload;
    const findings = {
      openCheckout: codeOf(() => readOpenCheckoutContent(openCheckout)),
      openPayment: codeOf(() => readOpenPaymentContent(openPayment)),
      checkoutHasTotalPrice: "total_price" in checkout,
      checkoutHasTotalsArray: Array.isArray(checkout.totals),
      checkoutPriceIsInteger: Number.isInteger(
        ((checkout.line_items as { item: { price: unknown } }[])[0]!.item.price as number),
      ),
    };
    expect(findings).toEqual({
      openCheckout: "OK",
      openPayment: "OK",
      checkoutHasTotalPrice: false,
      checkoutHasTotalsArray: true,
      checkoutPriceIsInteger: true,
    });
  });
});
