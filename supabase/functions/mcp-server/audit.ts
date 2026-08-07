// Audit-trail recording for MCP write tools.
//
// `mcp_request_logs` already carries the observability fields (who, when,
// which tool, scopes, error, timing). This helper layers semantic audit
// fields on top: which operation, which row, before/after snapshots, and a
// precomputed column-name diff.
//
// Migration: supabase/migrations/20260608000000_mcp_request_logs_audit_columns.sql
// All writes here are best-effort and wrapped in try/catch — audit failure
// must never fail the user-facing tool call.

export type AuditOperation =
  | "upsert"
  | "update"
  | "create"
  | "archive"
  | "restore"
  | "generate"
  | "read";

export interface AuditFields {
  operation: AuditOperation;
  resource_type: string;
  resource_id?: string | null;
  before_state?: unknown;
  after_state?: unknown;
  was_dry_run: boolean;
}

const SNAPSHOT_MAX_BYTES = 8 * 1024;
const PREVIEW_CHARS = 500;

/**
 * Keep a single before/after snapshot under SNAPSHOT_MAX_BYTES so the audit
 * log can fit 30 days of writes without the table ballooning. Truncated
 * snapshots keep the original size + a short preview so a human can still
 * tell what the value was.
 */
export function truncateSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { _truncated: true, _reason: "not_serializable" };
  }
  if (json.length <= SNAPSHOT_MAX_BYTES) return value;
  return {
    _truncated: true,
    _original_size: json.length,
    _preview: json.slice(0, PREVIEW_CHARS),
  };
}

/**
 * Top-level column-name diff. Operates on the row as a flat record (the
 * dominant shape for brand_kit_* tables). Nested-object diffing isn't
 * computed here — `before_state` and `after_state` are kept verbatim for
 * deeper review.
 */
export function computeDiff(
  before: unknown,
  after: unknown,
): { added: string[]; removed: string[]; changed: string[] } {
  const a = before && typeof before === "object" && !Array.isArray(before)
    ? (before as Record<string, unknown>)
    : {};
  const b = after && typeof after === "object" && !Array.isArray(after)
    ? (after as Record<string, unknown>)
    : {};

  const beforeKeys = new Set(Object.keys(a));
  const afterKeys = new Set(Object.keys(b));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) {
      added.push(k);
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      changed.push(k);
    }
  }
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) removed.push(k);
  }
  return { added, removed, changed };
}

/**
 * Populate the audit columns on the in-flight `mcp_request_logs` row.
 * Identifies the row by `request_id` (the same UUID returned to the client
 * as `Mcp-Request-Id`). Silent on failure — the user-facing call already
 * succeeded by the time we get here.
 */
export async function recordAuditFields(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  requestId: string | undefined,
  fields: AuditFields,
): Promise<void> {
  if (!supabaseAdmin || !requestId) return;
  const before = truncateSnapshot(fields.before_state);
  const after = truncateSnapshot(fields.after_state);
  const hasBoth = fields.before_state != null && fields.after_state != null;
  const diff = hasBoth ? computeDiff(fields.before_state, fields.after_state) : null;
  try {
    await supabaseAdmin
      .from("mcp_request_logs")
      .update({
        operation: fields.operation,
        resource_type: fields.resource_type,
        resource_id: fields.resource_id ?? null,
        before_state: before ?? null,
        after_state: after ?? null,
        state_diff: diff,
        was_dry_run: fields.was_dry_run,
      })
      .eq("request_id", requestId);
  } catch (err) {
    console.error("[audit] Failed to record audit fields:", err);
  }
}

/**
 * Read a single row to capture as `before_state`. Returns null if the row
 * doesn't exist (which is fine — that's the create case).
 */
export async function captureRowSnapshot(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  table: string,
  column: string,
  value: string,
  // deno-lint-ignore no-explicit-any
  extraEq?: { column: string; value: string },
): Promise<unknown> {
  if (!supabaseAdmin) return null;
  try {
    let query = supabaseAdmin.from(table).select("*").eq(column, value);
    if (extraEq) query = query.eq(extraEq.column, extraEq.value);
    const { data } = await query.maybeSingle();
    return data ?? null;
  } catch (err) {
    console.error(`[audit] Failed to capture snapshot from ${table}:`, err);
    return null;
  }
}
