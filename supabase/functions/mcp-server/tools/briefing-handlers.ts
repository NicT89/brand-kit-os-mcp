import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { buildBrandKitSectionToolMap } from "./section-map.ts";
import { normalizeGovernanceForRead } from "../json-helpers.ts";

const SECTIONS = [
  "core",
  "personality",
  "expression",
  "governance",
  "products",
  "audience",
  "personas",
  "competitors",
  "seo",
  "expression_examples",
  "logos",
  "social_profiles",
  "knowledge_files",
];

function fieldFill(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function countFields(row: Record<string, unknown> | null | undefined, fields: string[]) {
  const filled: string[] = [];
  const empty: string[] = [];
  for (const f of fields) {
    if (row && fieldFill(row[f])) filled.push(f);
    else empty.push(f);
  }
  return { filled, empty };
}

export const briefingHandlers: Record<string, ToolHandler> = {
  /**
   * One-call session bootstrap.
   *
   * Without `brand_kit_id`: returns kits the user can access and the
   * canonical next step.
   *
   * With `brand_kit_id`: returns brand kit metadata, a per-section health
   * report (last_updated_at, filled/empty field counts, flagged gaps),
   * the tool catalog scoped to each section, and recommended next steps.
   */
  get_agent_briefing: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const brandKitId = typeof args?.brand_kit_id === "string" ? args.brand_kit_id : null;
    const sectionMap = buildBrandKitSectionToolMap();

    if (!brandKitId) {
      const [{ data: owned }, { data: memberOf }] = await Promise.all([
        supabaseAdmin
          .from("brand_kits")
          .select("id, name, tagline, updated_at, completion_percentage")
          .eq("user_id", userId),
        supabaseAdmin
          .from("brand_kit_members")
          .select("role, brand_kits:brand_kit_id(id, name, tagline, updated_at, completion_percentage)")
          .eq("user_id", userId),
      ]);

      const seen = new Set<string>();
      const kits: unknown[] = [];
      for (const k of owned || []) {
        if (!k?.id || seen.has(k.id)) continue;
        seen.add(k.id);
        kits.push({ ...k, membership_role: "owner" });
      }
      for (const m of memberOf || []) {
        const k = m?.brand_kits;
        if (!k?.id || seen.has(k.id)) continue;
        seen.add(k.id);
        kits.push({ ...k, membership_role: String(m.role || "viewer") });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            instructions:
              "This is the canonical session-bootstrap response. Pick the most relevant brand_kit_id, then call get_agent_briefing again with brand_kit_id to receive a per-section health report and recommended next steps.",
            brand_kits: kits,
            next_action: kits.length === 1
              ? `Call get_agent_briefing({ brand_kit_id: "${(kits[0] as { id: string }).id}" })`
              : "Call get_agent_briefing({ brand_kit_id }) for the kit the user wants to work on.",
            section_tool_map: sectionMap,
          }, null, 2),
        }],
      };
    }

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", {
        code: "access_denied",
        tool: "get_agent_briefing",
        field: "brand_kit_id",
        recovery: ACCESS_DENIED_RECOVERY,
      });
    }

    const [
      { data: bk, error: bkError },
      { data: core },
      { data: personality },
      { data: expression },
      { data: governance },
      { data: products },
      { data: audience },
      { data: personas },
      { data: seo },
      { data: competitors },
      { data: socialProfiles },
      { data: logoAssets },
      { data: knowledgeFiles },
      { data: expressionExamples },
    ] = await Promise.all([
      supabaseAdmin.from("brand_kits").select("id, name, tagline, description, industry_details, updated_at, completion_percentage, version").eq("id", brandKitId).maybeSingle(),

      supabaseAdmin.from("brand_kit_core").select("*, updated_at").eq("brand_kit_id", brandKitId).maybeSingle(),
      supabaseAdmin.from("brand_kit_personality").select("*, updated_at").eq("brand_kit_id", brandKitId).maybeSingle(),
      supabaseAdmin.from("brand_kit_expression").select("*, updated_at").eq("brand_kit_id", brandKitId).maybeSingle(),
      supabaseAdmin.from("brand_kit_governance").select("*, updated_at").eq("brand_kit_id", brandKitId).maybeSingle(),
      supabaseAdmin.from("brand_kit_products").select("id, name, updated_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("brand_kit_target_audience").select("id, persona_name, updated_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("brand_kit_personas").select("id, name, updated_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("brand_kit_seo").select("*, updated_at").eq("brand_kit_id", brandKitId).maybeSingle(),
      supabaseAdmin.from("brand_kit_competitors").select("id, name, updated_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("social_profiles").select("id, platform, updated_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("brand_kit_logo_assets").select("id, label, updated_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("user_knowledge_file_uploads").select("id, original_file_name, created_at").eq("brand_kit_id", brandKitId),
      supabaseAdmin.from("expression_examples").select("id, updated_at").eq("brand_kit_id", brandKitId),
    ]);

    if (bkError) {
      return toolError(`Database error: ${bkError.message}`, {
        code: "db_error",
        tool: "get_agent_briefing",
        retryable: true,
      });
    }

    if (!bk) {
      return toolError("Brand kit not found", {
        code: "not_found",
        tool: "get_agent_briefing",
        field: "brand_kit_id",
        suggestedFix: "Call list_brand_kits to get a valid id.",
      });
    }


    const lastUpdatedFromRows = (rows: Array<{ updated_at?: string | null }> | null | undefined) => {
      if (!rows || rows.length === 0) return null;
      return rows
        .map((r) => r.updated_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;
    };

    const gov = normalizeGovernanceForRead(governance);

    const sections: Record<string, unknown> = {
      core: {
        last_updated_at: core?.updated_at ?? null,
        ...countFields(core as Record<string, unknown> | null, [
          "mission", "vision", "brand_story", "brand_promises", "taglines", "storytelling_elements",
        ]),
        flagged_gaps: !core ? ["section_never_populated"] : [],
      },
      personality: {
        last_updated_at: personality?.updated_at ?? null,
        ...countFields(personality as Record<string, unknown> | null, [
          "personality_traits", "brand_values", "brand_principles", "brand_moods",
        ]),
        flagged_gaps: !personality ? ["section_never_populated"] : [],
      },
      expression: {
        last_updated_at: expression?.updated_at ?? null,
        ...countFields(expression as Record<string, unknown> | null, [
          "tone_of_voice", "tone_dimensions", "voice_archetypes", "verbal_style", "visual_style", "preferred_terminology",
        ]),
        flagged_gaps: (() => {
          const gaps: string[] = [];
          if (!expression) gaps.push("section_never_populated");
          const archetypes = (expression as { voice_archetypes?: unknown[] } | null)?.voice_archetypes;
          if (Array.isArray(archetypes) && archetypes.some((a) => !(a as { archetype_id?: string })?.archetype_id)) {
            gaps.push("voice_archetypes_not_linked_to_library");
          }
          return gaps;
        })(),
      },
      governance: {
        last_updated_at: governance?.updated_at ?? null,
        filled: [
          "behavioral_constraints", "writing_constraints", "negative_directory", "drift_prevention_prompts",
        ].filter((f) => fieldFill((gov as Record<string, unknown> | null)?.[f] ?? (governance as Record<string, unknown> | null)?.[f])),
        empty: [
          "behavioral_constraints", "writing_constraints", "negative_directory", "drift_prevention_prompts",
        ].filter((f) => !fieldFill((gov as Record<string, unknown> | null)?.[f] ?? (governance as Record<string, unknown> | null)?.[f])),
        flagged_gaps: !governance ? ["section_never_populated"] : [],
      },
      products: {
        count: (products || []).length,
        last_updated_at: lastUpdatedFromRows(products as Array<{ updated_at?: string }> | null),
        flagged_gaps: (products || []).length === 0 ? ["no_products"] : [],
      },
      audience: {
        count: (audience || []).length,
        last_updated_at: lastUpdatedFromRows(audience as Array<{ updated_at?: string }> | null),
        flagged_gaps: (audience || []).length === 0 ? ["no_audience_personas"] : [],
      },
      personas: {
        count: (personas || []).length,
        last_updated_at: lastUpdatedFromRows(personas as Array<{ updated_at?: string }> | null),
        flagged_gaps: (personas || []).length === 0 ? ["no_ai_personas"] : [],
      },
      competitors: {
        count: (competitors || []).length,
        last_updated_at: lastUpdatedFromRows(competitors as Array<{ updated_at?: string }> | null),
        flagged_gaps: (competitors || []).length === 0 ? ["no_competitors"] : [],
      },
      seo: {
        last_updated_at: seo?.updated_at ?? null,
        ...countFields(seo as Record<string, unknown> | null, ["keywords"]),
        flagged_gaps: !seo ? ["section_never_populated"] : [],
      },
      expression_examples: {
        count: (expressionExamples || []).length,
        last_updated_at: lastUpdatedFromRows(expressionExamples as Array<{ updated_at?: string }> | null),
        flagged_gaps: (expressionExamples || []).length === 0 ? ["no_examples"] : [],
      },
      logos: {
        count: (logoAssets || []).length,
        last_updated_at: lastUpdatedFromRows(logoAssets as Array<{ updated_at?: string }> | null),
        flagged_gaps: (logoAssets || []).length === 0 ? ["no_logo_assets"] : [],
      },
      social_profiles: {
        count: (socialProfiles || []).length,
        last_updated_at: lastUpdatedFromRows(socialProfiles as Array<{ updated_at?: string }> | null),
        flagged_gaps: [],
      },
      knowledge_files: {
        count: (knowledgeFiles || []).length,
        last_updated_at: lastUpdatedFromRows(knowledgeFiles as Array<{ updated_at?: string }> | null),
        flagged_gaps: [],
      },
    };

    const recommended: string[] = [];
    for (const name of SECTIONS) {
      const s = sections[name] as { flagged_gaps?: string[]; empty?: string[] };
      if (s?.flagged_gaps?.includes("section_never_populated")) {
        const writeTool = sectionMap[name]?.write?.[0];
        if (writeTool) recommended.push(`${name} is empty — call ${writeTool}`);
      } else if (s?.empty && s.empty.length > 0) {
        const writeTool = sectionMap[name]?.write?.[0];
        if (writeTool) recommended.push(`${name} missing fields ${s.empty.join(", ")} — call ${writeTool}`);
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          instructions:
            "Use this briefing as the single source of truth for what is filled in, what is missing, and which tool writes each section. Prefer the recommended_next_steps list when deciding what to do next.",
          brand_kit: {
            id: bk.id,
            name: bk.name,
            tagline: bk.tagline,
            description: bk.description,
            industry_details: bk.industry_details,
            version: bk.version,
            completion_percentage: bk.completion_percentage,
            updated_at: bk.updated_at,
          },
          sections,
          tools_by_section: sectionMap,
          recommended_next_steps: recommended.slice(0, 8),
        }, null, 2),
      }],
    };
  },
};
