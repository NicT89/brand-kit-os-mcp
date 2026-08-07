/**
 * Deno-side mirror of src/features/brand-kit/expression/style-dialog/normalizeSlotShape.ts.
 * Coerces legacy slot key shapes into canonical `slot_1 … slot_5`.
 *
 * Accepts:
 *   - { slot_1, slot_2, ... }                              (canonical)
 *   - { verbal_style_1, ... } or { visual_style_1, ... }   (legacy per-prefix)
 *   - { name, ... }                                        (flat single template → slot_1)
 */
export type SlotShapePrefix = "visual_style" | "verbal_style";

function looksLikeTemplate(obj: Record<string, unknown>): boolean {
  return (
    "name" in obj ||
    "aesthetic" in obj ||
    "sentence_structure" in obj ||
    "photography" in obj ||
    "grammar_preferences" in obj
  );
}

export function normalizeSlotShapeForWrite(
  raw: unknown,
  prefix: SlotShapePrefix,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  let hasAny = false;
  for (let i = 1; i <= 5; i++) {
    const canonical = source[`slot_${i}`];
    const legacy = source[`${prefix}_${i}`];
    const value = canonical ?? legacy;
    if (value !== undefined && value !== null) {
      out[`slot_${i}`] = value;
      hasAny = true;
    }
  }

  if (!hasAny && looksLikeTemplate(source)) {
    out.slot_1 = source;
  }

  return out;
}
