/**
 * Canonical MCP field shapes and agent guidance aligned with the Brand Kit OS UI.
 * Used by mcp-server completeness, tool descriptions, and fill-brand-gaps prompts.
 */

export interface McpFieldMeta {
  type: string;
  example: unknown;
  guidance: string;
  upsert_tool: string;
  preview_tool: string;
}

export const MCP_PREVIEW_BY_UPSERT: Record<string, string> = {
  upsert_brand_kit_core: "preview_brand_kit_core_update",
  upsert_brand_kit_personality: "preview_brand_kit_personality_update",
  upsert_brand_kit_expression: "preview_brand_kit_expression_update",
  upsert_brand_kit_governance: "preview_brand_kit_governance_update",
  update_brand_kit: "update_brand_kit",
  update_brand_kit_visuals: "update_brand_kit_visuals",
};

export const MCP_FIELD_REGISTRY: Record<string, McpFieldMeta> = {
  tagline: {
    type: "string",
    example: "Ship faster with clarity",
    guidance: "Single headline tagline on the brand kit overview (not contextual taglines in Core).",
    upsert_tool: "update_brand_kit",
    preview_tool: "update_brand_kit",
  },
  description: {
    type: "string",
    example: "A SaaS platform that helps teams manage brand identity in one place.",
    guidance: "Short overview of what the brand does and who it serves.",
    upsert_tool: "update_brand_kit",
    preview_tool: "update_brand_kit",
  },
  brand_voice: {
    type: "string",
    example: "Confident and approachable",
    guidance: "One-line voice summary stored on the brand kit; also editable under Expression as Voice & Tone Guidelines.",
    upsert_tool: "upsert_brand_kit_expression",
    preview_tool: "preview_brand_kit_expression_update",
  },
  mission: {
    type: "string",
    example: "To make professional brand management accessible to every business",
    guidance: "Mission statement: why the company exists today.",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  vision: {
    type: "string",
    example: "A world where every brand communicates with clarity and consistency",
    guidance: "Vision statement: the future state the brand is working toward.",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  brand_story: {
    type: "object",
    example: {
      origin_story: "Founded when...",
      founder_story: "The founder noticed...",
      customer_stories: [{ title: "Acme Corp", story: "They reduced time-to-ship by 40%..." }],
      future_story: "We are building toward...",
    },
    guidance: "Structured story with origin, founder, customer_stories (title + story), and future. Not a single paragraph.",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  brand_promises: {
    type: "array",
    example: [{ title: "Customer First", description: "We prioritize your needs in every decision." }],
    guidance: "Array of promises. UI labels: Title and Description (not primary/secondary).",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  taglines: {
    type: "array",
    example: [{ tagline: "Just Ship It", use_when: "Product launches and release notes" }],
    guidance: "Contextual taglines array. UI labels: Tagline and Use When (not primary/alternatives).",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  storytelling_elements: {
    type: "object",
    example: {
      origin_story_summary: "Founded in 2020...",
      key_milestones: ["Series A", "10k users"],
      recurring_themes: ["Empowerment"],
      brand_metaphors: ["Your brand compass"],
      hero_narrative: "The customer is the hero",
      transformation_arc: "From overwhelmed to empowered",
      founder_voice_notes: "",
    },
    guidance: "Narrative framework fields for long-form brand storytelling.",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  industry_classification: {
    type: "object",
    example: {
      primary: { id: "saas-b2b", name: "SaaS — B2B", slug: "saas-b2b" },
      secondary: [{ id: "fintech", name: "Fintech", slug: "fintech" }],
    },
    guidance: "Industry taxonomy used for prompt tuning and benchmarks. `primary` is required; `secondary` is an optional array of additional industries. Source taxonomy: industry_classifications table.",
    upsert_tool: "upsert_brand_kit_core",
    preview_tool: "preview_brand_kit_core_update",
  },
  personality_traits: {
    type: "array",
    example: [{ title: "Bold", description: "Takes clear stances without hedging.", tags: ["voice"] }],
    guidance: "Each trait needs title; optional description and tags. No strength score field.",
    upsert_tool: "upsert_brand_kit_personality",
    preview_tool: "preview_brand_kit_personality_update",
  },
  brand_values: {
    type: "array",
    example: [{ name: "Transparency", description: "We communicate openly with customers." }],
    guidance: "Each value needs name; optional description.",
    upsert_tool: "upsert_brand_kit_personality",
    preview_tool: "preview_brand_kit_personality_update",
  },
  brand_principles: {
    type: "array",
    example: [{ name: "Lead with value", action: "Start every piece with the reader benefit.", tags: ["content"], use_case: "Blog posts" }],
    guidance: "Use name and action (not title/description). Optional tags and use_case.",
    upsert_tool: "upsert_brand_kit_personality",
    preview_tool: "preview_brand_kit_personality_update",
  },
  brand_moods: {
    type: "array",
    example: [{ name: "Energetic", emotional_description: "Upbeat and forward-moving", visual_descriptor: "Bright accents", associated_tone: "Direct" }],
    guidance: "Each mood needs name; optional emotional_description, visual_descriptor, associated_tone.",
    upsert_tool: "upsert_brand_kit_personality",
    preview_tool: "preview_brand_kit_personality_update",
  },
  tone_of_voice: {
    type: "object",
    example: {
      description: "Direct and warm peer voice.",
      attributes: [{ attribute: "Formal ↔ Casual", min_label: "Formal", max_label: "Casual", value: 70 }],
    },
    guidance: "Object with description and attributes array (attribute, min_label, max_label, value 0–100). Not primary/secondary strings.",
    upsert_tool: "upsert_brand_kit_expression",
    preview_tool: "preview_brand_kit_expression_update",
  },
  tone_dimensions: {
    type: "object",
    example: { formality: 70, energy: 65, warmth: 55, confidence: 80, complexity: 40 },
    guidance: "Sliders 0–100 for formality, energy, warmth, confidence, complexity (not formal_casual keys).",
    upsert_tool: "upsert_brand_kit_expression",
    preview_tool: "preview_brand_kit_expression_update",
  },
  voice_archetypes: {
    type: "object",
    example: {
      primary: { name: "The Builder", description: "Hands-on problem solver", characteristics: ["practical", "direct"] },
      secondary: { name: "The Guide", description: "Supportive expert", characteristics: ["patient"] },
      antiArchetypes: [],
    },
    guidance: "primary/secondary are objects with name, description, characteristics[]. antiArchetypes is an array of the same shape.",
    upsert_tool: "upsert_brand_kit_expression",
    preview_tool: "preview_brand_kit_expression_update",
  },
  verbal_style: {
    type: "object",
    example: { sentence_structure: "Short and punchy", vocabulary_level: "8th grade", punctuation_style: "Minimal" },
    guidance: "Flat verbal style fields or slot-packed templates in the app; prefer sentence_structure, vocabulary_level, punctuation_style for MCP.",
    upsert_tool: "upsert_brand_kit_expression",
    preview_tool: "preview_brand_kit_expression_update",
  },


  behavioral_constraints: {
    type: "array",
    example: ["Never make unverified claims", "Always disclose AI-generated content when required"],
    guidance: "Array of plain-string rules (not { rule, severity } objects).",
    upsert_tool: "upsert_brand_kit_governance",
    preview_tool: "preview_brand_kit_governance_update",
  },
  negative_directory: {
    type: "object",
    example: { forbidden_words: ["cheap", "easy"], forbidden_phrases: ["guaranteed results"] },
    guidance: "Words and phrases the brand must avoid.",
    upsert_tool: "upsert_brand_kit_governance",
    preview_tool: "preview_brand_kit_governance_update",
  },
  writing_constraints: {
    type: "object",
    example: {
      constraints: [
        { rule: "Sentences <= 18 words", applies_to: "all" },
        { rule: "No second-person pronouns in legal copy", applies_to: "legal" },
      ],
      preferences: { active_voice: true, readability_level: "grade 8" },
    },
    guidance: "Canonical shape: { constraints: [{ rule, applies_to? }, ...], preferences?: {...} }. The server auto-wraps legacy shapes (bare arrays, { rules: [...] }, flat key/value objects) into this form before write — the DB enforces the wrapped shape via brand_kit_governance_writing_constraints_wrapped_check.",
    upsert_tool: "upsert_brand_kit_governance",
    preview_tool: "preview_brand_kit_governance_update",
  },


  drift_prevention_prompts: {
    type: "array",
    example: [{ id: "dp-1", prompt: "Never sound overly salesy", category: "tone" }],
    guidance: "Each item: id, prompt, category (tone|content|style|ethics|custom). Optional source.",
    upsert_tool: "upsert_brand_kit_governance",
    preview_tool: "preview_brand_kit_governance_update",
  },
  keywords: {
    type: "array",
    example: [{ keyword: "brand management", volume: 1200 }],
    guidance: "SEO keywords for the brand kit.",
    upsert_tool: "upsert_brand_kit_seo",
    preview_tool: "upsert_brand_kit_seo",
  },
  primary_color: {
    type: "string",
    example: "#3B82F6",
    guidance: "Primary brand color hex.",
    upsert_tool: "update_brand_kit_visuals",
    preview_tool: "update_brand_kit_visuals",
  },
  heading_font: {
    type: "string",
    example: "Inter",
    guidance: "Heading typeface family name.",
    upsert_tool: "update_brand_kit_visuals",
    preview_tool: "update_brand_kit_visuals",
  },
  logo_url: {
    type: "string",
    example: "https://example.com/logo.png",
    guidance: "URL to the primary logo asset.",
    upsert_tool: "update_brand_kit_visuals",
    preview_tool: "update_brand_kit_visuals",
  },
};

export function getMcpFieldMeta(field: string, fallbackUpsertTool: string): {
  type: string;
  example: unknown;
  guidance: string;
  tool: string;
  preview_tool: string;
} {
  const meta = MCP_FIELD_REGISTRY[field];
  const upsert = meta?.upsert_tool ?? fallbackUpsertTool;
  return {
    type: meta?.type ?? "string",
    example: meta?.example ?? null,
    guidance: meta?.guidance ?? "Match the Brand Kit OS UI field shape for this section.",
    tool: upsert,
    preview_tool: meta?.preview_tool ?? MCP_PREVIEW_BY_UPSERT[upsert] ?? upsert,
  };
}

export const MCP_AGENT_HINTS = {
  scopes:
    "MCP keys use global scopes only: read, brand_kit:write (all sections), knowledge_files:write. There are no per-section scope toggles in Settings.",
  claude_approval:
    "If Claude shows 'No approval received', that is the Claude client blocking a write-classified tool — not a Brand Kit OS section permission. Use preview_* tools to diff without approval, then upsert_* after the user approves.",
  server_errors:
    "Brand Kit OS returns scope_denied (missing brand_kit:write), access_denied (not owner/admin on kit), validation_error, or db_error — never 'No approval received'.",
  workflow:
    "Recommended: get_brand_kit_completeness → preview_*_update → upsert_* with dry_run if supported → upsert_* commit after user approval.",
};

/** JSON schema fragment text for fill-brand-gaps and docs */
export function buildGapFillShapeHint(): string {
  return `Use these shapes (match the app UI):
- core.taglines: [{ "tagline": "...", "use_when": "..." }]
- core.brand_promises: [{ "title": "...", "description": "..." }]
- core.brand_story: { "origin_story", "founder_story", "customer_stories": [{ "title", "story" }], "future_story" }
- personality.personality_traits: [{ "title", "description", "tags"? }]
- personality.brand_principles: [{ "name", "action", "tags"?, "use_case"? }]
- expression.tone_dimensions: { "formality", "energy", "warmth", "confidence", "complexity" } (0-100 each)
- governance.behavioral_constraints: string[]`;
}

