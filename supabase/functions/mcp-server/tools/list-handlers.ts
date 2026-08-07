import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { AI_GATEWAY_TIMEOUT_MS, WRITE_SCOPE } from "../constants.ts";
import { getEnabledBrandKitWriteSections, hasAnyBrandKitSectionWrite } from "../../_shared/mcp-scopes.ts";
import { buildBrandKitSectionToolMap } from "./section-map.ts";
import { GOVERNANCE_PLATFORMS } from "../governance-platforms.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { effectiveVocabularies, loadVocabularySnapshot } from "../../_shared/persona-vocabulary.ts";
import { loadLibraryIndustries } from "./persona-vocabulary-gate.ts";


const PERSONA_FIELDS = [
  "role_definition", "personality_description", "function_description",
  "tasks", "behavioral_rules", "voice_profile",
  "negative_guardrails", "lexicon_syntax",
];


export const listHandlers: Record<string, ToolHandler> = {
  list_brand_kits: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const [{ data: owned, error: ownedError }, { data: memberOf }] = await Promise.all([
            supabaseAdmin.from('brand_kits').select('id, name, description, tagline, website_url, completion_percentage, og_image_url, created_at, updated_at').eq('user_id', userId),
            supabaseAdmin.from('brand_kit_members').select('brand_kit_id, role, brand_kits:brand_kit_id(id, name, description, tagline, website_url, completion_percentage, og_image_url, created_at, updated_at)').eq('user_id', userId),
          ]);
    
          if (ownedError) {
            console.error('Error fetching owned brand kits:', ownedError);
            return toolError(`Database error: ${ownedError.message}`, { code: "db_error", retryable: true });
          }
    
          const seen = new Set<string>();
          const merged: Array<{ kit: any; membership_role: string }> = [];
    
          for (const bk of owned || []) {
            if (!bk?.id || seen.has(bk.id)) continue;
            seen.add(bk.id);
            merged.push({ kit: bk, membership_role: "owner" });
          }
          for (const m of memberOf || []) {
            const bk = m?.brand_kits;
            if (!bk?.id || seen.has(bk.id)) continue;
            seen.add(bk.id);
            merged.push({ kit: bk, membership_role: String(m.role || "viewer") });
          }
    
          const canScopeBrandWrite = hasAnyBrandKitSectionWrite(scopes);
          const canScopeKnowledgeWrite = scopes.includes(WRITE_SCOPE);
          const writeSections = getEnabledBrandKitWriteSections(scopes);
    
          const enriched = merged.map(({ kit, membership_role }) => {
            const mcpWriteOk = membership_role === "owner" || membership_role === "admin";
            return {
              ...kit,
              membership_role,
              role: membership_role,
              can_read: true,
              can_write_brand_kit: canScopeBrandWrite && mcpWriteOk,
              brand_kit_write_sections: canScopeBrandWrite ? writeSections : [],
              can_write_knowledge_files: canScopeKnowledgeWrite && mcpWriteOk,
            };
          });
    
          return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
  },

  list_brand_kit_tools: async (ctx) => {
    const sectionMap = buildBrandKitSectionToolMap();
    const requested = typeof ctx.args?.section === "string" ? ctx.args.section : null;
    if (requested) {
      if (!(requested in sectionMap)) {
        return toolError(
          `Unknown section '${requested}'. Use one of: ${Object.keys(sectionMap).join(", ")}.`,
          { code: "validation_error" },
        );
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ section: requested, tools: sectionMap[requested] }, null, 2),
        }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ sections: sectionMap }, null, 2) }] };
  },

  list_compliance_standards: async (ctx) => {
    const { supabaseAdmin, userId } = ctx;
    // Library standards visible to all; custom standards limited to the caller's account team.
    const { data: library, error: libErr } = await supabaseAdmin
      .from("library_compliance_standards")
      .select("id, name, full_name, description, region, category, is_library, website_url, user_id")
      .order("name", { ascending: true });
    if (libErr) return toolError(`Database error: ${libErr.message}`, { code: "db_error", retryable: true });
    const visible = (library || []).filter((row: { is_library: boolean; user_id: string | null }) =>
      row.is_library === true || row.user_id === userId
    ).map(({ user_id: _u, ...rest }: Record<string, unknown>) => rest);
    return { content: [{ type: "text", text: JSON.stringify({ standards: visible }, null, 2) }] };
  },

  get_disclosure_diligence_questions: async () => {
    const { DISCLOSURE_CATEGORY_QUESTIONS, DISCLOSURE_CATEGORY_META, DISCLOSURE_ALL_CATEGORIES } =
      await import("../../_shared/disclosure-questions.ts");
    const payload = DISCLOSURE_ALL_CATEGORIES.map((category) => ({
      category,
      label: DISCLOSURE_CATEGORY_META[category].label,
      description: DISCLOSURE_CATEGORY_META[category].description,
      questions: DISCLOSURE_CATEGORY_QUESTIONS[category].map((question, index) => ({
        id: `q${index}`,
        question,
      })),
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          instructions: "Ask the user each question per category, collect answers keyed by id (q0, q1, q2), then call generate_disclosure_statement(brand_kit_id, category, answers). Merge the returned statement into disclosure_statements[category] before calling upsert_brand_kit_governance.",
          categories: payload,
        }, null, 2),
      }],
    };
  },

  list_library_archetypes: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const category = typeof args?.category === "string" ? args.category : null;
    const allowed = new Set(["core", "functional_collective", "relational_emotional"]);
    if (category && !allowed.has(category)) {
      return toolError(
        `Unknown category '${category}'. Use one of: ${[...allowed].join(", ")}.`,
        { code: "validation_error" },
      );
    }
    let query = supabaseAdmin
      .from("library_archetypes")
      .select("id, name, category, role_type, key_traits, description, is_library, user_id, usage_count")
      .order("name", { ascending: true });
    if (category) query = query.eq("category", category);
    const { data, error } = await query;
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    // Library entries are visible to everyone; custom (user-generated) entries
    // are scoped to their creator. Mirror the read-only intent.
    const visible = (data || []).filter((row: { is_library: boolean; user_id: string | null }) =>
      row.is_library === true || row.user_id === userId
    ).map(({ user_id: _u, ...rest }: Record<string, unknown>) => rest);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          instructions:
            "Voice archetypes describe a brand's character (e.g. The Sage, The Hero). To recommend one for a brand kit, also call get_brand_kit_summary (or get_brand_kit_personality + get_brand_kit_audience) and match key_traits to the brand's values, tone, and audience needs. Present 2-3 ranked options with rationale to the user before writing via upsert_brand_kit_expression(voice_archetypes).",
          archetypes: visible,
        }, null, 2),
      }],
    };
  },

  get_library_archetype: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const archetypeId = typeof args?.archetype_id === "string" ? args.archetype_id : null;
    if (!archetypeId) {
      return toolError("archetype_id is required", {
        code: "validation_error",
        recovery: "Pass the UUID returned by list_library_archetypes as archetype_id.",
      });
    }
    const { data, error } = await supabaseAdmin
      .from("library_archetypes")
      .select("id, name, category, role_type, key_traits, llm_instruction, description, is_library, user_id, usage_count, created_at")
      .eq("id", archetypeId)
      .maybeSingle();
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
    if (!data) return toolError("Archetype not found", { code: "not_found" });
    if (data.is_library !== true && data.user_id !== userId) {
      return toolError("Access denied to this archetype", { code: "access_denied" });
    }
    const { user_id: _u, ...rest } = data as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify({ archetype: rest }, null, 2) }] };
  },

  list_governance_platforms: async () => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          instructions:
            "Use these `value` strings as the `platform` field on writing_constraints.constraints[] entries when upsert_brand_kit_governance is called. Set writing_constraints.platformSpecificEnabled = true when any constraint is platform-scoped.",
          platforms: GOVERNANCE_PLATFORMS,
        }, null, 2),
      }],
    };
  },

  list_persona_field_options: async (ctx) => {
    const { supabaseAdmin } = ctx;
    const [libraryIndustries, snapshot] = await Promise.all([
      loadLibraryIndustries(supabaseAdmin),
      loadVocabularySnapshot(supabaseAdmin),
    ]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          instructions:
            "Every controlled persona field below is a selection list, not free text. Send one canonical value per array entry — never combine several concepts into one string. Closed fields reject unknown values. Open fields (industry) accept new values, but check `options` and `library_values` first and reuse an existing entry when one fits; anything genuinely new is saved to the shared library so later calls can select it. Descriptive prose (fields of study, sector narratives, size adjectives) belongs in description or daily_responsibilities, not in these fields.",
          fields: effectiveVocabularies(snapshot).map((v) => ({
            field: `${v.parent}.${v.field}`,
            label: v.label,
            mode: v.mode,
            value_type: v.multi ? "string[]" : "string",
            options: v.options,
            library_values: v.library === "industry_classifications" ? libraryIndustries : undefined,
            guidance: v.guidance,
          })),
        }, null, 2),
      }],
    };
  },




  /**
   * Lightweight persona index: returns one row per persona with field-fill
   * counts so the agent can decide which personas need work without pulling
   * full persona objects into context.
   */
  list_brand_kit_personas: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const brandKitId = typeof args?.brand_kit_id === "string" ? args.brand_kit_id : null;
    if (!brandKitId) {
      return toolError("brand_kit_id is required", {
        code: "missing_field",
        tool: "list_brand_kit_personas",
        field: "brand_kit_id",
        suggestedFix: "Pass the UUID returned by list_brand_kits.",
      });
    }
    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", {
        code: "access_denied",
        tool: "list_brand_kit_personas",
        field: "brand_kit_id",
        recovery: ACCESS_DENIED_RECOVERY,
      });
    }
    const { data, error } = await supabaseAdmin
      .from("brand_kit_personas")
      .select(`id, name, updated_at, ${PERSONA_FIELDS.join(", ")}`)
      .eq("brand_kit_id", brandKitId)
      .order("name", { ascending: true });
    if (error) {
      return toolError(`Database error: ${error.message}`, {
        code: "db_error",
        tool: "list_brand_kit_personas",
        retryable: true,
      });
    }
    const fill = (v: unknown) => {
      if (v === null || v === undefined || v === "") return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      return true;
    };
    const rows = (data || []).map((p: Record<string, unknown>) => {
      const filled = PERSONA_FIELDS.filter((f) => fill(p[f]));
      const empty = PERSONA_FIELDS.filter((f) => !fill(p[f]));
      const total = PERSONA_FIELDS.length;
      return {
        persona_id: p.id,
        name: p.name,
        updated_at: p.updated_at,
        fields_filled: filled,
        fields_empty: empty,
        completeness_pct: Math.round((filled.length / total) * 100),
      };
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          instructions:
            "Slim per-persona completeness index. Use this to pick which personas need work, then call get_brand_kit_personas or update_ai_persona for the full record.",
          personas: rows,
        }, null, 2),
      }],
    };
  },
};
