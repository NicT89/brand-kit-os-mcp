import { toolError } from "../tool-errors.ts";
import { describeToneDimensions } from "../../_shared/tone-dimensions.ts";
import { jsonContent, requireBrandKitReadAccess } from "./access-helpers.ts";
import { applyPlatformOverrides, fetchPlatformOverrides, OVERRIDABLE_EXPRESSION_FIELDS } from "./platform-expression.ts";
import type { ToolHandler } from "./types.ts";

const EXPRESSION_COLUMNS = "tone_of_voice, tone_dimensions, verbal_style, visual_style, preferred_terminology, voice_archetypes";

export const platformExpressionHandlers: Record<string, ToolHandler> = {
  get_platform_expression: async (ctx) => {
    const { brand_kit_id, platform } = ctx.args as { brand_kit_id?: string; platform?: string };
    if (!brand_kit_id || !platform) {
      return toolError("brand_kit_id and platform are required", {
        code: "validation_error",
        recovery: "Provide brand_kit_id (UUID) and platform (e.g. linkedin, instagram). Use list_platform_expressions to see which platforms have overrides.",
      });
    }
    const gate = await requireBrandKitReadAccess(brand_kit_id, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;

    const { data: expression, error } = await ctx.supabaseAdmin
      .from("brand_kit_expression")
      .select(EXPRESSION_COLUMNS)
      .eq("brand_kit_id", brand_kit_id)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });

    const { overrides, profileType } = await fetchPlatformOverrides(ctx.supabaseAdmin, brand_kit_id, platform);
    const resolved = applyPlatformOverrides(
      expression as Record<string, unknown> | null,
      overrides,
      platform,
      profileType,
    );
    if (!resolved.has_overrides && resolved.expression.tone_dimensions && typeof resolved.expression.tone_dimensions === "object") {
      resolved.expression.tone_dimensions = describeToneDimensions(
        resolved.expression.tone_dimensions as Record<string, unknown>,
      );
    }
    return jsonContent(resolved);
  },

  list_platform_expressions: async (ctx) => {
    const { brand_kit_id } = ctx.args as { brand_kit_id?: string };
    if (!brand_kit_id) {
      return toolError("brand_kit_id is required", { code: "validation_error" });
    }
    const gate = await requireBrandKitReadAccess(brand_kit_id, ctx.userId, ctx.supabaseAdmin);
    if (gate) return gate;

    const { data, error } = await ctx.supabaseAdmin
      .from("social_profiles")
      .select("platform, profile_type, expression_overrides")
      .eq("brand_kit_id", brand_kit_id)
      .eq("is_disconnected", false);
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });

    const rows = (data ?? []) as Array<{ platform: string; profile_type: string | null; expression_overrides: unknown }>;
    const platforms = rows.map((row) => {
      const overrides =
        row.expression_overrides && typeof row.expression_overrides === "object"
          ? (row.expression_overrides as Record<string, unknown>)
          : {};
      const fields = OVERRIDABLE_EXPRESSION_FIELDS.filter((field) => {
        const value = overrides[field];
        return value !== undefined && value !== null && (typeof value !== "object" || Object.keys(value as object).length > 0);
      });
      return {
        platform: row.platform,
        profile_type: row.profile_type,
        has_overrides: fields.length > 0,
        overridden_fields: fields,
      };
    });

    return jsonContent({
      platforms,
      configured_count: platforms.filter((p) => p.has_overrides).length,
    });
  },
};
