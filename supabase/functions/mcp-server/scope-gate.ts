import {
  brandKitSectionScope,
  hasBrandKitSectionWrite,
  type BrandKitWriteSection,
} from "../_shared/mcp-scopes.ts";
import { BRAND_KIT_WRITE_SCOPE } from "./constants.ts";
import { SCOPE_DENIED_RECOVERY, toolError } from "./tool-errors.ts";

export function assertBrandKitSectionScope(
  scopes: string[],
  section: BrandKitWriteSection,
) {
  if (hasBrandKitSectionWrite(scopes, section)) return null;

  const required = brandKitSectionScope(section);
  return toolError(
    `This tool requires the '${required}' scope (or '${BRAND_KIT_WRITE_SCOPE}' for all sections).`,
    {
      code: "scope_denied",
      recovery: SCOPE_DENIED_RECOVERY(required),
      data: {
        required_scope: required,
        required_section: section,
        scopes_present: scopes,
      },
    },
  );
}
