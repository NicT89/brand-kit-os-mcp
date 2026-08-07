import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { normalizeGovernanceForRead, toJsonArray } from "../json-helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

export const readContextHandlers: Record<string, ToolHandler> = {
  get_brand_context_for_agent: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const { brand_kit_id, task_type, persona_name } = args;
    if (!brand_kit_id || !task_type) {
      return toolError("brand_kit_id and task_type are required", {
        code: "validation_error",
        recovery: "Provide both brand_kit_id (UUID) and task_type (one of blog_writing, social_post, email, ad_copy, sales_copy, video_script, brand_voice_check, persona_chat).",
      });
    }
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    const sectionMap: Record<string, string[]> = {
      content_creation: ["summary", "expression", "governance", "audience"],
      voice_check: ["summary", "expression", "governance", "personality"],
      campaign_planning: ["summary", "expression", "audience", "products", "governance"],
      product_messaging: ["summary", "products", "audience", "expression", "governance"],
      persona_embodiment: ["summary", "expression", "governance", "personas"],
      competitive_analysis: ["summary", "products", "competitors", "core"],
    };

    const needed = sectionMap[task_type as string] || ["summary"];

    const fetches: Record<string, Promise<{ data: unknown }>> = {};
    if (needed.includes("summary") || needed.includes("core")) {
      fetches.bk = supabaseAdmin.from("brand_kits").select("name, tagline, description, brand_voice").eq("id", brand_kit_id).maybeSingle();
      fetches.core = supabaseAdmin.from("brand_kit_core").select("mission, vision").eq("brand_kit_id", brand_kit_id).maybeSingle();
    }
    if (needed.includes("expression") || needed.includes("summary")) {
      fetches.expression = supabaseAdmin.from("brand_kit_expression").select("tone_of_voice, tone_dimensions, verbal_style, preferred_terminology").eq("brand_kit_id", brand_kit_id).maybeSingle();
    }
    if (needed.includes("governance")) {
      fetches.governance = supabaseAdmin.from("brand_kit_governance").select("behavioral_constraints, negative_directory, writing_constraints").eq("brand_kit_id", brand_kit_id).maybeSingle();
    }
    if (needed.includes("audience")) {
      fetches.audience = supabaseAdmin.from("brand_kit_target_audience").select("persona_name, persona_type, is_primary, demographics, goals_motivations, frustrations_pain_points, preferred_channels, core_motivation, buying_behavior").eq("brand_kit_id", brand_kit_id);
    }
    if (needed.includes("products")) {
      fetches.products = supabaseAdmin.from("brand_kit_products").select("name, type, usp, description, key_benefits, competitive_differentiation").eq("brand_kit_id", brand_kit_id);
    }
    if (needed.includes("personality")) {
      fetches.personality = supabaseAdmin.from("brand_kit_personality").select("personality_traits, brand_values").eq("brand_kit_id", brand_kit_id).maybeSingle();
    }
    if (needed.includes("competitors")) {
      fetches.competitors = supabaseAdmin.from("brand_kit_competitors").select("name, tagline, value_propositions, brand_personality").eq("brand_kit_id", brand_kit_id);
    }
    if (needed.includes("personas")) {
      const personaQuery = supabaseAdmin.from("brand_kit_personas").select("*").eq("brand_kit_id", brand_kit_id).eq("is_active", true);
      fetches.personas = persona_name ? personaQuery.ilike("name", `%${persona_name}%`) : personaQuery;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, promise] of Object.entries(fetches)) {
      const { data } = await promise;
      resolved[key] = data;
    }

    const bk = resolved.bk as Record<string, string> | null;
    const core = resolved.core as Record<string, string> | null;
    const lines: string[] = [
      `# Brand Context: ${bk?.name || "Unknown Brand"}`,
      bk?.tagline ? `**Tagline:** ${bk.tagline}` : "",
      bk?.brand_voice ? `**Brand Voice:** ${bk.brand_voice}` : "",
      core?.mission ? `**Mission:** ${core.mission}` : "",
      core?.vision ? `**Vision:** ${core.vision}` : "",
    ].filter(Boolean);

    const expression = resolved.expression as Record<string, unknown> | null;
    if (expression) {
      if (expression.tone_of_voice) lines.push(`\n## Tone of Voice\n${JSON.stringify(expression.tone_of_voice)}`);
      if (expression.tone_dimensions) lines.push(`**Tone Dimensions:** ${JSON.stringify(expression.tone_dimensions)}`);
      if (expression.verbal_style) lines.push(`**Verbal Style:** ${JSON.stringify(expression.verbal_style)}`);
      if (expression.preferred_terminology) lines.push(`**Preferred Terms:** ${JSON.stringify(expression.preferred_terminology)}`);
    }

    const governance = normalizeGovernanceForRead(resolved.governance as Record<string, unknown> | null);
    if (governance) {
      lines.push("\n## Governance Rules");
      if (Array.isArray(governance.behavioral_constraints) && governance.behavioral_constraints.length) {
        lines.push(`**Constraints:**\n${(governance.behavioral_constraints as Record<string, string>[]).map((c) => `- ${c.rule || c}`).join("\n")}`);
      }
      if (Array.isArray(governance.writing_constraints) && governance.writing_constraints.length) {
        lines.push(`**Writing Rules:** ${JSON.stringify(governance.writing_constraints)}`);
      }
      const negativeDirectory = governance.negative_directory as { forbidden_words?: string[] } | undefined;
      if (negativeDirectory?.forbidden_words?.length) {
        lines.push(`**Never use:** ${negativeDirectory.forbidden_words.join(", ")}`);
      }
    }

    const personality = resolved.personality as Record<string, unknown[]> | null;
    if (personality) {
      if (Array.isArray(personality.personality_traits) && personality.personality_traits.length) {
        const traits = (personality.personality_traits as Record<string, string>[]).map((t) => t.title || t.name).filter(Boolean).join(", ");
        if (traits) lines.push(`\n## Personality Traits\n${traits}`);
      }
      if (Array.isArray(personality.brand_values) && personality.brand_values.length) {
        const values = (personality.brand_values as Record<string, string>[]).map((v) => v.name).filter(Boolean).join(", ");
        if (values) lines.push(`**Brand Values:** ${values}`);
      }
    }

    if (Array.isArray(resolved.audience) && resolved.audience.length) {
      lines.push("\n## Target Audience");
      (resolved.audience as Record<string, unknown>[]).forEach((a) => {
        lines.push(`**${a.persona_name}** (${a.persona_type}): ${a.core_motivation || ""} — Goals: ${(toJsonArray(a.goals_motivations) as string[]).slice(0, 2).join("; ")}`);
      });
    }

    if (Array.isArray(resolved.products) && resolved.products.length) {
      lines.push("\n## Products & Services");
      (resolved.products as Record<string, unknown>[]).forEach((p) => {
        lines.push(`**${p.name}** (${p.type || "N/A"}): ${p.usp || p.description || ""}`);
      });
    }

    if (Array.isArray(resolved.personas) && resolved.personas.length) {
      const persona = persona_name
        ? (resolved.personas as Record<string, unknown>[]).find((p) => String(p.name).toLowerCase().includes(String(persona_name).toLowerCase()))
        : (resolved.personas as Record<string, unknown>[])[0];

      if (persona) {
        lines.push(`\n## Active Persona: ${persona.name}`);
        if (persona.role_definition) lines.push(`**Role:** ${persona.role_definition}`);
        if (persona.function_description) lines.push(`**Function:** ${persona.function_description}`);
        if (Array.isArray(persona.behavioral_rules) && persona.behavioral_rules.length) {
          lines.push(`**Rules:**\n${(persona.behavioral_rules as string[]).map((r) => `- ${r}`).join("\n")}`);
        }
        if (Array.isArray(persona.negative_guardrails) && persona.negative_guardrails.length) {
          lines.push(`**Never:**\n${(persona.negative_guardrails as string[]).map((r) => `- ${r}`).join("\n")}`);
        }
      }
    }

    if (Array.isArray(resolved.competitors) && resolved.competitors.length) {
      lines.push("\n## Competitive Landscape");
      (resolved.competitors as Record<string, unknown>[]).forEach((c) => {
        lines.push(`**${c.name}:** ${c.tagline || ""} — ${(toJsonArray(c.value_propositions) as string[]).slice(0, 1).join("")}`);
      });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          task_type,
          brand_kit_id,
          sections_loaded: needed,
          context: lines.join("\n"),
        }, null, 2),
      }],
    };
  },

  get_persona_system_prompt: async (ctx) => {
    const { args, userId, supabaseAdmin } = ctx;
    const { brand_kit_id, persona_name } = args;
    if (!brand_kit_id || !persona_name) {
      return toolError("brand_kit_id and persona_name are required", {
        code: "validation_error",
        recovery: "Call get_brand_kit_personas first to find a valid persona_name.",
      });
    }
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    const { data: personas } = await supabaseAdmin
      .from("brand_kit_personas")
      .select("*")
      .eq("brand_kit_id", brand_kit_id)
      .eq("is_active", true)
      .ilike("name", `%${persona_name}%`);

    if (!personas?.length) {
      return toolError(`No active persona found matching "${persona_name}"`, {
        code: "not_found",
        recovery: "Call get_brand_kit_personas to list available personas in this brand kit.",
      });
    }
    const persona = personas[0];

    const { data: bk } = await supabaseAdmin
      .from("brand_kits")
      .select("name, brand_voice")
      .eq("id", brand_kit_id)
      .maybeSingle();

    const lines: string[] = [
      `You are ${persona.name}, ${bk?.name || "the brand"}'s ${persona.role_definition || "AI assistant"}.`,
      "",
    ];

    if (persona.function_description) {
      lines.push(`Your purpose: ${persona.function_description}`, "");
    }

    if (Array.isArray(persona.tasks) && persona.tasks.length) {
      lines.push("Your primary tasks:");
      (persona.tasks as string[]).forEach((t) => lines.push(`- ${t}`));
      lines.push("");
    }

    if (Array.isArray(persona.behavioral_rules) && persona.behavioral_rules.length) {
      lines.push("You must always:");
      (persona.behavioral_rules as string[]).forEach((r) => lines.push(`- ${r}`));
      lines.push("");
    }

    if (Array.isArray(persona.negative_guardrails) && persona.negative_guardrails.length) {
      lines.push("You must never:");
      (persona.negative_guardrails as string[]).forEach((r) => lines.push(`- ${r}`));
      lines.push("");
    }

    const voiceProfile = persona.voice_profile as { personality_pillars?: string[] } | null;
    if (voiceProfile?.personality_pillars?.length) {
      lines.push(`Your personality is defined by: ${voiceProfile.personality_pillars.join(", ")}.`, "");
    }

    const lexicon = persona.lexicon_syntax as { allowed_terms?: string[]; forbidden_terms?: string[] } | null;
    if (lexicon?.allowed_terms?.length) {
      lines.push(`Preferred language: ${lexicon.allowed_terms.join(", ")}`);
    }
    if (lexicon?.forbidden_terms?.length) {
      lines.push(`Never use: ${lexicon.forbidden_terms.join(", ")}`);
    }

    if (bk?.brand_voice) lines.push("", `Brand voice: ${bk.brand_voice}`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          persona_id: persona.id,
          persona_name: persona.name,
          purpose_type: persona.purpose_type,
          system_prompt: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
          persona_summary: {
            role: persona.role_definition,
            tasks: persona.tasks,
            tone_overrides: persona.tone_overrides,
          },
        }, null, 2),
      }],
    };
  },
};
