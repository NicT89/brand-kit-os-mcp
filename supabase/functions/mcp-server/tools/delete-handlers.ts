import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { WRITE_SCOPE } from "../constants.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { recordAuditFields } from "../audit.ts";

// Preview payload for a delete. Mirrors the competitor confirm flow: the commit
// requires `confirm: true` (with dry_run omitted), not `dry_run: false`.
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

export const deleteHandlers: Record<string, ToolHandler> = {
  delete_brand_kit_product: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "products");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.product_id, "product_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_products to look up the product_id." });
    await log("info", "Starting delete_brand_kit_product", { product_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("brand_kit_products").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("Product not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the product_id with get_brand_kit_products for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_products", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("brand_kit_products", existing);
    }
    const { error } = await supabaseAdmin.from("brand_kit_products").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_products", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_brand_kit_product done", { product_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "brand_kit_products" } }, null, 2) }] };
  },

  delete_brand_kit_competitor: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "competitors");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.competitor_id, "competitor_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_competitors to look up the competitor_id." });
    await log("info", "Starting delete_brand_kit_competitor", { competitor_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("brand_kit_competitors").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("Competitor not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the competitor_id with get_brand_kit_competitors for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_competitors", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("brand_kit_competitors", existing);
    }
    const { error } = await supabaseAdmin.from("brand_kit_competitors").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_competitors", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_brand_kit_competitor done", { competitor_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "brand_kit_competitors" } }, null, 2) }] };
  },

  delete_audience_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "audience");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.persona_id, "persona_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_audience to look up the persona_id." });
    await log("info", "Starting delete_audience_persona", { persona_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("brand_kit_target_audience").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("Audience persona not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the persona_id with get_brand_kit_audience for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_target_audience", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("brand_kit_target_audience", existing);
    }
    const { error } = await supabaseAdmin.from("brand_kit_target_audience").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_target_audience", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_audience_persona done", { persona_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "brand_kit_target_audience" } }, null, 2) }] };
  },

  delete_brand_kit_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "personas");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.persona_id, "persona_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_personas to look up the persona_id." });
    await log("info", "Starting delete_brand_kit_persona", { persona_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("brand_kit_personas").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("AI persona not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the persona_id with get_brand_kit_personas for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_personas", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("brand_kit_personas", existing);
    }
    const { error } = await supabaseAdmin.from("brand_kit_personas").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_personas", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_brand_kit_persona done", { persona_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "brand_kit_personas" } }, null, 2) }] };
  },

  delete_expression_example: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "expression");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.example_id, "example_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call list_expression_examples to look up the example_id." });
    await log("info", "Starting delete_expression_example", { example_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("expression_examples").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("Expression example not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the example_id with list_expression_examples for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "expression_examples", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("expression_examples", existing);
    }
    const { error } = await supabaseAdmin.from("expression_examples").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "expression_examples", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_expression_example done", { example_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "expression_examples" } }, null, 2) }] };
  },

  delete_logo_asset: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "logos");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.asset_id, "asset_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call list_logo_assets to look up the asset_id." });
    await log("info", "Starting delete_logo_asset", { asset_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("brand_kit_logo_assets").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("Logo asset not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the asset_id with list_logo_assets for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_logo_assets", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("brand_kit_logo_assets", existing);
    }
    const { error } = await supabaseAdmin.from("brand_kit_logo_assets").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "brand_kit_logo_assets", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_logo_asset done", { asset_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "brand_kit_logo_assets" } }, null, 2) }] };
  },

  // Knowledge files use the generic write scope (like upload_knowledge_file) and
  // need their storage object removed alongside the row.
  delete_knowledge_file: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    if (!scopes.includes(WRITE_SCOPE)) {
      return toolError(`This tool requires the '${WRITE_SCOPE}' scope. Mint a new API key with write access to use it.`, { code: "scope_denied", recovery: SCOPE_DENIED_RECOVERY(WRITE_SCOPE) });
    }
    const { brand_kit_id, dry_run } = args;
    const idRes = validateUuidParam(args.file_id, "file_id");
    if (!("ok" in idRes)) return idRes;
    const id = idRes.value;
    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call list_knowledge_files to look up the file_id and its brand_kit_id." });
    await log("info", "Starting delete_knowledge_file", { file_id: id, dry_run: !!dry_run });
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;
    const { data: existing } = await supabaseAdmin.from("user_knowledge_file_uploads").select("*").eq("id", id).eq("brand_kit_id", brand_kit_id).maybeSingle();
    if (!existing) return toolError("Knowledge file not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the file_id with list_knowledge_files for this brand kit." });
    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "user_knowledge_file_uploads", resource_id: id, before_state: existing, after_state: null, was_dry_run: true });
      return deletePreview("user_knowledge_file_uploads", existing);
    }
    const { error } = await supabaseAdmin.from("user_knowledge_file_uploads").delete().eq("id", id).eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    // Best-effort storage cleanup — don't fail the delete if the object is already gone.
    if (existing.storage_path) {
      try { await supabaseAdmin.storage.from("user-knowledge-files").remove([existing.storage_path]); } catch (_e) { /* ignore */ }
    }
    await recordAuditFields(supabaseAdmin, requestId, { operation: "delete", resource_type: "user_knowledge_file_uploads", resource_id: id, before_state: existing, after_state: null, was_dry_run: false });
    await log("info", "delete_knowledge_file done", { file_id: id });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted: { id, resource: "user_knowledge_file_uploads" } }, null, 2) }] };
  },
};
