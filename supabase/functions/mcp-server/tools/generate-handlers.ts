import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { AI_GATEWAY_TIMEOUT_MS, WRITE_SCOPE } from "../constants.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { callAIGateway, formatPersonality } from "../ai-gateway.ts";
import { checkAndDeductTokens } from "../../_shared/rate-limit.ts";
import { dryRunPreview, filterFields, refundTokens, withTimeout } from "../helpers.ts";
import { toJsonArray } from "../json-helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { normalizePersonaMultiValues } from "../../_shared/persona-multi-value.ts";

/**
 * Raised when the AI gateway call fails during persona generation. Carries the
 * timeout flag so callers can map to the right error code and recovery copy.
 * The generate_* handlers catch this to refund the token; the read-only
 * preview_generate_* handlers catch it to return a tool error (no refund —
 * they never deduct a token).
 */
export class PersonaGenerationError extends Error {
  isTimeout: boolean;
  constructor(message: string, isTimeout: boolean) {
    super(message);
    this.name = "PersonaGenerationError";
    this.isTimeout = isTimeout;
  }
}

/**
 * Reusable AI-generation core for audience personas. Reads the brand kit's
 * context (tone, mission, voice, personality), builds the prompt, and calls the
 * AI gateway. Returns the parsed `generated` fields plus whether the kit already
 * has a primary persona. Performs no token accounting and no database write —
 * both the writing `generate_audience_persona` handler and the read-only
 * `preview_generate_audience_persona` handler share this exact logic.
 */
// deno-lint-ignore no-explicit-any
export async function generateAudiencePersonaProposal(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  params: { brand_kit_id: string; persona_name: string; persona_type: string; description?: string },
): Promise<{ generated: any; hasPrimaryAlready: boolean }> {
  const { brand_kit_id, persona_name, persona_type, description } = params;

  const [{ data: bk }, { data: core }, { data: expression }, { data: personality }, { count: primaryCount }] = await Promise.all([
    supabaseAdmin.from('brand_kits').select('name, tagline, description, brand_voice').eq('id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_core').select('mission, vision').eq('brand_kit_id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_expression').select('tone_of_voice').eq('brand_kit_id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_personality').select('personality_traits').eq('brand_kit_id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_target_audience').select('id', { count: 'exact', head: true }).eq('brand_kit_id', brand_kit_id).eq('is_primary', true),
  ]);

  const hasPrimaryAlready = (primaryCount ?? 0) > 0;

  const topTraits = toJsonArray(personality?.personality_traits).slice(0, 3).map((t: Record<string, string>) => t.title || t.name).filter(Boolean).join(', ');

  const systemPrompt = "You are a brand strategist. Return only valid JSON with no markdown fences, no explanation, and no extra text.";
  const userPrompt = `Generate a detailed target audience persona for the brand below.

    Brand Name: ${bk?.name || 'Unknown'}
    Tagline: ${bk?.tagline || 'Not set'}
    Description: ${bk?.description || 'Not set'}
    Mission: ${core?.mission || 'Not set'}
    Brand Voice: ${bk?.brand_voice || 'Not set'}
    Top Personality Traits: ${topTraits || 'Not set'}

    Persona Name: ${persona_name}
    Persona Type: ${persona_type.toUpperCase()} (${persona_type === 'b2b' ? 'Business-to-Business' : 'Business-to-Consumer'})
    ${description ? `Additional Context: ${description}` : ''}

    Return a JSON object with exactly this structure (all fields required):
    {
      "persona_title": "string — job title or role label",
      "is_primary": false,
      "demographics": {
        "age_range": ["string e.g. 35-44"],
        "gender": "string",
        "location": "string e.g. Urban, US",
        "income_level": ["string"],
        "education": ["string"]
      },
      "professional_context": {
        "job_title": "string",
        "industry": ["string"],
        "company_size": ["string"],
        "company_type": ["string${persona_type === 'b2b' ? ' (important for B2B)' : ''}"],
        "daily_responsibilities": "string"
      },
      "personal_background": {
        "lifestyle": "string",
        "background_details": "string"
      },
      "goals_motivations": ["string", "string", "string"],
      "frustrations_pain_points": ["string", "string", "string"],
      "values_beliefs": ["string", "string"],
      "fears": ["string", "string"],
      "information_sources": ["string", "string", "string"],
      "preferred_channels": ["string", "string"],
      "core_motivation": "string — one of: Efficiency, Status, Security, Freedom, Connection, Achievement, Recognition, Growth, Innovation, Stability",
      "expertise_level": "string — one of: Novice, Intermediate, Expert, Thought Leader",
      "buying_behavior": "string — paragraph describing how they research and purchase",
      "content_that_resonates": "string — types of content they engage with",
      "representative_quote": "string — a quote capturing their mindset",
      "barriers_to_sale": ["string", "string"],
      "product_fit": "string — how this brand's offering addresses their needs"
    }`;

  let generated: any;
  try {
    generated = await withTimeout(
      callAIGateway(systemPrompt, userPrompt),
      AI_GATEWAY_TIMEOUT_MS,
      'AI gateway (audience persona)',
    );
  } catch (err: any) {
    const isTimeout = String(err?.message || '').includes('timed out');
    throw new PersonaGenerationError(err?.message ?? 'AI generation failed', isTimeout);
  }
  return { generated, hasPrimaryAlready };
}

/**
 * Map the AI-generated audience fields into the full persona payload accepted
 * by `create_audience_persona`. `source` is fixed to `ai_generated` so the
 * create tool records provenance correctly (it would otherwise default to
 * `manual`). Advanced ICP fields the generator does not populate are returned
 * as empty values so the proposed object has a complete, stable shape.
 */
// deno-lint-ignore no-explicit-any
export function buildAudiencePersonaPayload(
  // deno-lint-ignore no-explicit-any
  generated: any,
  params: { persona_name: string; persona_type: string },
  hasPrimaryAlready: boolean,
): Record<string, unknown> {
  return {
    persona_name: params.persona_name,
    persona_title: generated.persona_title ?? null,
    persona_type: params.persona_type,
    is_primary: hasPrimaryAlready ? false : (generated.is_primary ?? false),
    source: 'ai_generated',
    demographics: normalizePersonaMultiValues({ demographics: generated.demographics ?? {} }).demographics,
    professional_context: normalizePersonaMultiValues({ professional_context: generated.professional_context ?? {} }).professional_context,
    personal_background: generated.personal_background ?? {},
    goals_motivations: generated.goals_motivations ?? [],
    frustrations_pain_points: generated.frustrations_pain_points ?? [],
    values_beliefs: generated.values_beliefs ?? [],
    fears: generated.fears ?? [],
    information_sources: generated.information_sources ?? [],
    preferred_channels: generated.preferred_channels ?? [],
    core_motivation: generated.core_motivation ?? null,
    expertise_level: generated.expertise_level ?? null,
    buying_behavior: generated.buying_behavior ?? null,
    content_that_resonates: generated.content_that_resonates ?? null,
    representative_quote: generated.representative_quote ?? null,
    barriers_to_sale: generated.barriers_to_sale ?? [],
    product_fit: generated.product_fit ?? null,
    // Advanced ICP fields are not auto-generated — surfaced empty so the caller
    // can fill them via update_audience_persona after creation.
    current_perception: null,
    platform_behavior: null,
    tech_usage: [],
    influencers: [],
    objections_verbatim: [],
    trigger_events: [],
    aspirational_identity: null,
    show_dont_tell_scene: null,
    visual_identifiers: {},
    funnel_stage_triggers: {},
    channel_behavior_matrix: {},
    paid_tools: {},
  };
}

/**
 * Reusable AI-generation core for AI personas. Reads the brand kit's
 * expression, personality, and governance context, builds the prompt, and calls
 * the AI gateway. Returns the parsed `generated` config. No token accounting,
 * no database write — shared by both `generate_ai_persona` and
 * `preview_generate_ai_persona`.
 */
// deno-lint-ignore no-explicit-any
export async function generateAiPersonaProposal(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  params: {
    brand_kit_id: string;
    name: string;
    purpose_type: string;
    description?: string;
    base_archetype_name?: string;
    base_archetype_traits?: unknown;
    target_audience_context?: string;
    interaction_contexts?: unknown;
  },
): Promise<{ generated: any }> {
  const { brand_kit_id, name, purpose_type, description, base_archetype_name, base_archetype_traits, target_audience_context, interaction_contexts } = params;

  const [{ data: bk }, { data: core }, { data: personality }, { data: expression }, { data: governance }] = await Promise.all([
    supabaseAdmin.from('brand_kits').select('name, tagline, description, brand_voice').eq('id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_core').select('mission, vision').eq('brand_kit_id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_personality').select('personality_traits, brand_values').eq('brand_kit_id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_expression').select('tone_of_voice, tone_dimensions').eq('brand_kit_id', brand_kit_id).maybeSingle(),
    supabaseAdmin.from('brand_kit_governance').select('behavioral_constraints').eq('brand_kit_id', brand_kit_id).maybeSingle(),
  ]);

  const archetypeSection = base_archetype_name
    ? `Base Archetype: ${base_archetype_name}\nArchetype Traits: ${Array.isArray(base_archetype_traits) ? base_archetype_traits.join(', ') : 'Not specified'}`
    : '';
  const audienceSection = target_audience_context ? `Target Audience: ${target_audience_context}` : '';
  const interactionSection = Array.isArray(interaction_contexts) && interaction_contexts.length > 0
    ? `Interaction Contexts: ${interaction_contexts.join(', ')}`
    : '';

  const systemPrompt = "You are an expert AI persona architect. Return only valid JSON with no markdown fences, no explanation, and no extra text.";
  const userPrompt = `Create a complete AI persona configuration for the brand below.

    Persona Name: ${name}
    Purpose Type: ${purpose_type}
    ${description ? `Additional Requirements: ${description}` : ''}
    ${archetypeSection}
    ${audienceSection}
    ${interactionSection}

    Brand Context:
    - Name: ${bk?.name || 'Unknown'}
    - Tagline: ${bk?.tagline || 'Not set'}
    - Mission: ${core?.mission || 'Not set'}
    - Brand Voice: ${bk?.brand_voice || 'Not set'}
    - Personality Traits: ${JSON.stringify(personality?.personality_traits || [])}
    - Brand Values: ${JSON.stringify(personality?.brand_values || [])}
    - Tone of Voice: ${JSON.stringify(expression?.tone_of_voice || {})}
    - Behavioral Constraints: ${JSON.stringify(governance?.behavioral_constraints || [])}

    Return a JSON object with exactly this structure:
    {
      "role_definition": "string — concise role title and primary function",
      "function_description": "string — prime directive: what this persona exists to do",
      "tasks": ["string", "string", "string"],
      "behavioral_rules": ["string", "string", "string"],
      "tone_overrides": {
        "formality": "string",
        "empathy": "string",
        "verbosity": "string"
      },
      "voice_profile": {
        "tone_attributes": {
          "professionalism": "Low | Medium | High",
          "empathy": "Low | Medium | High",
          "verbosity": "Low | Medium | High"
        },
        "personality_pillars": ["string", "string", "string"]
      },
      "lexicon_syntax": {
        "allowed_terms": ["string", "string"],
        "forbidden_terms": ["string", "string"],
        "formatting_rules": ["string", "string"]
      },
      "negative_guardrails": ["string", "string", "string"],
      "execution_protocol": ["string", "string"]
    }`;

  let generated: any;
  try {
    generated = await withTimeout(
      callAIGateway(systemPrompt, userPrompt),
      AI_GATEWAY_TIMEOUT_MS,
      'AI gateway (AI persona)',
    );
  } catch (err: any) {
    const isTimeout = String(err?.message || '').includes('timed out');
    throw new PersonaGenerationError(err?.message ?? 'AI generation failed', isTimeout);
  }
  return { generated };
}

/**
 * Map the AI-generated AI-persona fields into the full payload accepted by
 * `create_brand_kit_persona`. `source` is fixed to `ai_generated`. Fields the
 * generator does not populate are surfaced empty so the proposed object has a
 * complete, stable shape.
 */
// deno-lint-ignore no-explicit-any
export function buildAiPersonaPayload(
  // deno-lint-ignore no-explicit-any
  generated: any,
  params: { name: string; purpose_type: string; target_audience_context?: string; interaction_contexts?: unknown },
): Record<string, unknown> {
  return {
    name: params.name,
    purpose_type: params.purpose_type,
    source: 'ai_generated',
    role_definition: generated.role_definition ?? null,
    function_description: generated.function_description ?? null,
    tasks: generated.tasks ?? [],
    behavioral_rules: generated.behavioral_rules ?? [],
    tone_overrides: generated.tone_overrides ?? {},
    voice_profile: generated.voice_profile ?? {},
    lexicon_syntax: generated.lexicon_syntax ?? {},
    negative_guardrails: generated.negative_guardrails ?? [],
    execution_protocol: generated.execution_protocol ?? [],
    target_audience_context: params.target_audience_context ?? null,
    interaction_context: Array.isArray(params.interaction_contexts) ? params.interaction_contexts : [],
    is_default: false,
    is_active: true,
    // Not auto-generated — surfaced empty so the caller can fill them via
    // update_ai_persona after creation.
    personality_description: null,
    safety_compliance: [],
    reference_protocols: {},
  };
}

export const generateHandlers: Record<string, ToolHandler> = {
  generate_audience_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, log, progress } = ctx;
          const scopeDeniedGenAudience = assertBrandKitSectionScope(scopes, "audience");
          if (scopeDeniedGenAudience) return scopeDeniedGenAudience;
          const { brand_kit_id, persona_name, persona_type, description } = args;
          await log("info", "Starting audience persona generation", { persona_name, persona_type });
          await progress(10, 100, "Preflight checks");
          if (!brand_kit_id || !persona_name || !persona_type) {
            return toolError("brand_kit_id, persona_name, and persona_type are required", { code: "validation_error" });
          }
          if (!['b2b', 'b2c'].includes(persona_type)) {
            return toolError("persona_type must be 'b2b' or 'b2c'", { code: "validation_error" });
          }
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;
    
          const tokenResult = await checkAndDeductTokens(supabaseAdmin, userId, 1, 'mcp-generate-audience-persona', brand_kit_id);
          if (!tokenResult.allowed) {
            return toolError(tokenResult.message || "Insufficient tokens to generate audience persona.", { code: "quota_exceeded", recovery: "Upgrade the user's plan or wait for the next monthly token allowance refresh." });
          }

          await log("info", "Calling AI gateway for audience persona");
          await progress(40, 100, "Calling AI gateway");
          let generated: any;
          let hasPrimaryAlready: boolean;
          try {
            ({ generated, hasPrimaryAlready } = await generateAudiencePersonaProposal(supabaseAdmin, { brand_kit_id, persona_name, persona_type, description }));
          } catch (err: any) {
            await refundTokens(supabaseAdmin, userId, 1, 'mcp-generate-audience-persona-failed', brand_kit_id);
            const isTimeout = err instanceof PersonaGenerationError ? err.isTimeout : String(err?.message || '').includes('timed out');
            await log("error", "AI gateway failed for audience persona", { error: err?.message, is_timeout: isTimeout });
            return toolError(
              isTimeout
                ? `AI gateway timed out after ${Math.round(AI_GATEWAY_TIMEOUT_MS / 1000)}s. Your token has been refunded.`
                : `AI generation failed: ${err.message}. Your token has been refunded.`,
              { code: isTimeout ? 'timeout' : 'ai_gateway_failed', retryable: true, recovery: 'Retry the call after a short delay; if the failure repeats, the AI provider may be degraded.' }
            );
          }

          await log("info", "AI gateway returned — writing persona to DB");
          await progress(80, 100, "Writing persona");
          const { data: row, error: insertError } = await supabaseAdmin
            .from('brand_kit_target_audience')
            .insert({
              brand_kit_id,
              persona_name,
              persona_type,
              source: 'ai_generated',
              persona_title: generated.persona_title ?? null,
              // Never auto-promote an AI-generated persona to primary if the kit
              // already has one. The user can flip is_primary later via the app
              // or update_audience_persona.
              is_primary: hasPrimaryAlready ? false : (generated.is_primary ?? false),
              demographics: normalizePersonaMultiValues({ demographics: generated.demographics ?? {} }).demographics,
              professional_context: normalizePersonaMultiValues({ professional_context: generated.professional_context ?? {} }).professional_context,
              personal_background: generated.personal_background ?? {},
              goals_motivations: generated.goals_motivations ?? [],
              frustrations_pain_points: generated.frustrations_pain_points ?? [],
              values_beliefs: generated.values_beliefs ?? [],
              fears: generated.fears ?? [],
              information_sources: generated.information_sources ?? [],
              preferred_channels: generated.preferred_channels ?? [],
              core_motivation: generated.core_motivation ?? null,
              expertise_level: generated.expertise_level ?? null,
              buying_behavior: generated.buying_behavior ?? null,
              content_that_resonates: generated.content_that_resonates ?? null,
              representative_quote: generated.representative_quote ?? null,
              barriers_to_sale: generated.barriers_to_sale ?? [],
              product_fit: generated.product_fit ?? null,
            })
            .select('*')
            .single();
    
          if (insertError) {
            await refundTokens(supabaseAdmin, userId, 1, 'mcp-generate-audience-persona-failed', brand_kit_id);
            return toolError(`Failed to save persona: ${insertError.message}. Your token has been refunded.`, { code: 'db_error', retryable: true });
          }

          await log("info", "Audience persona written", { persona_id: row?.id });
          await progress(100, 100, "Done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, persona: row, tokens_remaining: tokenResult.tokensRemaining }, null, 2) }] };
  },

  generate_ai_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, log, progress } = ctx;
          await log("info", "Starting AI persona generation");
          await progress(10, 100, "Preflight checks");
          const scopeDeniedGenPersonas = assertBrandKitSectionScope(scopes, "personas");
          if (scopeDeniedGenPersonas) return scopeDeniedGenPersonas;
          const { brand_kit_id, name, purpose_type, description, base_archetype_name, base_archetype_traits, target_audience_context, interaction_contexts } = args;
          if (!brand_kit_id || !name || !purpose_type) {
            return toolError("brand_kit_id, name, and purpose_type are required", { code: "validation_error" });
          }
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGateAi = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGateAi) return mcpWriteGateAi;
    
          const tokenResult = await checkAndDeductTokens(supabaseAdmin, userId, 1, 'mcp-generate-ai-persona', brand_kit_id);
          if (!tokenResult.allowed) {
            return toolError(tokenResult.message || "Insufficient tokens to generate AI persona.", { code: "quota_exceeded", recovery: "Upgrade the user's plan or wait for the next monthly token allowance refresh." });
          }

          await log("info", "Calling AI gateway for AI persona");
          await progress(40, 100, "Calling AI gateway");
          let generated: any;
          try {
            ({ generated } = await generateAiPersonaProposal(supabaseAdmin, { brand_kit_id, name, purpose_type, description, base_archetype_name, base_archetype_traits, target_audience_context, interaction_contexts }));
          } catch (err: any) {
            await refundTokens(supabaseAdmin, userId, 1, 'mcp-generate-ai-persona-failed', brand_kit_id);
            const isTimeout = err instanceof PersonaGenerationError ? err.isTimeout : String(err?.message || '').includes('timed out');
            await log("error", "AI gateway failed for AI persona", { error: err?.message, is_timeout: isTimeout });
            return toolError(
              isTimeout
                ? `AI gateway timed out after ${Math.round(AI_GATEWAY_TIMEOUT_MS / 1000)}s. Your token has been refunded.`
                : `AI generation failed: ${err.message}. Your token has been refunded.`,
              { code: isTimeout ? 'timeout' : 'ai_gateway_failed', retryable: true, recovery: 'Retry the call after a short delay; if the failure repeats, the AI provider may be degraded.' }
            );
          }

          await log("info", "AI gateway returned — writing persona to DB");
          await progress(80, 100, "Writing persona");
          const { data: row, error: insertError } = await supabaseAdmin
            .from('brand_kit_personas')
            .insert({
              brand_kit_id,
              name,
              purpose_type,
              source: 'ai_generated',
              is_active: true,
              is_default: false,
              target_audience_context: target_audience_context ?? null,
              interaction_context: Array.isArray(interaction_contexts) ? interaction_contexts : [],
              role_definition: generated.role_definition ?? null,
              function_description: generated.function_description ?? null,
              tasks: generated.tasks ?? [],
              behavioral_rules: generated.behavioral_rules ?? [],
              tone_overrides: generated.tone_overrides ?? {},
              voice_profile: generated.voice_profile ?? {},
              lexicon_syntax: generated.lexicon_syntax ?? {},
              negative_guardrails: generated.negative_guardrails ?? [],
              execution_protocol: generated.execution_protocol ?? [],
            })
            .select('*')
            .single();
    
          if (insertError) {
            await refundTokens(supabaseAdmin, userId, 1, 'mcp-generate-ai-persona-failed', brand_kit_id);
            return toolError(`Failed to save persona: ${insertError.message}. Your token has been refunded.`, { code: 'db_error', retryable: true });
          }

          await log("info", "AI persona written", { persona_id: row?.id });
          await progress(100, 100, "Done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, persona: row, tokens_remaining: tokenResult.tokensRemaining }, null, 2) }] };
  },

  generate_disclosure_statement: async (ctx) => {
    // audit:exempt: returns a generated disclosure statement to the caller and persists
    // nothing (the caller saves it via upsert_brand_kit_governance). Only token deduction
    // happens here, which checkAndDeductTokens records separately.
    const { args, userId, supabaseAdmin, scopes, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "governance");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, category, answers } = args as {
      brand_kit_id?: string;
      category?: string;
      answers?: Record<string, string>;
    };
    if (!brand_kit_id || !category || !answers || typeof answers !== "object") {
      return toolError("brand_kit_id, category, and answers are required", { code: "validation_error" });
    }
    if (!["creation", "transparency", "deployment"].includes(category)) {
      return toolError("category must be one of: creation, transparency, deployment", { code: "validation_error" });
    }
    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    const { DISCLOSURE_CATEGORY_QUESTIONS } = await import("../../_shared/disclosure-questions.ts");
    const questions = DISCLOSURE_CATEGORY_QUESTIONS[category as "creation" | "transparency" | "deployment"];
    const hasAnyAnswer = Object.values(answers).some((a) => typeof a === "string" && a.trim().length > 0);
    if (!hasAnyAnswer) {
      return toolError("Provide at least one non-empty answer before generating", { code: "validation_error" });
    }

    const { data: bk } = await supabaseAdmin
      .from("brand_kits")
      .select("name")
      .eq("id", brand_kit_id)
      .maybeSingle();
    if (!bk) return toolError("Brand kit not found", { code: "not_found" });

    const tokenResult = await checkAndDeductTokens(supabaseAdmin, userId, 1, "mcp-generate-disclosure-statement", brand_kit_id);
    if (!tokenResult.allowed) {
      return toolError(tokenResult.message || "Insufficient tokens to generate disclosure statement.", { code: "quota_exceeded", recovery: "Upgrade the user's plan or wait for the next monthly token refresh." });
    }

    const SYSTEM_PROMPT = `You are an AI Diligence Disclosure Statement writer. Your role is to generate clear, professional, and transparent disclosure statements about AI usage in creative and professional work.

Core Principles (AI Fluency Diligence Framework):
- Creation Diligence: Being thoughtful about which AI systems we use and how we engage with them
- Transparency Diligence: Being honest about AI's role in our work with everyone who needs to know
- Deployment Diligence: Taking responsibility for verifying and vouching for the outputs we use or share

Output Guidelines:
1. Write in first person (or first person plural if context suggests a team)
2. Be specific about AI tools and contributions — avoid vague generalities
3. Emphasize human oversight, judgment, and final responsibility
4. Include a closing statement about why this disclosure is made
5. Match the formality level to the answers
6. Keep the statement between 100-250 words
7. Output plain text only — no markdown, no heading`;

    const answersText = questions
      .map((q, i) => `Q: ${q}\nA: ${(answers[`q${i}`] || "").toString().trim() || "Not provided"}`)
      .join("\n\n");
    const userPrompt = `Generate a ${category} diligence disclosure statement for the brand "${bk.name}".

Category: ${category.charAt(0).toUpperCase() + category.slice(1)} Diligence

User's responses:

${answersText}

Generate a professional disclosure statement based on these answers. Focus on the ${category} diligence aspects.`;

    let statement = "";
    try {
      const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
      if (!lovableApiKey) throw new Error("LOVABLE_API_KEY is not configured");
      const response = await withTimeout(
        fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${lovableApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
          }),
        }),
        AI_GATEWAY_TIMEOUT_MS,
      );
      if (!response.ok) {
        if (response.status === 429) throw new Error("AI rate limit exceeded");
        throw new Error(`AI gateway error: ${response.status}`);
      }
      const aiData = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      statement = (aiData.choices?.[0]?.message?.content || "").trim();
      if (!statement) throw new Error("Empty AI response");
    } catch (err) {
      await refundTokens(supabaseAdmin, userId, 1, "mcp-generate-disclosure-statement-failed", brand_kit_id);
      const msg = err instanceof Error ? err.message : "AI generation failed";
      return toolError(`${msg}. Your token has been refunded.`, { code: "ai_gateway_failed", retryable: true });
    }

    await log("info", "Disclosure statement generated", { category });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          statement,
          category,
          merge_instructions: "Set disclosure_statements[category] = statement and disclosure_statements.answers[category] = answers; set disclosure_statements.approved[category] = false until the user reviews. Then call upsert_brand_kit_governance with the full disclosure_statements object.",
          tokens_remaining: tokenResult.tokensRemaining,
        }, null, 2),
      }],
    };
  },
};
