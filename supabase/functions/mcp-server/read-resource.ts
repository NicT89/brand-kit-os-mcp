import { verifyBrandKitAccess } from "./brand-access.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "./tool-errors.ts";
import { executeTool } from "./execute-tool.ts";
import { toolErrorToRpc } from "./tool-rpc.ts";
import { validateUuidParam } from "./validation.ts";
import { effectiveVocabularies, loadVocabularySnapshot } from "../_shared/persona-vocabulary.ts";

/**
 * Shared platform libraries, readable without a brand kit: the approved font
 * library and the persona vocabulary gate's allowed values. Agents read these
 * before writing typography or persona fields so they send values the write
 * handlers will accept.
 */
async function readLibraryResource(name: string, supabaseAdmin: any) {
  if (name === 'fonts') {
    const { data, error } = await supabaseAdmin
      .from('font_library')
      .select('family, normalized_family, category, source, is_open_source, is_verified')
      .eq('is_active', true)
      .order('family', { ascending: true });
    if (error) return { error: { code: -32603, message: error.message } };
    return {
      contents: [{
        uri: 'library://fonts',
        mimeType: 'application/json',
        text: JSON.stringify({
          fonts: data ?? [],
          note: "Write typography fields using the exact 'family' value. Unrecognized families are recorded for admin review and may be rejected.",
        }, null, 2),
      }],
    };
  }

  if (name === 'vocabulary') {
    const snapshot = await loadVocabularySnapshot(supabaseAdmin);
    const fields = effectiveVocabularies(snapshot).map((vocab) => ({
      field: vocab.field,
      parent: vocab.parent,
      label: vocab.label,
      mode: vocab.mode,
      multi: vocab.multi,
      options: vocab.options,
      guidance: vocab.guidance,
    }));
    return {
      contents: [{
        uri: 'library://vocabulary',
        mimeType: 'application/json',
        text: JSON.stringify({
          fields,
          note: "Closed fields reject values outside 'options'. Open fields accept new values, which are added to the shared library.",
        }, null, 2),
      }],
    };
  }

  return { error: { code: -32602, message: `Unknown library resource: ${name}` } };
}

export async function readResource(uri: string, userId: string, supabaseAdmin: any) {
  console.log(`Reading resource: ${uri}`);

  const libraryMatch = uri.match(/^library:\/\/(.+)$/);
  if (libraryMatch) return readLibraryResource(libraryMatch[1], supabaseAdmin);

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
