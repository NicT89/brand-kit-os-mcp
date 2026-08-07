import { toolError } from "./tool-errors.ts";

// Competitor tool helpers — enforce the dry_run → confirm → write workflow and
// validate the shape of visual-identity fields server-side.
export function requireCompetitorConfirmation(args: Record<string, unknown>) {
  if (args?.dry_run === true && args?.confirm === true) {
    return toolError(
      "dry_run and confirm cannot both be true. Use dry_run: true to preview, or confirm: true to commit — never both in the same call.",
      {
        code: "validation_error",
        recovery:
          "dry_run and confirm are mutually exclusive. Send exactly one of: {dry_run: true, ...args} for a preview, or {confirm: true, ...args} (with dry_run omitted) to write.",
      },
    );
  }
  if (args?.dry_run === true) return null;
  if (args?.confirm !== true) {
    return toolError(
      "Confirmation required. Call this tool with dry_run: true first, present the preview to the user, then resubmit with confirm: true to execute the write.",
      {
        code: "confirmation_required",
        recovery:
          "1) Re-invoke with the same arguments plus dry_run: true. 2) Show the returned preview to the user. 3) After explicit user approval, re-invoke with confirm: true (and dry_run omitted or false).",
      },
    );
  }
  return null;
}

function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function nonEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).length > 0;
}

export function hasMeaningfulScrapedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulScrapedValue(item));
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length > 0 && entries.some((entry) => hasMeaningfulScrapedValue(entry));
  }
  return true;
}

export function validateCompetitorVisualIdentity(args: Record<string, unknown>) {
  const hasSignal =
    nonEmptyArray(args.brand_colors) ||
    nonEmptyArray(args.fonts) ||
    nonEmptyString(args.tagline) ||
    nonEmptyArray(args.value_propositions) ||
    nonEmptyString(args.color_scheme) ||
    nonEmptyString(args.design_framework) ||
    nonEmptyObject(args.brand_personality) ||
    nonEmptyObject(args.typography) ||
    nonEmptyObject(args.button_styles) ||
    nonEmptyObject(args.spacing) ||
    nonEmptyArray(args.social_profiles);
  if (!hasSignal) {
    return toolError(
      "At least one visual-identity field must be populated (brand_colors, fonts, tagline, value_propositions, color_scheme, design_framework, brand_personality, typography, button_styles, spacing, or social_profiles). Scrape the competitor URL before calling and pass what you found.",
      { code: "validation_error" },
    );
  }
  return null;
}

export function validateCompetitorOptionalShapes(fields: Record<string, unknown>) {
  const arrayFields = ["value_propositions", "brand_colors", "fonts"];
  for (const k of arrayFields) {
    if (fields[k] !== undefined && !Array.isArray(fields[k])) {
      return toolError(`Field '${k}' must be an array.`, { code: "validation_error" });
    }
  }
  const objectFields = ["brand_personality", "typography", "button_styles", "spacing"];
  for (const k of objectFields) {
    if (fields[k] !== undefined && (typeof fields[k] !== "object" || fields[k] === null || Array.isArray(fields[k]))) {
      return toolError(`Field '${k}' must be an object.`, { code: "validation_error" });
    }
  }
  const stringFields = ["name", "url", "description", "tagline", "color_scheme", "design_framework"];
  for (const k of stringFields) {
    if (fields[k] !== undefined && typeof fields[k] !== "string") {
      return toolError(`Field '${k}' must be a string.`, { code: "validation_error" });
    }
  }
  if (fields.social_profiles !== undefined) {
    if (!Array.isArray(fields.social_profiles)) {
      return toolError("Field 'social_profiles' must be an array.", { code: "validation_error" });
    }
    for (const [i, entry] of (fields.social_profiles as unknown[]).entries()) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !nonEmptyString((entry as Record<string, unknown>).platform) ||
        !nonEmptyString((entry as Record<string, unknown>).url)
      ) {
        return toolError(
          `social_profiles[${i}] must be an object with non-empty 'platform' and 'url' strings.`,
          { code: "validation_error" },
        );
      }
    }
  }
  return null;
}
