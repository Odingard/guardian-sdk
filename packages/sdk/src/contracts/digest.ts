// Generated file — do not edit.
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
