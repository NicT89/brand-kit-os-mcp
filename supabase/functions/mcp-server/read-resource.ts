import { verifyBrandKitAccess } from "./brand-access.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "./tool-errors.ts";
import { executeTool } from "./execute-tool.ts";
import { toolErrorToRpc } from "./tool-rpc.ts";
import { validateUuidParam } from "./validation.ts";

export async function readResource(uri: string, userId: string, supabaseAdmin: any) {
  console.log(`Reading resource: ${uri}`);

  const match = uri.match(/^brandkit:\/\/([^/]+)(\/(.+))?$/);
  if (!match) return { error: { code: -32602, message: `Invalid resource URI: ${uri}` } };

  const brandKitIdRaw = match[1];
  const idRes = validateUuidParam(brandKitIdRaw, 'brand_kit_id');
  if (!('ok' in idRes)) return toolErrorToRpc(idRes) ?? idRes;
  const brandKitId = idRes.value;
  const subResource = match[3];

  const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
  if (!hasAccess) {
    const denied = toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    return toolErrorToRpc(denied) ?? denied;
  }

  const toolMapping: Record<string, string> = {
    'core': 'get_brand_kit_core',
    'personality': 'get_brand_kit_personality',
    'expression': 'get_brand_kit_expression',
    'products': 'get_brand_kit_products',
    'audience': 'get_brand_kit_audience',
    'governance': 'get_brand_kit_governance',
    'personas': 'get_brand_kit_personas',
    'competitors': 'get_brand_kit_competitors',
    'social_profiles': 'get_brand_kit_social_profiles',
    'logo_assets': 'get_brand_kit_logo_assets'
  };

  if (!subResource) {
    const result = await executeTool('get_brand_kit', { brand_kit_id: brandKitId }, userId, supabaseAdmin);
    return toolErrorToRpc(result) ?? result;
  }

  const toolName = toolMapping[subResource];
  if (!toolName) return { error: { code: -32602, message: `Unknown sub-resource: ${subResource}` } };

  const result = await executeTool(toolName, { brand_kit_id: brandKitId }, userId, supabaseAdmin);
  return toolErrorToRpc(result) ?? result;
}
