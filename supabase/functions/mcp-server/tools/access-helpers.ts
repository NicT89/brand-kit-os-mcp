import { verifyBrandKitAccess } from "../brand-access.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import type { ToolHandlerResult } from "./types.ts";

export function jsonContent(data: unknown): ToolHandlerResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export async function requireBrandKitReadAccess(
  brandKitId: string,
  userId: string,
  supabaseAdmin: any,
): Promise<ToolHandlerResult | null> {
  if (!brandKitId) {
    return toolError("brand_kit_id is required", {
      code: "validation_error",
      recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument.",
    });
  }
  const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
  if (!hasAccess) {
    return toolError("Access denied to this brand kit", {
      code: "access_denied",
      recovery: ACCESS_DENIED_RECOVERY,
    });
  }
  return null;
}

/** Read access + MCP write membership gate for mutation tools. */
export async function requireBrandKitWriteAccess(
  brandKitId: string,
  userId: string,
  supabaseAdmin: any,
  assertMcpWrite: (brandKitId: string, userId: string, supabaseAdmin: any) => Promise<ToolHandlerResult | null>,
): Promise<ToolHandlerResult | null> {
  const readGate = await requireBrandKitReadAccess(brandKitId, userId, supabaseAdmin);
  if (readGate) return readGate;
  return assertMcpWrite(brandKitId, userId, supabaseAdmin);
}
