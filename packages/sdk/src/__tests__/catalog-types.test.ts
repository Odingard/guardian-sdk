import { describe, expect, expectTypeOf, it } from "vitest";

import catalogJson from "../catalog/public-catalog.v1.json" with { type: "json" };
import { guardianCatalog, type GuardianPublicCatalog } from "../index.js";

describe("public catalog type", () => {
  it("is the type of the catalog JSON", () => {
    expectTypeOf<GuardianPublicCatalog>().toEqualTypeOf<
      typeof catalogJson
    >();
  });

  it("holds the catalog JSON", () => {
    expect(guardianCatalog).toStrictEqual(catalogJson);
  });
});
