/**
 * Defensively coerce a JSONB value into an array.
 *
 * Some legacy brand-kit fields (e.g. `writing_constraints`) are stored as
 * either an array, an object with preferences, or an object that wraps an
 * inner `constraints` array. `((x as any[]) || []).slice(...)` blows up
 * with "(...).slice is not a function" the moment the value is not the
 * shape we hoped for. This helper normalizes all of those shapes so the
 * caller can always `.slice` / `.map` without crashing.
 */
export function toJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>).constraints;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/** JSONB array fields on brand_kit_governance that MCP tools treat as arrays. */
const GOVERNANCE_ARRAY_FIELDS = [
  "behavioral_constraints",
  "drift_prevention_prompts",
  "compliance_selections",
] as const;


/**
 * Normalize governance JSONB at read boundaries so MCP consumers always
 * receive arrays for constraint-like fields regardless of legacy DB shapes.
 */
export function normalizeGovernanceForRead<T extends Record<string, unknown> | null | undefined>(
  row: T,
): T {
  if (!row || typeof row !== "object") return row;
  const normalized = { ...row } as Record<string, unknown>;
  for (const field of GOVERNANCE_ARRAY_FIELDS) {
    if (field in normalized) {
      normalized[field] = toJsonArray(normalized[field]);
    }
  }
  if ("writing_constraints" in normalized) {
    normalized.writing_constraints = normalizeWritingConstraintsForRead(normalized.writing_constraints);
  }
  if ("negative_directory" in normalized) {
    normalized.negative_directory = normalizeNegativeDirectoryForRead(normalized.negative_directory);
  }
  return normalized as T;
}

/**
 * Read-boundary normalizer for `writing_constraints` (G-3). Unlike the other
 * governance array fields, the UI persists a *wrapper* object
 * `{ constraints: [...], platformSpecificEnabled?: boolean, preferences?: {...} }`.
 * Earlier MCP reads ran `toJsonArray()` and returned only the inner
 * `constraints[]`, silently dropping the wrapper keys (and the
 * `platformSpecificEnabled` flag). Return the full object so agents can
 * round-trip it, while still guaranteeing `constraints` is an array.
 */
export function normalizeWritingConstraintsForRead(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return { constraints: value };
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return { ...obj, constraints: toJsonArray(obj.constraints !== undefined ? obj.constraints : obj) };
  }
  return { constraints: [] };
}

/**
 * Negative directory canonical shape (matches `EnhancedNegativeDirectoryCard`):
 *   Array<{ id, term, category, platform_context?, reason?, source? }>
 *
 * Accepts and normalizes:
 *  - Already-canonical array of objects with `term` → passthrough.
 *  - Legacy `{ forbidden_words: string[], forbidden_phrases: string[] }` produced by
 *    earlier MCP calls → expanded into typed items.
 *  - Legacy `{ words, topics, imagery }` keys → mapped to categories.
 *  - Bare array of strings → `{term, category: 'other'}` items.
 *  - null/undefined/garbage → `[]`.
 */
type NegativeDirectoryCategory =
  | "marketing_speak"
  | "pretentious"
  | "sales_language"
  | "jargon"
  | "offensive"
  | "other";

interface NegativeDirectoryRow {
  id: string;
  term: string;
  category: NegativeDirectoryCategory;
  platform_context?: string;
  reason?: string;
  source?: string;
}

function makeNegativeDirectoryItem(
  term: string,
  category: NegativeDirectoryCategory,
  extra: Partial<NegativeDirectoryRow> = {},
): NegativeDirectoryRow {
  return {
    id: extra.id || crypto.randomUUID(),
    term,
    category,
    platform_context: extra.platform_context,
    reason: extra.reason,
    source: extra.source || "mcp_import",
  };
}

export function normalizeNegativeDirectoryForRead(value: unknown): NegativeDirectoryRow[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map((item) => {
        if (typeof item === "string") {
          const t = item.trim();
          return t ? makeNegativeDirectoryItem(t, "other") : null;
        }
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const term = typeof obj.term === "string" ? obj.term.trim() : "";
          if (!term) return null;
          const cat = (typeof obj.category === "string" ? obj.category : "other") as NegativeDirectoryCategory;
          return makeNegativeDirectoryItem(term, cat, {
            id: typeof obj.id === "string" ? obj.id : undefined,
            platform_context: typeof obj.platform_context === "string"
              ? obj.platform_context
              : (typeof obj.platformContext === "string" ? (obj.platformContext as string) : undefined),
            reason: typeof obj.reason === "string" ? obj.reason : undefined,
            source: typeof obj.source === "string" ? obj.source : undefined,
          });
        }
        return null;
      })
      .filter(Boolean) as NegativeDirectoryRow[];
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: NegativeDirectoryRow[] = [];
    const pushAll = (arr: unknown, category: NegativeDirectoryCategory) => {
      if (!Array.isArray(arr)) return;
      for (const v of arr as unknown[]) {
        const t = typeof v === "string" ? v.trim() : "";
        if (t) out.push(makeNegativeDirectoryItem(t, category));
      }
    };
    pushAll(obj.forbidden_words, "offensive");
    pushAll(obj.forbidden_phrases, "marketing_speak");
    pushAll(obj.words, "offensive");
    pushAll(obj.topics, "marketing_speak");
    pushAll(obj.imagery, "other");
    return out;
  }
  return [];
}

/** Mirror of read normalization for writes — always persist the canonical array shape. */
export function normalizeNegativeDirectoryForWrite(value: unknown): NegativeDirectoryRow[] {
  return normalizeNegativeDirectoryForRead(value);
}

function normalizeConstraintItem(item: unknown): Record<string, unknown> {
  if (typeof item === "string") return { rule: item };
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return item as Record<string, unknown>;
  }
  return { rule: String(item) };
}

/**
 * Mirror of `toJsonArray` for the write side: shape any agent-supplied
 * `writing_constraints` payload into the canonical
 * `{ constraints: [...], preferences?: {...} }` form required by the
 * `brand_kit_governance_writing_constraints_wrapped_check` DB constraint.
 *
 * Accepts: null/undefined (passthrough), strings, bare arrays of strings or
 * objects, `{constraints: [...]}` (canonical), `{rules: [...]}` (common
 * AI mis-shape), or any other JSON object (treated as preferences).
 */
export function wrapWritingConstraintsForWrite(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return { constraints: [{ rule: value }] };
  if (Array.isArray(value)) return { constraints: value.map(normalizeConstraintItem) };
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.constraints)) {
      return { ...obj, constraints: (obj.constraints as unknown[]).map(normalizeConstraintItem) };
    }
    if (Array.isArray((obj as { rules?: unknown[] }).rules)) {
      const { rules, preferences: existingPreferences, ...rest } = obj as { rules: unknown[]; preferences?: Record<string, unknown> } & Record<string, unknown>;
      // Merge any caller-supplied `preferences` with the remaining top-level
      // keys so we don't double-nest as `{ preferences: { preferences: {...} } }`.
      const mergedPreferences = {
        ...(existingPreferences && typeof existingPreferences === "object" && !Array.isArray(existingPreferences) ? existingPreferences : {}),
        ...rest,
      };
      const preferencesKey = Object.keys(mergedPreferences).length > 0 ? { preferences: mergedPreferences } : {};
      return { constraints: rules.map(normalizeConstraintItem), ...preferencesKey };
    }
    return { constraints: [], preferences: obj };
  }
  return { constraints: [{ rule: String(value) }] };
}

/**
 * Write-boundary normalizer for `preferred_terminology` (E-3). Canonical
 * storage is an array `[{ term, instead_of: string[], description: string }]`.
 * Accepts:
 *  - canonical array → passthrough with defaults filled.
 *  - legacy `{ prefer: string[], avoid: string[] }` object → each `prefer`
 *    term becomes `{ term, instead_of: [], description: "" }`; each `avoid`
 *    term becomes `{ term, instead_of: [], description: "Avoid — do not use" }`.
 *  - null/undefined → passthrough.
 */
export function wrapTerminologyForWrite(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        return {
          term: typeof obj.term === "string" ? obj.term : String(obj.term ?? ""),
          instead_of: Array.isArray(obj.instead_of)
            ? (obj.instead_of as unknown[]).filter((t): t is string => typeof t === "string")
            : [],
          description: typeof obj.description === "string" ? obj.description : "",
        };
      }
      return { term: typeof item === "string" ? item : String(item), instead_of: [], description: "" };
    });
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Array<Record<string, unknown>> = [];
    if (Array.isArray(obj.prefer)) {
      for (const t of obj.prefer as unknown[]) {
        if (typeof t === "string" && t.trim()) out.push({ term: t.trim(), instead_of: [], description: "" });
      }
    }
    if (Array.isArray(obj.avoid)) {
      for (const t of obj.avoid as unknown[]) {
        if (typeof t === "string" && t.trim()) out.push({ term: t.trim(), instead_of: [], description: "Avoid — do not use" });
      }
    }
    return out;
  }
  return value;
}
