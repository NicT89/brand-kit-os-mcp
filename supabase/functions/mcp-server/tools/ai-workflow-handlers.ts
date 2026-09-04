/**
 * Delegate tools that give an MCP agent parity with the app's AI workflow
 * buttons (Personas & Audience, Current customers, Ideal company profiles,
 * website scrape).
 *
 * Every handler here is a thin, audited wrapper: validate → brand-kit access →
 * write scope + member role → dry_run preview → confirm → `callInternalFunction`
 * against the same edge function the UI calls. No AI or DB logic lives here, so
 * the UI and the agent can never drift apart.
 */
import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { requireCompetitorConfirmation } from "../competitor-validation.ts";
import { callInternalFunction } from "./internal-call.ts";

/** Credit-spending tools all share the competitor dry_run → confirm contract. */
const requireRunConfirmation = requireCompetitorConfirmation;

function jsonResult(payload: unknown): ToolHandlerResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function delegateError(result: { error: string; status: number }): ToolHandlerResult {
  return toolError(result.error, {
    code: result.status === 402 || result.status === 403 ? "access_denied" : "internal_error",
    retryable: result.status >= 500,
  });
}

/** Read access + write scope + member role. Returns null when the run may proceed. */
async function runGate(
  ctx: ToolHandlerContext,
  brandKitId: string,
  section: "audience" | "core",
): Promise<ToolHandlerResult | null> {
  const scopeDenied = assertBrandKitSectionScope(ctx.scopes, section);
  if (scopeDenied) return scopeDenied;
  const hasAccess = await verifyBrandKitAccess(brandKitId, ctx.userId, ctx.supabaseAdmin);
  if (!hasAccess) {
    return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
  }
  return await assertBrandKitMcpWriteAllowed(brandKitId, ctx.userId, ctx.supabaseAdmin);
}

function dryRun(payload: Record<string, unknown>): ToolHandlerResult {
  return jsonResult({
    dry_run: true,
    message: "Preview only — nothing was written and no credits were spent.",
    ...payload,
    next_call: { confirm: true },
  });
}

/**
 * Shared skeleton for every delegate tool: uuid check → gate → dry_run preview
 * → confirm → internal call.
 */
function delegate(options: {
  section: "audience" | "core";
  functionName: string;
  /** Human summary + credit estimate shown on the dry_run preview. */
  preview: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Build the edge-function body. Return a toolError to reject bad input. */
  body: (args: Record<string, unknown>) => Record<string, unknown> | ToolHandlerResult;
  nextStep?: string;
  logMessage: string;
}): ToolHandler {
  return async (ctx) => {
    const { args, userId, log } = ctx;
    const idRes = validateUuidParam(args.brand_kit_id, "brand_kit_id");
    if (!("ok" in idRes)) return idRes;
    const brandKitId = idRes.value;

    const confirmErr = requireRunConfirmation(args);
    if (confirmErr) return confirmErr;

    const gate = await runGate(ctx, brandKitId, options.section);
    if (gate) return gate;

    const built = options.body({ ...args, brand_kit_id: brandKitId });
    if ((built as ToolHandlerResult).isError === true) return built as ToolHandlerResult;

    if (args.dry_run === true) return dryRun(options.preview(args));

    await log("info", options.logMessage, { brand_kit_id: brandKitId });
    const result = await callInternalFunction(
      options.functionName,
      { brandKitId, ...(built as Record<string, unknown>) },
      userId,
    );
    if (!result.ok) return delegateError(result);

    const { success: _success, ...data } = result.data;
    return jsonResult({
      success: true,
      ...data,
      ...(options.nextStep ? { next_step: options.nextStep } : {}),
    });
  };
}

export const aiWorkflowHandlers: Record<string, ToolHandler> = {
  detect_brand_kit_customers: delegate({
    section: "audience",
    functionName: "detect-current-customers",
    logMessage: "Detecting current customers from the stored website scrape",
    preview: () => ({
      action: "Read the brand kit's stored website scrape and propose current-customer company profiles.",
      credits_estimate: 1,
    }),
    body: (args) => ({ persist: args.persist !== false }),
    nextStep:
      "Review the returned customers with the user. Enrich any of them with enrich_company_profile, or edit with update_customer_profile. If the response reason is 'no_website_scrape', run scrape_brand_kit_website first.",
  }),

  scrape_customer_profile: delegate({
    section: "audience",
    functionName: "scrape-company-profile",
    logMessage: "Scraping a company profile",
    preview: (args) => ({
      action: `Scrape ${String(args.url ?? "")} and save it as a ${
        args.profile_kind === "company_icp" ? "ideal company profile" : "current customer"
      }.`,
      credits_estimate: 1,
    }),
    body: (args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return toolError("url is required", {
          code: "validation_error",
          recovery: "Pass the customer's public website URL, e.g. https://example.com.",
        });
      }
      return {
        url,
        profileKind: args.profile_kind === "company_icp" ? "company_icp" : "customer",
      };
    },
    nextStep: "Show the saved profile to the user, then call enrich_company_profile to fill the remaining fields.",
  }),

  enrich_company_profile: delegate({
    section: "audience",
    functionName: "enrich-company-profile",
    logMessage: "Enriching a company profile",
    preview: (args) => ({
      action: `AI-enrich company profile ${String(args.profile_id ?? "")} (mode: ${
        args.mode === "initial" ? "initial" : "augment"
      }).`,
      credits_estimate: 1,
    }),
    body: (args) => {
      const idRes = validateUuidParam(args.profile_id, "profile_id");
      if (!("ok" in idRes)) return idRes;
      return { profileId: idRes.value, mode: args.mode === "initial" ? "initial" : "augment" };
    },
    nextStep: "Read the result with get_brand_kit_customers or get_brand_kit_company_icps.",
  }),

  generate_company_icp: delegate({
    section: "audience",
    functionName: "generate-company-icp",
    logMessage: "Generating ideal company profiles",
    preview: (args) => ({
      action: "Generate ideal company profile archetypes from the brand kit, its current customers and its personas.",
      count: typeof args.count === "number" ? args.count : 3,
      credits_estimate: 1,
    }),
    body: (args) => ({
      preview: args.preview === true,
      ...(typeof args.count === "number" ? { count: args.count } : {}),
    }),
    nextStep:
      "With preview: true nothing is saved — show the proposals and then re-run without preview, or write them with create_company_icp.",
  }),

  generate_target_audience: delegate({
    section: "audience",
    functionName: "generate-target-audience",
    logMessage: "Generating a target audience persona",
    preview: (args) => ({
      action: `Generate a ${args.persona_type === "b2c" ? "B2C" : "B2B"} target audience persona from the brand kit.`,
      persist: args.persist === true,
      credits_estimate: 1,
    }),
    body: (args) => ({
      personaType: args.persona_type === "b2c" ? "b2c" : "b2b",
      inputs: args.inputs && typeof args.inputs === "object" ? args.inputs : {},
      persist: args.persist === true,
    }),
    nextStep:
      "By default nothing is saved: show personaDraft to the user and write it with create_audience_persona, or re-run with persist: true to save it directly.",
  }),

  enrich_audience_persona: delegate({
    section: "audience",
    functionName: "enrich-target-audience-persona",
    logMessage: "Enriching a target audience persona",
    preview: (args) => ({
      action: `AI-enrich target audience persona ${String(args.persona_id ?? "")} (mode: ${
        args.mode === "augment" ? "augment" : "initial"
      }).`,
      credits_estimate: 1,
    }),
    body: (args) => {
      const idRes = validateUuidParam(args.persona_id, "persona_id");
      if (!("ok" in idRes)) return idRes;
      return {
        personaId: idRes.value,
        mode: args.mode === "augment" ? "augment" : "initial",
        seedText: typeof args.seed_text === "string" ? args.seed_text : "",
      };
    },
    nextStep:
      "The response reports partial runs via `partial` and `failedSections`. Re-call with mode: 'augment' to fill only the sections that failed.",
  }),

  detect_target_audiences: delegate({
    section: "audience",
    functionName: "detect-target-audiences",
    logMessage: "Detecting candidate target audiences",
    preview: () => ({
      action: "Propose distinct target audiences for the brand. Read-only — no personas are created.",
      credits_estimate: 1,
    }),
    body: (args) => ({
      ...(typeof args.seed_text === "string" && args.seed_text.trim() ? { seedText: args.seed_text.trim() } : {}),
    }),
    nextStep:
      "Show the candidates to the user, then create the chosen ones with create_audience_persona and fill them out with enrich_audience_persona.",
  }),

  scrape_brand_kit_website: delegate({
    section: "core",
    functionName: "firecrawl-scrape",
    logMessage: "Scraping the brand's website",
    preview: (args) => ({
      action: `Scrape ${String(args.url ?? "")} and store the raw result against the brand kit.`,
      credits_estimate: 1,
    }),
    body: (args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return toolError("url is required", {
          code: "validation_error",
          recovery: "Pass the brand's website URL, e.g. https://example.com.",
        });
      }
      return { url, source: "mcp" };
    },
    nextStep:
      "The stored scrape is what detect_brand_kit_customers and detect_target_audiences read from. Run those next.",
  }),
};
