// Generated file — do not edit.
export interface ToolRecordPort {
  invoke(input: {
    attemptId: string;
    connectionId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<
    { ok: true; result: unknown } | { ok: false; reason: string } | null
  >;
}
