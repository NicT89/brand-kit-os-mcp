import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { AI_GATEWAY_TIMEOUT_MS } from "../constants.ts";
import { callAIGateway, formatPersonality } from "../ai-gateway.ts";
import { dryRunPreview, filterFields, refundTokens, withTimeout } from "../helpers.ts";
import { wrapWritingConstraintsForWrite } from "../json-helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import {
  buildAiPersonaPayload,
  buildAudiencePersonaPayload,
  generateAiPersonaProposal,
  generateAudiencePersonaProposal,
  PersonaGenerationError,
} from "./generate-handlers.ts";

const AI_TIMEOUT_RECOVERY = "Retry the call after a short delay; if the failure repeats, the AI provider may be degraded.";

/** Map a PersonaGenerationError (or unknown error) to a tool error result. */
// deno-lint-ignore no-explicit-any
function aiGenerationToolError(err: any) {
  const isTimeout = err instanceof PersonaGenerationError ? err.isTimeout : String(err?.message || "").includes("timed out");
  return toolError(
    isTimeout
      ? `AI gateway timed out after ${Math.round(AI_GATEWAY_TIMEOUT_MS / 1000)}s.`
      : `AI generation failed: ${err?.message}.`,
    { code: isTimeout ? "timeout" : "ai_gateway_failed", retryable: true, recovery: AI_TIMEOUT_RECOVERY },
  );
}

export const previewHandlers: Record<string, ToolHandler> = {
  preview_brand_kit_core_update: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id, mission, vision, brand_story, brand_promises, taglines, storytelling_elements } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    
          const coreData: Record<string, any> = {};
          if (mission !== undefined) coreData.mission = mission;
          if (vision !== undefined) coreData.vision = vision;
          if (brand_story !== undefined) coreData.brand_story = brand_story;
          if (brand_promises !== undefined) coreData.brand_promises = brand_promises;
          if (taglines !== undefined) coreData.taglines = taglines;
          if (storytelling_elements !== undefined) coreData.storytelling_elements = storytelling_elements;
    
          if (Object.keys(coreData).length === 0) {
            return toolError("At least one field must be provided to preview.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. mission, vision, brand_story)." });
          }
    
          const { data: currentCore } = await supabaseAdmin.from("brand_kit_core").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle();
          return dryRunPreview("brand_kit_core", currentCore || {}, coreData);
  },

  preview_brand_kit_personality_update: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id, personality_traits, brand_values, brand_principles, brand_moods } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    
          const personalityData: Record<string, any> = {};
          if (personality_traits !== undefined) personalityData.personality_traits = personality_traits;
          if (brand_values !== undefined) personalityData.brand_values = brand_values;
          if (brand_principles !== undefined) personalityData.brand_principles = brand_principles;
          if (brand_moods !== undefined) personalityData.brand_moods = brand_moods;
    
          if (Object.keys(personalityData).length === 0) {
            return toolError("At least one field must be provided to preview.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. personality_traits)." });
          }
    
          const { data: currentPersonality } = await supabaseAdmin.from("brand_kit_personality").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle();
          const proposed = formatPersonality(personalityData);
          const current = formatPersonality(currentPersonality || {});
          return dryRunPreview("brand_kit_personality", current, proposed);
  },

  preview_brand_kit_expression_update: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id, brand_voice, tone_of_voice, tone_dimensions, voice_archetypes, verbal_style, visual_style, preferred_terminology } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    
          const expressionData: Record<string, any> = {};
          if (tone_of_voice !== undefined) expressionData.tone_of_voice = tone_of_voice;
          if (tone_dimensions !== undefined) expressionData.tone_dimensions = tone_dimensions;
          if (voice_archetypes !== undefined) expressionData.voice_archetypes = voice_archetypes;
          if (verbal_style !== undefined) expressionData.verbal_style = verbal_style;
          if (visual_style !== undefined) expressionData.visual_style = visual_style;
          if (preferred_terminology !== undefined) expressionData.preferred_terminology = preferred_terminology;

    
          const hasBrandVoice = brand_voice !== undefined;
          const hasExpressionData = Object.keys(expressionData).length > 0;
    
          if (!hasBrandVoice && !hasExpressionData) {
            return toolError("At least one field must be provided to preview.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. brand_voice, tone_of_voice)." });
          }
    
          const [{ data: currentExpression }, { data: currentBk }] = await Promise.all([
            supabaseAdmin.from("brand_kit_expression").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle(),
            hasBrandVoice ? supabaseAdmin.from("brand_kits").select("brand_voice").eq("id", brand_kit_id).maybeSingle() : Promise.resolve({ data: null }),
          ]);
    
          const proposed: Record<string, any> = { ...expressionData };
          if (hasBrandVoice) proposed.brand_voice = brand_voice;
          const current = { ...(currentExpression || {}), ...(currentBk ? { brand_voice: currentBk.brand_voice } : {}) };
          return dryRunPreview("brand_kit_expression + brand_kits.brand_voice", current, proposed);
  },

  preview_brand_kit_governance_update: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id, behavioral_constraints, negative_directory, writing_constraints, usage_guidelines, disclosure_statements, compliance_selections, disclosure_policy, compliance_notes, drift_prevention_prompts } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    
          const governanceData: Record<string, any> = {};
          if (behavioral_constraints !== undefined) governanceData.behavioral_constraints = behavioral_constraints;
          if (negative_directory !== undefined) governanceData.negative_directory = negative_directory;
          if (writing_constraints !== undefined) governanceData.writing_constraints = wrapWritingConstraintsForWrite(writing_constraints);
          if (usage_guidelines !== undefined) governanceData.usage_guidelines = usage_guidelines;
          if (disclosure_statements !== undefined) governanceData.disclosure_statements = disclosure_statements;
          if (compliance_selections !== undefined) governanceData.compliance_selections = compliance_selections;
          if (disclosure_policy !== undefined) governanceData.disclosure_policy = disclosure_policy;
          if (compliance_notes !== undefined) governanceData.compliance_notes = compliance_notes;
          if (drift_prevention_prompts !== undefined) governanceData.drift_prevention_prompts = drift_prevention_prompts;

    
          if (Object.keys(governanceData).length === 0) {
            return toolError("At least one field must be provided to preview.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. behavioral_constraints)." });
          }
    
          const { data: currentGovernance } = await supabaseAdmin.from("brand_kit_governance").select("*").eq("brand_kit_id", brand_kit_id).maybeSingle();
          return dryRunPreview("brand_kit_governance", currentGovernance || {}, governanceData);
  },

  preview_generate_audience_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, log } = ctx;
    const { brand_kit_id, persona_name, persona_type, description } = args;
    if (!brand_kit_id || !persona_name || !persona_type) {
      return toolError("brand_kit_id, persona_name, and persona_type are required", { code: "validation_error" });
    }
    if (!["b2b", "b2c"].includes(persona_type as string)) {
      return toolError("persona_type must be 'b2b' or 'b2c'", { code: "validation_error" });
    }
    const hasAccess = await verifyBrandKitAccess(brand_kit_id as string, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });

    await log("info", "Starting preview_generate_audience_persona", { persona_name, persona_type });
    // deno-lint-ignore no-explicit-any
    let generated: any;
    let hasPrimaryAlready: boolean;
    try {
      ({ generated, hasPrimaryAlready } = await generateAudiencePersonaProposal(supabaseAdmin, {
        brand_kit_id: brand_kit_id as string,
        persona_name: persona_name as string,
        persona_type: persona_type as string,
        description: description as string | undefined,
      }));
    } catch (err) {
      await log("error", "AI gateway failed for audience persona preview", { error: (err as Error)?.message });
      return aiGenerationToolError(err);
    }

    const proposed = buildAudiencePersonaPayload(generated, { persona_name: persona_name as string, persona_type: persona_type as string }, hasPrimaryAlready);
    await log("info", "preview_generate_audience_persona done", { persona_name });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "preview_ready",
          persona_name,
          proposed_persona: proposed,
          next_step: "Review the proposed persona above. Call create_audience_persona with brand_kit_id and the proposed_persona fields to save it.",
        }, null, 2),
      }],
    };
  },

  preview_generate_ai_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, log } = ctx;
    const { brand_kit_id, name, purpose_type, description } = args;
    if (!brand_kit_id || !name || !purpose_type) {
      return toolError("brand_kit_id, name, and purpose_type are required", { code: "validation_error" });
    }
    const hasAccess = await verifyBrandKitAccess(brand_kit_id as string, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });

    await log("info", "Starting preview_generate_ai_persona", { name, purpose_type });
    // deno-lint-ignore no-explicit-any
    let generated: any;
    try {
      ({ generated } = await generateAiPersonaProposal(supabaseAdmin, {
        brand_kit_id: brand_kit_id as string,
        name: name as string,
        purpose_type: purpose_type as string,
        description: description as string | undefined,
      }));
    } catch (err) {
      await log("error", "AI gateway failed for AI persona preview", { error: (err as Error)?.message });
      return aiGenerationToolError(err);
    }

    const proposed = buildAiPersonaPayload(generated, { name: name as string, purpose_type: purpose_type as string });
    await log("info", "preview_generate_ai_persona done", { name });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "preview_ready",
          persona_name: name,
          proposed_persona: proposed,
          next_step: "Review the proposed AI persona above. Call create_brand_kit_persona with brand_kit_id and the proposed_persona fields to save it.",
        }, null, 2),
      }],
    };
  },
};
