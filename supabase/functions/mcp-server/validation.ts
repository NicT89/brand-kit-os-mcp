import { ACCESS_DENIED_RECOVERY, MEMBER_MCP_WRITE_DENIED_RECOVERY, toolError } from "./tool-errors.ts";

const RFC4122_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function looksLikePlaceholderUuid(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^PASTE_/i.test(t)) return true;
  if (/^YOUR[-_]?/i.test(t)) return true;
  if (/^<[^>]+>$/.test(t)) return true;
  if (/UUID|PLACEHOLDER|TBD|TODO|EXAMPLE|^kit[-_]?id$/i.test(t)) return true;
  if (/YOUR-BRAND|YOUR_BRAND|MY-KIT|PASTE[-_]?(UUID|ID)/i.test(t)) return true;
  return false;
}

/** Returns normalized UUID string, or a toolError result object (discriminate with `.isError === true`). */
export function validateUuidParam(raw: unknown, fieldName: string) {
  if (raw === undefined || raw === null) {
    return toolError(`${fieldName} is required`, {
      code: "validation_error",
      recovery:
        fieldName === "brand_kit_id"
          ? "Call list_brand_kits first and pass the id from the response."
          : `Pass a valid ${fieldName} from the appropriate list tool.`,
    });
  }
  const s = String(raw).trim();
  if (!s) {
    return toolError(`${fieldName} is required`, {
      code: "validation_error",
      recovery: "Provide a non-empty UUID string.",
    });
  }
  if (looksLikePlaceholderUuid(s)) {
    return toolError(`Invalid ${fieldName}: looks like a placeholder or template, not a real id.`, {
      code: "validation_error",
      recovery: `Use the real UUID from list_brand_kits or the relevant list tool — do not paste documentation examples.`,
    });
  }
  if (!RFC4122_UUID_REGEX.test(s)) {
    return toolError(`Invalid ${fieldName}: expected a UUID in 8-4-4-4-12 hexadecimal form (RFC 4122).`, {
      code: "validation_error",
      recovery: `Copy the id exactly from list_brand_kits (or the tool that returned this entity).`,
    });
  }
  return { ok: true as const, value: s.toLowerCase() };
}

export async function assertBrandKitMcpWriteAllowed(
  brandKitId: string,
  userId: string,
  supabaseAdmin: any,
) {
  const { data: owned } = await supabaseAdmin
    .from("brand_kits")
    .select("id")
    .eq("id", brandKitId)
    .eq("user_id", userId)
    .maybeSingle();
  if (owned) return null;

  const { data: member } = await supabaseAdmin
    .from("brand_kit_members")
    .select("role")
    .eq("brand_kit_id", brandKitId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!member) {
    return toolError("Access denied to this brand kit", {
      code: "access_denied",
      recovery: ACCESS_DENIED_RECOVERY,
    });
  }
  if (member.role !== "admin") {
    return toolError(
      `Write access denied for this brand kit: your membership role is '${member.role}'. Only owner or admin members can edit via MCP.`,
      {
        code: "access_denied",
        recovery: MEMBER_MCP_WRITE_DENIED_RECOVERY,
        data: { membership_role: member.role },
      },
    );
  }
  return null;
}

/**
 * "Require explicit confirmation on MCP writes" gate.
 *
 * Precedence, highest first:
 *   1. `brand_kit_members.require_mcp_write_confirmation` for this member on
 *      this kit — set by the kit owner. Members cannot change it themselves.
 *   2. `profiles.require_mcp_write_confirmation` — the member's account default,
 *      and the only value that applies to a kit the caller owns.
 *
 * Returns null when the write may proceed, or a toolError when confirmation is
 * required and neither `dry_run: true` (preview) nor `confirm: true` was sent.
 */
export async function assertMcpWriteConfirmation(
  args: Record<string, unknown>,
  userId: string,
  supabaseAdmin: any,
) {
  if (args?.dry_run === true) return null;
  if (args?.confirm === true) return null;

  let required: boolean | null = null;
  let setBy: "brand_kit" | "account" = "account";

  const brandKitId = typeof args?.brand_kit_id === "string" ? args.brand_kit_id : null;
  if (brandKitId) {
    const { data: member } = await supabaseAdmin
      .from("brand_kit_members")
      .select("require_mcp_write_confirmation")
      .eq("brand_kit_id", brandKitId)
      .eq("user_id", userId)
      .maybeSingle();
    if (member && member.require_mcp_write_confirmation !== null) {
      required = member.require_mcp_write_confirmation === true;
      setBy = "brand_kit";
    }
  }

  if (required === null) {
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("require_mcp_write_confirmation")
      .eq("id", userId)
      .maybeSingle();
    required = profile?.require_mcp_write_confirmation === true;
  }

  if (!required) return null;

  return toolError(
    setBy === "brand_kit"
      ? "This brand kit's owner requires MCP writes to be explicitly confirmed."
      : "Your account requires MCP writes to be explicitly confirmed.",
    {
      code: "confirmation_required",
      recovery:
        setBy === "brand_kit"
          ? "Re-call this tool with `confirm: true` (and without `dry_run`) after reviewing the dry_run preview. Only the brand kit's owner can change this requirement, under Share → member settings."
          : "Re-call this tool with `confirm: true` (and without `dry_run`) after reviewing the dry_run preview. You can change this under Settings → Preferences → Agent writes.",
      data: { set_by: setBy },
    },
  );
}
