import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { recordAuditFields } from "../audit.ts";
import { dryRunPreview } from "../helpers.ts";
import { jsonContent, requireBrandKitReadAccess } from "./access-helpers.ts";
import {
  normalizeCompanyProfileValues,
  pickCompanyProfileFields,
  stripInapplicableCompanyFields,
  type CompanyProfileKind,
} from "../../_shared/company-profile-schema.ts";
import {
  applyCompanyProfileVocabularyGate,
  buildVocabularyReport,
} from "./persona-vocabulary-gate.ts";

const TABLE = "brand_kit_company_profiles";

// Company-level audience records reuse the `audience` write scope: they are the
// company-shaped half of the same brand-kit section that person personas cover.
const SECTION = "audience" as const;

function deletePreview(resource: string, before: unknown) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        dry_run: true,
        message: "Preview only — nothing deleted. Call again with confirm: true (omit dry_run) to delete.",
        resource,
        will_delete: before,
        next_call: { confirm: true },
      }, null, 2),
    }],
  };
}

async function readProfiles(ctx: Parameters<ToolHandler>[0], kind: CompanyProfileKind) {
  const { brand_kit_id } = ctx.args;
  const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
  if (gate) return gate;
  const { data, error } = await ctx.supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("brand_kit_id", brand_kit_id)
    .eq("profile_kind", kind)
    .order("is_primary", { ascending: false })
    .order("created_at");
  if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
  return jsonContent(data ?? []);
}

/** Shared write gate: scope → access → member role → confirmation toggle. */
async function writeGate(ctx: Parameters<ToolHandler>[0], brandKitId: string) {
  const scopeDenied = assertBrandKitSectionScope(ctx.scopes, SECTION);
  if (scopeDenied) return scopeDenied;
  const hasAccess = await verifyBrandKitAccess(brandKitId, ctx.userId, ctx.supabaseAdmin);
  if (!hasAccess) {
    return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
  }
  const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brandKitId, ctx.userId, ctx.supabaseAdmin);
  if (mcpWriteGate) return mcpWriteGate;
  return await assertMcpWriteConfirmation(ctx.args, ctx.userId, ctx.supabaseAdmin);
}

function createHandler(kind: CompanyProfileKind, toolName: string): ToolHandler {
  return async (ctx) => {
    const { args, supabaseAdmin, requestId, log } = ctx;
    const { brand_kit_id, dry_run, ...fields } = args;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
    if (typeof fields.name !== "string" || !fields.name.trim()) {
      return toolError("name is required", {
        code: "validation_error",
        recovery: kind === "customer"
          ? "Provide the customer's company name."
          : "Provide a short archetype label, e.g. 'Founder-Led Purity Challenger'.",
      });
    }
    await log("info", `Starting ${toolName}`, { brand_kit_id, dry_run: !!dry_run });

    const gate = await writeGate(ctx, brand_kit_id as string);
    if (gate) return gate;

    const picked = pickCompanyProfileFields(fields);
    stripInapplicableCompanyFields(picked, kind);
    let insertPayload = normalizeCompanyProfileValues({
      ...picked,
      brand_kit_id,
      profile_kind: kind,
      source: typeof picked.source === "string" ? picked.source : "manual",
      is_primary: picked.is_primary === true,
    }) as Record<string, unknown>;

    // Controlled-vocabulary gate: company_size / revenue_range must be real options.
    const vocabGate = await applyCompanyProfileVocabularyGate(insertPayload, supabaseAdmin);
    if (vocabGate.error) return vocabGate.error;
    insertPayload = vocabGate.result!.payload;

    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "create", resource_type: TABLE, resource_id: null, before_state: null, after_state: insertPayload, was_dry_run: true });
      return dryRunPreview(`${TABLE} (insert)`, null, insertPayload, {
        normalizations: vocabGate.result!.normalizations,
      });
    }

    const report = buildVocabularyReport(vocabGate.result!, `mcp:${toolName}`);
    if (report) insertPayload.vocabulary_report = report;
    const { data: row, error } = await supabaseAdmin.from(TABLE).insert(insertPayload).select("*").single();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "create", resource_type: TABLE, resource_id: row?.id ?? null, before_state: null, after_state: row, was_dry_run: false });
    await log("info", `${toolName} done`, { profile_id: row?.id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, profile: row, normalizations: vocabGate.result!.normalizations }, null, 2) }] };

  };
}

function updateHandler(kind: CompanyProfileKind, toolName: string, idArg: string): ToolHandler {
  return async (ctx) => {
    const { args, supabaseAdmin, requestId, log } = ctx;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args[idArg], idArg);
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
    await log("info", `Starting ${toolName}`, { profile_id: id, dry_run: !!dry_run });

    const gate = await writeGate(ctx, brand_kit_id as string);
    if (gate) return gate;

    const { data: existing } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .eq("brand_kit_id", brand_kit_id)
      .eq("profile_kind", kind)
      .maybeSingle();
    if (!existing) {
      return toolError("Company profile not found or does not belong to this brand kit", {
        code: "not_found",
        recovery: kind === "customer"
          ? "Verify the customer_id with get_brand_kit_customers."
          : "Verify the icp_id with get_brand_kit_company_icps.",
      });
    }

    const picked = pickCompanyProfileFields(args as Record<string, unknown>);
    stripInapplicableCompanyFields(picked, kind);
    let updateData = normalizeCompanyProfileValues(picked) as Record<string, unknown>;
    if (Object.keys(updateData).length === 0) {
      return toolError("At least one field must be provided to update.", {
        code: "validation_error",
        recovery: "Include at least one optional argument describing the change you want to make.",
      });
    }

    const vocabGate = await applyCompanyProfileVocabularyGate(updateData, supabaseAdmin);
    if (vocabGate.error) return vocabGate.error;
    updateData = vocabGate.result!.payload;

    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "update", resource_type: TABLE, resource_id: id, before_state: existing, after_state: { ...existing, ...updateData }, was_dry_run: true });
      return dryRunPreview(TABLE, existing, updateData, {
        normalizations: vocabGate.result!.normalizations,
      });
    }

    const report = buildVocabularyReport(vocabGate.result!, `mcp:${toolName}`);
    if (report) updateData.vocabulary_report = report;
    const { data: row, error } = await supabaseAdmin.from(TABLE).update(updateData).eq("id", id).select("*").single();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "update", resource_type: TABLE, resource_id: id, before_state: existing, after_state: row, was_dry_run: false });
    await log("info", `${toolName} done`, { profile_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, profile: row, normalizations: vocabGate.result!.normalizations }, null, 2) }] };

  };
}

function deleteHandler(kind: CompanyProfileKind, toolName: string, idArg: string): ToolHandler {
  return async (ctx) => {
    const { args, supabaseAdmin, requestId, log } = ctx;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args[idArg], idArg);
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
    await log("info", `Starting ${toolName}`, { profile_id: id, dry_run: !!dry_run });

    const gate = await writeGate(ctx, brand_kit_id as string);
    if (gate) return gate;

    const { data: existing } = await supabaseAdmin
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .eq("brand_kit_id", brand_kit_id)
      .eq("profile_kind", kind)
      .maybeSingle();
    if (!existing) {
      return toolError("Company profile not found or does not belong to this brand kit", { code: "not_found" });
    }

    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: TABLE, resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview(TABLE, existing);
    }

    const { error } = await supabaseAdmin.from(TABLE).delete().eq("id", id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: TABLE, resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", `${toolName} done`, { profile_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_id: id }, null, 2) }] };
  };
}

export const companyProfileHandlers: Record<string, ToolHandler> = {
  get_brand_kit_customers: (ctx) => readProfiles(ctx, "customer"),
  get_brand_kit_company_icps: (ctx) => readProfiles(ctx, "company_icp"),

  create_customer_profile: createHandler("customer", "create_customer_profile"),
  update_customer_profile: updateHandler("customer", "update_customer_profile", "customer_id"),
  delete_customer_profile: deleteHandler("customer", "delete_customer_profile", "customer_id"),

  create_company_icp: createHandler("company_icp", "create_company_icp"),
  update_company_icp: updateHandler("company_icp", "update_company_icp", "icp_id"),
  delete_company_icp: deleteHandler("company_icp", "delete_company_icp", "icp_id"),
};
