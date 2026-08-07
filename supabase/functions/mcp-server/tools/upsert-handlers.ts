import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { callAIGateway, formatPersonality } from "../ai-gateway.ts";
import { dryRunPreview, filterFields, refundTokens, withTimeout } from "../helpers.ts";
import { toJsonArray, normalizeGovernanceForRead, wrapWritingConstraintsForWrite, normalizeNegativeDirectoryForWrite, wrapTerminologyForWrite } from "../json-helpers.ts";
import { normalizeSlotShapeForWrite } from "../normalize-slot-shape.ts";
import { findInvalidGovernancePlatforms, GOVERNANCE_PLATFORMS } from "../governance-platforms.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { captureRowSnapshot, recordAuditFields } from "../audit.ts";

export const upsertHandlers: Record<string, ToolHandler> = {
  upsert_brand_kit_core: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedCore = assertBrandKitSectionScope(scopes, "core");
          if (scopeDeniedCore) return scopeDeniedCore;
          const { brand_kit_id, mission, vision, brand_story, brand_promises, taglines, storytelling_elements, industry_classification, dry_run } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          await log("info", "Starting upsert_brand_kit_core", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const updateData: Record<string, any> = {};
          if (mission !== undefined) updateData.mission = mission;
          if (vision !== undefined) updateData.vision = vision;
          if (brand_story !== undefined) updateData.brand_story = brand_story;
          if (brand_promises !== undefined) updateData.brand_promises = brand_promises;
          if (taglines !== undefined) updateData.taglines = taglines;
          if (storytelling_elements !== undefined) updateData.storytelling_elements = storytelling_elements;
          if (industry_classification !== undefined) updateData.industry_classification = industry_classification;

          if (Object.keys(updateData).length === 0) {
            return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. mission, vision, tone_of_voice) describing the change you want to make." });
          }

          const beforeState = await captureRowSnapshot(supabaseAdmin, 'brand_kit_core', 'brand_kit_id', brand_kit_id as string);

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'upsert',
              resource_type: 'brand_kit_core',
              resource_id: null,
              before_state: beforeState,
              after_state: { ...(beforeState && typeof beforeState === 'object' ? beforeState : {}), ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_core', beforeState, updateData);
          }

          const { error } = await supabaseAdmin
            .from('brand_kit_core')
            .upsert({ brand_kit_id, ...updateData }, { onConflict: 'brand_kit_id' });
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });

          const { data: updated } = await supabaseAdmin.from('brand_kit_core').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle();
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'upsert',
            resource_type: 'brand_kit_core',
            resource_id: null,
            before_state: beforeState,
            after_state: updated,
            was_dry_run: false,
          });
          await log("info", "upsert_brand_kit_core done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, data: updated }, null, 2) }] };
  },

  upsert_brand_kit_expression: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedExpression = assertBrandKitSectionScope(scopes, "expression");
          if (scopeDeniedExpression) return scopeDeniedExpression;
          const { brand_kit_id, brand_voice, tone_of_voice, tone_dimensions, voice_archetypes, verbal_style, visual_style, preferred_terminology, dry_run } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          await log("info", "Starting upsert_brand_kit_expression", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const expressionData: Record<string, any> = {};
          if (tone_of_voice !== undefined) expressionData.tone_of_voice = tone_of_voice;
          if (tone_dimensions !== undefined) expressionData.tone_dimensions = tone_dimensions;
          if (voice_archetypes !== undefined) {
            // Hydrate library-linked archetypes: when an entry includes
            // archetype_id, fetch the library record, fill missing name/
            // key_traits/description from it, validate the id, and increment
            // usage_count. Unknown ids are rejected with a structured error.
            const inputArr = Array.isArray(voice_archetypes) ? voice_archetypes : [];
            const ids = inputArr
              .map((a) => (a as { archetype_id?: string })?.archetype_id)
              .filter((id): id is string => typeof id === "string" && id.length > 0);
            let libraryById = new Map<string, any>();
            if (ids.length > 0) {
              const { data: libRows, error: libErr } = await supabaseAdmin
                .from("library_archetypes")
                .select("id, name, description, key_traits, is_library, user_id, usage_count")
                .in("id", ids);
              if (libErr) {
                return toolError(`Database error: ${libErr.message}`, {
                  code: "db_error",
                  tool: "upsert_brand_kit_expression",
                  field: "voice_archetypes",
                  retryable: true,
                });
              }
              libraryById = new Map((libRows || []).map((r: any) => [r.id, r]));
              const visibleIds = new Set(
                (libRows || [])
                  .filter((r: any) => r.is_library === true || r.user_id === userId)
                  .map((r: any) => r.id as string),
              );
              const missing = ids.filter((id) => !visibleIds.has(id));
              if (missing.length > 0) {
                return toolError(
                  `Unknown or inaccessible archetype_id(s): ${missing.join(", ")}`,
                  {
                    code: "invalid_reference",
                    tool: "upsert_brand_kit_expression",
                    field: "voice_archetypes[].archetype_id",
                    suggestedFix: "Call list_library_archetypes to get valid ids.",
                    data: { invalid_ids: missing },
                  },
                );
              }
            }
            const hydrated = inputArr.map((entry) => {
              const e = entry as Record<string, unknown>;
              const id = typeof e.archetype_id === "string" ? e.archetype_id : null;
              if (!id) return e;
              const lib = libraryById.get(id);
              if (!lib) return e;
              return {
                archetype_id: id,
                name: e.name ?? lib.name,
                description: e.description ?? lib.description,
                characteristics: e.characteristics ?? lib.key_traits ?? [],
                ...e,
                archetype_id_resolved: true,
              };
            });
            expressionData.voice_archetypes = hydrated;
            // Fire-and-forget usage counter bumps (don't block the write).
            if (!dry_run) {
              for (const [id, lib] of libraryById) {
                const next = (typeof lib.usage_count === "number" ? lib.usage_count : 0) + 1;
                supabaseAdmin
                  .from("library_archetypes")
                  .update({ usage_count: next })
                  .eq("id", id)
                  .then(() => undefined, () => undefined);
              }
            }
          }
          if (verbal_style !== undefined) expressionData.verbal_style = normalizeSlotShapeForWrite(verbal_style, "verbal_style");
          if (visual_style !== undefined) expressionData.visual_style = normalizeSlotShapeForWrite(visual_style, "visual_style");
          if (preferred_terminology !== undefined) expressionData.preferred_terminology = wrapTerminologyForWrite(preferred_terminology);


          const hasBrandVoice = brand_voice !== undefined;
          const hasExpressionData = Object.keys(expressionData).length > 0;

          if (!hasBrandVoice && !hasExpressionData) {
            return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. mission, vision, tone_of_voice) describing the change you want to make." });
          }

          // Capture a merged before-state across both tables (brand_kit_expression
          // is the primary; brand_voice lives on the parent brand_kits row).
          const [{ data: beforeExpression }, { data: beforeBk }] = await Promise.all([
            supabaseAdmin.from('brand_kit_expression').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle(),
            supabaseAdmin.from('brand_kits').select('brand_voice').eq('id', brand_kit_id).maybeSingle(),
          ]);
          const beforeState = { ...(beforeExpression || {}), ...(beforeBk ? { brand_voice: beforeBk.brand_voice } : {}) };

          if (dry_run) {
            const proposed: Record<string, any> = { ...expressionData };
            if (hasBrandVoice) proposed.brand_voice = brand_voice;
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'upsert',
              resource_type: 'brand_kit_expression',
              resource_id: null,
              before_state: beforeState,
              after_state: { ...beforeState, ...proposed },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_expression + brand_kits.brand_voice', beforeState, proposed);
          }

          const ops: Promise<any>[] = [];

          if (hasExpressionData) {
            ops.push(
              supabaseAdmin.from('brand_kit_expression').upsert({ brand_kit_id, ...expressionData }, { onConflict: 'brand_kit_id' })
            );
          }
          if (hasBrandVoice) {
            ops.push(
              supabaseAdmin.from('brand_kits').update({ brand_voice }).eq('id', brand_kit_id)
            );
          }

          const results = await Promise.all(ops);
          const firstError = results.find(r => r.error);
          if (firstError?.error) return toolError(`Database error: ${firstError.error.message}`, { code: "db_error", retryable: true });

          const [{ data: updated }, { data: updatedBk }] = await Promise.all([
            supabaseAdmin.from('brand_kit_expression').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle(),
            hasBrandVoice
              ? supabaseAdmin.from('brand_kits').select('brand_voice').eq('id', brand_kit_id).maybeSingle()
              : Promise.resolve({ data: null }),
          ]);
          const afterState = { ...(updated || {}), ...(updatedBk ? { brand_voice: updatedBk.brand_voice } : (beforeBk ? { brand_voice: beforeBk.brand_voice } : {})) };
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'upsert',
            resource_type: 'brand_kit_expression',
            resource_id: null,
            before_state: beforeState,
            after_state: afterState,
            was_dry_run: false,
          });
          await log("info", "upsert_brand_kit_expression done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, data: updated }, null, 2) }] };
  },

  upsert_brand_kit_personality: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedPersonality = assertBrandKitSectionScope(scopes, "personality");
          if (scopeDeniedPersonality) return scopeDeniedPersonality;
          const { brand_kit_id, personality_traits, brand_values, brand_principles, brand_moods, dry_run } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          await log("info", "Starting upsert_brand_kit_personality", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const updateData: Record<string, any> = {};
          if (personality_traits !== undefined) updateData.personality_traits = personality_traits;
          if (brand_values !== undefined) updateData.brand_values = brand_values;
          if (brand_principles !== undefined) updateData.brand_principles = brand_principles;
          if (brand_moods !== undefined) updateData.brand_moods = brand_moods;

          if (Object.keys(updateData).length === 0) {
            return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. mission, vision, tone_of_voice) describing the change you want to make." });
          }

          const beforeState = await captureRowSnapshot(supabaseAdmin, 'brand_kit_personality', 'brand_kit_id', brand_kit_id as string);

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'upsert',
              resource_type: 'brand_kit_personality',
              resource_id: null,
              before_state: beforeState,
              after_state: { ...(beforeState && typeof beforeState === 'object' ? beforeState : {}), ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_personality', beforeState, updateData);
          }

          const { error } = await supabaseAdmin
            .from('brand_kit_personality')
            .upsert({ brand_kit_id, ...updateData }, { onConflict: 'brand_kit_id' });
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });

          const { data: updated } = await supabaseAdmin.from('brand_kit_personality').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle();
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'upsert',
            resource_type: 'brand_kit_personality',
            resource_id: null,
            before_state: beforeState,
            after_state: updated,
            was_dry_run: false,
          });
          await log("info", "upsert_brand_kit_personality done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, data: formatPersonality(updated) }, null, 2) }] };
  },

  upsert_brand_kit_governance: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
          const scopeDeniedGovernance = assertBrandKitSectionScope(scopes, "governance");
          if (scopeDeniedGovernance) return scopeDeniedGovernance;
          const { brand_kit_id, behavioral_constraints, negative_directory, writing_constraints, usage_guidelines, disclosure_statements, compliance_selections, disclosure_policy, compliance_notes, drift_prevention_prompts, dry_run } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          await log("info", "Starting upsert_brand_kit_governance", { brand_kit_id, dry_run: !!dry_run });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;

          const updateData: Record<string, any> = {};
          if (behavioral_constraints !== undefined) updateData.behavioral_constraints = behavioral_constraints;
          if (negative_directory !== undefined) updateData.negative_directory = normalizeNegativeDirectoryForWrite(negative_directory);
          if (writing_constraints !== undefined) {
            const wrapped = wrapWritingConstraintsForWrite(writing_constraints);
            const invalidPlatforms = findInvalidGovernancePlatforms(wrapped);
            if (invalidPlatforms) {
              return toolError(
                `Unknown platform value(s) in writing_constraints: ${invalidPlatforms.join(", ")}.`,
                {
                  code: "validation_error",
                  recovery: `Use one of the values from list_governance_platforms: ${GOVERNANCE_PLATFORMS.map((p) => p.value).join(", ")}.`,
                  data: { invalid_platforms: invalidPlatforms, allowed_platforms: GOVERNANCE_PLATFORMS.map((p) => p.value) },
                },
              );
            }
            updateData.writing_constraints = wrapped;
          }
          if (usage_guidelines !== undefined) updateData.usage_guidelines = usage_guidelines;
          if (disclosure_statements !== undefined) updateData.disclosure_statements = disclosure_statements;
          if (compliance_selections !== undefined) updateData.compliance_selections = compliance_selections;
          if (disclosure_policy !== undefined) updateData.disclosure_policy = disclosure_policy;
          if (compliance_notes !== undefined) updateData.compliance_notes = compliance_notes;
          if (drift_prevention_prompts !== undefined) updateData.drift_prevention_prompts = drift_prevention_prompts;


          if (Object.keys(updateData).length === 0) {
            return toolError("At least one field must be provided to update.", { code: "validation_error", recovery: "Include at least one optional argument (e.g. mission, vision, tone_of_voice) describing the change you want to make." });
          }

          // Audit snapshots store raw DB values (writing_constraints in its
          // wrapped form) so the diff is meaningful. Callers get the
          // normalized form via normalizeGovernanceForRead below.
          const beforeState = await captureRowSnapshot(supabaseAdmin, 'brand_kit_governance', 'brand_kit_id', brand_kit_id as string);

          if (dry_run) {
            await recordAuditFields(supabaseAdmin, requestId, {
              operation: 'upsert',
              resource_type: 'brand_kit_governance',
              resource_id: null,
              before_state: beforeState,
              after_state: { ...(beforeState && typeof beforeState === 'object' ? beforeState : {}), ...updateData },
              was_dry_run: true,
            });
            return dryRunPreview('brand_kit_governance', beforeState, updateData);
          }

          const { error } = await supabaseAdmin
            .from('brand_kit_governance')
            .upsert({ brand_kit_id, ...updateData }, { onConflict: 'brand_kit_id' });
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });

          const { data: updated } = await supabaseAdmin.from('brand_kit_governance').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle();
          await recordAuditFields(supabaseAdmin, requestId, {
            operation: 'upsert',
            resource_type: 'brand_kit_governance',
            resource_id: null,
            before_state: beforeState,
            after_state: updated,
            was_dry_run: false,
          });
          await log("info", "upsert_brand_kit_governance done");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, data: normalizeGovernanceForRead(updated) }, null, 2) }] };
  },

  /**
   * Shortcut for toggling `writing_constraints.platformSpecificEnabled` and
   * optionally appending platform-scoped rules in a single call. Deep-merges
   * into the existing wrapper, preserving `constraints[]` and `preferences`.
   */
  set_platform_specific_rules: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log } = ctx;
    const scopeDenied = assertBrandKitSectionScope(scopes, "governance");
    if (scopeDenied) return scopeDenied;

    const { brand_kit_id, enabled, rules, dry_run } = args;
    if (!brand_kit_id) {
      return toolError("brand_kit_id is required", {
        code: "missing_field",
        tool: "set_platform_specific_rules",
        field: "brand_kit_id",
      });
    }
    if (typeof enabled !== "boolean") {
      return toolError("`enabled` must be a boolean.", {
        code: "validation_error",
        tool: "set_platform_specific_rules",
        field: "enabled",
      });
    }
    await log("info", "Starting set_platform_specific_rules", { brand_kit_id, enabled, dry_run: !!dry_run });

    const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
    if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", tool: "set_platform_specific_rules", recovery: ACCESS_DENIED_RECOVERY });
    const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
    if (mcpWriteGate) return mcpWriteGate;
    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    const beforeRow = await captureRowSnapshot(supabaseAdmin, 'brand_kit_governance', 'brand_kit_id', brand_kit_id as string);
    const beforeWc = ((beforeRow && typeof beforeRow === 'object') ? (beforeRow as Record<string, unknown>).writing_constraints : null) as Record<string, unknown> | null;
    const baseWrapper: Record<string, unknown> = beforeWc && typeof beforeWc === 'object' && !Array.isArray(beforeWc)
      ? { ...beforeWc }
      : Array.isArray(beforeWc) ? { constraints: beforeWc } : {};
    const existingConstraints = Array.isArray(baseWrapper.constraints) ? (baseWrapper.constraints as unknown[]) : [];

    const newRules = Array.isArray(rules) ? rules : [];
    if (newRules.length > 0) {
      const invalid = findInvalidGovernancePlatforms({ constraints: newRules });
      if (invalid) {
        return toolError(
          `Unknown platform value(s) in rules: ${invalid.join(", ")}.`,
          {
            code: "validation_error",
            tool: "set_platform_specific_rules",
            field: "rules[].platform",
            suggestedFix: `Use values from list_governance_platforms: ${GOVERNANCE_PLATFORMS.map((p) => p.value).join(", ")}.`,
            data: { invalid_platforms: invalid, allowed_platforms: GOVERNANCE_PLATFORMS.map((p) => p.value) },
          },
        );
      }
    }

    const mergedWrapper = {
      ...baseWrapper,
      platformSpecificEnabled: enabled,
      constraints: [...existingConstraints, ...newRules],
    };

    if (dry_run) {
      await recordAuditFields(supabaseAdmin, requestId, {
        operation: 'upsert',
        resource_type: 'brand_kit_governance',
        resource_id: null,
        before_state: beforeRow,
        after_state: { ...(beforeRow && typeof beforeRow === 'object' ? beforeRow : {}), writing_constraints: mergedWrapper },
        was_dry_run: true,
      });
      return dryRunPreview('brand_kit_governance.writing_constraints', beforeWc, mergedWrapper);
    }

    const { error } = await supabaseAdmin
      .from('brand_kit_governance')
      .upsert({ brand_kit_id, writing_constraints: mergedWrapper }, { onConflict: 'brand_kit_id' });
    if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", tool: "set_platform_specific_rules", retryable: true });

    const { data: updated } = await supabaseAdmin.from('brand_kit_governance').select('*').eq('brand_kit_id', brand_kit_id).maybeSingle();
    await recordAuditFields(supabaseAdmin, requestId, {
      operation: 'upsert',
      resource_type: 'brand_kit_governance',
      resource_id: null,
      before_state: beforeRow,
      after_state: updated,
      was_dry_run: false,
    });
    await log("info", "set_platform_specific_rules done");
    return { content: [{ type: "text", text: JSON.stringify({ success: true, data: normalizeGovernanceForRead(updated) }, null, 2) }] };
  },
};
