export type ToolErrorCode =
  | "scope_denied"
  | "access_denied"
  | "validation_error"
  | "missing_field"
  | "invalid_reference"
  | "not_found"
  | "quota_exceeded"
  | "ai_gateway_failed"
  | "db_error"
  | "timeout"
  | "internal_error"
  | "confirmation_required"
  | "stale_version"
  | "scrape_failed";

export interface ToolErrorOpts {
  code: ToolErrorCode;
  retryable?: boolean;
  recovery?: string;
  data?: Record<string, unknown>;
  /** The MCP tool name where the error originated. */
  tool?: string;
  /** The specific input field that caused the error, if applicable. */
  field?: string;
  /**
   * Whether the agent can self-correct and retry without human intervention.
   * Defaults are derived from `code` when omitted:
   *   - validation_error / missing_field / invalid_reference / not_found / stale_version → true
   *   - scope_denied / access_denied / confirmation_required → false
   *   - db_error / ai_gateway_failed / timeout / scrape_failed → true (retryable transient)
   *   - quota_exceeded / internal_error → false
   */
  recoverable?: boolean;
  /** Concrete next step the agent should take to recover. Surfaced as `suggested_fix`. */
  suggestedFix?: string;
}

function defaultRecoverable(code: ToolErrorCode): boolean {
  switch (code) {
    case "validation_error":
    case "missing_field":
    case "invalid_reference":
    case "not_found":
    case "stale_version":
    case "db_error":
    case "ai_gateway_failed":
    case "timeout":
    case "scrape_failed":
      return true;
    default:
      return false;
  }
}

/**
 * Structured tool error envelope.
 *
 * Returns an MCP tool result with `isError: true`. The result contains BOTH:
 *
 *   - `_meta` (legacy + machine-readable):
 *       { error_code, retryable, recovery_hint, tool?, field?, recoverable, suggested_fix?, ...data }
 *   - `content[0].text` — a JSON string with the canonical envelope:
 *       {
 *         "error": {
 *           "code": "<error_code>",
 *           "tool": "<tool_name>",
 *           "field": "<field>?",
 *           "message": "<human readable>",
 *           "recoverable": true|false,
 *           "suggested_fix": "<next step>?",
 *           "retryable": true|false,
 *           "data": { ... }
 *         }
 *       }
 *
 * Agents should parse `content[0].text` first; clients that only inspect
 * `_meta` continue to work unchanged.
 */
export function toolError(message: string, opts: ToolErrorOpts) {
  const recoverable = opts.recoverable ?? defaultRecoverable(opts.code);
  const suggestedFix = opts.suggestedFix ?? opts.recovery;

  const meta: Record<string, unknown> = {
    error_code: opts.code,
    retryable: opts.retryable ?? false,
    recoverable,
  };
  if (opts.recovery) meta.recovery_hint = opts.recovery;
  if (opts.tool) meta.tool = opts.tool;
  if (opts.field) meta.field = opts.field;
  if (suggestedFix) meta.suggested_fix = suggestedFix;
  if (opts.data) Object.assign(meta, opts.data);

  const envelope: Record<string, unknown> = {
    code: opts.code,
    message,
    recoverable,
    retryable: opts.retryable ?? false,
  };
  if (opts.tool) envelope.tool = opts.tool;
  if (opts.field) envelope.field = opts.field;
  if (suggestedFix) envelope.suggested_fix = suggestedFix;
  if (opts.data) envelope.data = opts.data;

  return {
    content: [{ type: "text", text: JSON.stringify({ error: envelope }, null, 2) }],
    isError: true,
    _meta: meta,
  };
}

export const SCOPE_DENIED_RECOVERY = (scope: string) =>
  `Mint a new API key with the '${scope}' scope at /settings → API Keys, or disconnect and reconnect the OAuth integration to grant write access.`;

export const ACCESS_DENIED_RECOVERY =
  "Confirm the brand_kit_id is correct, or ask the brand kit owner to share it with you via /brand-kits → Members.";

export const MEMBER_MCP_WRITE_DENIED_RECOVERY =
  "Only the brand kit owner or a member with the admin role can edit this kit via MCP. Ask an owner to upgrade your role to admin, or make changes in the Brand Kit OS app.";
