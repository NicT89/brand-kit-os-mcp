/**
 * Platform-specific expression resolution.
 *
 * Users configure a distinct voice per platform through PlatformExpressionDialog,
 * stored on `social_profiles.expression_overrides`. Before this module the MCP
 * server never read that column, so every agent generated content with the
 * global voice and silently ignored the overrides the user deliberately set.
 *
 * Inheritance is resolved here, server-side. Returning base and override
 * separately and expecting the model to merge them is exactly the kind of work
 * a model does inconsistently.
 */

import { describeToneDimensions } from "../../_shared/tone-dimensions.ts";

/** Fields the platform dialog can override. */
export const OVERRIDABLE_EXPRESSION_FIELDS = [
  "verbal_style",
  "preferred_terminology",
  "tone_dimensions",
  "tone_of_voice",
] as const;

export interface ResolvedPlatformExpression {
  platform: string;
  profile_type: string | null;
  has_overrides: boolean;
  overridden_fields: string[];
  expression: Record<string, unknown>;
  base_values: Record<string, unknown>;
}

type Supabase = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => any;
    };
  };
};

/** Overrides configured for one platform, or null when the profile has none. */
export async function fetchPlatformOverrides(
  supabaseAdmin: Supabase,
  brandKitId: string,
  platform: string,
): Promise<{ overrides: Record<string, unknown> | null; profileType: string | null }> {
  const { data } = await supabaseAdmin
    .from("social_profiles")
    .select("profile_type, expression_overrides")
    .eq("brand_kit_id", brandKitId)
    .eq("platform", platform.toLowerCase())
    .eq("is_disconnected", false);

  const rows = (data ?? []) as Array<{ profile_type: string | null; expression_overrides: unknown }>;
  // Company overrides win when both a company and a personal profile carry them:
  // brand-level voice is what content generation is asking for.
  const withOverrides = rows.filter(
    (r) => r.expression_overrides && typeof r.expression_overrides === "object" && Object.keys(r.expression_overrides as object).length > 0,
  );
  if (withOverrides.length === 0) return { overrides: null, profileType: rows[0]?.profile_type ?? null };
  const preferred = withOverrides.find((r) => r.profile_type === "company") ?? withOverrides[0];
  return {
    overrides: preferred.expression_overrides as Record<string, unknown>,
    profileType: preferred.profile_type ?? null,
  };
}

/** Merge overrides over the global expression row and report what changed. */
export function applyPlatformOverrides(
  baseExpression: Record<string, unknown> | null,
  overrides: Record<string, unknown> | null,
  platform: string,
  profileType: string | null,
): ResolvedPlatformExpression {
  const base = { ...(baseExpression ?? {}) };
  const merged: Record<string, unknown> = { ...base };
  const overriddenFields: string[] = [];
  const baseValues: Record<string, unknown> = {};

  for (const field of OVERRIDABLE_EXPRESSION_FIELDS) {
    const value = overrides?.[field];
    const isPresent =
      value !== undefined &&
      value !== null &&
      (typeof value !== "object" || Object.keys(value as object).length > 0);
    if (!isPresent) continue;
    overriddenFields.push(field);
    baseValues[field] = base[field] ?? null;
    merged[field] = value;
  }

  if (merged.tone_dimensions && typeof merged.tone_dimensions === "object") {
    merged.tone_dimensions = describeToneDimensions(merged.tone_dimensions as Record<string, unknown>);
  }

  return {
    platform: platform.toLowerCase(),
    profile_type: profileType,
    has_overrides: overriddenFields.length > 0,
    overridden_fields: overriddenFields,
    expression: merged,
    base_values: baseValues,
  };
}
