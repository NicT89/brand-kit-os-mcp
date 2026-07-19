// Canonical mapping from brand-kit section to the tools that read,
// preview, and write it. Surfaced via the `list_brand_kit_tools` MCP tool so
// agents can discover all tools for a section in one call instead of running
// multiple tool_search queries.
//
// When adding a new tool, update the matching section entry below.

export type SectionToolGroup = {
  read?: string[];
  preview?: string[];
  write?: string[];
  generate?: string[];
};

export type BrandKitSectionToolMap = Record<string, SectionToolGroup>;

export function buildBrandKitSectionToolMap(): BrandKitSectionToolMap {
  return {
    core: {
      read: ["get_brand_kit_core"],
      preview: ["preview_brand_kit_core_update"],
      write: ["upsert_brand_kit_core"],
    },
    personality: {
      read: ["get_brand_kit_personality"],
      preview: ["preview_brand_kit_personality_update"],
      write: ["upsert_brand_kit_personality"],
    },
    expression: {
      read: ["get_brand_kit_expression"],
      preview: ["preview_brand_kit_expression_update"],
      write: ["upsert_brand_kit_expression"],
    },
    governance: {
      read: ["get_brand_kit_governance", "list_compliance_standards", "get_disclosure_diligence_questions"],
      preview: ["preview_brand_kit_governance_update"],
      write: ["upsert_brand_kit_governance", "set_platform_specific_rules"],
      generate: ["generate_disclosure_statement"],
    },
    products: {
      read: ["get_brand_kit_products"],
      write: ["create_brand_kit_product", "update_brand_kit_product", "delete_brand_kit_product"],
    },
    audience: {
      read: ["get_brand_kit_audience"],
      preview: ["preview_generate_audience_persona"],
      write: ["create_audience_persona", "update_audience_persona", "delete_audience_persona"],
      generate: ["generate_audience_persona"],
    },
    personas: {
      read: ["list_brand_kit_personas", "get_brand_kit_personas", "get_persona_system_prompt"],
      preview: ["preview_generate_ai_persona"],
      write: ["create_brand_kit_persona", "update_ai_persona", "delete_brand_kit_persona"],
      generate: ["generate_ai_persona"],
    },
    competitors: {
      read: ["get_brand_kit_competitors"],
      write: ["create_brand_kit_competitor", "update_brand_kit_competitor", "delete_brand_kit_competitor"],
    },
    seo: {
      read: ["get_brand_kit_seo"],
      write: ["upsert_brand_kit_seo"],
    },
    expression_examples: {
      read: ["list_expression_examples"],
      write: ["create_expression_example", "update_expression_example", "delete_expression_example"],
    },
    logos: {
      read: ["list_logo_assets", "get_logo_asset", "get_brand_kit_logo_assets"],
      write: ["update_logo_asset", "delete_logo_asset"],
    },
    knowledge_files: {
      read: ["list_knowledge_files", "get_knowledge_file"],
      write: ["upload_knowledge_file", "delete_knowledge_file"],
    },
    root: {
      read: ["get_agent_briefing", "list_brand_kits", "get_brand_kit", "get_brand_kit_summary", "get_brand_kit_completeness", "get_brand_context_for_agent", "get_write_history"],
      write: ["update_brand_kit", "batch_upsert"],
    },
    visuals: {
      read: ["get_brand_kit_visuals"],
      write: ["update_brand_kit_visuals"],
    },
    social_profiles: {
      read: ["get_brand_kit_social_profiles"],
      write: ["request_social_profile_scrape"],
    },

    archetypes: {
      read: ["list_library_archetypes", "get_library_archetype"],
    },
    platforms: {
      read: ["list_governance_platforms"],
    },
  };
}
