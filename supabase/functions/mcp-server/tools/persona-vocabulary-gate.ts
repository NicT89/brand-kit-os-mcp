import { toolError } from "../tool-errors.ts";
import {
  buildVocabularyReport,
  effectiveVocabularies,
  loadLibraryIndustryNames,
  loadVocabularySnapshot,
  PERSONA_VOCABULARIES,
  persistNewIndustryNames,
  splitCompositeValue,
  suggestOptions,
  validatePersonaPayloadWithLibrary,
  type VocabularyError,
  type VocabularyResult,
} from "../../_shared/persona-vocabulary.ts";

import { COMPANY_SIZE_VALUES, REVENUE_RANGE_VALUES } from "../../_shared/company-profile-schema.ts";


/**
 * Vocabulary guardrail shared by create_audience_persona / update_audience_persona.
 *
 * Every controlled persona field is resolved against the same option lists the
 * UI renders, so an MCP write can never produce a selection a user could not
 * have made by hand. Open vocabularies (industry) may grow, and new values are
 * persisted to the shared library so later calls reuse them.
 */

/** Distinct industry names already in the shared library. */
// deno-lint-ignore no-explicit-any
export async function loadLibraryIndustries(supabaseAdmin: any): Promise<string[]> {
  return await loadLibraryIndustryNames(supabaseAdmin);
}


export function vocabularyToolError(errors: VocabularyError[]) {
  const summary = errors.map((e) => `${e.field}: ${e.reason}`).join(" ");
  return toolError(`Rejected ${errors.length} value(s) that are not valid selections. ${summary}`, {
    code: "validation_error",
    recovery:
      "Call list_persona_field_options to see the accepted values for each field, then re-send one canonical value per array entry. Never combine several concepts into a single entry, and move sector/industry descriptions out of company_type.",
    data: {
      invalid_values: errors,
      field_guidance: PERSONA_VOCABULARIES.map((v) => ({
        field: `${v.parent}.${v.field}`,
        mode: v.mode,
        guidance: v.guidance,
      })),
    },
  });
}

/** Persist newly-discovered industries so the next MCP call can reuse them. */
export async function persistNewIndustries(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  names: string[],
  userId: string,
): Promise<string[]> {
  return await persistNewIndustryNames(supabaseAdmin, names, userId);
}


export interface VocabularyGateOutcome {
  /** Present when the write must be rejected. */
  error?: ReturnType<typeof toolError>;
  result?: VocabularyResult;
}

/** Validate a persona payload; returns a tool error when any value is invalid. */
export async function applyPersonaVocabularyGate(
  payload: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
): Promise<VocabularyGateOutcome> {
  const result = await validatePersonaPayloadWithLibrary(payload, supabaseAdmin);
  if (result.errors.length > 0) return { error: vocabularyToolError(result.errors), result };
  return { result };
}


export { buildVocabularyReport };


/**
 * Company-profile equivalent of the persona gate. Only `company_size` and
 * `revenue_range` are vocabulary-controlled; both are closed lists, so prose and
 * combined entries are split, matched, or rejected with the allowed options.
 */
export async function applyCompanyProfileVocabularyGate(
  payload: Record<string, unknown>,
  supabaseAdmin: any,
): Promise<VocabularyGateOutcome> {
  const touches = payload.company_size !== undefined || payload.revenue_range !== undefined;
  if (!touches) {
    return { result: { payload, normalizations: [], errors: [], newLibraryValues: { industry: [] } } };
  }

  const snapshot = await loadVocabularySnapshot(supabaseAdmin);
  const sizeOptions = effectiveVocabularies(snapshot).find((v) => v.field === "company_size")?.options
    ?? COMPANY_SIZE_VALUES;

  const result: VocabularyResult = {
    payload: { ...payload },
    normalizations: [],
    errors: [],
    newLibraryValues: { industry: [] },
  };

  const resolveClosed = (
    field: string,
    label: string,
    raw: unknown,
    options: readonly string[],
    guidance: string,
  ): string[] => {
    const inputs = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const out: string[] = [];
    for (const input of inputs) {
      const parts = splitCompositeValue(input);
      if (parts.length > 1) {
        result.normalizations.push(`${label}: split "${input}" into ${parts.length} separate selections`);
      }
      for (const part of parts) {
        const match = options.find((o) => o.toLowerCase() === part.trim().toLowerCase());
        if (match) {
          if (match !== part.trim()) result.normalizations.push(`${label}: "${part}" → "${match}"`);
          out.push(match);
          continue;
        }
        result.errors.push({
          field,
          value: part,
          reason: `"${part}" is not one of the accepted ${label} options. ${guidance}`,
          allowed_values: options,
          suggestions: suggestOptions(part, options),
        });
      }
    }
    return Array.from(new Set(out));
  };

  if (payload.company_size !== undefined && payload.company_size !== null && payload.company_size !== "") {
    result.payload.company_size = resolveClosed(
      "company_size",
      "Company Size",
      payload.company_size,
      sizeOptions,
      "Use employee-count brackets, one per entry — prose like 'small to large brands' is not accepted.",
    );
  }

  if (payload.revenue_range !== undefined && payload.revenue_range !== null && payload.revenue_range !== "") {
    const resolved = resolveClosed(
      "revenue_range",
      "Revenue Range",
      payload.revenue_range,
      REVENUE_RANGE_VALUES,
      "Use a single revenue bracket.",
    );
    result.payload.revenue_range = resolved[0] ?? "";
  }

  if (result.errors.length > 0) return { error: vocabularyToolError(result.errors), result };
  return { result };
}

