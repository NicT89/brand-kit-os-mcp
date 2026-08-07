import { TOOLS_WITHOUT_BRAND_KIT_ID_ARG } from "./constants.ts";
import { dispatchTool } from "./tools/dispatch.ts";
import type { ToolHandlerContext } from "./tools/types.ts";
import { toolError } from "./tool-errors.ts";
import { validateUuidParam } from "./validation.ts";
import { NOOP_NOTIFY, type NotifyContext } from "./notify.ts";

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  supabaseAdmin: unknown,
  scopes: string[] = [],
  requestId?: string,
  notify: NotifyContext = NOOP_NOTIFY,
) {
  console.log(`Executing tool: ${toolName} with args:`, args);

  if (!TOOLS_WITHOUT_BRAND_KIT_ID_ARG.has(toolName)) {
    const vid = validateUuidParam(args?.brand_kit_id, "brand_kit_id");
    if (!("ok" in vid)) return vid;
    args = { ...args, brand_kit_id: vid.value };
  }

  const ctx: ToolHandlerContext = {
    args,
    userId,
    supabaseAdmin,
    scopes,
    requestId,
    log: notify.log,
    progress: notify.progress,
  };

  const result = await dispatchTool(toolName, ctx);
  if (result !== undefined) return result;

  return toolError(`Unknown tool: ${toolName}`, {
    code: "validation_error",
    recovery: "Call tools/list to see the available tools.",
  });
}
