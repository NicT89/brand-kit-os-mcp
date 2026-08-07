import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { requireCompetitorConfirmation } from "../competitor-validation.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

const MAX_ACCEPTED_COMPETITORS = 10;

function jsonResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Call one of the app's own edge functions as a trusted internal caller: the
 * service-role key as bearer plus `internal_user_id`. The MCP server has
 * already authenticated the API key and verified brand-kit access; the target
 * function re-checks access for the resolved user id.
 */
async function callInternalFunction(
  name: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: "Service is not configured (missing SUPABASE_URL / service key).", status: 500 };
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ ...body, internal_user_id: userId }),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.slice(0, 400) };
  }

  if (!response.ok || parsed.success !== true) {
    const message = typeof parsed.error === "string" ? parsed.error : `Request failed with status ${response.status}`;
    return { ok: false, error: message, status: response.status };
  }
  return { ok: true, data: parsed };
}

function parseCompetitorList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const out: Array<{ name: string; url: string; logo_url: string | null }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) continue;
    out.push({
      name: typeof record.name === "string" ? record.name.trim() : "",
      url,
      logo_url: typeof record.logo_url === "string" ? record.logo_url : null,
    });
  }
  return out;
}

export const webDiscoveryHandlers: Record<string, ToolHandler> = {
  discover_brand_kit_competitors: async ({ args, userId, supabaseAdmin, log }) => {
    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    const provider = args.provider === "semrush" ? "semrush" : "ai";
    const limitRaw = typeof args.limit === "number" ? args.limit : MAX_ACCEPTED_COMPETITORS;
    const limit = Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_ACCEPTED_COMPETITORS);

    await log("info", "Discovering competitors", { provider, limit });
    const result = await callInternalFunction(
      "discover-competitors",
      { brandKitId, provider, limit },
      userId,
    );
    if (!result.ok) {
      return toolError(result.error, {
        code: result.status === 402 || result.status === 403 ? "access_denied" : "internal_error",
        retryable: result.status >= 500,
      });
    }

    return jsonResult({
      ...(result.data.data as Record<string, unknown>),
      next_step:
        "Show the candidates to the user. After they choose, call accept_brand_kit_competitors with dry_run: true, then confirm: true.",
    });
  },

  accept_brand_kit_competitors: async ({ args, userId, supabaseAdmin, scopes, log }) => {
    const scopeDenied = assertBrandKitSectionScope(scopes, "competitors");
    if (scopeDenied) return scopeDenied;

    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    const competitors = parseCompetitorList(args.competitors);
    if (!competitors || competitors.length === 0) {
      return toolError("competitors must be a non-empty array of objects with a url", { code: "validation_error" });
    }
    if (competitors.length > MAX_ACCEPTED_COMPETITORS) {
      return toolError(`At most ${MAX_ACCEPTED_COMPETITORS} competitors can be added per call`, { code: "validation_error" });
    }

    const confirmErr = requireCompetitorConfirmation(args);
    if (confirmErr) return confirmErr;

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }
    const writeGate = await assertBrandKitMcpWriteAllowed(brandKitId, userId, supabaseAdmin);
    if (writeGate) return writeGate;

    if (args.dry_run === true) {
      return jsonResult({
        dry_run: true,
        message: "Preview only — no competitors added and no credits spent.",
        competitors,
        credits_per_competitor: 1,
        credits_total: competitors.length,
        next_call: { confirm: true },
      });
    }

    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    await log("info", "Adding competitors", { count: competitors.length });
    const result = await callInternalFunction("accept-competitors", { brandKitId, competitors }, userId);
    if (!result.ok) {
      return toolError(result.error, {
        code: result.status === 402 ? "validation_error" : "internal_error",
        retryable: result.status >= 500,
      });
    }

    return jsonResult({ success: true, ...(result.data.data as Record<string, unknown>) });
  },

  scrape_brand_kit_reviews: async ({ args, userId, supabaseAdmin, scopes, log }) => {
    const scopeDenied = assertBrandKitSectionScope(scopes, "competitors");
    if (scopeDenied) return scopeDenied;

    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    let competitorId: string | undefined;
    if (typeof args.competitor_id === "string" && args.competitor_id) {
      const competitorRes = validateUuidParam(args.competitor_id, "competitor_id");
      if (!("ok" in competitorRes)) return competitorRes;
      competitorId = competitorRes.value;
    }

    const confirmErr = requireCompetitorConfirmation(args);
    if (confirmErr) return confirmErr;

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }
    const writeGate = await assertBrandKitMcpWriteAllowed(brandKitId, userId, supabaseAdmin);
    if (writeGate) return writeGate;

    const payload: Record<string, unknown> = {
      brandKitId,
      ...(typeof args.query === "string" && args.query ? { query: args.query } : {}),
      ...(Array.isArray(args.platforms) ? { platforms: args.platforms } : {}),
      ...(typeof args.sort === "string" ? { sort: args.sort } : {}),
      ...(Array.isArray(args.star_ratings) ? { starRatings: args.star_ratings } : {}),
      ...(competitorId ? { competitorId } : {}),
    };

    if (args.dry_run === true) {
      const preview = await callInternalFunction("scrape-reviews-apify", { ...payload, dryRun: true }, userId);
      if (!preview.ok) {
        return toolError(preview.error, { code: "validation_error", retryable: preview.status >= 500 });
      }
      return jsonResult({
        dry_run: true,
        message: "Preview only — no reviews imported and no credits spent.",
        ...(preview.data.data as Record<string, unknown>),
        next_call: { confirm: true },
      });
    }

    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    await log("info", "Importing reviews", { competitor_id: competitorId ?? null });
    const result = await callInternalFunction("scrape-reviews-apify", payload, userId);
    if (!result.ok) {
      return toolError(result.error, {
        code: result.status === 402 ? "validation_error" : "internal_error",
        retryable: result.status >= 500,
      });
    }

    return jsonResult({ success: true, ...(result.data.data as Record<string, unknown>) });
  },
};
