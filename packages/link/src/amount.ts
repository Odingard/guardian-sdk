// Console dollar limits on `link.spend`. Guardian reads the amount from the
// tool call's `amount` argument when the owner declares it on the tool, and
// the call must echo that declaration (`amountArgument`). Only an SDK whose
// tool.invoke parameters carry `amountArgument` can send the echo; with an
// older SDK a declared tool would be refused (Off) on every call, so the
// guard refuses to be built with a declaration instead.
import * as contracts from "@odingard/guardian-sdk/contracts";

/** The only declaration that reads this guard's amount correctly. */
export type AmountDeclaration = Readonly<{
  argument: "amount";
  unit: "minor";
  currency: "usd";
  currencyArgument: "currency";
  allowedArguments?: readonly string[];
}>;

/** What to set on the `link.spend` and `link.spend.above_cap` tools in the console. */
export const LINK_AMOUNT_DECLARATION: AmountDeclaration = Object.freeze({
  argument: "amount",
  unit: "minor",
  currency: "usd",
  currencyArgument: "currency",
});

/** Every argument name the guard sends to Guardian. */
export const GUARD_ARGUMENT_NAMES = Object.freeze([
  "merchantName",
  "merchantUrl",
  "merchantHost",
  "amount",
  "currency",
  "amountDisplay",
  "lineItems",
  "totals",
  "context",
  "credentialType",
  "linkMode",
  "payeeEnforcedByLink",
  "spendRequestId",
  "reviewReasons",
] as const);

type SchemaLike = { shape?: unknown; safeParse?: (v: unknown) => { success: boolean } };

/** True when the installed `@odingard/guardian-sdk` sends `amountArgument` on tool.invoke. */
export function sdkCarriesAmountArgument(source: unknown = contracts): boolean {
  const schema = (source as Record<string, unknown>)?.ToolInvokeParametersV1Schema as SchemaLike | undefined;
  const shape = schema?.shape;
  return shape !== null && typeof shape === "object" && "amountArgument" in shape;
}

/**
 * Checks the owner's declaration for this guard. Throws (the guard is not
 * built) unless it reads `amount` in cents with `currency` checked, and
 * the installed SDK can send it.
 */
export function checkAmountDeclaration(raw: unknown, source: unknown = contracts): AmountDeclaration {
  if (!sdkCarriesAmountArgument(source)) {
    throw new Error(
      "guardian-link: `amountArgument` needs an @odingard/guardian-sdk release whose tool.invoke " +
        "carries amount declarations. The installed SDK does not; without it Guardian would refuse every call.",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("guardian-link: `amountArgument` must be an object.");
  }
  const d = raw as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (!["argument", "unit", "currency", "currencyArgument", "allowedArguments"].includes(key)) {
      throw new Error(`guardian-link: \`amountArgument\` has an unknown field ${key}.`);
    }
  }
  if (
    d.argument !== "amount" ||
    d.unit !== "minor" ||
    d.currency !== "usd" ||
    d.currencyArgument !== "currency"
  ) {
    throw new Error(
      'guardian-link: `amountArgument` must be {"argument":"amount","unit":"minor","currency":"usd","currencyArgument":"currency"}.',
    );
  }
  let allowed: string[] | undefined;
  if (d.allowedArguments !== undefined) {
    if (!Array.isArray(d.allowedArguments) || !d.allowedArguments.every((n) => typeof n === "string")) {
      throw new Error("guardian-link: `amountArgument.allowedArguments` must list argument names.");
    }
    allowed = [...(d.allowedArguments as string[])];
    const missing = GUARD_ARGUMENT_NAMES.filter((n) => !allowed!.includes(n));
    if (missing.length > 0) {
      throw new Error(
        `guardian-link: \`amountArgument.allowedArguments\` must include every argument the guard sends; missing ${missing.join(", ")}.`,
      );
    }
  }
  const declaration: AmountDeclaration = Object.freeze({
    argument: "amount",
    unit: "minor",
    currency: "usd",
    currencyArgument: "currency",
    ...(allowed ? { allowedArguments: Object.freeze(allowed) } : {}),
  });
  const parse = (source as Record<string, unknown>)?.ToolAmountDeclarationSchema as SchemaLike | undefined;
  if (typeof parse?.safeParse === "function" && !parse.safeParse(declaration).success) {
    throw new Error("guardian-link: `amountArgument` is not a valid amount declaration.");
  }
  return declaration;
}
