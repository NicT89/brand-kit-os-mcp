import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { buildBrandKitComputedFields, scrapeVisualIdentity, type VisualIdentityResult } from "../scrape-visual-identity.ts";
import { dryRunPreview, filterFields, refundTokens, withTimeout } from "../helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { recordAuditFields } from "../audit.ts";
import {
  FONT_FIELD_KEYS,
  gateFontFields,
  loadFontLibrary,
  normalizeFontsList as normalizeFontsListForLibrary,
} from "../../_shared/font-vocabulary.ts";


export const brandWriteHandlers: Record<string, ToolHandler> = {
  update_brand_kit: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedRoot = assertBrandKitSectionScope(scopes, "visuals");
          if (scopeDeniedRoot) return scopeDeniedRoot;
          const { brand_kit_id, dry_run, ...fields } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          await log("info", "Starting update_brand_kit", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const allowed = ['name','description','long_summary','tagline','website_url','brand_kit_social_urls','industry_details','og_image_url','additional_colors'];
          const updateData: Record<string, any> = {};
          for (const key of allowed) {
            if (fields[key] !== undefined) updateData[key] = fields[key];
          }
          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided.", { code: "validation_error" });

          const selectCols = 'name, description, long_summary, tagline, website_url, brand_kit_social_urls, industry_details, og_image_url, additional_colors';
          const { data: beforeState } = await supabaseAdmin.from('brand_kits').select(selectCols).eq('id', brand_kit_id).maybeSingle();

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'update',
              resource_type: 'brand_kits',
              // resource_id stays null for root-level brand_kits writes — the
              // mcp_request_logs.brand_kit_id column already identifies the kit.
              resource_id: null,
              before_state: beforeState,
              after_state: { ...(beforeState ?? {}), ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kits', beforeState, updateData);
          }

          const { data: row, error } = await supabaseAdmin.from('brand_kits').update(updateData).eq('id', brand_kit_id).select('id, ' + selectCols).single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'update',
            resource_type: 'brand_kits',
            resource_id: null,
            before_state: beforeState,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "update_brand_kit done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, data: row }, null, 2) }] };
  },

  update_brand_kit_visuals: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedVisuals = assertBrandKitSectionScope(scopes, "visuals");
          if (scopeDeniedVisuals) return scopeDeniedVisuals;
          const { brand_kit_id, dry_run, ...fields } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          await log("info", "Starting update_brand_kit_visuals", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const allowed = ['primary_color','secondary_color','accent_color','background_color','text_primary_color','text_secondary_color','link_color','color_scheme','color_details','custom_1_color','custom_1_name','custom_2_color','custom_2_name','custom_3_color','custom_3_name','custom_4_color','custom_4_name','heading_font','body_font','paragraph_font','font_sizes','font_weights','fonts_list','spacing','button_styles','logo_url','logo_dark_url','favicon_url','css_custom_properties','color_roles','font_scale','line_heights','letter_spacing','shadow_scale','border_radius_scale','spacing_scale','button_variants','input_styles','card_styles','max_container_width','breakpoints','dark_mode_tokens'];
          const updateData: Record<string, any> = {};
          for (const key of allowed) {
            if (fields[key] !== undefined) updateData[key] = fields[key];
          }
          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided.", { code: "validation_error" });

          // Font vocabulary gate: the three font slots must resolve to families in
          // the approved font_library, exactly like the UI picker enforces.
          // Bundler noise (`__DM_Sans_0d7163`) and CSS stacks (`ui-sans-serif`)
          // are auto-corrected; anything unrecognized is rejected with guidance.
          const fontKeysPresent = FONT_FIELD_KEYS.filter((key) => updateData[key] !== undefined);
          const fontCorrections: Array<{ field: string; from: string; to: string; reason: string }> = [];
          if (fontKeysPresent.length > 0) {
            let library;
            try {
              library = await loadFontLibrary(supabaseAdmin);
            } catch (libraryError) {
              return toolError(
                `Could not load the font library: ${libraryError instanceof Error ? libraryError.message : "unknown error"}`,
                { code: "db_error", retryable: true },
              );
            }
            const gate = gateFontFields(updateData, library, true);
            if (gate.rejected.length > 0) {
              const detail = gate.rejected
                .map((r) => `${r.field}: "${r.value}" — ${r.reason}`)
                .join("; ");
              return toolError(`Unapproved font value(s). ${detail}`, {
                code: "validation_error",
                recovery:
                  "Use a family from the approved font library (get_brand_kit_visual_identity shows the current fonts). Add a genuinely new family through the app's \"Add custom font\" flow before writing it.",
              });
            }
            for (const key of fontKeysPresent) {
              if (gate.values[key] !== undefined) updateData[key] = gate.values[key];
            }
            fontCorrections.push(...gate.corrections);
            if (updateData.fonts_list !== undefined) {
              updateData.fonts_list = normalizeFontsListForLibrary(updateData.fonts_list, library);
            }
            if (fontCorrections.length > 0) {
              await log("info", "Normalized font values against the font library", { corrections: fontCorrections });
            }
          }


          // Compute tailwind_config and css_variables_export from merged state.
          // `current` doubles as the audit before_state — no extra round-trip.
          const { data: current } = await supabaseAdmin.from('brand_kits').select(allowed.join(', ')).eq('id', brand_kit_id).maybeSingle();
          const merged = { ...(current ?? {}), ...updateData };
          const computed = buildBrandKitComputedFields(merged);
          updateData.tailwind_config = computed.tailwind_config;
          updateData.css_variables_export = computed.css_variables_export;

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'update',
              resource_type: 'brand_kits',
              resource_id: null,
              before_state: current,
              after_state: merged,
              was_dry_run: true,
            });
            return dryRunPreview('brand_kits (visuals)', current, updateData);
          }

          const selectCols = 'id, tailwind_config, css_variables_export, ' + allowed.join(', ');
          const { data: row, error } = await supabaseAdmin.from('brand_kits').update(updateData).eq('id', brand_kit_id).select(selectCols).single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'update',
            resource_type: 'brand_kits',
            resource_id: null,
            before_state: current,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "update_brand_kit_visuals done");
          const visualsPayload: Record<string, unknown> = { success: true, data: row };
          if (fontCorrections.length > 0) visualsPayload.font_corrections = fontCorrections;
          return { content: [{ type: "text", text: JSON.stringify(visualsPayload, null, 2) }] };
  },
};
