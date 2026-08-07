import { formatPersonality } from "../ai-gateway.ts";
import { filterFields } from "../helpers.ts";
import { toolError } from "../tool-errors.ts";
import { normalizeGovernanceForRead } from "../json-helpers.ts";
import { jsonContent, requireBrandKitReadAccess } from "./access-helpers.ts";
import type { ToolHandler } from "./types.ts";

/**
 * Slot-key normalization for brand_kit_expression reads (Gap #7).
 *
 * The canonical write contract on `upsert_brand_kit_expression` uses
 * `verbal_style_1 … verbal_style_5` and `visual_style_1 … visual_style_5`
 * keys inside the `verbal_style` / `visual_style` JSONB objects. Some legacy
 * rows persist `slot_1 … slot_5`. To keep agents from chasing two different
 * key conventions, reads expose BOTH: the canonical keys are the source of
 * truth, and the `slot_1..5` aliases are added (marked deprecated) so
 * existing consumers keep working for one release.
 */
function normalizeExpressionSlotsForRead<T extends Record<string, unknown> | null | undefined>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = { ...row };
  for (const [field, canonicalPrefix] of [["verbal_style", "verbal_style"], ["visual_style", "visual_style"]] as const) {
    const raw = out[field];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = { ...(raw as Record<string, unknown>) };
    for (let i = 1; i <= 5; i++) {
      const canonical = `${canonicalPrefix}_${i}`;
      const slotAlias = `slot_${i}`;
      if (obj[canonical] === undefined && obj[slotAlias] !== undefined) {
        obj[canonical] = obj[slotAlias];
      } else if (obj[slotAlias] === undefined && obj[canonical] !== undefined) {
        obj[slotAlias] = obj[canonical];
      }
    }
    out[field] = obj;
  }
  out._slot_keys_deprecated = "slot_1..slot_5 aliases are deprecated; use verbal_style_1..5 and visual_style_1..5 going forward.";
  return out as T;
}


export const sectionReadHandlers: Record<string, ToolHandler> = {
  get_brand_kit_core: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_core")
      .select("*")
      .eq("brand_kit_id", brand_kit_id)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent(filterFields(data, ctx.args.fields));
  },

  get_brand_kit_personality: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_personality")
      .select("*")
      .eq("brand_kit_id", brand_kit_id)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    if (!data) return jsonContent(null);
    return jsonContent(filterFields(formatPersonality(data), ctx.args.fields));
  },

  get_brand_kit_expression: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_expression")
      .select("*")
      .eq("brand_kit_id", brand_kit_id)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent(filterFields(normalizeExpressionSlotsForRead(data), ctx.args.fields));
  },

  get_brand_kit_products: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_products")
      .select("*")
      .eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent((data || []).map((item: any) => filterFields(item, ctx.args.fields)));
  },

  get_brand_kit_audience: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_target_audience")
      .select("*")
      .eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent((data || []).map((item: any) => filterFields(item, ctx.args.fields)));
  },

  get_brand_kit_governance: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_governance")
      .select("*")
      .eq("brand_kit_id", brand_kit_id)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent(filterFields(normalizeGovernanceForRead(data), ctx.args.fields));
  },

  get_brand_kit_personas: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_personas")
      .select("*")
      .eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent((data || []).map((item: any) => filterFields(item, ctx.args.fields)));
  },

  get_brand_kit_competitors: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_competitors")
      .select("*")
      .eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent((data || []).map((item: any) => filterFields(item, ctx.args.fields)));
  },

  get_brand_kit_social_profiles: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("social_profiles")
      .select(
        "id, platform, profile_type, profile_url, status, full_name, headline, about, biography, job_title, company_name, followers, following_count, is_business_account, profile_image_url, business_category, created_at",
      )
      .eq("brand_kit_id", brand_kit_id);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent(data || []);
  },

  get_brand_kit_logo_assets: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kit_logo_assets")
      .select(
        "id, asset_key, label, url, description, long_description, usage_guidelines, image_width, image_height, file_type, is_default, sort_order, created_at",
      )
      .eq("brand_kit_id", brand_kit_id)
      .order("sort_order", { ascending: true });
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent(data || []);
  },

  get_brand_kit_visuals: async (ctx) => {
    const { brand_kit_id } = ctx.args;
    const gate = await requireBrandKitReadAccess(brand_kit_id as string, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;
    // Visuals live as columns on brand_kits (no separate table). Mirror the
    // update_brand_kit_visuals allowed-list plus the server-computed config so
    // the read round-trips everything update_brand_kit_visuals can write.
    const cols =
      "id, primary_color, secondary_color, accent_color, background_color, text_primary_color, text_secondary_color, link_color, color_scheme, color_details, additional_colors, custom_1_color, custom_1_name, custom_2_color, custom_2_name, custom_3_color, custom_3_name, custom_4_color, custom_4_name, heading_font, body_font, paragraph_font, font_sizes, font_weights, fonts_list, spacing, button_styles, logo_url, logo_dark_url, favicon_url, og_image_url, css_custom_properties, color_roles, font_scale, line_heights, letter_spacing, shadow_scale, border_radius_scale, spacing_scale, button_variants, input_styles, card_styles, max_container_width, breakpoints, dark_mode_tokens, tailwind_config, css_variables_export";
    const { data, error } = await ctx.supabaseAdmin
      .from("brand_kits")
      .select(cols)
      .eq("id", brand_kit_id)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    return jsonContent(filterFields(data, ctx.args.fields));
  },
};
