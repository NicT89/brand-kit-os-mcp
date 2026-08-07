// Tests for create_brand_kit_competitor and update_brand_kit_competitor.
//
// We import the live module to assert on:
//   1. The exported `tools` catalog (schema & description contents).
//   2. The exported validation/confirmation helpers (pure logic).
//
// We do NOT exercise the DB write path here — that would require service-role
// credentials and a seeded brand kit. The execute path is covered indirectly:
// the helpers are the only validation surface the case-blocks use before the
// DB call, and the case-blocks themselves are exercised in
// scripts/test-mcp-server-curl.sh against deployed environments.
import { assert, assertEquals, assertExists } from "../_shared/asserts.ts";
import {
  hasMeaningfulScrapedValue,
  requireCompetitorConfirmation,
  validateCompetitorOptionalShapes,
  validateCompetitorVisualIdentity,
} from "./competitor-validation.ts";
import { tools } from "./tools-catalog.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

function getTool(name: string) {
  const t = tools.find((x: { name: string }) => x.name === name);
  assertExists(t, `tool ${name} should exist in catalog`);
  return t as unknown as {
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, { type?: string; description?: string; items?: unknown; properties?: Record<string, unknown> }>;
      required?: string[];
    };
  };
}

Deno.test("create_brand_kit_competitor schema exposes new writable fields", opts, () => {
  const t = getTool("create_brand_kit_competitor");
  for (const f of ["social_profiles", "typography", "button_styles", "spacing", "confirm"]) {
    assertExists(t.inputSchema.properties[f], `missing input property: ${f}`);
  }
  assertEquals(t.inputSchema.properties.social_profiles.type, "array");
  assertEquals(t.inputSchema.properties.typography.type, "object");
  assertEquals(t.inputSchema.properties.button_styles.type, "object");
  assertEquals(t.inputSchema.properties.spacing.type, "object");
  assertEquals(t.inputSchema.properties.confirm.type, "boolean");
});

Deno.test("update_brand_kit_competitor schema exposes new writable fields", opts, () => {
  const t = getTool("update_brand_kit_competitor");
  for (const f of ["social_profiles", "typography", "button_styles", "spacing", "confirm"]) {
    assertExists(t.inputSchema.properties[f], `missing input property: ${f}`);
  }
});

Deno.test("both tool descriptions document the dry_run + confirm contract and include an example payload", opts, () => {
  for (const name of ["create_brand_kit_competitor", "update_brand_kit_competitor"]) {
    const t = getTool(name);
    assert(t.description.includes("dry_run"), `${name} description should mention dry_run`);
    assert(t.description.includes("confirm: true"), `${name} description should mention confirm: true`);
    assert(t.description.includes("Example payload"), `${name} description should include an example payload`);
    assert(
      t.description.includes("social_profiles") &&
        t.description.includes("typography") &&
        t.description.includes("button_styles") &&
        t.description.includes("spacing"),
      `${name} description should reference all new fields`,
    );
  }
});

Deno.test("requireCompetitorConfirmation allows dry_run without confirm", opts, () => {
  assertEquals(requireCompetitorConfirmation({ dry_run: true }), null);
});

Deno.test("requireCompetitorConfirmation rejects writes without confirm", opts, () => {
  const err = requireCompetitorConfirmation({ dry_run: false });
  assertExists(err);
  const text = JSON.stringify(err);
  assert(text.includes("confirmation_required"), `expected confirmation_required, got ${text}`);
});

Deno.test("requireCompetitorConfirmation rejects when confirm is not boolean true", opts, () => {
  assertExists(requireCompetitorConfirmation({ confirm: "true" }));
  assertExists(requireCompetitorConfirmation({ confirm: 1 }));
  assertExists(requireCompetitorConfirmation({}));
});

Deno.test("requireCompetitorConfirmation allows writes with confirm: true", opts, () => {
  assertEquals(requireCompetitorConfirmation({ confirm: true }), null);
  assertEquals(requireCompetitorConfirmation({ dry_run: false, confirm: true }), null);
});

Deno.test("requireCompetitorConfirmation rejects dry_run + confirm passed together", opts, () => {
  const err = requireCompetitorConfirmation({ dry_run: true, confirm: true });
  assertExists(err);
  const text = JSON.stringify(err);
  assert(text.includes("validation_error"), `expected validation_error, got ${text}`);
  assert(text.includes("mutually exclusive"), `expected 'mutually exclusive' in recovery, got ${text}`);
});

Deno.test("validateCompetitorVisualIdentity rejects bare URL submissions", opts, () => {
  const err = validateCompetitorVisualIdentity({ brand_kit_id: "x", url: "https://x.com" });
  assertExists(err);
});

Deno.test("validateCompetitorVisualIdentity rejects empty arrays / objects / strings", opts, () => {
  assertExists(
    validateCompetitorVisualIdentity({
      brand_colors: [],
      fonts: [],
      tagline: "",
      value_propositions: [],
      typography: {},
      button_styles: {},
      spacing: {},
      social_profiles: [],
    }),
  );
});

Deno.test("validateCompetitorVisualIdentity accepts any single populated visual signal", opts, () => {
  assertEquals(validateCompetitorVisualIdentity({ brand_colors: ["#000"] }), null);
  assertEquals(validateCompetitorVisualIdentity({ fonts: ["Inter"] }), null);
  assertEquals(validateCompetitorVisualIdentity({ tagline: "x" }), null);
  assertEquals(validateCompetitorVisualIdentity({ typography: { heading: "Inter" } }), null);
  assertEquals(
    validateCompetitorVisualIdentity({ social_profiles: [{ platform: "x", url: "https://x.com" }] }),
    null,
  );
});

Deno.test("validateCompetitorOptionalShapes rejects wrong-typed arrays", opts, () => {
  assertExists(validateCompetitorOptionalShapes({ brand_colors: "red" }));
  assertExists(validateCompetitorOptionalShapes({ fonts: { Inter: true } }));
  assertExists(validateCompetitorOptionalShapes({ value_propositions: "fast" }));
});

Deno.test("validateCompetitorOptionalShapes rejects wrong-typed objects", opts, () => {
  assertExists(validateCompetitorOptionalShapes({ typography: "Inter" }));
  assertExists(validateCompetitorOptionalShapes({ button_styles: [] }));
  assertExists(validateCompetitorOptionalShapes({ spacing: null }));
  assertExists(validateCompetitorOptionalShapes({ brand_personality: 42 }));
});

Deno.test("validateCompetitorOptionalShapes rejects malformed social_profiles entries", opts, () => {
  assertExists(validateCompetitorOptionalShapes({ social_profiles: "linkedin" }));
  assertExists(validateCompetitorOptionalShapes({ social_profiles: [{ platform: "linkedin" }] }));
  assertExists(validateCompetitorOptionalShapes({ social_profiles: [{ url: "https://x.com" }] }));
  assertExists(validateCompetitorOptionalShapes({ social_profiles: [{ platform: "", url: "" }] }));
});

Deno.test("validateCompetitorOptionalShapes accepts well-formed payloads", opts, () => {
  assertEquals(
    validateCompetitorOptionalShapes({
      name: "Example",
      brand_colors: ["#000"],
      fonts: ["Inter"],
      typography: { heading: "Inter 600 48px" },
      button_styles: { background_color: "#000" },
      spacing: { base_unit: "8px" },
      social_profiles: [{ platform: "linkedin", url: "https://linkedin.com/company/x" }],
    }),
    null,
  );
  assertEquals(validateCompetitorOptionalShapes({}), null);
});

Deno.test("hasMeaningfulScrapedValue rejects empty scraped payloads", opts, () => {
  assertEquals(hasMeaningfulScrapedValue([]), false);
  assertEquals(hasMeaningfulScrapedValue([""]), false);
  assertEquals(hasMeaningfulScrapedValue({}), false);
  assertEquals(
    hasMeaningfulScrapedValue({
      heading: null,
      body: "   ",
    }),
    false,
  );
});

Deno.test("hasMeaningfulScrapedValue keeps non-empty scraped values", opts, () => {
  assertEquals(hasMeaningfulScrapedValue(["#123456"]), true);
  assertEquals(hasMeaningfulScrapedValue({ heading: "Inter 600 48px" }), true);
  assertEquals(hasMeaningfulScrapedValue({ dark_mode_support: false }), true);
});
