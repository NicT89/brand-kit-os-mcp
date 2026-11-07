import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { dryRunPreview, filterFields, refundTokens, withTimeout } from "../helpers.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { captureRowSnapshot, recordAuditFields } from "../audit.ts";
import { normalizePersonaMultiValues } from "../../_shared/persona-multi-value.ts";
import { AI_PERSONA_WRITABLE_COLUMNS, normalizeAiPersonaFields } from "../../_shared/ai-persona-fields.ts";
import { applyPersonaVocabularyGate, buildVocabularyReport, persistNewIndustries } from "./persona-vocabulary-gate.ts";


/**
 * Validate the shape of a `few_shot_examples` array if present. Returns null
 * when valid, or a structured tool error envelope when invalid.
 *
 * Canonical shape: Array<{ label?: string; content: string; verdict?: 'good'|'bad'|'borderline' }>
 */
function validateFewShotExamples(value: unknown, toolName: string) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    return toolError("few_shot_examples must be an array.", {
      code: "validation_error",
      tool: toolName,
      field: "few_shot_examples",
      suggestedFix: "Pass an array of { label?, content, verdict? } objects.",
    });
  }
  const allowedVerdicts = new Set(["good", "bad", "borderline"]);
  for (let i = 0; i < value.length; i++) {
    const item = value[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return toolError(`few_shot_examples[${i}] must be an object.`, {
        code: "validation_error",
        tool: toolName,
        field: `few_shot_examples[${i}]`,
      });
    }
    if (typeof item.content !== "string" || item.content.trim().length === 0) {
      return toolError(`few_shot_examples[${i}].content is required and must be a non-empty string.`, {
        code: "missing_field",
        tool: toolName,
        field: `few_shot_examples[${i}].content`,
      });
    }
    if (item.verdict !== undefined && !allowedVerdicts.has(String(item.verdict))) {
      return toolError(`few_shot_examples[${i}].verdict must be one of: good, bad, borderline.`, {
        code: "validation_error",
        tool: toolName,
        field: `few_shot_examples[${i}].verdict`,
      });
    }
  }
  return null;
}

export const mutateHandlers: Record<string, ToolHandler> = {
  create_brand_kit_product: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedProductsCreate = assertBrandKitSectionScope(scopes, "products");
          if (scopeDeniedProductsCreate) return scopeDeniedProductsCreate;
          const { brand_kit_id, name, description, short_description, long_description, type, cost, special_pricing, usp, key_benefits, competitive_differentiation, dry_run } = args;
          if (!brand_kit_id || !name) return toolError("brand_kit_id and name are required", { code: "validation_error" });
          await log("info", "Starting create_brand_kit_product", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          // Legacy `description` aliases short_description (truncated to 300).
          const effectiveShort = short_description ?? (typeof description === "string" ? description.slice(0, 300) : undefined);

          const insertPayload = {
            brand_kit_id,
            name,
            short_description: effectiveShort ?? null,
            long_description: long_description ?? null,
            type: type ?? null,
            cost: cost ?? null,
            special_pricing: special_pricing ?? null,
            usp: usp ?? null,
            key_benefits: Array.isArray(key_benefits) ? key_benefits : (key_benefits ?? null),
            competitive_differentiation: competitive_differentiation ?? null,
          };

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'create',
              resource_type: 'brand_kit_products',
              resource_id: null,
              before_state: null,
              after_state: insertPayload,
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_products (insert)', null, insertPayload);
          }

          const { data: row, error } = await supabaseAdmin
            .from('brand_kit_products')
            .insert(insertPayload)
            .select('*')
            .single();

          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'create',
            resource_type: 'brand_kit_products',
            resource_id: row?.id ?? null,
            before_state: null,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "create_brand_kit_product done", { product_id: row?.id });
          return { content: [{ type: "text", text: JSON.stringify({ success: true, product: row }, null, 2) }] };
  },

  update_brand_kit_product: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedProductsUpdate = assertBrandKitSectionScope(scopes, "products");
          if (scopeDeniedProductsUpdate) return scopeDeniedProductsUpdate;
          const { product_id: rawProductId, brand_kit_id, name, description, short_description, long_description, type, cost, special_pricing, usp, key_benefits, competitive_differentiation, dry_run } = args;
          const pidRes = validateUuidParam(rawProductId, 'product_id');
          if (!('ok' in pidRes)) return pidRes;
          const product_id = pidRes.value;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_products to look up the product_id you want to update." });
          await log("info", "Starting update_brand_kit_product", { product_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const { data: existing } = await supabaseAdmin.from('brand_kit_products').select('*').eq('id', product_id).eq('brand_kit_id', brand_kit_id).maybeSingle();
          if (!existing) return toolError("Product not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the product_id by calling get_brand_kit_products for the relevant brand kit." });

          const updateData: Record<string, any> = {};
          if (name !== undefined) updateData.name = name;
          if (short_description !== undefined) updateData.short_description = short_description;
          if (long_description !== undefined) updateData.long_description = long_description;
          // Legacy `description` aliases short_description when short_description not explicitly provided.
          if (short_description === undefined && description !== undefined) {
            updateData.short_description = typeof description === "string" ? description.slice(0, 300) : description;
          }
          if (type !== undefined) updateData.type = type;
          if (cost !== undefined) updateData.cost = cost;
          if (special_pricing !== undefined) updateData.special_pricing = special_pricing;
          if (usp !== undefined) updateData.usp = usp;
          if (key_benefits !== undefined) updateData.key_benefits = key_benefits;
          if (competitive_differentiation !== undefined) updateData.competitive_differentiation = competitive_differentiation;

          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument describing the change you want to make." });

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'update',
              resource_type: 'brand_kit_products',
              resource_id: product_id,
              before_state: existing,
              after_state: { ...existing, ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_products', existing, updateData);
          }

          const { data: row, error } = await supabaseAdmin.from('brand_kit_products').update(updateData).eq('id', product_id).select('*').single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'update',
            resource_type: 'brand_kit_products',
            resource_id: product_id,
            before_state: existing,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "update_brand_kit_product done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, product: row }, null, 2) }] };
  },

  update_audience_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedAudience = assertBrandKitSectionScope(scopes, "audience");
          if (scopeDeniedAudience) return scopeDeniedAudience;
          const { persona_id: rawPersonaId, brand_kit_id, dry_run, ...fields } = args;
          const persRes = validateUuidParam(rawPersonaId, 'persona_id');
          if (!('ok' in persRes)) return persRes;
          const persona_id = persRes.value;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_audience or get_brand_kit_personas to look up the persona_id you want to update." });
          await log("info", "Starting update_audience_persona", { persona_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const { data: existing } = await supabaseAdmin.from('brand_kit_target_audience').select('*').eq('id', persona_id).eq('brand_kit_id', brand_kit_id).maybeSingle();
          if (!existing) return toolError("Audience persona not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify persona_id with get_brand_kit_audience for this brand kit." });

          const allowed = ['persona_name','persona_title','persona_type','audience_kind','is_primary','description','demographics','professional_context','personal_background','goals_motivations','frustrations_pain_points','values_beliefs','fears','information_sources','preferred_channels','core_motivation','expertise_level','buying_behavior','content_that_resonates','representative_quote','barriers_to_sale','objections_verbatim','trigger_events','product_fit','current_perception','platform_behavior','tech_usage','influencers','aspirational_identity','show_dont_tell_scene','visual_identifiers','funnel_stage_triggers','channel_behavior_matrix','paid_tools','source'];
          let updateData: Record<string, any> = {};
          for (const key of allowed) {
            if (fields[key] !== undefined) updateData[key] = fields[key];
          }
          // Multi-value demographics / professional context are stored as string arrays.
          updateData = normalizePersonaMultiValues(updateData);

          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument describing the change you want to make." });

          // Controlled-vocabulary gate: every selection must resolve to a real option.
          const vocabGate = await applyPersonaVocabularyGate(updateData, supabaseAdmin);
          if (vocabGate.error) return vocabGate.error;
          updateData = vocabGate.result!.payload;
          const pendingIndustries = vocabGate.result!.newLibraryValues.industry;

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'update',
              resource_type: 'brand_kit_target_audience',
              resource_id: persona_id,
              before_state: existing,
              after_state: { ...existing, ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_target_audience', existing, updateData, {
              normalizations: vocabGate.result!.normalizations,
              new_library_values: { industry_classifications: pendingIndustries },
            });
          }

          const vocabReport = buildVocabularyReport(vocabGate.result!, 'mcp:update_audience_persona');
          if (vocabReport) updateData.vocabulary_report = vocabReport;
          const { data: row, error } = await supabaseAdmin.from('brand_kit_target_audience').update(updateData).eq('id', persona_id).select('*').single();

          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          const addedIndustries = await persistNewIndustries(supabaseAdmin, pendingIndustries, userId);
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'update',
            resource_type: 'brand_kit_target_audience',
            resource_id: persona_id,
            before_state: existing,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "update_audience_persona done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, persona: row, normalizations: vocabGate.result!.normalizations, industries_added_to_library: addedIndustries }, null, 2) }] };

  },

  update_ai_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedPersonasUpdate = assertBrandKitSectionScope(scopes, "personas");
          if (scopeDeniedPersonasUpdate) return scopeDeniedPersonasUpdate;
          const { persona_id: rawAiPersonaId, brand_kit_id, dry_run, ...fields } = args;
          const aiPersRes = validateUuidParam(rawAiPersonaId, 'persona_id');
          if (!('ok' in aiPersRes)) return aiPersRes;
          const persona_id = aiPersRes.value;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call get_brand_kit_personas to look up the persona_id you want to update." });
          await log("info", "Starting update_ai_persona", { persona_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const { data: existing } = await supabaseAdmin.from('brand_kit_personas').select('*').eq('id', persona_id).eq('brand_kit_id', brand_kit_id).maybeSingle();
          if (!existing) return toolError("AI persona not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify persona_id with get_brand_kit_personas for this brand kit." });

          const fewShotErrUpdate = validateFewShotExamples(fields.few_shot_examples, "update_ai_persona");
          if (fewShotErrUpdate) return fewShotErrUpdate;
          const updatePersonaFields = normalizeAiPersonaFields(fields);
          const allowed = AI_PERSONA_WRITABLE_COLUMNS.filter((c) => c !== 'source');
          let updateData: Record<string, any> = {};
          for (const key of allowed) {
            if (updatePersonaFields[key] !== undefined) updateData[key] = updatePersonaFields[key];
          }

          // Multi-value demographics / professional context are stored as string arrays.
          updateData = normalizePersonaMultiValues(updateData);

          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument describing the change you want to make." });

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'update',
              resource_type: 'brand_kit_personas',
              resource_id: persona_id,
              before_state: existing,
              after_state: { ...existing, ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_personas', existing, updateData);
          }

          const { data: row, error } = await supabaseAdmin.from('brand_kit_personas').update(updateData).eq('id', persona_id).select('*').single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'update',
            resource_type: 'brand_kit_personas',
            resource_id: persona_id,
            before_state: existing,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "update_ai_persona done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, persona: row }, null, 2) }] };
  },

  get_brand_kit_seo: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const { data, error } = await supabaseAdmin.from('brand_kit_seo').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          return { content: [{ type: "text", text: JSON.stringify(filterFields(data, args.fields), null, 2) }] };
  },

  upsert_brand_kit_seo: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedSeo = assertBrandKitSectionScope(scopes, "seo");
          if (scopeDeniedSeo) return scopeDeniedSeo;
          const { brand_kit_id, keywords, tags, suggested_keywords, dry_run } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          await log("info", "Starting upsert_brand_kit_seo", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const updateData: Record<string, any> = {};
          if (keywords !== undefined) updateData.keywords = keywords;
          if (tags !== undefined) updateData.tags = tags;
          if (suggested_keywords !== undefined) updateData.suggested_keywords = suggested_keywords;

          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided.", { code: "validation_error" });

          const beforeState = await captureRowSnapshot(supabaseAdmin, 'brand_kit_seo', 'brand_kit_id', brand_kit_id as string);

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'upsert',
              resource_type: 'brand_kit_seo',
              resource_id: null,
              before_state: beforeState,
              after_state: { ...(beforeState && typeof beforeState === 'object' ? beforeState : {}), ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_seo', beforeState, updateData);
          }

          const { error } = await supabaseAdmin.from('brand_kit_seo').upsert({ brand_kit_id, ...updateData }, { onConflict: 'brand_kit_id' });
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          const { data: updated } = await supabaseAdmin.from('brand_kit_seo').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle();
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'upsert',
            resource_type: 'brand_kit_seo',
            resource_id: null,
            before_state: beforeState,
            after_state: updated,
            was_dry_run: false,
          });
          await log("info", "upsert_brand_kit_seo done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, data: updated }, null, 2) }] };
  },

  // Trigger the server-side social-profile scrape (the same APIFY/n8n workflow
  // the app UI runs) as a non-blocking background job. The agent supplies the
  // profile URL; Brand Kit OS owns the scrape, formatting, storage, and token
  // charging. We do NOT let the agent write social_profiles fields directly —
  // that bypasses the formatting/normalization the scrape workflow performs.
  request_social_profile_scrape: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "visuals");
    if (scopeDenied) return scopeDenied;
    const { brand_kit_id, platform, profile_type, profile_url, scrape_type = "profile", results_limit } =
      args as Record<string, unknown>;

    if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "missing_field", tool: "request_social_profile_scrape", field: "brand_kit_id" });
    if (!profile_url) return toolError("profile_url is required", { code: "missing_field", tool: "request_social_profile_scrape", field: "profile_url" });

    // Only Instagram and Facebook are supported today.
    const allowedPlatforms = new Set(["instagram", "facebook"]);
    if (!allowedPlatforms.has(String(platform))) {
      return toolError(`platform must be one of: ${[...allowedPlatforms].join(", ")} (only Instagram and Facebook are supported today).`, { code: "validation_error", tool: "request_social_profile_scrape", field: "platform" });
    }
    const allowedProfileTypes = new Set(["personal", "company"]);
    if (!allowedProfileTypes.has(String(profile_type))) {
      return toolError("profile_type must be 'personal' or 'company'.", { code: "validation_error", tool: "request_social_profile_scrape", field: "profile_type" });
    }
    const allowedScrapeTypes = new Set(["profile", "posts"]);
    if (!allowedScrapeTypes.has(String(scrape_type))) {
      return toolError("scrape_type must be 'profile' or 'posts' (they are separate operations).", { code: "validation_error", tool: "request_social_profile_scrape", field: "scrape_type" });
    }

    await log("info", "Starting request_social_profile_scrape", { brand_kit_id, platform, profile_type, scrape_type });

    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    // Posts scraping is metered (1 token per 10 posts). Before kicking off, read
    // the user's balance + overage room and cap how many posts we request to
    // what their credits cover — never start a scrape they can't pay for.
    // Cost model is unchanged; the scrape function still does the actual charge.
    let resultsLimit = 200;
    if (scrape_type === "posts") {
      const { data: sub } = await supabaseAdmin
        .from("user_subscriptions")
        .select("tokens_balance, monthly_token_allowance, overage_limit_percent")
        .eq("user_id", userId)
        .maybeSingle();
      const balance = Number(sub?.tokens_balance ?? 0);
      const allowance = Number(sub?.monthly_token_allowance ?? 0);
      const overagePct = Number(sub?.overage_limit_percent ?? 0);
      const maxOverage = Math.floor(allowance * (overagePct / 100));
      const availableCredits = balance + maxOverage; // room before hitting the minimum balance
      const affordablePosts = Math.max(0, availableCredits) * 10; // 10 posts per token
      if (affordablePosts < 10) {
        return toolError(
          `Insufficient credits to scrape posts. Available credits: ${availableCredits} (covers ${affordablePosts} posts). Posts scraping costs 1 token per 10 posts.`,
          { code: "quota_exceeded", tool: "request_social_profile_scrape", recovery: "Top up credits, or run a 'profile' scrape (which is not metered) instead." },
        );
      }
      const requested = Number.isFinite(Number(results_limit)) && Number(results_limit) > 0 ? Math.floor(Number(results_limit)) : 200;
      resultsLimit = Math.min(requested, affordablePosts, 200);
    }

    // Ensure the social_profiles row exists and is marked pending, so the UI and
    // subsequent reads (get_brand_kit_social_profiles) reflect the in-flight
    // scrape. Keyed by (brand_kit_id, platform, profile_type). This persists
    // only the URL + status — never agent-supplied profile fields.
    const { data: beforeState } = await supabaseAdmin
      .from("social_profiles")
      .select("id, status")
      .eq("brand_kit_id", brand_kit_id)
      .eq("platform", platform)
      .eq("profile_type", profile_type)
      .maybeSingle();

    const { error: upsertErr } = await supabaseAdmin
      .from("social_profiles")
      .upsert(
        { brand_kit_id, platform, profile_type, profile_url, status: "pending" },
        { onConflict: "brand_kit_id,platform,profile_type" },
      );
    if (upsertErr) return toolError(`Database error: ${upsertErr.message}`, { code: "db_error", retryable: true });

    const { data: pendingRow } = await supabaseAdmin
      .from("social_profiles")
      .select("id, status")
      .eq("brand_kit_id", brand_kit_id)
      .eq("platform", platform)
      .eq("profile_type", profile_type)
      .maybeSingle();

    await recordAuditFields(supabaseAdmin, requestId, {
      operation: "upsert",
      resource_type: "social_profiles",
      resource_id: (pendingRow as { id?: string } | null)?.id ?? null,
      before_state: beforeState,
      after_state: pendingRow,
      was_dry_run: false,
    });

    // Fire-and-forget the scrape: it can take up to ~45s, and we must not block
    // the MCP conversation. EdgeRuntime.waitUntil keeps the work alive after we
    // return. The scrape function authenticates this as a trusted internal call
    // via the service-role bearer + internal_user_id (the MCP server has already
    // authenticated the API key and verified brand-kit write access above).
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey) {
      const scrapePromise = fetch(`${supabaseUrl}/functions/v1/social-profile-scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
        body: JSON.stringify({
          brandKitId: brand_kit_id,
          platform,
          profileType: profile_type,
          url: profile_url,
          scrapeType: scrape_type,
          resultsLimit,
          internal_user_id: userId,
        }),
      }).catch((err) => console.error("social-profile-scrape kickoff failed:", err));
      // @ts-expect-error EdgeRuntime is provided by the Supabase Functions runtime
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        // @ts-expect-error EdgeRuntime is provided by the Supabase Functions runtime
        EdgeRuntime.waitUntil(scrapePromise);
      } else {
        // Local/non-edge runtime: don't await (keep the tool non-blocking).
        void scrapePromise;
      }
    } else {
      return toolError("Scrape service is not configured (missing SUPABASE_URL / service key).", { code: "internal_error", retryable: true });
    }

    await log("info", "request_social_profile_scrape kicked off", { brand_kit_id, platform, scrape_type, resultsLimit });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          status: "scrape_started",
          platform,
          profile_type,
          scrape_type,
          ...(scrape_type === "posts" ? { posts_requested: resultsLimit } : {}),
          message: `${scrape_type === "posts" ? "Posts" : "Profile"} scrape started in the background for ${platform}. It usually completes within ~45 seconds.`,
          next_step: "Do not block on this. Continue with the user; after ~90 seconds, call get_brand_kit_social_profiles to check whether status has changed from 'pending' to 'active' (or 'error'), then read the populated fields.",
        }, null, 2),
      }],
    };
  },




  list_expression_examples: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const { data, error } = await supabaseAdmin.from('expression_examples').select('id, platform, context_type, user_response, original_content, source, platform_metadata, created_at, updated_at').eq('brand_kit_id', brand_kit_id).order('created_at', { ascending: false });
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          return { content: [{ type: "text", text: JSON.stringify(data || [], null, 2) }] };
  },

  create_expression_example: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedExprExample = assertBrandKitSectionScope(scopes, "expression");
          if (scopeDeniedExprExample) return scopeDeniedExprExample;
          const { brand_kit_id, platform, context_type, user_response, original_content, source, platform_metadata, dry_run } = args;
          if (!brand_kit_id || !platform || !context_type || !user_response) return toolError("brand_kit_id, platform, context_type, and user_response are required", { code: "validation_error" });
          // expression_examples.source has a DB CHECK ('manual','n8n','import'); reject up front
          // so callers get a clear validation error instead of a raw Postgres 23514.
          const ALLOWED_EXPRESSION_SOURCES = ['manual', 'n8n', 'import'];
          if (source !== undefined && !ALLOWED_EXPRESSION_SOURCES.includes(source as string)) {
            return toolError(`Invalid source '${source}'. Allowed values: ${ALLOWED_EXPRESSION_SOURCES.join(', ')}.`, { code: "validation_error", recovery: "Set source to one of 'manual', 'n8n', or 'import' (or omit it to default to 'manual')." });
          }
          await log("info", "Starting create_expression_example", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const insertPayload = {
            brand_kit_id,
            user_id: userId,
            platform,
            context_type,
            user_response,
            original_content: original_content ?? null,
            source: source ?? 'manual',
            platform_metadata: platform_metadata ?? null,
          };

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'create',
              resource_type: 'expression_examples',
              resource_id: null,
              before_state: null,
              after_state: insertPayload,
              was_dry_run: true,
            });
            return dryRunPreview('expression_examples (insert)', null, insertPayload);
          }

          const { data: row, error } = await supabaseAdmin.from('expression_examples').insert(insertPayload).select('*').single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'create',
            resource_type: 'expression_examples',
            resource_id: row?.id ?? null,
            before_state: null,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "create_expression_example done", { example_id: row?.id });
          return { content: [{ type: "text", text: JSON.stringify({ success: true, example: row }, null, 2) }] };
  },

  update_expression_example: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedExprExampleUpdate = assertBrandKitSectionScope(scopes, "expression");
          if (scopeDeniedExprExampleUpdate) return scopeDeniedExprExampleUpdate;
          const { example_id: rawExampleId, brand_kit_id, dry_run, ...fields } = args;
          const exRes = validateUuidParam(rawExampleId, 'example_id');
          if (!('ok' in exRes)) return exRes;
          const example_id = exRes.value;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Call list_expression_examples to look up the example_id you want to update." });
          const ALLOWED_EXPRESSION_SOURCES = ['manual', 'n8n', 'import'];
          if (fields.source !== undefined && !ALLOWED_EXPRESSION_SOURCES.includes(fields.source as string)) {
            return toolError(`Invalid source '${fields.source}'. Allowed values: ${ALLOWED_EXPRESSION_SOURCES.join(', ')}.`, { code: "validation_error", recovery: "Set source to one of 'manual', 'n8n', or 'import'." });
          }
          await log("info", "Starting update_expression_example", { example_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const { data: existing } = await supabaseAdmin.from('expression_examples').select('*').eq('id', example_id).eq('brand_kit_id', brand_kit_id).maybeSingle();
          if (!existing) return toolError("Expression example not found or does not belong to this brand kit", { code: "not_found", recovery: "Verify the example_id with list_expression_examples for this brand kit." });

          const allowed = ['platform','context_type','user_response','original_content','source','platform_metadata'];
          const updateData: Record<string, any> = {};
          for (const key of allowed) {
            if (fields[key] !== undefined) updateData[key] = fields[key];
          }
          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument describing the change you want to make." });

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, { operation: 'update', resource_type: 'expression_examples', resource_id: example_id, before_state: existing, after_state: { ...existing, ...updateData }, was_dry_run: true });
            return dryRunPreview('expression_examples', existing, updateData);
          }

          const { data: row, error } = await supabaseAdmin.from('expression_examples').update(updateData).eq('id', example_id).select('*').single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, { operation: 'update', resource_type: 'expression_examples', resource_id: example_id, before_state: existing, after_state: row, was_dry_run: false });
          await log("info", "update_expression_example done", { example_id });
          return { content: [{ type: "text", text: JSON.stringify({ success: true, example: row }, null, 2) }] };
  },

  create_audience_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedAudienceCreate = assertBrandKitSectionScope(scopes, "audience");
          if (scopeDeniedAudienceCreate) return scopeDeniedAudienceCreate;
          const { brand_kit_id, dry_run, ...fields } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          if (!fields.persona_name) return toolError("persona_name is required", { code: "validation_error", recovery: "Provide persona_name for the new persona." });
          // Person persona vs company ICP is an explicit choice, never a guess:
          // the two describe different things and were previously conflated.
          const audienceKind = fields.audience_kind;
          if (audienceKind !== 'person' && audienceKind !== 'company') {
            return toolError("audience_kind is required and must be 'person' or 'company'.", {
              code: "validation_error",
              recovery:
                "Use audience_kind: 'person' for an individual buyer persona (a human — demographics, goals, fears), or audience_kind: 'company' for a company ICP (an organization — size, type, industry). For a full firmographic company ICP, call create_company_profile instead.",
            });
          }
          if (fields.persona_type === undefined) {
            // A company ICP is a B2B motion by definition; a person persona must say.
            if (audienceKind === 'company') fields.persona_type = 'b2b';
            else {
              return toolError("persona_type is required for a person persona.", {
                code: "validation_error",
                recovery: "Pass persona_type: 'b2b' or 'b2c' to say which selling motion this person belongs to.",
              });
            }
          }
          await log("info", "Starting create_audience_persona", { brand_kit_id, dry_run: !!dry_run, audience_kind: audienceKind });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const allowed = ['persona_name','persona_title','persona_type','audience_kind','is_primary','description','demographics','professional_context','personal_background','goals_motivations','frustrations_pain_points','values_beliefs','fears','information_sources','preferred_channels','core_motivation','expertise_level','buying_behavior','content_that_resonates','representative_quote','barriers_to_sale','objections_verbatim','trigger_events','product_fit','current_perception','platform_behavior','tech_usage','influencers','aspirational_identity','show_dont_tell_scene','visual_identifiers','funnel_stage_triggers','channel_behavior_matrix','paid_tools','source'];
          let insertPayload: Record<string, any> = { brand_kit_id };
          for (const key of allowed) {
            if (fields[key] !== undefined) insertPayload[key] = fields[key];
          }
          // Multi-value demographics / professional context are stored as string arrays.
          insertPayload = normalizePersonaMultiValues(insertPayload);
          if (insertPayload.source === undefined) insertPayload.source = 'manual';
          if (insertPayload.is_primary === undefined) insertPayload.is_primary = false;

          // Controlled-vocabulary gate: every selection must resolve to a real option.
          const createVocabGate = await applyPersonaVocabularyGate(insertPayload, supabaseAdmin);
          if (createVocabGate.error) return createVocabGate.error;
          insertPayload = createVocabGate.result!.payload;
          const createPendingIndustries = createVocabGate.result!.newLibraryValues.industry;

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, { operation: 'create', resource_type: 'brand_kit_target_audience', resource_id: null, before_state: null, after_state: insertPayload, was_dry_run: true });
            return dryRunPreview('brand_kit_target_audience (insert)', null, insertPayload, {
              normalizations: createVocabGate.result!.normalizations,
              new_library_values: { industry_classifications: createPendingIndustries },
            });
          }

          const createVocabReport = buildVocabularyReport(createVocabGate.result!, 'mcp:create_audience_persona');
          if (createVocabReport) insertPayload.vocabulary_report = createVocabReport;
          const { data: row, error } = await supabaseAdmin.from('brand_kit_target_audience').insert(insertPayload).select('*').single();

          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          const createdIndustries = await persistNewIndustries(supabaseAdmin, createPendingIndustries, userId);
          await recordAuditFields(supabaseAdmin, requestId, { operation: 'create', resource_type: 'brand_kit_target_audience', resource_id: row?.id ?? null, before_state: null, after_state: row, was_dry_run: false });
          await log("info", "create_audience_persona done", { persona_id: row?.id });
          return { content: [{ type: "text", text: JSON.stringify({ success: true, persona: row, normalizations: createVocabGate.result!.normalizations, industries_added_to_library: createdIndustries }, null, 2) }] };

  },

  create_brand_kit_persona: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedPersonaCreate = assertBrandKitSectionScope(scopes, "personas");
          if (scopeDeniedPersonaCreate) return scopeDeniedPersonaCreate;
          const { brand_kit_id, dry_run, ...fields } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error" });
          if (!fields.name || !fields.purpose_type) return toolError("name and purpose_type are required", { code: "validation_error", recovery: "Provide name and purpose_type for the new AI persona." });
          await log("info", "Starting create_brand_kit_persona", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const fewShotErrCreate = validateFewShotExamples(fields.few_shot_examples, "create_brand_kit_persona");
          if (fewShotErrCreate) return fewShotErrCreate;
          const createPersonaFields = normalizeAiPersonaFields(fields);
          const allowed = [...AI_PERSONA_WRITABLE_COLUMNS];
          let insertPayload: Record<string, any> = { brand_kit_id };
          for (const key of allowed) {
            if (createPersonaFields[key] !== undefined) insertPayload[key] = createPersonaFields[key];
          }
          // Multi-value demographics / professional context are stored as string arrays.
          insertPayload = normalizePersonaMultiValues(insertPayload);

          if (insertPayload.source === undefined) insertPayload.source = 'manual';
          if (insertPayload.is_active === undefined) insertPayload.is_active = true;
          if (insertPayload.is_default === undefined) insertPayload.is_default = false;
          if (insertPayload.interaction_context === undefined) insertPayload.interaction_context = [];

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, { operation: 'create', resource_type: 'brand_kit_personas', resource_id: null, before_state: null, after_state: insertPayload, was_dry_run: true });
            return dryRunPreview('brand_kit_personas (insert)', null, insertPayload);
          }

          const { data: row, error } = await supabaseAdmin.from('brand_kit_personas').insert(insertPayload).select('*').single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, { operation: 'create', resource_type: 'brand_kit_personas', resource_id: row?.id ?? null, before_state: null, after_state: row, was_dry_run: false });
          await log("info", "create_brand_kit_persona done", { persona_id: row?.id });
          return { content: [{ type: "text", text: JSON.stringify({ success: true, persona: row }, null, 2) }] };
  },

  update_logo_asset: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedLogo = assertBrandKitSectionScope(scopes, "visuals");
          if (scopeDeniedLogo) return scopeDeniedLogo;
          const { asset_id, brand_kit_id, dry_run, ...fields } = args;
          if (!asset_id || !brand_kit_id) return toolError("asset_id and brand_kit_id are required", { code: "validation_error" });
          await log("info", "Starting update_logo_asset", { asset_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const { data: existing } = await supabaseAdmin.from('brand_kit_logo_assets').select('*').eq('id', asset_id).eq('brand_kit_id', brand_kit_id).maybeSingle();
          if (!existing) return toolError("Logo asset not found or does not belong to this brand kit", { code: "not_found" });

          const allowed = ['label','description','long_description','usage_guidelines','is_default','sort_order'];
          const updateData: Record<string, any> = {};
          for (const key of allowed) {
            if (fields[key] !== undefined) updateData[key] = fields[key];
          }
          if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided.", { code: "validation_error" });

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'update',
              resource_type: 'brand_kit_logo_assets',
              resource_id: asset_id as string,
              before_state: existing,
              after_state: { ...existing, ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_logo_assets', existing, updateData);
          }

          const { data: row, error } = await supabaseAdmin.from('brand_kit_logo_assets').update(updateData).eq('id', asset_id).select('*').single();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'update',
            resource_type: 'brand_kit_logo_assets',
            resource_id: asset_id as string,
            before_state: existing,
            after_state: row,
            was_dry_run: false,
          });
          await log("info", "update_logo_asset done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, asset: row }, null, 2) }] };
  },
};
