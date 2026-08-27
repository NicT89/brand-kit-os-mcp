import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { BRAND_KIT_WRITE_SCOPE } from "../constants.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { requireCompetitorConfirmation } from "../competitor-validation.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { callInternalFunction } from "./internal-call.ts";

const MAX_ACCEPTED_COMPETITORS = 10;

function jsonResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
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

  create_brand_kit_from_url: async ({ args, userId, supabaseAdmin, scopes, log }) => {
    if (!scopes.includes(BRAND_KIT_WRITE_SCOPE)) {
      return toolError(
        `Creating a brand kit requires the '${BRAND_KIT_WRITE_SCOPE}' scope.`,
        { code: "scope_denied", recovery: SCOPE_DENIED_RECOVERY(BRAND_KIT_WRITE_SCOPE) },
      );
    }

    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return toolError("url is required", {
        code: "validation_error",
        recovery: "Pass the public website URL of the brand, e.g. 'https://www.example.com'.",
      });
    }
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
    const enrich = args.enrich !== false;

    if (args.dry_run === true) {
      return jsonResult({
        dry_run: true,
        message: "Preview only — nothing was created and no credits were spent.",
        url,
        name: name ?? "Taken from the site title",
        enrichment: enrich
          ? "Competitors, audience personas, company ICPs and current customers are generated after the kit is created."
          : "Disabled — only the website extraction runs.",
        estimated_credits: enrich ? "1 for the extraction, plus 1 per competitor and 1 per AI enrichment step" : "1",
        next_call: { confirm: true },
      });
    }

    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    await log("info", "Creating brand kit from URL", { url, enrich });
    const result = await callInternalFunction("create-brand-kit-from-url", { url, name, enrich }, userId);
    if (!result.ok) {
      return toolError(result.error, {
        code: result.status === 402 || result.status === 403 ? "access_denied" : "internal_error",
        retryable: result.status >= 500,
      });
    }

    return jsonResult({
      ...result.data,
      next_step: enrich
        ? "Enrichment runs in the background. Wait ~1-2 minutes, then call get_agent_briefing with this brand_kit_id to see the competitors, personas, ICPs and customers that were added."
        : "Call get_agent_briefing with this brand_kit_id to review what was extracted.",
    });
  },
};
