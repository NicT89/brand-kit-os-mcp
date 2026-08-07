// get_write_history — reads from the existing mcp_request_logs audit view.
//
// No new columns required: every MCP write handler already stamps
// operation / resource_type / before_state / after_state / state_diff via
// recordAuditFields(). This tool just exposes that data with an
// agent-friendly shape, scoped to a single brand kit.

import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Map resource_type values stored in mcp_request_logs back to the section
 * names used elsewhere in the MCP surface (section-map, get_agent_briefing).
 */
const RESOURCE_TO_SECTION: Record<string, string> = {
  brand_kits: "root",
  brand_kit_core: "core",
  brand_kit_personality: "personality",
  brand_kit_expression: "expression",
  brand_kit_governance: "governance",
  brand_kit_seo: "seo",
  brand_kit_products: "products",
  brand_kit_target_audience: "audience",
  brand_kit_personas: "personas",
  brand_kit_competitors: "competitors",
  brand_kit_logo_assets: "logos",
  brand_kit_knowledge_files: "knowledge_files",
  expression_examples: "expression_examples",
};

export const historyHandlers: Record<string, ToolHandler> = {
  get_write_history: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const brandKitId = typeof args?.brand_kit_id === "string" ? args.brand_kit_id : null;
    if (!brandKitId) {
      return toolError("brand_kit_id is required", {
        code: "missing_field",
        tool: "get_write_history",
        field: "brand_kit_id",
        suggestedFix: "Pass the UUID returned by list_brand_kits.",
      });
    }

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", {
        code: "access_denied",
        tool: "get_write_history",
        field: "brand_kit_id",
        recovery: ACCESS_DENIED_RECOVERY,
      });
    }

    const sectionFilter = typeof args?.section === "string" ? args.section : null;
    const includeDryRuns = args?.include_dry_runs === true;
    const limitArg = Number(args?.limit);
    const limit = Number.isFinite(limitArg) && limitArg > 0
      ? Math.min(Math.floor(limitArg), MAX_LIMIT)
      : DEFAULT_LIMIT;

    let query = supabaseAdmin
      .from("mcp_request_logs")
      .select(
        "request_id, user_id, tool_name, operation, resource_type, resource_id, state_diff, was_dry_run, request_status, error_code, created_at",
      )
      .eq("brand_kit_id", brandKitId)
      .not("operation", "is", null)
      .neq("operation", "read")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!includeDryRuns) query = query.eq("was_dry_run", false);

    const { data, error } = await query;
    if (error) {
      return toolError(`Database error: ${error.message}`, {
        code: "db_error",
        tool: "get_write_history",
        retryable: true,
      });
    }

    const entries = (data || [])
      .map((row: Record<string, unknown>) => {
        const resourceType = (row.resource_type as string | null) ?? null;
        const section = resourceType ? RESOURCE_TO_SECTION[resourceType] ?? resourceType : null;
        return {
          request_id: row.request_id,
          tool: row.tool_name,
          operation: row.operation,
          section,
          resource_type: resourceType,
          resource_id: row.resource_id,
          updated_by: row.user_id,
          changed_columns: (row.state_diff as { changed?: string[] } | null)?.changed ?? [],
          added_columns: (row.state_diff as { added?: string[] } | null)?.added ?? [],
          removed_columns: (row.state_diff as { removed?: string[] } | null)?.removed ?? [],
          was_dry_run: row.was_dry_run,
          status: row.request_status,
          error_code: row.error_code,
          at: row.created_at,
        };
      })
      .filter((e: { section: string | null }) =>
        sectionFilter ? e.section === sectionFilter : true,
      );

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          brand_kit_id: brandKitId,
          section: sectionFilter,
          limit,
          include_dry_runs: includeDryRuns,
          entries,
          notes: "Sourced from mcp_request_logs audit view; retained for 30 days. Reads (operation='read' or NULL) are excluded.",
        }, null, 2),
      }],
    };
  },
};
