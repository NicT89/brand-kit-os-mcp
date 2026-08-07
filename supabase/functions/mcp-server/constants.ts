import { MCP_SCOPES } from "../_shared/mcp-scopes.ts";

// MCP endpoints use wildcard CORS since external tools (Claude Desktop, etc.) call this endpoint.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_VERSION = "1.5.0";

export const AI_GATEWAY_TIMEOUT_MS = 60_000;
export const TOOL_CALL_TIMEOUT_MS = 90_000;

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_MAX_REQUESTS = 100;

/** Throttle `api_keys.last_used_at` writes — only update if older than this. */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export const SESSION_TTL_MS = 30 * 60 * 1000;

export const readOnlyAnnotation = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const writeAnnotation = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const WRITE_SCOPE = MCP_SCOPES.KNOWLEDGE_FILES_WRITE;
export const BRAND_KIT_WRITE_SCOPE = MCP_SCOPES.BRAND_KIT_WRITE;

export const fieldsParam = {
  fields: {
    type: "array",
    items: { type: "string" },
    description: "Optional subset of fields to return. Omit to return all data for the section.",
  },
};

export const dryRunParam = {
  dry_run: {
    type: "boolean",
    description:
      "If true, returns the data that would be written without committing. Always use dry_run first, present the proposed changes to the user, and wait for explicit confirmation before calling without dry_run.",
  },
};

export const confirmParam = {
  confirm: {
    type: "boolean",
    description:
      "Optional explicit commit flag. Required only when the calling user has enabled 'Require confirmation on MCP writes' in their settings; otherwise it is a no-op. When required, the standard flow is: call with `dry_run: true` to preview, then re-call with `confirm: true` (and no dry_run) to commit.",
  },
};

export const WRITE_GOVERNANCE_PREFIX =
  "[WRITE TOOL] Always call with dry_run: true first, present the returned preview to the user, and wait for explicit confirmation before calling without dry_run. ";

export const GENERATE_PREFIX =
  "[GENERATE — costs 1 token, writes immediately] Use the create_target_audience or create_ai_persona_guided MCP prompts when you need a confirmation step before generation. ";

export const TOOLS_WITHOUT_BRAND_KIT_ID_ARG = new Set([
  "list_brand_kits",
  "list_brand_kit_tools",
  "get_knowledge_file",
  "get_logo_asset",
  "list_library_archetypes",
  "get_library_archetype",
  "list_governance_platforms",
  "list_persona_field_options",

  "list_compliance_standards",
  "get_agent_briefing",
  "get_disclosure_diligence_questions",
]);


