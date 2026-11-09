// Generated file — do not edit.
import { describe, expect, it } from "vitest";

import {
  API_MONEY_ORIGINS,
  API_MONEY_RULES,
  API_NON_MONEY_ENDPOINTS,
  API_REQUEST_DEFINITION,
  apiMoneyRuleFor,
  readApiMoney,
  validateActionParameters,
  type ApiMoneyRequest,
} from "../contracts/index.js";

/**
 * Money facts on `api.request`: the published reader that derives the
 * amount a request moves from the exact request, and the parameter gate
 * that compares a declared value with that derived amount. Every case is a
 * real request shape; refusals come from the reader, not from fixtures.
 */
const connectionId = "pcn_0000000000000001";
const resource = `api:endpoint:${connectionId}`;
const FORM = {
  name: "content-type",
  value: "application/x-www-form-urlencoded",
};
const JSON_TYPE = { name: "content-type", value: "application/json" };

type Header = { name: string; value: string };
type Request = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers: Header[];
  body?: string;
};

const post = (url: string, body?: string, headers: Header[] = [FORM]) =>
  ({
    method: "POST",
    url,
    headers,
    ...(body === undefined ? {} : { body }),
  }) satisfies Request;

const stripe = (
  path: string,
  body?: string,
  headers: Header[] = [FORM],
  method: Request["method"] = "POST",
): Request => ({
  method,
  url: `https://api.stripe.com${path}`,
  headers,
  ...(body === undefined ? {} : { body }),
});

/** The parameter gate for one api.request, with an optional declared value. */
const gate = (request: Request, valueCents?: number) =>
  validateActionParameters({
    action: "api.request",
    resource,
    uses: 1,
    materialParameters: {
      schema: "odingard.guardian.api.request.v1",
      connectionId,
      ...request,
    },
    ...(valueCents === undefined ? {} : { valueCents }),
  }).ok;

const refusedAtGate = (request: Request) => {
  for (const declared of [undefined, 0, 1, 100, 1_000_000]) {
    expect(gate(request, declared)).toBe(false);
  }
};

const reasonOf = (request: ApiMoneyRequest) => {
  const reading = readApiMoney(request);
  return reading.kind === "refused" ? reading.reason : reading.kind;
};

describe("API_MONEY_RULES — the reviewed money endpoints", () => {
  it("every rule and reviewed non-money endpoint is on a money origin", () => {
    const origins = new Set(API_MONEY_ORIGINS.map((o) => o.origin));
    expect(origins).toEqual(new Set(["https://api.stripe.com"]));
    for (const entry of [...API_MONEY_RULES, ...API_NON_MONEY_ENDPOINTS]) {
      expect(origins.has(entry.origin), entry.label).toBe(true);
      expect(entry.method).toBe("POST");
    }
  });

  it("every money rule reads form bodies only", () => {
    for (const rule of API_MONEY_RULES) {
      expect(rule.bodies, rule.label).toEqual(["form"]);
    }
  });

  it("the rules are frozen", () => {
    expect(Object.isFrozen(API_MONEY_RULES)).toBe(true);
    for (const rule of API_MONEY_RULES) {
      expect(Object.isFrozen(rule), rule.label).toBe(true);
      expect(Object.isFrozen(rule.bodies), rule.label).toBe(true);
    }
    expect(Object.isFrozen(API_NON_MONEY_ENDPOINTS)).toBe(true);
  });

  it("the reviewed non-money list stays short", () => {
    expect(API_NON_MONEY_ENDPOINTS.length).toBeLessThanOrEqual(6);
  });

  it("finds the rule for a money endpoint, and none elsewhere", () => {
    expect(
      apiMoneyRuleFor("post", "https://api.stripe.com/v1/refunds")?.label,
    ).toBe("Stripe refund");
    expect(
      apiMoneyRuleFor("POST", "https://api.stripe.com/v1/charges/ch_1/capture")
        ?.label,
    ).toBe("Stripe charge capture");
    expect(apiMoneyRuleFor("GET", "https://api.stripe.com/v1/refunds")).toBe(
      null,
    );
    expect(apiMoneyRuleFor("POST", "https://api.github.com/v1/refunds")).toBe(
      null,
    );
    expect(apiMoneyRuleFor("POST", "not a url")).toBe(null);
  });
});

describe("readApiMoney — the amount is derived from the exact request", () => {
  it.each([
    ["/v1/refunds", "charge=ch_1&amount=100", 100, null, "Stripe refund"],
    ["/v1/refunds/", "amount=0", 0, null, "Stripe refund"],
    [
      "/v1/charges/ch_1/refunds",
      "amount=500",
      500,
      null,
      "Stripe refund (legacy charge path)",
    ],
    ["/v1/payouts", "amount=7&currency=USD", 7, "usd", "Stripe payout"],
    [
      "/v1/charges",
      "amount=7&currency=usd&source=tok",
      7,
      "usd",
      "Stripe charge",
    ],
    [
      "/v1/transfers",
      "currency=usd&amount=42&destination=acct_1",
      42,
      "usd",
      "Stripe transfer",
    ],
    [
      "/v1/payment_intents",
      "amount=100&currency=usd&customer=cus_1&confirm=true",
      100,
      "usd",
      "Stripe payment",
    ],
    ["/v1/topups", "amount=300&currency=usd", 300, "usd", "Stripe top-up"],
    [
      "/v1/payment_intents/pi_1/capture",
      "amount_to_capture=250",
      250,
      null,
      "Stripe payment capture",
    ],
    [
      "/v1/transfers/tr_1/reversals",
      "amount=250",
      250,
      null,
      "Stripe transfer reversal",
    ],
    [
      "/v1/application_fees/fee_1/refunds",
      "amount=250",
      250,
      null,
      "Stripe application fee refund",
    ],
    // Brackets in an unrelated key, and a percent-encoded key name.
    ["/v1/refunds", "amount=5&metadata%5Bnote%5D=x", 5, null, "Stripe refund"],
    ["/v1/refunds", "am%6Funt=5", 5, null, "Stripe refund"],
  ])("%s %s reads %d", (path, body, amount, currency, rule) => {
    const reading = readApiMoney(stripe(path, body));
    expect(reading.kind).toBe("money");
    if (reading.kind !== "money") return;
    expect(reading.amountMinor).toBe(amount);
    expect(reading.rule).toBe(rule);
    if (currency === null) expect(reading.currency).toBe(null);
    else expect(reading.currency?.toLowerCase()).toBe(currency);
  });

  it("accepts a UTF-8 form content type with a charset parameter", () => {
    const reading = readApiMoney(
      stripe("/v1/payment_intents", "amount=100&currency=usd", [
        {
          name: "content-type",
          value: "application/x-www-form-urlencoded; charset=UTF-8",
        },
      ]),
    );
    expect(reading).toMatchObject({ kind: "money", amountMinor: 100 });
  });

  it("an idempotency key does not change the reading", () => {
    const request = stripe("/v1/refunds", "charge=ch_1&amount=100", [
      FORM,
      { name: "idempotency-key", value: "k_1" },
    ]);
    expect(readApiMoney(request)).toMatchObject({
      kind: "money",
      amountMinor: 100,
    });
  });

  it("reads nothing where no money moves", () => {
    for (const request of [
      stripe(
        "/v1/payment_intents/pi_1/cancel",
        "cancellation_reason=duplicate",
      ),
      stripe("/v1/payment_intents/pi_1/cancel", undefined, []),
      stripe("/v1/refunds/re_1", "metadata%5Bk%5D=v"),
      stripe("/v1/payment_methods/pm_1/detach", "expand%5B%5D=customer"),
      stripe("/v1/refunds", undefined, [], "GET"),
      post(
        "https://api.github.com/repos/o/r/issues/1/comments",
        '{"body":"amount=1"}',
        [JSON_TYPE],
      ),
      post("https://api.github.com/repos/o/r/issues", "{}", [
        JSON_TYPE,
        { name: "stripe-version", value: "2017-08-15" },
      ]),
      post("https://bücher.example/orders", "amount=100"),
      { method: "POST", url: "not a url", headers: [] },
    ]) {
      expect(readApiMoney(request), request.url).toEqual({ kind: "none" });
    }
  });
});

describe("readApiMoney — anything that cannot be read unambiguously is refused", () => {
  it.each([
    // The amount is missing ("all of it") or unreadable.
    ["AMOUNT_MISSING", stripe("/v1/refunds", "charge=ch_1")],
    ["AMOUNT_MISSING", stripe("/v1/refunds", undefined)],
    ["AMOUNT_MISSING", stripe("/v1/charges/ch_1/capture", "metadata%5Bk%5D=v")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount=1&amount=100")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount[]=100")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount[value]=100&amount=1")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "Amount=100&amount=1")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount%20=100&amount=1")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount=100&%5Bamount%5D=9")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount=100&%5B%5Damount=9")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount=100&%5Damount=9")],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/refunds", "amount=5&am%6Funt=50")],
    [
      "AMOUNT_AMBIGUOUS",
      stripe("/v1/refunds", "charge=ch_1;amount=9&amount=1"),
    ],
    [
      "AMOUNT_AMBIGUOUS",
      {
        ...stripe("/v1/refunds", "amount=1"),
        url: "https://api.stripe.com/v1/refunds?amount=100",
      },
    ],
    ["AMOUNT_AMBIGUOUS", stripe("/v1/%72efunds", "amount=1")],
    ["AMOUNT_AMBIGUOUS", stripe("//v1/refunds", "amount=1")],
    ["AMOUNT_INVALID", stripe("/v1/refunds", "amount=1.5")],
    ["AMOUNT_INVALID", stripe("/v1/refunds", "amount=-1")],
    ["AMOUNT_INVALID", stripe("/v1/refunds", "amount=01")],
    ["AMOUNT_INVALID", stripe("/v1/refunds", "amount=1e6")],
    ["AMOUNT_INVALID", stripe("/v1/refunds", "amount=+5")],
    ["AMOUNT_INVALID", stripe("/v1/refunds", "amount=99999999999999999")],
    // Currency.
    ["CURRENCY_MISSING", stripe("/v1/payment_intents", "amount=1")],
    [
      "CURRENCY_NOT_ALLOWED",
      stripe("/v1/payment_intents", "amount=1&currency=jpy"),
    ],
    ["CURRENCY_NOT_ALLOWED", stripe("/v1/topups", "amount=300&currency=eur")],
    // Body encoding: the provider reads form bodies only.
    ["CONTENT_TYPE_UNSUPPORTED", stripe("/v1/refunds", "amount=1", [])],
    [
      "CONTENT_TYPE_UNSUPPORTED",
      stripe("/v1/payouts", '{"amount":7,"currency":"usd"}', [JSON_TYPE]),
    ],
    [
      "CONTENT_TYPE_UNSUPPORTED",
      stripe("/v1/refunds", "amount=1", [
        { name: "content-type", value: "multipart/form-data" },
      ]),
    ],
    [
      "CONTENT_TYPE_UNSUPPORTED",
      stripe("/v1/payment_intents/pi_1/cancel", '{"metadata":{"k":"v"}}', [
        JSON_TYPE,
      ]),
    ],
    // Money moves but the request does not say how much.
    ["AMOUNT_UNVERIFIABLE", stripe("/v1/payment_intents/pi_1/confirm", "x=1")],
    ["AMOUNT_UNVERIFIABLE", stripe("/v1/payment_intents/pi_1", "amount=99999")],
    ["AMOUNT_UNVERIFIABLE", stripe("/v1/invoices/in_1/pay", "")],
    ["AMOUNT_UNVERIFIABLE", stripe("/v1/subscriptions", "customer=cus_1")],
    ["AMOUNT_UNVERIFIABLE", stripe("/v1/checkout/sessions", "mode=payment")],
    ["AMOUNT_UNVERIFIABLE", stripe("/v1/payouts/po_1/reverse", "")],
    // The money origin is closed: unreviewed endpoints are refused.
    ["MONEY_ENDPOINT_UNKNOWN", stripe("/v1/customers", "name=x")],
    ["MONEY_ENDPOINT_UNKNOWN", stripe("/v1/customers", "account_balance=1")],
    ["MONEY_ENDPOINT_UNKNOWN", stripe("/v1/charges/ch_1", "amount=1")],
    [
      "MONEY_ENDPOINT_UNKNOWN",
      stripe("/v1/refunds", "amount=1", [FORM], "PUT"),
    ],
    [
      "MONEY_ENDPOINT_UNKNOWN",
      stripe("/v1/subscriptions/sub_1", "amount=1", [FORM], "DELETE"),
    ],
    // The host must be written exactly as the canonical origin.
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://api.stripe.com./v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://API.STRIPE.COM/v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://api.stripe.com:443/v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://u@api.stripe.com/v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("http://api.stripe.com/v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://api.strіpe.com/v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://api.str1pe.com/v1/refunds", "amount=1"),
    ],
    [
      "MONEY_HOST_NONCANONICAL",
      post("https://files.stripe.com/v1/files", "amount=1"),
    ],
    // Headers that change how the provider reads the request.
    [
      "MONEY_HEADER_UNSUPPORTED",
      stripe("/v1/refunds", "charge=ch_1&amount=100", [
        FORM,
        { name: "stripe-version", value: "2017-08-15" },
      ]),
    ],
    [
      "MONEY_HEADER_UNSUPPORTED",
      stripe(
        "/v1/refunds",
        undefined,
        [{ name: "Stripe-Account", value: "acct_1" }],
        "GET",
      ),
    ],
  ] as const)("%s", (reason, request) => {
    expect(reasonOf(request)).toBe(reason);
  });

  it("a control character in a key is refused; in a value it is not", () => {
    expect(
      reasonOf(stripe("/v1/refunds", "charge=ch_1&amount=100&amount%00=9")),
    ).toBe("AMOUNT_AMBIGUOUS");
    expect(reasonOf(stripe("/v1/refunds/re_1", "balance%00=100000"))).toBe(
      "AMOUNT_AMBIGUOUS",
    );
    expect(
      readApiMoney(stripe("/v1/refunds", "amount=100&metadata%5Bk%5D=a%00b")),
    ).toMatchObject({ kind: "money", amountMinor: 100 });
  });
});

describe("the parameter gate compares the declared value with the request", () => {
  it("exposes the derived value as an authority fact", () => {
    const parsed = API_REQUEST_DEFINITION.validateParameters({
      schema: "odingard.guardian.api.request.v1",
      connectionId,
      ...stripe("/v1/refunds", "charge=ch_1&amount=100"),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(API_REQUEST_DEFINITION.authorityFacts?.(parsed.params)).toEqual({
      valueCents: 100,
    });
  });

  it("accepts exactly the derived value", () => {
    const refund = stripe("/v1/refunds", "charge=ch_1&amount=100");
    expect(gate(refund, 100)).toBe(true);
    expect(gate(refund)).toBe(false);
    expect(gate(refund, 99)).toBe(false);
    expect(gate(refund, 101)).toBe(false);
  });

  it("refuses every declared value when the reader refuses", () => {
    refusedAtGate(stripe("/v1/refunds", "charge=ch_1"));
    refusedAtGate(
      stripe("/v1/payouts", '{"amount":7,"currency":"usd"}', [JSON_TYPE]),
    );
    refusedAtGate(stripe("/v1/customers", "name=x"));
    refusedAtGate(post("https://api.stripe.com./v1/refunds", "amount=1"));
  });

  it("accepts a request that moves no money only without a declared value", () => {
    for (const request of [
      stripe(
        "/v1/payment_intents/pi_1/cancel",
        "cancellation_reason=duplicate",
      ),
      stripe("/v1/refunds", undefined, [], "GET"),
      post("https://api.github.com/repos/o/r/issues/1/comments", "{}", [
        JSON_TYPE,
      ]),
    ]) {
      expect(gate(request)).toBe(true);
      expect(gate(request, 0)).toBe(false);
      expect(gate(request, 100)).toBe(false);
    }
  });
});
