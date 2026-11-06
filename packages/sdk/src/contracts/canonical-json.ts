// Generated file — do not edit.
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const MAX_CANONICAL_NODES = 100_000;
type SerializationBudget = { remainingNodes: number };

function serialize(
  value: unknown,
  ancestors: WeakSet<object>,
  depth = 0,
  budget: SerializationBudget = { remainingNodes: MAX_CANONICAL_NODES },
): string {
  budget.remainingNodes -= 1;
  if (budget.remainingNodes < 0) {
    throw new TypeError("Canonical JSON exceeds maximum node count");
  }
  if (depth > 64) throw new TypeError("Canonical JSON exceeds maximum depth");
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not permit non-finite numbers");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError("Canonical JSON rejects cycles");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    const expectedKeys = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (
      keys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
      keys.length !== expectedKeys.size
    ) {
      ancestors.delete(value);
      throw new TypeError(
        "Canonical JSON rejects sparse arrays and extra properties",
      );
    }
    const entries = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(
          "Canonical JSON rejects accessors and hidden values",
        );
      }
      return serialize(descriptor.value, ancestors, depth + 1, budget);
    });
    const result = `[${entries.join(",")}]`;
    ancestors.delete(value);
    return result;
  }

  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(`Canonical JSON rejects ${typeof value}`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON accepts only plain objects and arrays");
  }
  if (ancestors.has(value))
    throw new TypeError("Canonical JSON rejects cycles");
  ancestors.add(value);

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    ancestors.delete(value);
    throw new TypeError("Canonical JSON rejects symbol keys");
  }
  const entries = (keys as string[])
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(
          "Canonical JSON rejects accessors and hidden values",
        );
      }
      return [key, descriptor.value] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const result = `{${entries
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${serialize(entry, ancestors, depth + 1, budget)}`,
    )
    .join(",")}}`;
  ancestors.delete(value);
  return result;
}

export function canonicalJson(value: CanonicalJsonValue | unknown): string {
  return serialize(value, new WeakSet());
}
