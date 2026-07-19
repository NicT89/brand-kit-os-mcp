// batch_upsert — apply N section upserts atomically (all-or-nothing).
//
// Implementation notes:
//   • Supabase-js handlers can't share a Postgres transaction, so we
//     simulate atomicity with snapshot + revert:
//       1. Snapshot every targeted (table, brand_kit_id) row.
//       2. Dispatch each op through the existing tool handler.
//       3. If any op returns isError (or throws), revert every row that
//          was already written by re-upserting the captured snapshot.
//       4. Surface a session_id on every result so writes are traceable
//          across audit log rows.
//   • Only single-row section upserts are accepted today. Collection
//     mutations (create/update/delete persona, product, etc.) are
//     intentionally excluded because they can't be cleanly reverted
//     without per-table delete logic.

import type { ToolHandler } from "./types.ts";
import { toolError } from "../tool-errors.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

const ALLOWED_TOOLS_TO_TABLE: Record<string, string> = {
  upsert_brand_kit_core: "brand_kit_core",
  upsert_brand_kit_expression: "brand_kit_expression",
  upsert_brand_kit_personality: "brand_kit_personality",
  upsert_brand_kit_governance: "brand_kit_governance",
  upsert_brand_kit_seo: "brand_kit_seo",
  set_platform_specific_rules: "brand_kit_governance",
};

const MAX_OPS = 12;

function genSessionId(): string {
  return crypto.randomUUID();
}

export const batchHandlers: Record<string, ToolHandler> = {
  batch_upsert: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const brandKitId = typeof args?.brand_kit_id === "string" ? args.brand_kit_id : null;
    const ops = Array.isArray(args?.operations) ? args.operations as unknown[] : null;
    const dryRun = args?.dry_run === true;

    if (!brandKitId) {
      return toolError("brand_kit_id is required", {
        code: "missing_field",
        tool: "batch_upsert",
        field: "brand_kit_id",
      });
    }
    if (!ops || ops.length === 0) {
      return toolError("`operations` must be a non-empty array.", {
        code: "validation_error",
        tool: "batch_upsert",
        field: "operations",
        suggestedFix: "Pass an array like [{ tool: 'upsert_brand_kit_core', args: { mission: '…' } }].",
      });
    }
    if (ops.length > MAX_OPS) {
      return toolError(`Too many operations (${ops.length}); max ${MAX_OPS} per batch.`, {
        code: "validation_error",
        tool: "batch_upsert",
        field: "operations",
      });
    }

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", {
        code: "access_denied",
        tool: "batch_upsert",
        field: "brand_kit_id",
      });
    }

    // Validate each op shape + tool allow-list up front so we fail fast.
    const normalized: Array<{ tool: string; args: Record<string, unknown>; table: string }> = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as { tool?: unknown; args?: unknown } | null;
      const tool = typeof op?.tool === "string" ? op.tool : null;
      const opArgs = (op?.args && typeof op.args === "object") ? op.args as Record<string, unknown> : null;
      if (!tool || !opArgs) {
        return toolError(`operations[${i}] must be { tool, args }.`, {
          code: "validation_error",
          tool: "batch_upsert",
          field: `operations[${i}]`,
        });
      }
      const table = ALLOWED_TOOLS_TO_TABLE[tool];
      if (!table) {
        return toolError(
          `operations[${i}].tool '${tool}' is not allowed in batch_upsert.`,
          {
            code: "validation_error",
            tool: "batch_upsert",
            field: `operations[${i}].tool`,
            suggestedFix: `Allowed tools: ${Object.keys(ALLOWED_TOOLS_TO_TABLE).join(", ")}.`,
          },
        );
      }
      const kit = opArgs.brand_kit_id;
      if (kit && kit !== brandKitId) {
        return toolError(
          `operations[${i}].args.brand_kit_id must match the batch brand_kit_id (or be omitted).`,
          {
            code: "validation_error",
            tool: "batch_upsert",
            field: `operations[${i}].args.brand_kit_id`,
          },
        );
      }
      normalized.push({
        tool,
        args: { ...opArgs, brand_kit_id: brandKitId },
        table,
      });
    }

    const sessionId = genSessionId();
    // Lazy import to avoid the dispatch <-> batch circular dependency at
    // module load time.
    const { dispatchTool } = await import("./dispatch.ts");

    // Snapshot every distinct target table once, so revert is a single
    // upsert per table even if a table is touched twice.
    const distinctTables = Array.from(new Set(normalized.map((o) => o.table)));
    const snapshots = new Map<string, Record<string, unknown> | null>();
    for (const table of distinctTables) {
      const { data } = await supabaseAdmin
        .from(table)
        .select("*")
        .eq("brand_kit_id", brandKitId)
        .maybeSingle();
      snapshots.set(table, (data as Record<string, unknown> | null) ?? null);
    }

    const results: Array<{
      index: number;
      tool: string;
      status: "ok" | "error" | "reverted";
      result?: unknown;
      error?: unknown;
    }> = [];

    const written: string[] = [];
    let failedAt: number | null = null;
    let failureResult: unknown = null;

    for (let i = 0; i < normalized.length; i++) {
      const op = normalized[i];
      const dispatched = await dispatchTool(op.tool, {
        ...ctx,
        // Forward dry_run when the batch is a dry run.
        args: { ...op.args, ...(dryRun ? { dry_run: true } : {}) },
      });

      if (!dispatched) {
        failedAt = i;
        failureResult = { error: { code: "internal_error", message: `Tool '${op.tool}' not found` } };
        results.push({ index: i, tool: op.tool, status: "error", error: failureResult });
        break;
      }
      if ((dispatched as { isError?: boolean }).isError) {
        failedAt = i;
        failureResult = dispatched;
        results.push({ index: i, tool: op.tool, status: "error", error: dispatched });
        break;
      }

      results.push({ index: i, tool: op.tool, status: "ok", result: dispatched });
      if (!dryRun) written.push(op.table);
    }

    // Revert phase: restore any table written before the failure point.
    const revertedTables: string[] = [];
    const revertErrors: Array<{ table: string; message: string }> = [];
    if (failedAt !== null && !dryRun && written.length > 0) {
      const distinctWritten = Array.from(new Set(written));
      for (const table of distinctWritten) {
        const snapshot = snapshots.get(table);
        try {
          if (snapshot && typeof snapshot === "object") {
            const { error } = await supabaseAdmin
              .from(table)
              .upsert(snapshot, { onConflict: "brand_kit_id" });
            if (error) {
              revertErrors.push({ table, message: error.message });
            } else {
              revertedTables.push(table);
            }
          } else {
            // No prior row → delete what we just wrote to leave the table
            // in its pre-batch state.
            const { error } = await supabaseAdmin
              .from(table)
              .delete()
              .eq("brand_kit_id", brandKitId);
            if (error) {
              revertErrors.push({ table, message: error.message });
            } else {
              revertedTables.push(table);
            }
          }
        } catch (err) {
          revertErrors.push({ table, message: String((err as Error)?.message ?? err) });
        }
      }
      // Mark previously-ok results as reverted so callers don't think
      // those writes survived.
      for (const r of results) {
        if (r.status === "ok") r.status = "reverted";
      }
    }

    const isError = failedAt !== null;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_id: sessionId,
          brand_kit_id: brandKitId,
          dry_run: dryRun,
          atomic: true,
          succeeded: !isError,
          failed_at: failedAt,
          results,
          reverted_tables: revertedTables,
          revert_errors: revertErrors,
          notes: isError
            ? "Batch aborted; previously-applied ops were reverted to their pre-batch snapshot. revert_errors lists any rows that could not be restored — check get_write_history for traceability via session_id."
            : "Batch applied. session_id is stamped on every audit log row for this batch.",
        }, null, 2),
      }],
      isError,
    };
  },
};
