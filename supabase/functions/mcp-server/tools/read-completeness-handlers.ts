import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { getMcpFieldMeta, MCP_AGENT_HINTS } from "../../_shared/brand-field-schemas.ts";
import { normalizeGovernanceForRead } from "../json-helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

export const readCompletenessHandlers: Record<string, ToolHandler> = {
  get_brand_kit_completeness: async (ctx) => {
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
      { data: bk }, { data: core }, { data: personality },
      { data: expression }, { data: governance }, { data: products },
      { data: audience }, { data: personas }, { data: seo },
      { data: competitors }, { data: socialProfiles }, { data: logoAssets },
      { data: expressionExamples },
    ] = await Promise.all([
      supabaseAdmin.from("brand_kits").select("name, tagline, description, brand_voice, primary_color, heading_font, logo_url").eq("id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_core").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_personality").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_expression").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_governance").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_products").select("id, name").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_target_audience").select("id, persona_name").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_personas").select("id, name").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_seo").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
      supabaseAdmin.from("brand_kit_competitors").select("id, name").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("social_profiles").select("id, platform").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("brand_kit_logo_assets").select("id, label").eq("brand_kit_id", brand_kit_id),
      supabaseAdmin.from("expression_examples").select("id").eq("brand_kit_id", brand_kit_id),
    ]);

    const isEmpty = (val: unknown) =>
      val === null || val === undefined || val === "" ||
      (Array.isArray(val) && val.length === 0) ||
      (typeof val === "object" && !Array.isArray(val) && Object.keys(val as object).length === 0);

    const fieldEntry = (field: string, upsertTool: string) => {
      const meta = getMcpFieldMeta(field, upsertTool);
      return {
        field,
        tool: meta.tool,
        preview_tool: meta.preview_tool,
        type: meta.type,
        example: meta.example,
        guidance: meta.guidance,
      };
    };

    const report: Record<string, unknown> = {
      brand_kit_id,
      brand_kit_name: bk?.name,
      mcp_hints: MCP_AGENT_HINTS,
      sections: {},
    };

    const rootMissing: unknown[] = [];
    if (isEmpty(bk?.tagline)) rootMissing.push(fieldEntry("tagline", "update_brand_kit"));
    if (isEmpty(bk?.description)) rootMissing.push(fieldEntry("description", "update_brand_kit"));
    if (isEmpty(bk?.brand_voice)) rootMissing.push(fieldEntry("brand_voice", "upsert_brand_kit_expression"));
    (report.sections as Record<string, unknown>).root = { status: rootMissing.length === 0 ? "complete" : "partial", missing_fields: rootMissing };

    const visualMissing: unknown[] = [];
    if (isEmpty(bk?.primary_color)) visualMissing.push(fieldEntry("primary_color", "update_brand_kit_visuals"));
    if (isEmpty(bk?.heading_font)) visualMissing.push(fieldEntry("heading_font", "update_brand_kit_visuals"));
    if (isEmpty(bk?.logo_url)) visualMissing.push(fieldEntry("logo_url", "update_brand_kit_visuals"));
    (report.sections as Record<string, unknown>).visual_identity = { status: visualMissing.length === 0 ? "complete" : "partial", missing_fields: visualMissing };

    const coreMissing: unknown[] = [];
    if (isEmpty(core?.mission)) coreMissing.push(fieldEntry("mission", "upsert_brand_kit_core"));
    if (isEmpty(core?.vision)) coreMissing.push(fieldEntry("vision", "upsert_brand_kit_core"));
    if (isEmpty(core?.brand_story)) coreMissing.push(fieldEntry("brand_story", "upsert_brand_kit_core"));
    if (isEmpty(core?.brand_promises)) coreMissing.push(fieldEntry("brand_promises", "upsert_brand_kit_core"));
    if (isEmpty(core?.taglines)) coreMissing.push(fieldEntry("taglines", "upsert_brand_kit_core"));
    if (isEmpty(core?.storytelling_elements)) coreMissing.push(fieldEntry("storytelling_elements", "upsert_brand_kit_core"));
    (report.sections as Record<string, unknown>).core = { status: !core ? "empty" : coreMissing.length === 0 ? "complete" : "partial", missing_fields: coreMissing };

    const personalityMissing: unknown[] = [];
    if (isEmpty(personality?.personality_traits)) personalityMissing.push(fieldEntry("personality_traits", "upsert_brand_kit_personality"));
    if (isEmpty(personality?.brand_values)) personalityMissing.push(fieldEntry("brand_values", "upsert_brand_kit_personality"));
    if (isEmpty(personality?.brand_principles)) personalityMissing.push(fieldEntry("brand_principles", "upsert_brand_kit_personality"));
    if (isEmpty(personality?.brand_moods)) personalityMissing.push(fieldEntry("brand_moods", "upsert_brand_kit_personality"));
    (report.sections as Record<string, unknown>).personality = { status: !personality ? "empty" : personalityMissing.length === 0 ? "complete" : "partial", missing_fields: personalityMissing };

    const expressionMissing: unknown[] = [];
    if (isEmpty(expression?.tone_of_voice)) expressionMissing.push(fieldEntry("tone_of_voice", "upsert_brand_kit_expression"));
    if (isEmpty(expression?.tone_dimensions)) expressionMissing.push(fieldEntry("tone_dimensions", "upsert_brand_kit_expression"));
    if (isEmpty(expression?.voice_archetypes)) expressionMissing.push(fieldEntry("voice_archetypes", "upsert_brand_kit_expression"));
    if (isEmpty(expression?.verbal_style)) expressionMissing.push(fieldEntry("verbal_style", "upsert_brand_kit_expression"));
    if (isEmpty(expression?.preferred_terminology)) expressionMissing.push(fieldEntry("preferred_terminology", "upsert_brand_kit_expression"));

    (report.sections as Record<string, unknown>).expression = { status: !expression ? "empty" : expressionMissing.length === 0 ? "complete" : "partial", missing_fields: expressionMissing };

    const governanceMissing: unknown[] = [];
    const normalizedGov = normalizeGovernanceForRead(governance);
    if (isEmpty(normalizedGov?.behavioral_constraints)) governanceMissing.push(fieldEntry("behavioral_constraints", "upsert_brand_kit_governance"));
    if (isEmpty(governance?.negative_directory)) governanceMissing.push(fieldEntry("negative_directory", "upsert_brand_kit_governance"));
    if (isEmpty(normalizedGov?.writing_constraints)) governanceMissing.push(fieldEntry("writing_constraints", "upsert_brand_kit_governance"));

    if (isEmpty(normalizedGov?.drift_prevention_prompts)) governanceMissing.push(fieldEntry("drift_prevention_prompts", "upsert_brand_kit_governance"));
    (report.sections as Record<string, unknown>).governance = { status: !governance ? "empty" : governanceMissing.length === 0 ? "complete" : "partial", missing_fields: governanceMissing };

    const seoMissing: unknown[] = [];
    if (isEmpty(seo?.keywords)) seoMissing.push(fieldEntry("keywords", "upsert_brand_kit_seo"));
    (report.sections as Record<string, unknown>).seo = { status: !seo ? "empty" : seoMissing.length === 0 ? "complete" : "partial", missing_fields: seoMissing };

    (report.sections as Record<string, unknown>).products = { status: (products || []).length === 0 ? "empty" : "populated", count: (products || []).length };
    (report.sections as Record<string, unknown>).target_audience = { status: (audience || []).length === 0 ? "empty" : "populated", count: (audience || []).length };
    (report.sections as Record<string, unknown>).ai_personas = { status: (personas || []).length === 0 ? "empty" : "populated", count: (personas || []).length };
    (report.sections as Record<string, unknown>).competitors = { status: (competitors || []).length === 0 ? "empty" : "populated", count: (competitors || []).length };
    (report.sections as Record<string, unknown>).social_profiles = { status: (socialProfiles || []).length === 0 ? "empty" : "populated", count: (socialProfiles || []).length };
    (report.sections as Record<string, unknown>).logo_assets = { status: (logoAssets || []).length === 0 ? "empty" : "populated", count: (logoAssets || []).length };
    (report.sections as Record<string, unknown>).expression_examples = { status: (expressionExamples || []).length === 0 ? "empty" : "populated", count: (expressionExamples || []).length };

    const sectionStatuses = Object.values(report.sections as Record<string, { status: string }>);
    const complete = sectionStatuses.filter((s) => s.status === "complete" || s.status === "populated").length;
    report.completeness_score = Math.round((complete / sectionStatuses.length) * 100);
    report.presence_score = report.completeness_score;

    // Quality scoring: stricter than presence. A field is "quality-filled" when
    // it is present AND meaningful (string length ≥ 10 chars, non-empty objects
    // for tone_dimensions, ≥ 2 populated slots for verbal_style/visual_style,
    // ≥ 1 archetype with archetype_id for voice_archetypes, etc.).
    const minStringLen = (v: unknown, n = 10) => typeof v === "string" && v.trim().length >= n;
    const populatedSlots = (obj: unknown, prefix: string) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
      const o = obj as Record<string, unknown>;
      let count = 0;
      for (let i = 1; i <= 5; i++) {
        const slot = o[`${prefix}_${i}`] ?? o[`slot_${i}`];
        if (slot && typeof slot === "object" && Object.keys(slot as object).length > 1) count++;
      }
      return count;
    };
    const archetypesLinked = (() => {
      const arr = (expression as { voice_archetypes?: unknown } | null)?.voice_archetypes;
      if (!Array.isArray(arr)) return 0;
      return arr.filter((a) => (a as { archetype_id?: string })?.archetype_id).length;
    })();

    const qualityChecks: Array<{ section: string; field: string; pass: boolean }> = [
      { section: "core", field: "mission", pass: minStringLen(core?.mission, 20) },
      { section: "core", field: "vision", pass: minStringLen(core?.vision, 20) },
      { section: "core", field: "brand_story", pass: minStringLen(core?.brand_story, 100) },
      { section: "expression", field: "tone_of_voice", pass: !!expression?.tone_of_voice && typeof expression.tone_of_voice === "object" && Object.keys(expression.tone_of_voice as object).length > 0 },
      { section: "expression", field: "tone_dimensions", pass: !!expression?.tone_dimensions && typeof expression.tone_dimensions === "object" && Object.keys(expression.tone_dimensions as object).length >= 3 },
      { section: "expression", field: "voice_archetypes_linked", pass: archetypesLinked >= 1 },
      { section: "expression", field: "verbal_style", pass: populatedSlots(expression?.verbal_style, "verbal_style") >= 2 },
      { section: "expression", field: "visual_style", pass: populatedSlots(expression?.visual_style, "visual_style") >= 2 },
      { section: "personality", field: "personality_traits", pass: Array.isArray(personality?.personality_traits) && (personality!.personality_traits as unknown[]).length >= 3 },
      { section: "personality", field: "brand_values", pass: Array.isArray(personality?.brand_values) && (personality!.brand_values as unknown[]).length >= 3 },
      { section: "governance", field: "writing_constraints", pass: Array.isArray((normalizedGov as { writing_constraints?: { constraints?: unknown[] } } | null)?.writing_constraints?.constraints) && ((normalizedGov as { writing_constraints?: { constraints?: unknown[] } } | null)?.writing_constraints?.constraints as unknown[]).length > 0 },
      { section: "governance", field: "behavioral_constraints", pass: Array.isArray(normalizedGov?.behavioral_constraints) && (normalizedGov!.behavioral_constraints as unknown[]).length >= 2 },
      { section: "audience", field: "has_audience_personas", pass: (audience || []).length > 0 },
      { section: "personas", field: "has_ai_personas", pass: (personas || []).length > 0 },
      { section: "products", field: "has_products", pass: (products || []).length > 0 },
    ];
    const qualityPass = qualityChecks.filter((c) => c.pass).length;
    report.quality_score = Math.round((qualityPass / qualityChecks.length) * 100);
    report.flagged_gaps = qualityChecks.filter((c) => !c.pass).map((c) => `${c.section}.${c.field}`);
    report.summary = `${complete} of ${sectionStatuses.length} sections present (${report.completeness_score}%) · quality ${report.quality_score}% · ${report.flagged_gaps.length} flagged gap(s)`;

    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
};
