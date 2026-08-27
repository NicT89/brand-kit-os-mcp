/**
 * Social scraping and social post reading tools.
 *
 * Post scrapes are asynchronous: `scrape_brand_kit_social_profile` starts an
 * Apify run and returns immediately with a scrape run id. The agent polls
 * `get_brand_kit_social_scrape_run`, then reads results with
 * `list_brand_kit_social_posts`.
 */

import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { callInternalFunction } from "./internal-call.ts";

const SUPPORTED_PLATFORMS = ["instagram", "linkedin", "facebook", "tiktok", "youtube", "twitter"];
const MAX_POSTS_PER_RUN = 200;
const MAX_POSTS_PER_PAGE = 100;

function jsonResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export const socialHandlers: Record<string, ToolHandler> = {
  scrape_brand_kit_social_profile: async ({ args, userId, supabaseAdmin, scopes, log }) => {
    const scopeDenied = assertBrandKitSectionScope(scopes, "social_profiles");
    if (scopeDenied) return scopeDenied;

    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    const platform = typeof args.platform === "string" ? args.platform.toLowerCase() : "";
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return toolError(`platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`, {
        code: "validation_error",
      });
    }

    const url = typeof args.profile_url === "string" ? args.profile_url.trim() : "";
    if (!url) {
      return toolError("profile_url is required (the public profile URL to scrape)", { code: "validation_error" });
    }

    const scrapeKind = args.scrape_type === "posts" ? "posts" : "profile";
    const profileType = args.profile_type === "personal" ? "personal" : "company";
    const limitRaw = typeof args.results_limit === "number" ? args.results_limit : 50;
    const resultsLimit = Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_POSTS_PER_RUN);

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }
    const writeGate = await assertBrandKitMcpWriteAllowed(brandKitId, userId, supabaseAdmin);
    if (writeGate) return writeGate;

    if (args.dry_run === true) {
      return jsonResult({
        dry_run: true,
        message: "Preview only — nothing scraped and no credits spent.",
        platform,
        profile_type: profileType,
        profile_url: url,
        scrape_type: scrapeKind,
        results_limit: scrapeKind === "posts" ? resultsLimit : 1,
        credits_estimate: scrapeKind === "posts" ? Math.ceil(resultsLimit / 10) : 1,
        next_call: { confirm: true },
      });
    }

    const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
    if (confirmGate) return confirmGate;

    await log("info", "Starting social scrape", { platform, scrape_type: scrapeKind });
    const result = await callInternalFunction(
      "social-profile-scrape",
      { brandKitId, platform, profileType, url, scrapeType: scrapeKind, resultsLimit },
      userId,
    );
    if (!result.ok) {
      return toolError(result.error, {
        code: result.status === 402 || result.status === 403 ? "access_denied" : "internal_error",
        retryable: result.status >= 500,
      });
    }

    const data = result.data;
    return jsonResult({
      success: true,
      scrape_run_id: data.scrapeRunId ?? null,
      async: data.async === true,
      ...(data.async === true
        ? {
            next_step:
              "Poll get_brand_kit_social_scrape_run with this scrape_run_id until status is 'succeeded', then call list_brand_kit_social_posts.",
          }
        : { profile: data.normalized ?? null, credits_charged: data.creditsCharged ?? 0 }),
    });
  },

  get_brand_kit_social_scrape_run: async ({ args, userId, supabaseAdmin }) => {
    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    let query = supabaseAdmin
      .from("social_scrape_runs")
      .select("id, platform, profile_type, scrape_kind, status, items_count, credits_spent, error_message, started_at, finished_at")
      .eq("brand_kit_id", brandKitId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (typeof args.scrape_run_id === "string" && args.scrape_run_id) {
      const runRes = validateUuidParam(args.scrape_run_id, "scrape_run_id");
      if (!("ok" in runRes)) return runRes;
      query = query.eq("id", runRes.value);
    }

    const { data, error } = await query;
    if (error) return toolError(error.message, { code: "internal_error", retryable: true });

    return jsonResult({ runs: data ?? [] });
  },

  list_brand_kit_social_posts: async ({ args, userId, supabaseAdmin }) => {
    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }

    const limitRaw = typeof args.limit === "number" ? args.limit : 25;
    const limit = Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_POSTS_PER_PAGE);

    let query = supabaseAdmin
      .from("social_posts")
      .select("id, platform, profile_type, external_id, post_url, posted_at, caption, post_type, hashtags, mentions, metrics")
      .eq("brand_kit_id", brandKitId)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(limit);

    if (typeof args.platform === "string" && args.platform) {
      const platform = args.platform.toLowerCase();
      if (!SUPPORTED_PLATFORMS.includes(platform)) {
        return toolError(`platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`, { code: "validation_error" });
      }
      query = query.eq("platform", platform);
    }

    const { data, error } = await query;
    if (error) return toolError(error.message, { code: "internal_error", retryable: true });

    return jsonResult({ count: (data ?? []).length, posts: data ?? [] });
  },
};
