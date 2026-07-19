# MCP server layout

**Runtime entry:** `index.ts` (Supabase Edge Function).

## Direction

Brand Kit OS depends heavily on MCP. The handler is split into a thin dispatcher plus modular tool handlers:

- **`execute-tool.ts`** — UUID validation, then `dispatchTool()` from `tools/dispatch.ts`.
- **`tools/dispatch.ts`** — Merges all handler registries and routes by tool name.
- **`tools/types.ts`** — `ToolHandlerContext`, `ToolHandler`, `ToolHandlerResult`.
- **`tools/access-helpers.ts`** — Shared read/write access gates and JSON content helper.
- **`tools/section-read-handlers.ts`** — Section `get_*` read tools.
- **`tools/list-handlers.ts`** — `list_brand_kits`.
- **`tools/preview-handlers.ts`** — `preview_brand_kit_*_update` dry-run tools.
- **`tools/read-aggregate-handlers.ts`** — Merges bundled read tools (`get_brand_kit`, summary, completeness, agent context, system prompt).
- **`tools/read-brand-kit-handlers.ts`** — `get_brand_kit`, `get_brand_kit_summary`.
- **`tools/read-completeness-handlers.ts`** — `get_brand_kit_completeness`.
- **`tools/read-context-handlers.ts`** — `get_brand_context_for_agent`, `get_persona_system_prompt`.
- **`tools/knowledge-handlers.ts`** — Knowledge files and logo asset list/get/upload.
- **`tools/upsert-handlers.ts`** — Section upserts (core, personality, expression, governance).
- **`tools/mutate-handlers.ts`** — Product/audience/persona/SEO/expression example/logo mutations.
- **`tools/generate-handlers.ts`** — AI generation tools (audience + AI persona).
- **`tools/brand-write-handlers.ts`** — Root brand kit and visuals updates.
- **`tools/competitor-handlers.ts`** — Competitor create/update.
- **`tool-errors.ts`** — Structured tool errors and recovery hints.
- **`validation.ts`** — UUID validation and MCP write membership gate.
- **`scope-gate.ts`** — Section-scoped write checks.
- **`contract.test.ts`** — Deno unit tests (`npm run test:mcp-contract`).
- **`tools/section-map.ts`** — Canonical section→tool mapping returned by the `list_brand_kit_tools` MCP tool. Update this when adding a new section tool.

`index.ts` imports **`execute-tool.ts`**, **`read-resource.ts`**, **`execute-prompt.ts`**, **`tools-catalog.ts`**, **`session.ts`**, **`auth.ts`**, **`rate-limit.ts`**, and **`competitor-validation.ts`**. Do not re-inline the tool switch in `index.ts`.

## Local checks

```bash
npm run test:mcp-contract
npx deno check supabase/functions/mcp-server/index.ts
```

Further tool changes should attach to **one handler module per PR** after parity verification with contract tests.
