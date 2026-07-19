import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { formatPersonality } from "../ai-gateway.ts";
import { normalizeGovernanceForRead, toJsonArray } from "../json-helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

export const readBrandKitHandlers: Record<string, ToolHandler> = {
  get_brand_kit: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const { brand_kit_id } = args;
    if (!brand_kit_id) {
      return toolError("brand_kit_id is required", {
        code: "validation_error",
        recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument.",
      });
    }

    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    const includeRaw = Array.isArray((args as { include?: unknown }).include) ? (args as { include: unknown[] }).include : [];
    const includeSet = new Set(
      includeRaw.filter((v): v is string => typeof v === "string"),
    );
    const wantSeo = includeSet.has("seo");
    const wantExamples = includeSet.has("expression_examples");
    const wantKnowledge = includeSet.has("knowledge_files");

    const [
      { data: brandKit }, { data: core }, { data: personality },
      { data: expression }, { data: governance }, { data: products },
      { data: audience }, { data: personas }, { data: competitors },
      { data: socialProfiles }, { data: logoAssets },
      seoRes, examplesRes, knowledgeRes,
    ] = await Promise.all([
      supabaseAdmin.from("brand_kits").select("*").eq("id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_core").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_personality").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_expression").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_governance").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_products").select("*").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_target_audience").select("*").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_personas").select("*").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_competitors").select("id, name, url, description, logo_url, brand_colors, fonts, tagline, value_propositions, social_profiles, brand_personality, color_scheme, design_framework, created_at").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("social_profiles").select("id, platform, profile_type, profile_url, status, full_name, headline, about, biography, job_title, company_name, followers, following_count, is_business_account, profile_image_url, business_category, created_at").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_logo_assets").select("id, asset_key, label, url, description, usage_guidelines, image_width, image_height, file_type, is_default, sort_order, created_at").eq("brand_kit_id", brand_kit_id).order("sort_order", { ascending: true }),
      wantSeo
        ? supabaseAdmin.from("brand_kit_seo").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle()
        : Promise.resolve({ data: null }),
      wantExamples
        ? supabaseAdmin.from("expression_examples").select("id, platform, context_type, user_response, original_content, source, platform_metadata, created_at, updated_at").eq("brand_kit_id", brand_kit_id).order("created_at", { ascending: false })
        : Promise.resolve({ data: null }),
      wantKnowledge
        ? supabaseAdmin.from("user_knowledge_file_uploads").select("id, title, original_file_name, description, relevance_hint, file_type, tags, category, sensitivity, department, version, source, platform_context, created_at").eq("brand_kit_id", brand_kit_id).order("created_at", { ascending: false })
        : Promise.resolve({ data: null }),
    ]);


    const resolvedPersonality = personality ? formatPersonality(personality) : null;
    const normalizedGovernance = normalizeGovernanceForRead(governance);

    const fullBrandKit: Record<string, unknown> = {
      ...brandKit,
      core,
      personality: resolvedPersonality,
      expression,
      governance: normalizedGovernance,
      products: products || [],
      target_audience: audience || [],
      personas: personas || [],
      competitors: competitors || [],
      social_profiles: socialProfiles || [],
      logo_assets: logoAssets || [],
    };
    if (wantSeo) fullBrandKit.seo = (seoRes as { data: unknown }).data ?? null;
    if (wantExamples) fullBrandKit.expression_examples = (examplesRes as { data: unknown }).data ?? [];
    if (wantKnowledge) fullBrandKit.knowledge_files = (knowledgeRes as { data: unknown }).data ?? [];


    return { content: [{ type: "text", text: JSON.stringify(fullBrandKit, null, 2) }] };
  },

  get_brand_kit_summary: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const { brand_kit_id } = args;
    if (!brand_kit_id) {
      return toolError("brand_kit_id is required", {
        code: "validation_error",
        recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument.",
      });
    }

    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    const [
      { data: bk }, { data: core }, { data: personality }, { data: expression },
      { data: governance }, { data: products }, { data: audience },
    ] = await Promise.all([
      supabaseAdmin.from("brand_kits").select("name, tagline, description, brand_voice").eq("id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_core").select("mission, vision").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_personality").select("personality_traits, brand_values").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_expression").select("tone_of_voice, tone_dimensions").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_governance").select("behavioral_constraints, writing_constraints").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_products").select("name, type, usp").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_target_audience").select("persona_name, persona_type, is_primary, demographics").eq("brand_kit_id", brand_kit_id),
    ]);

    const traitNames = toJsonArray(personality?.personality_traits).slice(0, 3).map((t: Record<string, string>) => t.title || t.name);
    const valueNames = toJsonArray(personality?.brand_values).slice(0, 3).map((v: Record<string, string>) => v.name);

    const constraints = [
      ...toJsonArray(governance?.behavioral_constraints).slice(0, 2),
      ...toJsonArray(governance?.writing_constraints).slice(0, 1),
    ].slice(0, 3);

    const summary = {
      name: bk?.name || "",
      tagline: bk?.tagline || "",
      description: bk?.description || "",
      brand_voice: bk?.brand_voice || "",
      mission: core?.mission || "",
      vision: core?.vision || "",
      top_personality_traits: traitNames,
      top_values: valueNames,
      tone: expression?.tone_of_voice || {},
      tone_dimensions: expression?.tone_dimensions || {},
      top_constraints: constraints,
      products: (products || []).map((p: Record<string, unknown>) => ({ name: p.name, type: p.type, usp: p.usp })),
      primary_audiences: (audience || []).filter((a: Record<string, unknown>) => a.is_primary).map((a: Record<string, unknown>) => ({
        persona_name: a.persona_name,
        persona_type: a.persona_type,
        demographics: a.demographics,
      })),
    };

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
};
