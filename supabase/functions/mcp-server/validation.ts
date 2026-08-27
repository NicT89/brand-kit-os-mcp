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
 * Per-user "require explicit confirmation on MCP writes" gate.
 *
 * Returns null if the write is allowed to proceed, or a toolError result if
 * the user has the toggle on AND the call is not a dry_run AND `confirm: true`
 * was not supplied. Dry-run previews are always allowed.
 *
 * Behavior summary:
 *   - require_mcp_write_confirmation = false → no-op (opt-out; the user turned
 *     the toggle off in Settings → Preferences → Agent writes).
 *   - require_mcp_write_confirmation = true → the default since the column
 *     default was flipped and existing rows were backfilled:
 *       • args.dry_run === true            → allow (preview)
 *       • args.confirm === true            → allow (commit)
 *       • otherwise                        → confirmation_required error
 */
export async function assertMcpWriteConfirmation(
  args: Record<string, unknown>,
  userId: string,
  supabaseAdmin: any,
) {
  if (args?.dry_run === true) return null;
  if (args?.confirm === true) return null;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("require_mcp_write_confirmation")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.require_mcp_write_confirmation) return null;

  return toolError(
    "Your account requires MCP writes to be explicitly confirmed.",
    {
      code: "confirmation_required",
      recovery:
        "Re-call this tool with `confirm: true` (and without `dry_run`) after reviewing the dry_run preview. You can disable this requirement in Settings → Preferences → Agent writes → 'Require confirmation on MCP writes'.",
    },
  );
}
