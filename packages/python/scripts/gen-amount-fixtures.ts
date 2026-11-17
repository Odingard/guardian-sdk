/**
 * Golden cross-language fixtures for dollar amounts on tools (amount_args).
 *
 *   npm run fixtures:python   (from the repo root)
 *
 * Writes tests/fixtures/tool-amounts.json: every case records what the
 * TypeScript readToolAmount reads and whether ToolAmountDeclarationSchema
 * accepts the declaration. The Python port must match both.
 */
import { writeFileSync } from "node:fs";

import {
  readToolAmount,
  ToolAmountDeclarationSchema,
} from "../../sdk/src/contracts/index.js";

const here = new URL(".", import.meta.url);

const MINOR = { argument: "amount", unit: "minor", currency: "usd" } as const;
const MAJOR = { argument: "amount", unit: "major", currency: "usd" } as const;
const WITH_CURRENCY = { ...MINOR, currencyArgument: "currency" } as const;
const ALLOWED = {
  ...MINOR,
  currencyArgument: "currency",
  allowedArguments: ["amount", "currency", "sku"],
} as const;
const PIN = {
  arg: "sku",
  index: 0,
  mode: "bytes",
  size: 3,
  sha256: `sha256:${"a".repeat(64)}`,
};

const reads: [string, object, Record<string, unknown>][] = [
  ["minor integer", MINOR, { amount: 2000 }],
  ["minor zero", MINOR, { amount: 0 }],
  ["minor text", MINOR, { amount: "2000" }],
  ["minor text leading zero", MINOR, { amount: "02000" }],
  ["minor text sign", MINOR, { amount: "+2000" }],
  ["minor text space", MINOR, { amount: " 2000" }],
  ["minor text decimal", MINOR, { amount: "20.00" }],
  ["minor fraction", MINOR, { amount: 19.99 }],
  ["minor negative", MINOR, { amount: -1 }],
  ["minor whole float", MINOR, { amount: 2000.0 }],
  ["minor largest safe", MINOR, { amount: 9007199254740991 }],
  ["minor above safe", MINOR, { amount: 9007199254740992 }],
  ["minor seventeen digits text", MINOR, { amount: "12345678901234567" }],
  ["minor boolean", MINOR, { amount: true }],
  ["minor null", MINOR, { amount: null }],
  ["minor missing", MINOR, { other: 1 }],
  ["minor object", MINOR, { amount: { value: 1 } }],
  ["major whole", MAJOR, { amount: 20 }],
  ["major text cents", MAJOR, { amount: "19.99" }],
  ["major text one decimal", MAJOR, { amount: "19.9" }],
  ["major text three decimals", MAJOR, { amount: "19.999" }],
  ["major text dollar sign", MAJOR, { amount: "$19.99" }],
  ["major text comma", MAJOR, { amount: "1,000" }],
  ["major text exponent", MAJOR, { amount: "1e3" }],
  ["major fraction number", MAJOR, { amount: 19.99 }],
  ["major text thirteen digits", MAJOR, { amount: "1234567890123.45" }],
  ["major text fourteen digits", MAJOR, { amount: "12345678901234" }],
  ["major number too large for cents", MAJOR, { amount: 90071992547410 }],
  ["currency usd", WITH_CURRENCY, { amount: 100, currency: "usd" }],
  ["currency upper", WITH_CURRENCY, { amount: 100, currency: "USD" }],
  ["currency eur", WITH_CURRENCY, { amount: 100, currency: "eur" }],
  ["currency missing", WITH_CURRENCY, { amount: 100 }],
  ["currency number", WITH_CURRENCY, { amount: 100, currency: 840 }],
  [
    "allowed listed arguments",
    ALLOWED,
    { amount: 100, currency: "usd", sku: "a" },
  ],
  [
    "allowed extra argument",
    ALLOWED,
    { amount: 100, currency: "usd", note: "x" },
  ],
  [
    "allowed with valid pin",
    ALLOWED,
    { amount: 100, currency: "usd", sku: "a", guardianContentPins: [PIN] },
  ],
  [
    "allowed with pin for unlisted argument",
    ALLOWED,
    {
      amount: 100,
      currency: "usd",
      sku: "a",
      guardianContentPins: [{ ...PIN, arg: "note" }],
    },
  ],
  [
    "allowed with malformed pin",
    ALLOWED,
    {
      amount: 100,
      currency: "usd",
      sku: "a",
      guardianContentPins: [{ ...PIN, sha256: "sha256:abc" }],
    },
  ],
];

const declarations: [string, unknown][] = [
  ["minor", MINOR],
  ["major", MAJOR],
  ["with currency", WITH_CURRENCY],
  ["with allowed", ALLOWED],
  ["unknown key", { ...MINOR, cap: 100 }],
  ["eur", { ...MINOR, currency: "eur" }],
  ["unit cents", { ...MINOR, unit: "cents" }],
  ["dotted argument", { ...MINOR, argument: "order.amount" }],
  ["empty argument", { ...MINOR, argument: "" }],
  ["proto argument", { ...MINOR, argument: "__proto__" }],
  ["long argument", { ...MINOR, argument: "a".repeat(65) }],
  ["64 character argument", { ...MINOR, argument: "a".repeat(64) }],
  ["control character", { ...MINOR, argument: "am\u0001ount" }],
  ["currency same as amount", { ...MINOR, currencyArgument: "amount" }],
  ["allowed missing amount", { ...MINOR, allowedArguments: ["sku"] }],
  [
    "allowed missing currency",
    { ...WITH_CURRENCY, allowedArguments: ["amount"] },
  ],
  ["allowed repeated", { ...MINOR, allowedArguments: ["amount", "amount"] }],
  ["allowed empty", { ...MINOR, allowedArguments: [] }],
  ["not an object", "amount"],
];

writeFileSync(
  new URL("../tests/fixtures/tool-amounts.json", here),
  JSON.stringify(
    {
      reads: reads.map(([name, declaration, args]) => ({
        name,
        declaration,
        args,
        expected: readToolAmount(
          ToolAmountDeclarationSchema.parse(declaration),
          args as Record<string, never>,
        ),
      })),
      declarations: declarations.map(([name, declaration]) => ({
        name,
        declaration,
        valid: ToolAmountDeclarationSchema.safeParse(declaration).success,
      })),
    },
    null,
    2,
  ) + "\n",
);
