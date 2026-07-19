import type { LogLevel } from "../notify.ts";

export type { LogLevel };

export interface ToolHandlerContext {
  args: Record<string, unknown>;
  userId: string;
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any;
  scopes: string[];
  /**
   * UUID generated per MCP request and surfaced to the client as the
   * `Mcp-Request-Id` response header. Write handlers use it to attach
   * audit fields (before/after state, operation, resource) to the
   * existing in-flight `mcp_request_logs` row via `recordAuditFields`.
   */
  requestId?: string;
  /**
   * Emit a `notifications/message` event to the SSE client mid-call.
   * No-op for JSON-only clients. Throttled to one message per 100ms per
   * handler call; urgent levels (warning+) bypass the throttle. Level
   * filtering uses the session log level set by `logging/setLevel`
   * (default `info`).
   */
  log: (level: LogLevel, message: string, data?: unknown) => Promise<void>;
  /**
   * Emit a `notifications/progress` event to the SSE client. No-op for
   * JSON-only clients. Throttled to one message per 100ms per handler
   * call; completion events (`current >= total`) bypass the throttle.
   * Uses the client's `_meta.progressToken` when provided, otherwise
   * falls back to the request id.
   */
  progress: (current: number, total?: number, message?: string) => Promise<void>;
}

export type ToolHandlerResult = Record<string, unknown> & { isError?: boolean };

export type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolHandlerResult>;
