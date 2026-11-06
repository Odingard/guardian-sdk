// Types for "@odingard/guardian-hook/agent-sdk" (see src/agent-sdk.ts).
type Env = Readonly<Record<string, string | undefined>>;

export type GuardianHookInput = Readonly<{
  hook_event_name?: string;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}>;

export type GuardianHookOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "allow" | "deny";
        permissionDecisionReason: string;
      };
    };

export type GuardianPreToolUseOptions = Readonly<{
  env?: Env;
  agentName?: string;
  log?: (line: string) => void;
}>;

export declare function guardianPreToolUse(
  options?: GuardianPreToolUseOptions,
): (input: GuardianHookInput) => Promise<GuardianHookOutput>;

export declare const GUARDIAN_HOOK_TIMEOUT_SECONDS: number;

export declare function guardianHookMatcher(
  options?: GuardianPreToolUseOptions,
): {
  hooks: ((input: GuardianHookInput) => Promise<GuardianHookOutput>)[];
  timeout: number;
  onFailure: "block";
};
