import {
  readOnlyAnnotation,
  writeAnnotation,
  fieldsParam,
  dryRunParam,
  confirmParam,
  WRITE_GOVERNANCE_PREFIX,
  GENERATE_PREFIX,
} from "./constants.ts";


export const tools = [
  {
    name: "get_agent_briefing",
    title: "Get Agent Briefing (Session Bootstrap)",
    description: "Canonical session-bootstrap tool. Call this FIRST in every new MCP session. Without brand_kit_id: returns the list of brand kits the user can access plus the canonical section→tools map. With brand_kit_id: returns brand kit metadata, per-section health (last_updated_at, fields_filled/empty, flagged_gaps), the section→tools map, and a ranked recommended_next_steps list. Replaces the fragmented list_brand_kits → list_brand_kit_tools → get_brand_kit_completeness sequence with one call.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: {
          type: "string",
          description: "Optional. Omit for a list of accessible brand kits; pass to receive a full per-section briefing for that kit.",
        },
      },
      required: [],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_write_history",
    title: "Get Write History",
    description: "Returns the recent MCP write audit trail for a brand kit, sourced from mcp_request_logs. Each entry includes tool, operation, section, resource_id, updated_by, changed/added/removed columns, status, error_code, and timestamp. Filter with `section` and cap with `limit` (default 25, max 100). Dry runs are excluded unless `include_dry_runs: true`. Retention is 30 days.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "Brand kit UUID." },
        section: { type: "string", description: "Optional section filter (core, expression, governance, personality, seo, products, audience, personas, competitors, logos, knowledge_files, expression_examples, root)." },
        limit: { type: "number", description: "Max rows to return. Default 25, max 100." },
        include_dry_runs: { type: "boolean", description: "Include dry-run preview rows. Default false." },
      },
      required: ["brand_kit_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "batch_upsert",
    title: "Batch Upsert (All-or-Nothing)",
    description: "Apply multiple section upserts atomically against one brand kit. All ops succeed or every applied op is reverted to its pre-batch snapshot. Returns a `session_id` stamped on every audit row for traceability. Allowed tools per op: upsert_brand_kit_core, upsert_brand_kit_expression, upsert_brand_kit_personality, upsert_brand_kit_governance, upsert_brand_kit_seo, set_platform_specific_rules. Max 12 ops per batch. Pass `dry_run: true` to preview without writing.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "Brand kit UUID. Applies to every op." },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "One of: upsert_brand_kit_core, upsert_brand_kit_expression, upsert_brand_kit_personality, upsert_brand_kit_governance, upsert_brand_kit_seo, set_platform_specific_rules." },
              args: { type: "object", description: "Args object passed to that tool. `brand_kit_id` is auto-injected from the batch." },
            },
            required: ["tool", "args"],
          },
        },
        dry_run: { type: "boolean", description: "If true, every op runs as a preview and nothing is persisted." },
      },
      required: ["brand_kit_id", "operations"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "list_brand_kits",
    title: "List Brand Kits",
    description: "List all brand kits the user has access to (owned and shared). Each entry includes id, kit metadata, membership_role (owner | admin | editor | viewer), can_read (always true when present), and can_write_brand_kit / can_write_knowledge_files derived from the token's scopes and membership (only owners and admin members may write via MCP). Call this first to discover kits and permissions.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: readOnlyAnnotation,
  },
  {
    name: "list_brand_kit_tools",
    title: "List Brand Kit Tools by Section",
    description: "Return the canonical mapping from brand-kit section to the tools that read, preview, and write that section. Use this to discover all tools for a given section in one call instead of running multiple tool_search queries. Optional `section` filter restricts the result to one of: core, personality, expression, governance, products, audience, personas, competitors, seo, expression_examples, logos, knowledge_files, root, visuals, social_profiles, archetypes, platforms.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["core", "personality", "expression", "governance", "products", "audience", "personas", "competitors", "seo", "expression_examples", "logos", "knowledge_files", "root", "visuals", "social_profiles", "archetypes", "platforms"],
          description: "Optional section to scope the result. Omit to return all sections.",
        },
      },
      required: [],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit",
    title: "Get Brand Kit",
    description: "Get the complete brand kit with ALL sections (core, personality, expression, governance, products, audience, personas, competitors, social profiles, logo assets). Returns a large payload. For most tasks, prefer get_brand_kit_summary first, then load specific sections as needed to conserve context window. Pass `include` to inline optional sections (seo, expression_examples, knowledge_files) that are omitted by default.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit" },
        include: {
          type: "array",
          items: { type: "string", enum: ["seo", "expression_examples", "knowledge_files"] },
          description: "Optional list of extra sections to inline in the response. Default: none.",
        },
      },
      required: ["brand_kit_id"]
    },

    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_summary",
    title: "Get Brand Kit Summary",
    description: "Get a compact overview (~500 tokens) of a brand kit: name, tagline, mission, vision, top personality traits, top values, tone dimensions, key constraints, products, and primary audiences. Start here for any brand-related task, then layer additional section tools only when the task requires deeper data.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_completeness",
    title: "Get Brand Kit Completeness Report",
    description: "Scan a brand kit and return a completeness report. Returns BOTH a `presence_score` (legacy — does the field have any value?) and a stricter `quality_score` (is the value meaningful: min length, ≥2 populated style slots, archetypes linked to the library, etc.). `flagged_gaps[]` lists fields that pass presence but fail quality. Use this before proposing fills or writing to any section.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_context_for_agent",
    title: "Get Brand Context for Agent",
    description: "Assemble a compact, task-specific brand context string from a brand kit. Specify the task_type to receive only the sections relevant to that task, within a token budget. Use this to inject brand context into agent system prompts or sub-agent instructions. task_type options: content_creation, voice_check, campaign_planning, product_messaging, persona_embodiment, competitive_analysis.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit" },
        task_type: {
          type: "string",
          enum: ["content_creation", "voice_check", "campaign_planning", "product_messaging", "persona_embodiment", "competitive_analysis"],
          description: "The type of task this context will support."
        },
        persona_name: {
          type: "string",
          description: "For persona_embodiment tasks: the name of the AI persona to embody. Optional for other task types."
        }
      },
      required: ["brand_kit_id", "task_type"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_persona_system_prompt",
    title: "Get Persona System Prompt",
    description: "Returns a formatted system prompt string for a specific AI persona stored in the brand kit. Use this when you need to embody a persona for content creation, customer support, or any agent task. The returned system_prompt is ready to prepend to your context. More reliable than reading raw persona JSON.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit" },
        persona_name: {
          type: "string",
          description: "Name or partial name of the persona to retrieve. If multiple match, the first active result is returned."
        }
      },
      required: ["brand_kit_id", "persona_name"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_core",
    title: "Get Brand Core Identity",
    description: "Get core identity: mission, vision, brand story, brand promises, taglines, storytelling elements (origin story, milestones, themes, metaphors, hero narrative, transformation arc), and industry_classification ({ primary, secondary? }). Use when creating brand introductions, about pages, elevator pitches, or content that needs the brand's narrative foundation.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_personality",
    title: "Get Brand Personality",
    description: "Get personality traits (with strength ratings), brand values, guiding principles, and brand moods. Use alongside get_brand_kit_expression when creating content that must reflect the brand's character. Essential for brand voice enforcement.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_expression",
    title: "Get Brand Expression",
    description: "Get tone of voice, tone dimensions (e.g., formal-casual spectrum), voice archetypes, verbal style, visual style, preferred terminology, and content categories. This is the primary tool for any content creation or review task. Combine with get_brand_kit_governance for complete voice enforcement with guardrails.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_products",
    title: "Get Brand Products",
    description: "Get products and services with names, descriptions, types, USPs, key benefits, competitive differentiation, and pricing. Use when creating product-focused content, sales copy, feature announcements, or when the user mentions specific offerings.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_audience",
    title: "Get Target Audience",
    description: "Get target audience personas with demographics, goals, motivations, pain points, preferred channels, buying behavior, expertise level, and psychographics. Use when creating audience-targeted content or campaign planning. Combine with get_brand_kit_expression for tone-matched, persona-aware messaging.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_governance",
    title: "Get Brand Governance",
    description: "Get behavioral constraints, negative directory (blacklisted words/phrases), writing constraints (sentence length, readability, active voice), compliance rules, disclosure policies, and usage guidelines. ALWAYS load this alongside get_brand_kit_expression for any content creation to ensure outputs respect brand guardrails and legal requirements.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_personas",
    title: "Get AI Personas",
    description: "Get AI persona configurations with role definitions, personality descriptions, tone overrides, behavioral rules, and negative guardrails. Use when the user wants to adopt a specific brand persona (e.g., customer support bot, social media manager, content creator) for their interaction.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "list_brand_kit_personas",
    title: "List AI Personas (slim)",
    description: "Lightweight index of AI personas in a brand kit. Returns one row per persona with persona_id, name, fields_filled[], fields_empty[], completeness_pct, and updated_at — without loading full persona content. Use this to decide which personas need work before pulling full records via get_brand_kit_personas.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_competitors",
    title: "Get Competitors",
    description: "Get competitor analysis: names, URLs, descriptions, taglines, value propositions, brand personality, colors, fonts, and design frameworks. Use for competitive positioning analysis, differentiation messaging, or providing market context in strategic content.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_social_profiles",
    title: "Get Social Profiles",
    description: "Get linked social media profiles (LinkedIn, Instagram, Facebook, TikTok, YouTube, Reddit) with bios, headlines, follower counts, and account metadata. Use when creating platform-specific content or analyzing the brand's social presence.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_brand_kit_logo_assets",
    title: "Get Logo Assets (Deprecated)",
    description: "DEPRECATED — prefer list_logo_assets + get_logo_asset for the metadata-first pattern. Get logo and visual asset metadata including URLs, dimensions, file types, usage guidelines, and default variants. Use when the user needs asset references, visual identity information, or logo specifications.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "list_logo_assets",
    title: "List Logo Assets",
    description: "Returns metadata for all logo and visual assets in a brand kit: label, usage guidelines, file type, dimensions, and long description. Does NOT return URLs. Read this first to identify which asset is relevant to your task, then call get_logo_asset to retrieve the URL and full details for a specific asset.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_logo_asset",
    title: "Get Logo Asset",
    description: "Retrieve the URL and full metadata for a specific logo asset by its ID. Call list_logo_assets first to identify the correct asset ID based on usage guidelines and description. Returns the asset URL which can be passed to image generation tools as a reference image.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "UUID of the logo asset from list_logo_assets" }
      },
      required: ["asset_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "list_knowledge_files",
    title: "List Knowledge Files",
    description: "List knowledge files attached to a brand kit. Returns metadata only — title, description, relevance_hint, tags, and category. Use relevance_hint to decide whether fetching this file is necessary for your current task. Call get_knowledge_file with the file ID only when the file is relevant. Supports an optional category filter spanning both upload-wizard report types (general, writing_style_report, audience_report, performance_report, comment_analysis_report) and agent-facing tags (template, guideline, research, campaign).",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit" },
        category: {
          type: "string",
          enum: ["general", "writing_style_report", "audience_report", "performance_report", "comment_analysis_report", "template", "guideline", "research", "campaign"],
          description: "Optional filter. Use 'template' to fetch fill-in-the-blank documents only."
        }
      },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_knowledge_file",
    title: "Get Knowledge File",
    description: "Get the full content and metadata of a specific knowledge file by its ID. Returns extracted data for processed files or raw content for markdown/JSON files. Use after list_knowledge_files when the user references a specific document or when deeper brand context is needed beyond the standard sections.",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string", description: "The UUID of the knowledge file" } },
      required: ["file_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "upload_knowledge_file",
    title: "Upload Knowledge File",
    description: "Upload a new document to the user-uploaded knowledge files section of a brand kit. Writes to user-uploaded storage only — auto-generated documents and curated templates cannot be modified via MCP. Requires an API key with the 'knowledge_files:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit to attach the file to." },
        title: { type: "string", description: "Display title for the file." },
        original_file_name: { type: "string", description: "Source filename including extension, e.g. 'brand-guidelines.pdf' or 'voice-notes.md'. Stored on the row for export/download integrity." },
        file_type: { type: "string", enum: ["markdown", "json", "pdf"], description: "File format. PDFs must be base64-encoded in `content`." },
        content: { type: "string", description: "Raw text for markdown/json, or base64-encoded bytes for pdf." },
        description: { type: "string", description: "Optional short description." },
        relevance_hint: {
          type: "string",
          description: "One sentence describing when an agent should load this file. Example: 'Load this when writing blog posts or checking content tone.'"
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        department: { type: "string", description: "Optional department (e.g. marketing, sales)." },
        category: {
          type: "string",
          enum: ["general", "writing_style_report", "audience_report", "performance_report", "comment_analysis_report", "template", "guideline", "research", "campaign"],
          description: "Optional category. Upload-wizard report types: general, writing_style_report, audience_report, performance_report, comment_analysis_report. Agent-facing tags: template, guideline, research, campaign."
        },
        ...confirmParam,
      },
      required: ["brand_kit_id", "title", "original_file_name", "file_type", "content"]
    },
    annotations: writeAnnotation,
  },
  // ── Preview tools (read-only) — no brand_kit:write scope required ───────
  {
    name: "preview_brand_kit_core_update",
    title: "Preview Brand Core Update",
    description: "READ-ONLY PREVIEW — no database write. Does not require approval in clients that honor readOnlyHint. Returns a diff of proposed core section updates (mission, vision, story, promises, taglines) against the existing row. Use before upsert_brand_kit_core.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        mission: { type: "string", description: "Brand mission statement." },
        vision: { type: "string", description: "Brand vision statement." },
        brand_story: { type: "object", description: "Object with origin_story, founder_story, customer_stories[{title,story}], future_story." },
        brand_promises: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title"] }, description: "Array of { title, description } (UI labels: Title, Description)." },
        taglines: { type: "array", items: { type: "object", properties: { tagline: { type: "string" }, use_when: { type: "string" } }, required: ["tagline"] }, description: "Array of { tagline, use_when } (UI labels: Tagline, Use When)." },
        storytelling_elements: { type: "object", description: "Brand narrative and storytelling elements. JSONB object with keys: origin_story_summary (string), key_milestones (string[]), recurring_themes (string[]), brand_metaphors (string[]), hero_narrative (string), transformation_arc (string), founder_voice_notes (string)." },
        industry_classification: { type: "object", properties: { primary: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } }, secondary: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } } } }, description: "Industry classification JSONB. Shape: { primary: { id, name, slug }, secondary?: [{ id, name, slug }] }." },
      },
      required: ["brand_kit_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "preview_brand_kit_personality_update",
    title: "Preview Brand Personality Update",
    description: "READ-ONLY PREVIEW — no database write. Does not require approval in clients that honor readOnlyHint. Returns a diff of proposed personality updates against the existing row. Use before upsert_brand_kit_personality.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        personality_traits: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["title"] } },
        brand_values: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name"] } },
        brand_principles: { type: "array", items: { type: "object", properties: { name: { type: "string" }, action: { type: "string" }, tags: { type: "array", items: { type: "string" } }, use_case: { type: "string" } }, required: ["name"] }, description: "Array of guiding principle objects. Each MUST have 'name'. Optional: 'action', 'tags' (string[] — plural array at the MCP/DB boundary; the library table's singular 'tag' maps into this), 'use_case'." },
        brand_moods: { type: "array", items: { type: "object", properties: { name: { type: "string" }, emotional_description: { type: "string" }, visual_descriptor: { type: "string" }, associated_tone: { type: "string" } }, required: ["name"] } },
      },
      required: ["brand_kit_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "preview_brand_kit_expression_update",
    title: "Preview Brand Expression Update",
    description: "READ-ONLY PREVIEW — no database write. Does not require approval in clients that honor readOnlyHint. Returns a diff of proposed expression updates against the existing row. Use before upsert_brand_kit_expression.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        brand_voice: { type: "string", description: "Short brand voice descriptor on brand_kits." },
        tone_of_voice: { type: "object", description: "Object with description and attributes[{attribute,min_label,max_label,value}]." },
        tone_dimensions: { type: "object", description: "Object with formality, energy, warmth, confidence, complexity (0-100 each)." },
        voice_archetypes: { type: "object", description: "Object with primary/secondary {archetype_id?, name, description, characteristics[]} and antiArchetypes[]. PREFERRED: pass archetype_id (UUID from list_library_archetypes) — the server will hydrate name/description/characteristics from the library record and increment its usage_count. Freeform entries without archetype_id are still accepted for legacy/custom archetypes." },
        verbal_style: { type: "object", description: "Verbal style — a single JSONB object keyed by slot (verbal_style_1 … verbal_style_5); each slot is a full template { name, use_when, sentence_structure, vocabulary_level, punctuation_style, grammar_preferences, formatting, digital_elements, content_patterns }. Only the slots you include are written." },
        visual_style: { type: "object", description: "Visual style — a single JSONB object keyed by slot (visual_style_1 … visual_style_5); each slot is a full template { name, use_when, aesthetic, imagery_guidelines, color_usage, photography, illustration, iconography, layout, graphic_elements }. Only the slots you include are written." },
        preferred_terminology: { type: "array", items: { type: "object", properties: { term: { type: "string" }, instead_of: { type: "array", items: { type: "string" } }, description: { type: "string" } }, required: ["term"] }, description: "Array of preferred-terminology entries: { term, instead_of: string[], description }. Legacy { prefer: [], avoid: [] } objects are auto-converted on write." },

      },
      required: ["brand_kit_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "preview_brand_kit_governance_update",
    title: "Preview Brand Governance Update",
    description: "READ-ONLY PREVIEW — no database write. Does not require approval in clients that honor readOnlyHint. Returns a diff of proposed governance updates against the existing row, with writing_constraints auto-wrapped and negative_directory auto-normalized to the canonical shapes the upsert will produce. Use before upsert_brand_kit_governance.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        behavioral_constraints: { type: "array", items: { type: "string" }, description: "Array of plain-string constraint rules." },
        negative_directory: {
          type: "array",
          description: "Forbidden words and phrases. Canonical shape: array of { term, category, platform_context?, reason? }. The server also accepts legacy shapes { forbidden_words: [], forbidden_phrases: [] } and auto-normalizes them, but prefer the canonical array.",
          items: {
            type: "object",
            properties: {
              term: { type: "string", description: "The forbidden word or phrase." },
              category: { type: "string", enum: ["marketing_speak", "pretentious", "sales_language", "jargon", "offensive", "other"], description: "Why the term is forbidden." },
              platform_context: { type: "string", description: "Optional platform scope, e.g. 'all', 'linkedin', 'consumer copy'." },
              reason: { type: "string", description: "Optional rationale shown in the UI tooltip." },
            },
            required: ["term"],
          },
        },
        writing_constraints: { type: "object", description: "Writing constraints wrapper: { constraints: [{ rule, type?, value?, platform?, isHard? }], platformSpecificEnabled?: boolean, preferences?: { ... } }. The `platform` field on each constraint MUST be one of the values returned by list_governance_platforms (e.g. 'all', 'linkedin', 'reddit', 'instagram', 'email'); unknown values are rejected. Set platformSpecificEnabled: true whenever any constraint is platform-scoped. Example: { platformSpecificEnabled: true, constraints: [ { rule: 'No emoji', platform: 'linkedin', isHard: true }, { rule: 'Light emoji OK', platform: 'reddit' } ] }. Each constraint item supports type, value, platform, and isHard — set isHard:true for must-enforce rules. Server auto-wraps legacy shapes." },
        usage_guidelines: { type: "array", items: { type: "string" }, description: "Array of usage guideline strings (e.g. 'Logo must have 20px minimum clear space')." },
        disclosure_statements: { type: "object", description: "AI diligence disclosure object: { creation: string, transparency: string, deployment: string, answers: { creation: {q0,q1,q2}, transparency: {...}, deployment: {...} }, approved: { creation: boolean, transparency: boolean, deployment: boolean } }. Use generate_disclosure_statement to produce each section's text before saving." },
        compliance_selections: {
          type: "array",
          description: "Selected compliance standards. Call list_compliance_standards first to discover the library; users can also propose custom standards.",
          items: {
            type: "object",
            properties: {
              standard_id: { type: "string", description: "UUID from library_compliance_standards (when selecting a library standard)." },
              name: { type: "string", description: "Display name, e.g. 'GDPR', 'CCPA'." },
              is_custom: { type: "boolean", description: "True if user-created rather than from the library." },
            },
            required: ["name"],
          },
        },
        disclosure_policy: { type: "string", description: "DEPRECATED free-text disclosure policy. Use disclosure_statements (the structured AI-diligence object) instead." },
        compliance_notes: { type: "string", description: "DEPRECATED free-text compliance notes. Use compliance_selections (structured list from list_compliance_standards) instead." },
        drift_prevention_prompts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, prompt: { type: "string" }, category: { type: "string", enum: ["tone", "content", "style", "ethics", "custom"] } }, required: ["prompt", "category"] }, description: "Drift-prevention prompts. Each item: { id?, prompt, category }. category must be one of tone | content | style | ethics | custom." },
      },
      required: ["brand_kit_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "list_library_archetypes",
    title: "List Library Archetypes",
    description: "List voice archetypes available from the curated library plus any custom archetypes the caller has created. Each entry includes id, name, category (core | functional_collective | relational_emotional), role_type, key_traits, and description. Use this when the user asks for archetype recommendations: read this list, call get_brand_kit_summary (or get_brand_kit_personality + get_brand_kit_audience), then present 2-3 ranked archetype options with a short rationale before writing via upsert_brand_kit_expression(voice_archetypes). Optional `category` filter.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["core", "functional_collective", "relational_emotional"],
          description: "Optional category filter.",
        },
      },
      required: [],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_library_archetype",
    title: "Get Library Archetype",
    description: "Fetch one archetype by id, including the full `llm_instruction` text that tells an agent how to embody this archetype. Call list_library_archetypes first to discover ids.",
    inputSchema: {
      type: "object",
      properties: {
        archetype_id: { type: "string", description: "UUID from list_library_archetypes." },
      },
      required: ["archetype_id"],
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "list_governance_platforms",
    title: "List Governance Platforms",
    description: "Return the canonical list of platform values accepted on a writing_constraints.constraints[].platform field. Call this before adding a platform-scoped governance rule via upsert_brand_kit_governance — agents must use one of these exact `value` strings (e.g. 'linkedin', 'reddit', 'all') and set writing_constraints.platformSpecificEnabled to true when any rule is platform-scoped.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: readOnlyAnnotation,
  },
  // ── Write tools — require brand_kit:write scope ──────────────────────────
  {
    name: "upsert_brand_kit_core",
    title: "Update Brand Core Identity",
    description: WRITE_GOVERNANCE_PREFIX + "Create or update the brand's core identity section: mission, vision, brand story, brand promises, taglines, and storytelling elements. All fields are optional — only provided fields are written; existing data is preserved. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        mission: { type: "string", description: "Brand mission statement." },
        vision: { type: "string", description: "Brand vision statement." },
        brand_story: { type: "object", description: "Brand story: origin_story, founder_story, future_story, customer_stories[{title,story}]." },
        brand_promises: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title"] }, description: "Array of { title, description } — UI labels Title and Description." },
        taglines: { type: "array", items: { type: "object", properties: { tagline: { type: "string" }, use_when: { type: "string" } }, required: ["tagline"] }, description: "Array of { tagline, use_when } — UI labels Tagline and Use When." },
        storytelling_elements: { type: "object", description: "Brand narrative and storytelling elements. JSONB object with keys: origin_story_summary (string), key_milestones (string[]), recurring_themes (string[]), brand_metaphors (string[]), hero_narrative (string), transformation_arc (string), founder_voice_notes (string)." },
        industry_classification: { type: "object", properties: { primary: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } }, secondary: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } } } }, description: "Industry classification JSONB. Shape: { primary: { id, name, slug }, secondary?: [{ id, name, slug }] }. Drives industry-aware prompt tuning." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "upsert_brand_kit_expression",
    title: "Update Brand Expression",
    description: WRITE_GOVERNANCE_PREFIX + "Create or update the brand's expression section: tone of voice, tone dimensions, voice archetypes, verbal style, visual style, and preferred terminology. Optionally updates brand_voice on the brand kit itself. All fields are optional. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        brand_voice: { type: "string", description: "Short brand voice descriptor (e.g. 'Confident and approachable'). Stored on the brand kit record itself." },
        tone_of_voice: { type: "object", description: "Object with description and attributes[{attribute,min_label,max_label,value 0-100}]." },
        tone_dimensions: { type: "object", description: "Object with formality, energy, warmth, confidence, complexity (0-100 each)." },
        voice_archetypes: { type: "object", description: "Object with primary/secondary {archetype_id?, name, description, characteristics[]} and antiArchetypes[]. PREFERRED: pass archetype_id (UUID from list_library_archetypes) — the server will hydrate name/description/characteristics from the library record and increment its usage_count. Freeform entries without archetype_id are still accepted for legacy/custom archetypes." },
        verbal_style: { type: "object", description: "Verbal style — a single JSONB object keyed by slot (verbal_style_1 … verbal_style_5); each slot is a full template { name, use_when, sentence_structure, vocabulary_level, punctuation_style, grammar_preferences, formatting, digital_elements, content_patterns }. Only the slots you include are written." },
        visual_style: { type: "object", description: "Visual style — a single JSONB object keyed by slot (visual_style_1 … visual_style_5); each slot is a full template { name, use_when, aesthetic, imagery_guidelines, color_usage, photography, illustration, iconography, layout, graphic_elements }. Only the slots you include are written." },
        preferred_terminology: { type: "array", items: { type: "object", properties: { term: { type: "string" }, instead_of: { type: "array", items: { type: "string" } }, description: { type: "string" } }, required: ["term"] }, description: "Array of preferred-terminology entries: { term, instead_of: string[], description }. Legacy { prefer: [], avoid: [] } objects are auto-converted on write." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },

  {
    name: "upsert_brand_kit_personality",
    title: "Update Brand Personality",
    description: WRITE_GOVERNANCE_PREFIX + "Create or update the brand's personality section: personality traits, brand values, guiding principles, and brand moods. All fields are optional JSONB arrays. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        personality_traits: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["title"] }, description: "Array of personality trait objects. Each MUST have 'title' (string). Optional: 'description' (string), 'tags' (string[])." },
        brand_values: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name"] }, description: "Array of brand value objects. Each MUST have 'name' (string). Optional: 'description' (string)." },
        brand_principles: { type: "array", items: { type: "object", properties: { name: { type: "string" }, action: { type: "string" }, tags: { type: "array", items: { type: "string" } }, use_case: { type: "string" } }, required: ["name"] }, description: "Array of guiding principle objects. Each MUST have 'name' (string). Optional: 'action', 'tags' (string[] — plural array at the MCP/DB boundary; the library table's singular 'tag' maps into this), 'use_case'." },
        brand_moods: { type: "array", items: { type: "object", properties: { name: { type: "string" }, emotional_description: { type: "string" }, visual_descriptor: { type: "string" }, associated_tone: { type: "string" } }, required: ["name"] }, description: "Array of brand mood objects. Each MUST have 'name' (string). Optional: 'emotional_description', 'visual_descriptor', 'associated_tone'." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "upsert_brand_kit_governance",
    title: "Update Brand Governance",
    description: WRITE_GOVERNANCE_PREFIX + "Create or update the brand's governance section. IMPORTANT shapes:\n  • negative_directory MUST be an array of { term, category, platform_context?, reason? } items (category ∈ marketing_speak | pretentious | sales_language | jargon | offensive | other). Legacy { forbidden_words, forbidden_phrases } objects are auto-normalized but not preferred.\n  • compliance_selections is the structured list from list_compliance_standards (each item { standard_id?, name, is_custom? }). Do not use the deprecated free-text compliance_notes.\n  • disclosure_statements is the AI-diligence object { creation, transparency, deployment, answers, approved }. Use get_disclosure_diligence_questions to fetch the question sets, ask the user the questions in chat, then call generate_disclosure_statement per section before saving. Do not use the deprecated disclosure_policy string.\n  • usage_guidelines is an array of plain strings (one rule per item).\nAll fields are optional. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        behavioral_constraints: { type: "array", items: { type: "string" }, description: "Array of plain-string behavioral rules." },
        negative_directory: {
          type: "array",
          description: "Forbidden words/phrases. Each item: { term (required), category (required, enum), platform_context?, reason? }.",
          items: {
            type: "object",
            properties: {
              term: { type: "string", description: "The forbidden word or phrase." },
              category: { type: "string", enum: ["marketing_speak", "pretentious", "sales_language", "jargon", "offensive", "other"], description: "Why the term is forbidden." },
              platform_context: { type: "string", description: "Optional platform scope, e.g. 'all', 'linkedin', 'consumer copy'." },
              reason: { type: "string", description: "Optional rationale shown in the UI tooltip." },
            },
            required: ["term"],
          },
        },
        writing_constraints: { type: "object", description: "Writing constraints wrapper: { constraints: [{ rule, type?, value?, platform?, isHard? }], platformSpecificEnabled?: boolean, preferences?: { active_voice: true, readability_level: 'grade 8' } }. The `platform` field on each constraint MUST be one of the values returned by list_governance_platforms (e.g. 'all', 'linkedin', 'reddit', 'instagram', 'email'); unknown values are rejected. Set platformSpecificEnabled: true whenever any constraint is platform-scoped. Example: { platformSpecificEnabled: true, constraints: [ { rule: 'No emoji', platform: 'linkedin', isHard: true }, { rule: 'Light emoji OK', platform: 'reddit' } ] }. Each constraint item supports type, value, platform, and isHard — set isHard:true for must-enforce rules. Server auto-wraps legacy shapes." },
        usage_guidelines: { type: "array", items: { type: "string" }, description: "Array of usage guideline strings (e.g. 'Logo must have 20px minimum clear space')." },
        disclosure_statements: {
          type: "object",
          description: "AI diligence disclosure. Shape: { creation: string, transparency: string, deployment: string, answers: { creation: {q0,q1,q2}, transparency: {...}, deployment: {...} }, approved: { creation, transparency, deployment } }.",
          properties: {
            creation: { type: "string" },
            transparency: { type: "string" },
            deployment: { type: "string" },
            answers: { type: "object" },
            approved: { type: "object" },
          },
        },
        compliance_selections: {
          type: "array",
          description: "Selected compliance standards. Use list_compliance_standards to discover library options first.",
          items: {
            type: "object",
            properties: {
              standard_id: { type: "string", description: "UUID from library_compliance_standards (omit for purely custom entries)." },
              name: { type: "string", description: "Display name, e.g. 'GDPR'." },
              is_custom: { type: "boolean", description: "True if user-created rather than from the library." },
            },
            required: ["name"],
          },
        },
        disclosure_policy: { type: "string", description: "DEPRECATED free-text disclosure policy. Use disclosure_statements (the structured AI-diligence object) instead." },
        compliance_notes: { type: "string", description: "DEPRECATED free-text compliance notes. Use compliance_selections (structured list from list_compliance_standards) instead." },
        drift_prevention_prompts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, prompt: { type: "string" }, category: { type: "string", enum: ["tone", "content", "style", "ethics", "custom"] } }, required: ["prompt", "category"] }, description: "Each item: id, prompt, category (tone|content|style|ethics|custom)." },

        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "set_platform_specific_rules",
    title: "Toggle / Set Platform-Specific Writing Rules",
    description: WRITE_GOVERNANCE_PREFIX + "Shortcut for flipping `writing_constraints.platformSpecificEnabled` and (optionally) appending platform-scoped constraints in one call — without re-sending the entire writing_constraints wrapper. The server deep-merges into the existing wrapper, preserving `constraints[]` and `preferences`. Use list_governance_platforms to discover valid platform values. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        enabled: { type: "boolean", description: "Set platformSpecificEnabled on writing_constraints." },
        rules: {
          type: "array",
          description: "Optional new platform-scoped constraint rules to append. Each: { rule, platform, isHard?, type?, value? }.",
          items: {
            type: "object",
            properties: {
              rule: { type: "string" },
              platform: { type: "string", description: "One of the values from list_governance_platforms." },
              isHard: { type: "boolean" },
              type: { type: "string" },
              value: {},
            },
            required: ["rule", "platform"],
          },
        },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "enabled"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "create_brand_kit_product",
    title: "Create Brand Product",
    description: WRITE_GOVERNANCE_PREFIX + "Add a new product or service to the brand kit's product catalog. Use `short_description` (150–300 chars) for list views and `long_description` (1,000–4,000 chars) for the detail view. The legacy `description` parameter is accepted as an alias for `short_description` for backwards compatibility. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        name: { type: "string", description: "Product or service name." },
        short_description: { type: "string", description: "Concise product summary, 150–300 characters. Shown in product list cards." },
        long_description: { type: "string", description: "Detailed product narrative, 1,000–4,000 characters. Shown in the product detail view." },
        description: { type: "string", description: "DEPRECATED alias for short_description. Prefer short_description." },
        type: { type: "string", description: "Product type (e.g. SaaS, Service, Physical)." },
        cost: { type: "string", description: "Price or cost information." },
        special_pricing: { type: "string", description: "Special pricing details or tiers." },
        usp: { type: "string", description: "Unique selling proposition." },
        key_benefits: { type: "array", items: { type: "string" }, description: "Array of key benefit strings." },
        competitive_differentiation: { type: "string", description: "How this product differs from competitors." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "name"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_brand_kit_product",
    title: "Update Brand Product",
    description: WRITE_GOVERNANCE_PREFIX + "Update an existing product in the brand kit's product catalog. Requires the product's UUID. All content fields are optional — only provided fields are updated. Use `short_description` (150–300 chars) and `long_description` (1,000–4,000 chars); the legacy `description` field is accepted as an alias for `short_description`. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The UUID of the product to update." },
        brand_kit_id: { type: "string", description: "The UUID of the brand kit (for access verification)." },
        name: { type: "string", description: "Product or service name." },
        short_description: { type: "string", description: "Concise product summary, 150–300 characters." },
        long_description: { type: "string", description: "Detailed product narrative, 1,000–4,000 characters." },
        description: { type: "string", description: "DEPRECATED alias for short_description. Prefer short_description." },
        type: { type: "string", description: "Product type." },
        cost: { type: "string", description: "Price or cost information." },
        special_pricing: { type: "string", description: "Special pricing details." },
        usp: { type: "string", description: "Unique selling proposition." },
        key_benefits: { type: "array", items: { type: "string" }, description: "Array of key benefit strings." },
        competitive_differentiation: { type: "string", description: "How this product differs from competitors." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["product_id", "brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_audience_persona",
    title: "Update Target Audience Persona",
    description: WRITE_GOVERNANCE_PREFIX + "Update an existing target audience persona. Requires the persona's UUID. All content fields are optional — only provided fields are updated. The `description` field is a short persona summary (up to 500 chars) shown on the persona card. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        persona_id: { type: "string", description: "The UUID of the audience persona to update." },
        brand_kit_id: { type: "string", description: "The UUID of the brand kit (for access verification)." },
        persona_name: { type: "string" },
        persona_title: { type: "string" },
        persona_type: { type: "string", enum: ["b2b", "b2c"] },
        is_primary: { type: "boolean" },
        description: { type: "string", description: "Short persona summary shown on the persona card, up to 500 characters." },
        demographics: { type: "object", description: "Demographics: age_range, gender, location, income_level, education." },
        professional_context: { type: "object", description: "Professional context: job_title, industry, company_size, company_type, daily_responsibilities." },
        personal_background: { type: "object", description: "Personal background: lifestyle, family_status, interests, background_details." },
        goals_motivations: { type: "array", items: { type: "string" } },
        frustrations_pain_points: { type: "array", items: { type: "string" } },
        values_beliefs: { type: "array", items: { type: "string" } },
        fears: { type: "array", items: { type: "string" } },
        information_sources: { type: "array", items: { type: "string" } },
        preferred_channels: { type: "array", items: { type: "string" } },
        core_motivation: { type: "string" },
        expertise_level: { type: "string" },
        buying_behavior: { type: "string" },
        content_that_resonates: { type: "string" },
        representative_quote: { type: "string" },
        barriers_to_sale: { type: "array", items: { type: "string" } },
        objections_verbatim: { type: "array", items: { type: "string" } },
        trigger_events: { type: "array", items: { type: "string" } },
        forbidden_moves: { type: "array", items: { type: "string" } },
        product_fit: { type: "string" },
        current_perception: { type: "string" },
        platform_behavior: { type: "string" },
        tech_usage: { type: "array", items: { type: "string" } },
        influencers: { type: "array", items: { type: "string" } },
        aspirational_identity: { type: "string", description: "Who this persona aspires to become." },
        show_dont_tell_scene: { type: "string", description: "A vivid scene depicting this persona in their element." },
        visual_identifiers: { type: "object", description: "Visual cues that identify this persona (clothing, environment, etc.)." },
        funnel_stage_triggers: { type: "object", description: "What triggers this persona to move between funnel stages." },
        channel_behavior_matrix: { type: "object", description: "How this persona behaves differently across channels." },
        paid_tools: { type: "object", description: "Tools and software this persona pays for." },
        source: { type: "string", description: "How this persona was created: 'manual', 'ai_generated', 'imported'." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["persona_id", "brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "create_audience_persona",
    title: "Create Target Audience Persona",
    description: WRITE_GOVERNANCE_PREFIX + "Manually create a new target audience persona (no AI generation). persona_name and persona_type are required; all other fields are optional. The `description` field is a short persona summary (up to 500 chars) shown on the persona card. To AI-generate one instead, use generate_audience_persona. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        persona_name: { type: "string", description: "Name for the audience persona (e.g. 'Marketing Mary')." },
        persona_title: { type: "string" },
        persona_type: { type: "string", enum: ["b2b", "b2c"] },
        is_primary: { type: "boolean", description: "Whether this is the primary persona for the brand kit. Default false." },
        description: { type: "string", description: "Short persona summary shown on the persona card, up to 500 characters." },
        demographics: { type: "object", description: "Demographics: age_range, gender, location, income_level, education." },
        professional_context: { type: "object", description: "Professional context: job_title, industry, company_size, company_type, daily_responsibilities." },
        personal_background: { type: "object", description: "Personal background: lifestyle, family_status, interests, background_details." },
        goals_motivations: { type: "array", items: { type: "string" } },
        frustrations_pain_points: { type: "array", items: { type: "string" } },
        values_beliefs: { type: "array", items: { type: "string" } },
        fears: { type: "array", items: { type: "string" } },
        information_sources: { type: "array", items: { type: "string" } },
        preferred_channels: { type: "array", items: { type: "string" } },
        core_motivation: { type: "string" },
        expertise_level: { type: "string" },
        buying_behavior: { type: "string" },
        content_that_resonates: { type: "string" },
        representative_quote: { type: "string" },
        barriers_to_sale: { type: "array", items: { type: "string" } },
        objections_verbatim: { type: "array", items: { type: "string" } },
        trigger_events: { type: "array", items: { type: "string" } },
        forbidden_moves: { type: "array", items: { type: "string" } },
        product_fit: { type: "string" },
        current_perception: { type: "string" },
        platform_behavior: { type: "string" },
        tech_usage: { type: "array", items: { type: "string" } },
        influencers: { type: "array", items: { type: "string" } },
        aspirational_identity: { type: "string" },
        show_dont_tell_scene: { type: "string" },
        visual_identifiers: { type: "object" },
        funnel_stage_triggers: { type: "object" },
        channel_behavior_matrix: { type: "object" },
        paid_tools: { type: "object" },
        source: { type: "string", description: "How this persona was created. Default: 'manual'." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "persona_name", "persona_type"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_ai_persona",
    title: "Update AI Persona",
    description: WRITE_GOVERNANCE_PREFIX + "Update an existing AI persona configuration. Requires the persona's UUID. All content fields are optional. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        persona_id: { type: "string", description: "The UUID of the AI persona to update." },
        brand_kit_id: { type: "string", description: "The UUID of the brand kit (for access verification)." },
        name: { type: "string" },
        purpose_type: { type: "string", enum: ["content_creation", "customer_support", "internal_assistant", "creative_brainstorming", "sales_enablement", "thought_leadership", "community_management", "product_education", "data_analysis", "custom"] },
        role_definition: { type: "string" },
        function_description: { type: "string" },
        tasks: { type: "array", items: { type: "string" } },
        behavioral_rules: { type: "array", items: { type: "string" } },
        tone_overrides: { type: "object" },
        voice_profile: { type: "object", description: "Voice profile with tone_attributes (professionalism, empathy, verbosity) and personality_pillars." },
        lexicon_syntax: { type: "object", description: "Lexicon with allowed_terms, forbidden_terms, formatting_rules." },
        negative_guardrails: { type: "array", items: { type: "string" } },
        target_audience_context: { type: "string" },
        is_active: { type: "boolean" },
        personality_description: { type: "string", description: "Free-text personality description for the persona." },
        is_default: { type: "boolean", description: "Whether this is the default persona for the brand kit." },
        safety_compliance: { type: "array", items: { type: "string" }, description: "Array of safety and compliance rules the persona must follow." },
        execution_protocol: { type: "array", items: { type: "string" }, description: "Step-by-step execution protocol for persona interactions." },
        reference_protocols: { type: "object", description: "Reference protocols: how the persona handles citations, sources, links." },
        interaction_context: { type: "object", description: "Context about where/how this persona interacts (channels, formats, triggers)." },
        few_shot_examples: {
          type: "array",
          description: "Array of structured few-shot examples for this persona. Each item: { label?, content, verdict? } where verdict ∈ 'good' | 'bad' | 'borderline'. Use to anchor tone/voice with concrete demonstrations.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              content: { type: "string", description: "The example response text." },
              verdict: { type: "string", enum: ["good", "bad", "borderline"] },
            },
            required: ["content"],
          },
        },
        ...dryRunParam, ...confirmParam,
      },
      required: ["persona_id", "brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "create_brand_kit_persona",
    title: "Create AI Persona",
    description: WRITE_GOVERNANCE_PREFIX + "Manually create a new AI persona configuration (no AI generation). name and purpose_type are required; all other fields are optional. To AI-generate one instead, use generate_ai_persona. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        name: { type: "string", description: "Name for the AI persona." },
        purpose_type: { type: "string", enum: ["content_creation", "customer_support", "internal_assistant", "creative_brainstorming", "sales_enablement", "thought_leadership", "community_management", "product_education", "data_analysis", "custom"] },
        role_definition: { type: "string" },
        function_description: { type: "string" },
        tasks: { type: "array", items: { type: "string" } },
        behavioral_rules: { type: "array", items: { type: "string" } },
        tone_overrides: { type: "object" },
        voice_profile: { type: "object", description: "Voice profile with tone_attributes and personality_pillars." },
        lexicon_syntax: { type: "object", description: "Lexicon with allowed_terms, forbidden_terms, formatting_rules." },
        negative_guardrails: { type: "array", items: { type: "string" } },
        target_audience_context: { type: "string" },
        is_active: { type: "boolean", description: "Whether the persona is active. Default true." },
        personality_description: { type: "string" },
        is_default: { type: "boolean", description: "Whether this is the default persona for the brand kit. Default false." },
        safety_compliance: { type: "array", items: { type: "string" } },
        execution_protocol: { type: "array", items: { type: "string" } },
        reference_protocols: { type: "object" },
        interaction_context: { type: "array", items: { type: "string" }, description: "Interaction contexts (channels/formats), e.g. ['email','landing_page','support_ticket']. Default []." },
        source: { type: "string", enum: ["ai_generated", "manual", "imported"], description: "How this persona was created. Pass 'ai_generated' when saving the output of preview_generate_ai_persona. Default: 'manual'." },
        few_shot_examples: {
          type: "array",
          description: "Array of structured few-shot examples for this persona. Each item: { label?, content, verdict? } where verdict ∈ 'good' | 'bad' | 'borderline'.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              content: { type: "string" },
              verdict: { type: "string", enum: ["good", "bad", "borderline"] },
            },
            required: ["content"],
          },
        },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "name", "purpose_type"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "preview_generate_audience_persona",
    title: "Preview Generated Audience Persona",
    description: "READ-ONLY PREVIEW — no database write. Does not require approval in clients that honor readOnlyHint. Runs the AI audience-persona generation against the brand's context and returns the proposed persona for review (source: 'ai_generated'). Nothing is saved. Pass the returned proposed_persona fields to create_audience_persona to save it.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "UUID of the brand kit to generate the persona for." },
        persona_name: { type: "string", description: "Name for the persona (e.g. 'Solo Creator Sarah')." },
        persona_type: { type: "string", enum: ["b2b", "b2c"], description: "Whether this is a B2B or B2C persona." },
        description: { type: "string", description: "Free-form description of who this persona is. The more detail provided, the higher quality the generated persona. Include role, behaviors, pain points, tech usage, and goals." },
      },
      required: ["brand_kit_id", "persona_name", "persona_type", "description"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "preview_generate_ai_persona",
    title: "Preview Generated AI Persona",
    description: "READ-ONLY PREVIEW — no database write. Does not require approval in clients that honor readOnlyHint. Runs the AI persona-config generation against the brand's expression, personality, and governance context and returns the proposed config for review (source: 'ai_generated'). Nothing is saved. Pass the returned proposed_persona fields to create_brand_kit_persona to save it.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "UUID of the brand kit to generate the AI persona for." },
        name: { type: "string", description: "Name for the AI persona (e.g. 'Brand Voice Agent')." },
        purpose_type: { type: "string", enum: ["content_creation", "customer_support", "internal_assistant", "creative_brainstorming", "sales_enablement", "thought_leadership", "community_management", "product_education", "data_analysis", "custom"], description: "Primary function of this AI persona." },
        description: { type: "string", description: "What this AI persona should do, how it should behave, its role in the workflow, and any specific constraints or capabilities it should have." },
      },
      required: ["brand_kit_id", "name", "purpose_type", "description"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "generate_audience_persona",
    title: "Generate Target Audience Persona",
    description: GENERATE_PREFIX + "DEPRECATED: This tool writes immediately with no preview step and will be removed in a future release. Use preview_generate_audience_persona to review the proposed persona first, then create_audience_persona to save it. Existing integrations will continue to work until the deprecation window closes. (Legacy behavior: AI-generates a target audience persona using brand context and saves it. Costs 1 token. Requires an API key with the 'brand_kit:write' scope.)",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        persona_name: { type: "string", description: "Name for the audience persona (e.g. 'Marketing Mary', 'Enterprise IT Director')." },
        persona_type: { type: "string", enum: ["b2b", "b2c"], description: "Whether this is a B2B or B2C audience persona." },
        description: { type: "string", description: "Optional additional context to guide persona generation (e.g. specific industry focus, seniority level, use case)." },
        ...confirmParam,
      },
      required: ["brand_kit_id", "persona_name", "persona_type"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "generate_ai_persona",
    title: "Generate AI Persona",
    description: GENERATE_PREFIX + "DEPRECATED: This tool writes immediately with no preview step and will be removed in a future release. Use preview_generate_ai_persona to review the proposed persona first, then create_brand_kit_persona to save it. Existing integrations will continue to work until the deprecation window closes. (Legacy behavior: AI-generates an AI persona configuration using brand context and saves it. Costs 1 token. Requires an API key with the 'brand_kit:write' scope.)",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        name: { type: "string", description: "Name for the AI persona (e.g. 'Brand Ambassador', 'Customer Support Agent')." },
        purpose_type: { type: "string", enum: ["content_creation", "customer_support", "internal_assistant", "creative_brainstorming", "sales_enablement", "thought_leadership", "community_management", "product_education", "data_analysis", "custom"], description: "The primary purpose of this AI persona." },
        description: { type: "string", description: "Optional additional context or specific requirements for the persona." },
        base_archetype_name: { type: "string", description: "Optional base archetype name to ground the persona's voice and style." },
        base_archetype_traits: { type: "array", items: { type: "string" }, description: "Optional key traits from the base archetype." },
        target_audience_context: { type: "string", description: "Optional target audience this persona will serve (e.g. 'Marketing Managers - Enterprise')." },
        interaction_contexts: { type: "array", items: { type: "string" }, description: "Optional interaction contexts: formal_meeting, casual_chat, support_ticket, social_media, email, landing_page, documentation." },
        ...confirmParam,
      },
      required: ["brand_kit_id", "name", "purpose_type"]
    },
    annotations: writeAnnotation,
  },
  // ── Phase 2: Brand Kit Root & Visuals write tools ──────────────────────────
  {
    name: "update_brand_kit",
    title: "Update Brand Kit",
    description: WRITE_GOVERNANCE_PREFIX + "Update the brand kit's root-level metadata: name, description, tagline, website URL, social URLs, and industry details. All fields are optional. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        name: { type: "string", description: "Brand name." },
        description: { type: "string", description: "Brand description (short)." },
        long_summary: { type: "string", description: "Long-form brand summary (1,000–4,000 chars) typically generated via generate-brand-long-summary." },

        tagline: { type: "string", description: "Brand tagline." },
        website_url: { type: "string", description: "Brand website URL." },
        brand_kit_social_urls: { type: "array", items: { type: "object" }, description: "Array of social media URL objects with platform (string) and url (string)." },
        industry_details: { type: "object", description: "Industry classification details (sector, sub_sector, niche)." },
        og_image_url: { type: "string", description: "Open Graph share image URL for the brand." },
        additional_colors: { type: "array", items: { type: "object" }, description: "Additional brand colors beyond the core palette (array of color objects, e.g. { name, value })." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_brand_kit_visuals",
    title: "Update Brand Visual Identity",
    description: WRITE_GOVERNANCE_PREFIX + "Update the brand kit's visual identity: colors (primary, secondary, accent, background, text, link, custom 1-4), fonts (heading, body, paragraph, sizes, weights, list), spacing, button styles, and logo URLs. All fields are optional. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        primary_color: { type: "string", description: "Primary brand color (hex)." },
        secondary_color: { type: "string", description: "Secondary brand color (hex)." },
        accent_color: { type: "string", description: "Accent color (hex)." },
        background_color: { type: "string", description: "Background color (hex)." },
        text_primary_color: { type: "string", description: "Primary text color (hex)." },
        text_secondary_color: { type: "string", description: "Secondary text color (hex)." },
        link_color: { type: "string", description: "Link color (hex)." },
        color_scheme: { type: "string", description: "Color scheme name (e.g. 'light', 'dark', 'vibrant')." },
        color_details: { type: "object", description: "Additional color detail metadata." },
        custom_1_color: { type: "string" }, custom_1_name: { type: "string" },
        custom_2_color: { type: "string" }, custom_2_name: { type: "string" },
        custom_3_color: { type: "string" }, custom_3_name: { type: "string" },
        custom_4_color: { type: "string" }, custom_4_name: { type: "string" },
        heading_font: { type: "string", description: "Heading font family." },
        body_font: { type: "string", description: "Body font family." },
        paragraph_font: { type: "string", description: "Paragraph font family." },
        font_sizes: { type: "object", description: "Font size scale object." },
        font_weights: { type: "object", description: "Font weight mappings." },
        fonts_list: { type: "array", items: { type: "object" }, description: "Array of font objects with name and usage." },
        spacing: { type: "object", description: "Spacing scale object." },
        button_styles: { type: "object", description: "Button style configurations." },
        logo_url: { type: "string", description: "Primary logo URL." },
        logo_dark_url: { type: "string", description: "Dark-mode logo URL." },
        favicon_url: { type: "string", description: "Favicon URL." },
        css_custom_properties: { type: "object", description: "Raw :root design tokens dump (CSS custom properties). Typically auto-populated from a website scrape." },
        color_roles: { type: "object", description: "Semantic color roles (primary, secondary, accent, surface, border, text_primary, text_muted, success, error)." },
        font_scale: { type: "object", description: "Font size scale (xs, sm, base, lg, xl, display)." },
        line_heights: { type: "object", description: "Line height scale (heading, body)." },
        letter_spacing: { type: "object", description: "Letter spacing scale (heading, body)." },
        shadow_scale: { type: "object", description: "Box shadow scale (sm, md, lg)." },
        border_radius_scale: { type: "object", description: "Border radius scale (sm, md, lg, full)." },
        spacing_scale: { type: "object", description: "Full spacing scale array [4,8,12,16,24,32,48,64,96]." },
        button_variants: { type: "object", description: "Button variants (primary, secondary, ghost) each with full styles." },
        input_styles: { type: "object", description: "Input field styles." },
        card_styles: { type: "object", description: "Card styles." },
        max_container_width: { type: "string", description: "Max content container width." },
        breakpoints: { type: "object", description: "Responsive breakpoints (mobile, tablet, desktop)." },
        dark_mode_tokens: { type: "object", description: "Dark mode variant of css_custom_properties." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "get_brand_kit_visuals",
    title: "Get Brand Visual Identity",
    description: "Get the brand kit's visual identity: colors, fonts, spacing, button styles, logo/favicon/OG URLs, semantic color roles, design-token scales, and the server-computed tailwind_config / css_variables_export. Mirrors everything update_brand_kit_visuals can write. Use when generating on-brand designs or exporting design tokens.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit." }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  // ── Phase 3: New table tools ───────────────────────────────────────────────
  {
    name: "get_brand_kit_seo",
    title: "Get Brand SEO",
    description: "Get the brand kit's SEO data: keywords, tags, and suggested keywords. Use when creating SEO-optimized content or analyzing keyword strategy.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" }, ...fieldsParam },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "upsert_brand_kit_seo",
    title: "Update Brand SEO",
    description: WRITE_GOVERNANCE_PREFIX + "Create or update the brand kit's SEO section: keywords, tags, and suggested keywords. All fields are optional. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        keywords: { type: "array", items: { type: "object" }, description: "Array of keyword objects with keyword (string), volume (number), difficulty (string)." },
        tags: { type: "array", items: { type: "object" }, description: "Array of tag objects." },
        suggested_keywords: { type: "array", items: { type: "object" }, description: "Array of AI-suggested keyword objects." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "request_social_profile_scrape",
    title: "Request Social Profile Scrape",
    description: WRITE_GOVERNANCE_PREFIX + "Trigger Brand Kit OS to scrape a social profile (the same server-side APIFY/n8n workflow the app UI runs) and populate the brand's social_profiles. You provide the profile URL; the server owns the scrape, formatting, storage, and token charging — agents cannot write profile fields directly. The scrape runs in the BACKGROUND (usually < ~45s) and does not block: do not wait on it. The row is marked 'pending' immediately; after ~90 seconds call get_brand_kit_social_profiles to see status flip to 'active' (or 'error') and read the populated data. 'profile' and 'posts' are separate scrapes. Posts scraping is metered (1 token per 10 posts); the server caps the request to the credits the user can afford (including overage). Only Instagram and Facebook are supported today. Requires an API key with the brand-kit write scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        platform: { type: "string", enum: ["instagram", "facebook"], description: "Social platform (Instagram and Facebook only for now)." },
        profile_type: { type: "string", enum: ["personal", "company"], description: "Whether this is a personal or company profile." },
        profile_url: { type: "string", description: "Public URL of the social profile to scrape (required)." },
        scrape_type: { type: "string", enum: ["profile", "posts"], description: "Which scrape to run: 'profile' (profile details — not metered) or 'posts' (recent posts — metered). Default 'profile'." },
        results_limit: { type: "number", description: "Posts-only. Max posts to scrape (default 200). The server caps this to what the user's credits cover." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "platform", "profile_type", "profile_url"],
    },
    annotations: writeAnnotation,
  },

  {
    name: "list_expression_examples",
    title: "List Expression Examples",
    description: "List all expression examples (content samples demonstrating brand voice) for a brand kit. Returns platform, context type, user response, and original content. Use when reviewing voice consistency or finding reference content.",
    inputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", description: "The UUID of the brand kit" } },
      required: ["brand_kit_id"]
    },
    annotations: readOnlyAnnotation,
  },
  {
    name: "create_expression_example",
    title: "Create Expression Example",
    description: WRITE_GOVERNANCE_PREFIX + "Add a new expression example (brand voice content sample) to the brand kit. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        platform: { type: "string", description: "Platform where this content appears (e.g. 'linkedin', 'twitter', 'email', 'blog')." },
        context_type: { type: "string", description: "Type of content (e.g. 'post', 'reply', 'headline', 'caption', 'cta')." },
        user_response: { type: "string", description: "The brand-voice content example text." },
        original_content: { type: "string", description: "Optional: the original content being responded to or adapted." },
        platform_metadata: { type: "object", description: "Optional platform-specific metadata (e.g. character limits, hashtags, formatting notes) stored alongside the example." },
        source: { type: "string", enum: ["manual", "n8n", "import"], description: "How this example was created (must match the DB CHECK on expression_examples.source). Default: 'manual'." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "platform", "context_type", "user_response"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_expression_example",
    title: "Update Expression Example",
    description: WRITE_GOVERNANCE_PREFIX + "Update an existing expression example (brand voice content sample). Requires the example's UUID. All content fields are optional — only provided fields are updated. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        example_id: { type: "string", description: "The UUID of the expression example to update." },
        brand_kit_id: { type: "string", description: "The UUID of the brand kit (for access verification)." },
        platform: { type: "string", description: "Platform where this content appears (e.g. 'linkedin', 'twitter', 'email', 'blog')." },
        context_type: { type: "string", description: "Type of content (e.g. 'post', 'reply', 'headline', 'caption', 'cta')." },
        user_response: { type: "string", description: "The brand-voice content example text." },
        original_content: { type: "string", description: "The original content being responded to or adapted." },
        platform_metadata: { type: "object", description: "Platform-specific metadata (e.g. character limits, hashtags, formatting notes)." },
        source: { type: "string", enum: ["manual", "n8n", "import"], description: "How this example was created (must match the DB CHECK on expression_examples.source)." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["example_id", "brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "create_brand_kit_competitor",
    title: "Create Competitor",
    description: "[WRITE TOOL] Two-step confirmation, server-enforced. Send EXACTLY one of these two calls, never both flags together:\n  1) Preview: { dry_run: true, ...args }   — returns a diff. No DB write.\n  2) Commit:  { confirm: true,  ...args }   — writes to DB. Do NOT include dry_run on this call.\nPassing { dry_run: true, confirm: true } is rejected as a validation_error. Passing neither flag is rejected as confirmation_required.\n\nAdd a new competitor to the brand kit. Before calling, scrape the competitor URL to extract all available fields: brand_colors (hex values), fonts (heading and body typefaces), color_scheme (light or dark), design_framework, tagline, value_propositions, and brand_personality. Also extract social_profiles, typography details, button_styles, and spacing if visible. At least one visual-identity field must be non-empty — populate from the live site or explicitly flag what could not be found and why. The server also runs its own Firecrawl scrape and returns a scrape_status (success | partial | blocked | timeout | no_api_key | no_data) on the response so you can tell the user when the scraper failed and the write proceeded with manual fields only. Example commit payload: {\"brand_kit_id\":\"<uuid>\",\"url\":\"https://example.com\",\"name\":\"Example\",\"tagline\":\"Better, faster\",\"brand_colors\":[\"#0a0a0a\",\"#ffffff\"],\"fonts\":[\"Inter\",\"Source Serif\"],\"color_scheme\":\"light\",\"design_framework\":\"custom\",\"social_profiles\":[{\"platform\":\"linkedin\",\"url\":\"https://linkedin.com/company/example\"}],\"typography\":{\"heading\":\"Inter 600 48px\",\"body\":\"Inter 400 16px\"},\"button_styles\":{\"background_color\":\"#0a0a0a\",\"text_color\":\"#ffffff\",\"border_radius\":\"8px\",\"font_weight\":\"600\"},\"spacing\":{\"base_unit\":\"8px\",\"padding\":\"24px\",\"margin\":\"48px\"},\"confirm\":true}. Requires an API key with the brand_kit:write scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        name: { type: "string", description: "Competitor name." },
        url: { type: "string", description: "Competitor website URL." },
        logo_url: { type: "string", description: "Competitor logo image URL." },
        short_description: { type: "string", description: "Concise competitor summary, 150–300 characters. Shown in competitor list cards." },
        long_description: { type: "string", description: "Detailed competitor analysis, 1,000–4,000 characters. Shown in the competitor detail view." },
        description: { type: "string", description: "DEPRECATED alias for short_description. Prefer short_description." },
        tagline: { type: "string", description: "Competitor tagline." },
        value_propositions: { type: "array", items: { type: "string" }, description: "Competitor value propositions." },
        brand_personality: { type: "object", description: "Competitor brand personality analysis." },
        brand_colors: { type: "array", items: { type: "string" }, description: "Competitor brand colors (hex values)." },
        fonts: { type: "array", items: { type: "string" }, description: "Competitor fonts." },
        color_scheme: { type: "string", description: "Overall color scheme, e.g. 'light' or 'dark'." },
        design_framework: { type: "string", description: "Detected design system or framework (e.g. 'Tailwind', 'Material', 'custom')." },
        social_profiles: {
          type: "array",
          description: "Competitor social profiles linked from the live site.",
          items: {
            type: "object",
            properties: {
              platform: { type: "string", description: "Social platform name, e.g. 'linkedin', 'twitter', 'instagram'." },
              url: { type: "string", description: "Full URL of the social profile." },
            },
            required: ["platform", "url"],
          },
        },
        typography: {
          type: "object",
          description: "Typography usage observed on the competitor's site.",
          properties: {
            heading: { type: "string", description: "Heading typeface and sizing notes." },
            body: { type: "string", description: "Body typeface and sizing notes." },
          },
        },
        button_styles: {
          type: "object",
          description: "CTA button appearance observed on the competitor's site.",
          properties: {
            background_color: { type: "string", description: "Button background color (hex or token)." },
            text_color: { type: "string", description: "Button text color (hex or token)." },
            border_radius: { type: "string", description: "Button corner radius (e.g. '8px', 'full')." },
            font_weight: { type: "string", description: "Button font weight (e.g. '500', 'bold')." },
          },
        },
        spacing: {
          type: "object",
          description: "Layout spacing conventions observed on the competitor's site.",
          properties: {
            base_unit: { type: "string", description: "Base spacing unit (e.g. '4px', '8px')." },
            padding: { type: "string", description: "Typical container padding." },
            margin: { type: "string", description: "Typical section margin." },
          },
        },
        color_roles: { type: "object", description: "Semantic color roles (primary, secondary, accent, surface, border, text_primary, text_muted, success, error)." },
        font_scale: { type: "object", description: "Font size scale (xs, sm, base, lg, xl, display) in px." },
        line_heights: { type: "object", description: "Line height scale (heading, body)." },
        letter_spacing: { type: "object", description: "Letter spacing scale (heading, body)." },
        shadow_scale: { type: "object", description: "Box shadow scale (sm, md, lg)." },
        border_radius_scale: { type: "object", description: "Border radius scale (sm, md, lg, full)." },
        input_styles: { type: "object", description: "Input field styles (border_color, border_radius, focus_color, background)." },
        card_styles: { type: "object", description: "Card styles (background, border_radius, shadow, border)." },
        nav_styles: { type: "object", description: "Navigation styles (background, link_color, hover_color, sticky)." },
        max_container_width: { type: "string", description: "Max content container width (e.g. '1200px')." },
        breakpoints: { type: "object", description: "Responsive breakpoints (mobile, tablet, desktop)." },
        dark_mode_support: { type: "boolean", description: "Whether the site offers dark mode." },
        gradient_usage: { type: "string", description: "Plain-language note on gradient usage observed on the site." },
        animation_style: { type: "string", description: "Observed animation style: 'minimal' | 'smooth' | 'aggressive' | 'none'." },
        ...dryRunParam, ...confirmParam,
        confirm: { type: "boolean", description: "Set to true to commit the write after the user has approved the dry_run preview. Required when dry_run is false." },
      },
      required: ["brand_kit_id", "url"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_brand_kit_competitor",
    title: "Update Competitor",
    description: "[WRITE TOOL] Two-step confirmation, server-enforced. Send EXACTLY one of these two calls, never both flags together:\n  1) Preview: { dry_run: true, ...args }   — returns a diff. No DB write.\n  2) Commit:  { confirm: true,  ...args }   — writes to DB. Do NOT include dry_run on this call.\nPassing { dry_run: true, confirm: true } is rejected as a validation_error. Passing neither flag is rejected as confirmation_required.\n\nUpdate an existing competitor in the brand kit. All fields are optional — only provided fields are updated. When updating visual identity fields, source values from the competitor's live site. Example commit payload: {\"competitor_id\":\"<uuid>\",\"brand_kit_id\":\"<uuid>\",\"social_profiles\":[{\"platform\":\"twitter\",\"url\":\"https://twitter.com/example\"}],\"typography\":{\"heading\":\"Söhne 700 56px\",\"body\":\"Söhne 400 17px\"},\"button_styles\":{\"background_color\":\"#1a73e8\",\"text_color\":\"#ffffff\",\"border_radius\":\"6px\",\"font_weight\":\"500\"},\"spacing\":{\"base_unit\":\"4px\",\"padding\":\"16px\",\"margin\":\"32px\"},\"confirm\":true}. Requires an API key with the brand_kit:write scope.",
    inputSchema: {
      type: "object",
      properties: {
        competitor_id: { type: "string", description: "The UUID of the competitor to update." },
        brand_kit_id: { type: "string", description: "The UUID of the brand kit (for access verification)." },
        name: { type: "string" },
        url: { type: "string" },
        logo_url: { type: "string" },
        short_description: { type: "string", description: "Concise competitor summary, 150–300 characters." },
        long_description: { type: "string", description: "Detailed competitor analysis, 1,000–4,000 characters." },
        description: { type: "string", description: "DEPRECATED alias for short_description. Prefer short_description." },
        tagline: { type: "string" },
        value_propositions: { type: "array", items: { type: "string" } },
        brand_personality: { type: "object" },
        brand_colors: { type: "array", items: { type: "string" } },
        fonts: { type: "array", items: { type: "string" } },
        color_scheme: { type: "string" },
        design_framework: { type: "string" },
        social_profiles: {
          type: "array",
          description: "Competitor social profiles linked from the live site.",
          items: {
            type: "object",
            properties: {
              platform: { type: "string", description: "Social platform name, e.g. 'linkedin', 'twitter', 'instagram'." },
              url: { type: "string", description: "Full URL of the social profile." },
            },
            required: ["platform", "url"],
          },
        },
        typography: {
          type: "object",
          description: "Typography usage observed on the competitor's site.",
          properties: {
            heading: { type: "string", description: "Heading typeface and sizing notes." },
            body: { type: "string", description: "Body typeface and sizing notes." },
          },
        },
        button_styles: {
          type: "object",
          description: "CTA button appearance observed on the competitor's site.",
          properties: {
            background_color: { type: "string", description: "Button background color (hex or token)." },
            text_color: { type: "string", description: "Button text color (hex or token)." },
            border_radius: { type: "string", description: "Button corner radius (e.g. '8px', 'full')." },
            font_weight: { type: "string", description: "Button font weight (e.g. '500', 'bold')." },
          },
        },
        spacing: {
          type: "object",
          description: "Layout spacing conventions observed on the competitor's site.",
          properties: {
            base_unit: { type: "string", description: "Base spacing unit (e.g. '4px', '8px')." },
            padding: { type: "string", description: "Typical container padding." },
            margin: { type: "string", description: "Typical section margin." },
          },
        },
        color_roles: { type: "object", description: "Semantic color roles." },
        font_scale: { type: "object", description: "Font size scale (xs, sm, base, lg, xl, display)." },
        line_heights: { type: "object", description: "Line height scale." },
        letter_spacing: { type: "object", description: "Letter spacing scale." },
        shadow_scale: { type: "object", description: "Box shadow scale." },
        border_radius_scale: { type: "object", description: "Border radius scale." },
        input_styles: { type: "object", description: "Input field styles." },
        card_styles: { type: "object", description: "Card styles." },
        nav_styles: { type: "object", description: "Navigation styles." },
        max_container_width: { type: "string", description: "Max content container width." },
        breakpoints: { type: "object", description: "Responsive breakpoints." },
        dark_mode_support: { type: "boolean", description: "Whether the site offers dark mode." },
        gradient_usage: { type: "string", description: "Note on gradient usage observed on the site." },
        animation_style: { type: "string", description: "Observed animation style: 'minimal' | 'smooth' | 'aggressive' | 'none'." },
        ...dryRunParam, ...confirmParam,
        confirm: { type: "boolean", description: "Set to true to commit the write after the user has approved the dry_run preview. Required when dry_run is false." },
      },
      required: ["competitor_id", "brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "update_logo_asset",
    title: "Update Logo Asset Metadata",
    description: WRITE_GOVERNANCE_PREFIX + "Update metadata for an existing logo asset (label, description, usage guidelines, default status, sort order). Does not handle file uploads — only metadata. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "The UUID of the logo asset to update." },
        brand_kit_id: { type: "string", description: "The UUID of the brand kit (for access verification)." },
        label: { type: "string", description: "Display label for the asset." },
        description: { type: "string", description: "Short description." },
        long_description: { type: "string", description: "Detailed description of the asset." },
        usage_guidelines: { type: "string", description: "When and how to use this asset." },
        is_default: { type: "boolean", description: "Whether this is the default logo." },
        sort_order: { type: "integer", description: "Display sort order." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["asset_id", "brand_kit_id"]
    },
    annotations: writeAnnotation,
  },
  {
    name: "list_compliance_standards",
    title: "List Compliance Standards",
    description: "List the library of compliance standards available to attach to a brand kit's governance section (GDPR, CCPA, HIPAA, etc.) plus any custom standards the user has previously added. Use this BEFORE calling upsert_brand_kit_governance with compliance_selections so each selection includes a valid standard_id and name. Returns: id, name, full_name, description, region, category, is_library, website_url.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: readOnlyAnnotation,
  },
  {
    name: "get_disclosure_diligence_questions",
    title: "Get AI Disclosure Diligence Questions",
    description: "Return the three sets of AI-diligence questions (creation, transparency, deployment) the user should answer before generating disclosure statements. Use this to drive an interactive Q&A in chat: ask the user each question, collect answers, then call generate_disclosure_statement per section. The answers and generated statements both go into upsert_brand_kit_governance.disclosure_statements.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: readOnlyAnnotation,
  },
  {
    name: "generate_disclosure_statement",
    title: "Generate AI Disclosure Statement",
    description: GENERATE_PREFIX + "Generate a single AI-diligence disclosure statement (creation, transparency, OR deployment) from the user's answers to that section's questions. Costs 1 token. Returns { statement, category } — merge into disclosure_statements[category] and the matching answers into disclosure_statements.answers[category] before calling upsert_brand_kit_governance. Requires an API key with the 'brand_kit:write:governance' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        category: { type: "string", enum: ["creation", "transparency", "deployment"], description: "Which diligence category this statement covers." },
        answers: {
          type: "object",
          description: "Map of question id (q0, q1, q2) to the user's answer text. Get the questions via get_disclosure_diligence_questions.",
          additionalProperties: { type: "string" },
        },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "category", "answers"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_brand_kit_product",
    title: "Delete Brand Product",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete a product/service from the brand kit. Call get_brand_kit_products first to find the product_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        product_id: { type: "string", description: "The UUID of the product to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "product_id"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_brand_kit_competitor",
    title: "Delete Competitor",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete a competitor from the brand kit. Call get_brand_kit_competitors first to find the competitor_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        competitor_id: { type: "string", description: "The UUID of the competitor to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "competitor_id"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_audience_persona",
    title: "Delete Audience Persona",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete an audience persona from the brand kit. Call get_brand_kit_audience first to find the persona_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        persona_id: { type: "string", description: "The UUID of the audience persona to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "persona_id"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_brand_kit_persona",
    title: "Delete AI Persona",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete an AI persona from the brand kit. Call get_brand_kit_personas first to find the persona_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        persona_id: { type: "string", description: "The UUID of the AI persona to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "persona_id"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_expression_example",
    title: "Delete Expression Example",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete an expression example from the brand kit. Call list_expression_examples first to find the example_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        example_id: { type: "string", description: "The UUID of the expression example to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "example_id"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_logo_asset",
    title: "Delete Logo Asset",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete a logo asset from the brand kit. Call list_logo_assets first to find the asset_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit." },
        asset_id: { type: "string", description: "The UUID of the logo asset to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "asset_id"],
    },
    annotations: writeAnnotation,
  },
  {
    name: "delete_knowledge_file",
    title: "Delete Knowledge File",
    description: WRITE_GOVERNANCE_PREFIX + "Permanently delete a knowledge file (row + stored object) from the brand kit. Call list_knowledge_files first to find the file_id. Requires an API key with the 'brand_kit:write' scope.",
    inputSchema: {
      type: "object",
      properties: {
        brand_kit_id: { type: "string", description: "The UUID of the brand kit the file belongs to." },
        file_id: { type: "string", description: "The UUID of the knowledge file to delete." },
        ...dryRunParam, ...confirmParam,
      },
      required: ["brand_kit_id", "file_id"],
    },
    annotations: writeAnnotation,
  },
];

export const resourceTemplates = [
  {
    uriTemplate: "brandkit://{brand_kit_id}",
    name: "Brand Kit",
    description: "Root resource for a brand kit. For targeted data, use the dedicated get_brand_kit_* tools with this brand_kit_id rather than reading the full resource. The full resource payload is large — prefer get_brand_kit_summary first.",
    mimeType: "application/json"
  }
];

// MCP Prompts
export const prompts = [
  {
    name: "brand_voice_check",
    title: "Brand Voice Check",
    description: "Analyze text and evaluate whether it matches the brand's tone, personality, and expression guidelines. Returns feedback on alignment and suggestions for improvement.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit to check against", required: true },
      { name: "text", description: "The text content to evaluate for brand voice alignment", required: true },
    ],
  },
  {
    name: "social_profile_scrape_followup",
    title: "Social Profile Scrape Follow-up",
    description: "Guidance for after calling request_social_profile_scrape: the scrape runs in the background (~45s). Do not block the user. After ~90 seconds, re-check get_brand_kit_social_profiles to see whether the profile's status flipped from 'pending' to 'active' (or 'error') and read the populated fields.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit whose social scrape was started", required: true },
    ],
  },
  {
    name: "generate_brand_copy",
    title: "Generate Brand Copy",
    description: "Generate on-brand marketing copy for a specific channel (social, email, web, ad) using the brand kit's voice, tone, and governance guidelines.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit to use", required: true },
      { name: "channel", description: "The target channel: social, email, web, ad, or blog", required: true },
      { name: "topic", description: "The subject or topic for the copy", required: true },
    ],
  },
  {
    name: "brand_intro",
    title: "Brand Introduction",
    description: "Create a concise brand introduction or elevator pitch using the brand kit's core identity, mission, values, and personality.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit", required: true },
      { name: "format", description: "The format: elevator_pitch, bio, about_page, or tagline_options", required: false },
    ],
  },
  {
    name: "competitor_positioning",
    title: "Competitor Positioning Analysis",
    description: "Summarize how the brand differentiates from its competitors based on stored competitor data, value propositions, and brand personality.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit", required: true },
    ],
  },
  {
    name: "audience_persona_brief",
    title: "Audience Persona Brief",
    description: "Generate a concise persona brief for a target audience segment, useful for campaign planning and content strategy.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit", required: true },
      { name: "persona_name", description: "Optional: name of a specific persona to focus on. If omitted, all personas are summarized.", required: false },
    ],
  },
  {
    name: "create_target_audience",
    title: "Create Target Audience Persona (Guided)",
    description: "Guided multi-step interview to create a new target audience persona. Walks the user through demographics, goals, pain points, buying behavior, and preferred channels one question at a time. Presents a confirmation summary before writing to the brand kit. Use this instead of calling generate_audience_persona directly.",
    arguments: [
      { name: "brand_kit_id", description: "The UUID of the brand kit", required: true },
      { name: "persona_type", description: "b2b or b2c", required: true },
      { name: "persona_name", description: "Name for the persona, e.g. 'Marketing Mary'", required: true },
    ],
  },
  {
    name: "create_ai_persona_guided",
    title: "Create AI Persona (Guided)",
    description: "Guided multi-step interview to create a new AI persona for a brand kit. Covers purpose, tone, behavioral rules, forbidden actions, and target audience. Presents a confirmation summary before writing. Use this instead of calling generate_ai_persona directly.",
    arguments: [
      { name: "brand_kit_id", description: "UUID of the brand kit", required: true },
      { name: "persona_name", description: "Name for the AI persona", required: true },
      { name: "purpose_type", description: "content_creation, customer_support, internal_assistant, sales_enablement, thought_leadership, community_management, product_education, or custom", required: true },
    ],
  },
];
