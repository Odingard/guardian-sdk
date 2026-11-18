#!/usr/bin/env node
/**
 * The `guardian-hook` command. A small entry with no dependencies: it loads
 * the hook (./index.js, which needs @odingard/guardian-sdk) with a dynamic
 * import, so a hook that cannot load or crashes still blocks the tool call
 * (exit 2) instead of letting it run. See fail-closed.ts.
 */
import { runFailClosed } from "./fail-closed.js";

runFailClosed(() => import("./index.js"));
