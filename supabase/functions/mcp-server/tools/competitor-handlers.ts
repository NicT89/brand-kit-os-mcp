import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { assertBrandKitSectionScope } from "../scope-gate.ts";
import { buildBrandKitComputedFields, scrapeVisualIdentity, type VisualIdentityResult } from "../scrape-visual-identity.ts";
import { dryRunPreview, filterFields, refundTokens, summarizeRawScrape, withTimeout } from "../helpers.ts";
import { hasMeaningfulScrapedValue, requireCompetitorConfirmation, validateCompetitorOptionalShapes, validateCompetitorVisualIdentity } from "../competitor-validation.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";
import { recordAuditFields } from "../audit.ts";

export const competitorHandlers: Record<string, ToolHandler> = {
  create_brand_kit_competitor: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, log, progress } = ctx;
    const scopeDeniedCompetitorCreate = assertBrandKitSectionScope(scopes, "competitors");
    if (scopeDeniedCompetitorCreate) return scopeDeniedCompetitorCreate;
    try {
      const { brand_kit_id, url, dry_run } = args;
      if (!brand_kit_id || !url) return toolError("brand_kit_id and url are required", { code: "validation_error" });

      await log("info", "Starting competitor create", { url });
      await progress(10, 100, "Validating input");

      const shapeErr = validateCompetitorOptionalShapes(args);
      if (shapeErr) return shapeErr;
      const confirmErr = requireCompetitorConfirmation(args);
      if (confirmErr) return confirmErr;

      const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
      if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
      const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
      if (mcpWriteGate) return mcpWriteGate;
      const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
      if (confirmGate) return confirmGate;

      // Auto-populate visual identity from Firecrawl. scrapeVisualIdentity
      // always returns a result with a `scrape_status` — empty fields on failure.
      await log("info", "Scraping competitor URL via Firecrawl", { url });
      await progress(40, 100, "Calling Firecrawl");
      let scraped: VisualIdentityResult;
      try {
        scraped = await scrapeVisualIdentity(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[create_brand_kit_competitor] Firecrawl extraction threw:", msg);
        await log("warning", "Firecrawl extraction threw — proceeding with empty visual identity", { error: msg });
        scraped = {
          brand_colors: [], fonts: [], color_scheme: null, design_framework: null,
          typography: { heading: null, body: null },
          button_styles: { background_color: null, text_color: null, border_radius: null, font_weight: null },
          spacing: { base_unit: null, padding: null, margin: null },
          color_roles: { primary: null, secondary: null, accent: null, surface: null, border: null, text_primary: null, text_muted: null, success: null, error: null },
          font_scale: {}, shadow_scale: {}, border_radius_scale: {}, css_tokens: {},
          extraction_confidence: { brand_colors: "failed", fonts: "failed", button_styles: "failed", spacing: "failed" },
          scrape_status: "blocked",
          scrape_status_reason: msg,
        };
      }

      const scrapeUsable = scraped.scrape_status === "success" || scraped.scrape_status === "partial";
      await log("info", "Extracting visual identity from scrape result", { scrape_status: scraped.scrape_status });
      await progress(70, 100, "Extracting visual identity");

      // Merge precedence: explicit caller field > scraped (when usable) > default.
      const pick = <T,>(explicit: T | undefined, fromScrape: T | undefined, fallback: T): T =>
        explicit !== undefined ? explicit : (scrapeUsable && fromScrape !== undefined && fromScrape !== null ? fromScrape : fallback);

      const insertPayload: Record<string, any> = {
        brand_kit_id,
        user_id: userId,
        url,
        name: args.name ?? null,
        logo_url: args.logo_url ?? null,
        description: args.short_description ?? (typeof args.description === "string" ? args.description.slice(0, 300) : args.description ?? null),
        short_description: args.short_description ?? (typeof args.description === "string" ? args.description.slice(0, 300) : null),
        long_description: args.long_description ?? null,
        tagline: args.tagline ?? null,
        value_propositions: Array.isArray(args.value_propositions) ? args.value_propositions : [],
        brand_personality: args.brand_personality ?? null,
        brand_colors: pick(args.brand_colors, scraped.brand_colors, []),
        fonts: pick(args.fonts, scraped.fonts, []),
        color_scheme: pick(args.color_scheme, scraped.color_scheme ?? undefined, null),
        design_framework: pick(args.design_framework, scraped.design_framework ?? undefined, null),
        social_profiles: args.social_profiles ?? [],
        typography: pick(args.typography, scrapeUsable ? scraped.typography : undefined, null),
        button_styles: pick(args.button_styles, scrapeUsable ? scraped.button_styles : undefined, null),
        spacing: pick(args.spacing, scrapeUsable ? scraped.spacing : undefined, null),
        color_roles: pick(args.color_roles, scrapeUsable ? scraped.color_roles : undefined, null),
        font_scale: pick(args.font_scale, scrapeUsable ? scraped.font_scale : undefined, null),
        line_heights: args.line_heights ?? null,
        letter_spacing: args.letter_spacing ?? null,
        shadow_scale: pick(args.shadow_scale, scrapeUsable ? scraped.shadow_scale : undefined, null),
        border_radius_scale: pick(args.border_radius_scale, scrapeUsable ? scraped.border_radius_scale : undefined, null),
        input_styles: args.input_styles ?? null,
        card_styles: args.card_styles ?? null,
        nav_styles: args.nav_styles ?? null,
        max_container_width: args.max_container_width ?? null,
        breakpoints: args.breakpoints ?? null,
        dark_mode_support: args.dark_mode_support ?? false,
        gradient_usage: args.gradient_usage ?? null,
        animation_style: args.animation_style ?? null,
        raw_scrape_data: scrapeUsable
          ? {
              css_tokens: scraped.css_tokens,
              extraction_confidence: scraped.extraction_confidence,
              scrape_status: scraped.scrape_status,
              scraped_at: new Date().toISOString(),
            }
          : null,
      };

      // Backstop visual-signal check on the merged payload (after scraping).
      const mergedForValidation = {
        brand_colors: insertPayload.brand_colors,
        fonts: insertPayload.fonts,
        tagline: insertPayload.tagline,
        value_propositions: insertPayload.value_propositions,
        color_scheme: insertPayload.color_scheme,
        design_framework: insertPayload.design_framework,
        brand_personality: insertPayload.brand_personality,
        typography: insertPayload.typography,
        button_styles: insertPayload.button_styles,
        spacing: insertPayload.spacing,
        social_profiles: insertPayload.social_profiles,
      };
      await log("info", "Validating merged competitor payload");
      await progress(90, 100, "Validating");
      const visualErr = validateCompetitorVisualIdentity(mergedForValidation);
      if (visualErr) return visualErr;

      if (dry_run) {
        const previewPayload = summarizeRawScrape(insertPayload);
        const preview = dryRunPreview('brand_kit_competitors (insert)', null, previewPayload);
        const enriched = JSON.parse(preview.content[0].text);
        // Override the generic dryRunPreview message — competitor commits
        // require `confirm: true` (with dry_run omitted), not `dry_run: false`.
        enriched.message = "Preview only — no data written. Call again with confirm: true (omit dry_run) to commit.";
        enriched.extraction_confidence = scraped.extraction_confidence;
        enriched.scrape_status = scraped.scrape_status;
        if (scraped.scrape_status_reason) enriched.scrape_status_reason = scraped.scrape_status_reason;
        enriched.next_call = { confirm: true };
        preview.content[0].text = JSON.stringify(enriched, null, 2);
        return preview;
      }

      const { data: row, error } = await supabaseAdmin.from('brand_kit_competitors').insert(insertPayload).select('*').single();
      if (error) return toolError(`Database error creating competitor: ${error.message}`, { code: "db_error", retryable: true, data: { db_message: error.message } });
      await log("info", "Competitor written", { competitor_id: row?.id });
      await progress(100, 100, "Done");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            competitor: summarizeRawScrape(row),
            extraction_confidence: scraped.extraction_confidence,
            scrape_status: scraped.scrape_status,
            ...(scraped.scrape_status_reason ? { scrape_status_reason: scraped.scrape_status_reason } : {}),
          }, null, 2)
        }]
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'unknown error');
      console.error("[create_brand_kit_competitor] Unexpected failure:", msg, err);
      return toolError(
        `create_brand_kit_competitor failed: ${msg}`,
        { code: "internal_error", retryable: true, recovery: "Retry once; if it still fails, try with explicit fields and skip the URL to bypass scraping." },
      );
    }
  },

  update_brand_kit_competitor: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes, requestId, log, progress } = ctx;
    const scopeDeniedCompetitorUpdate = assertBrandKitSectionScope(scopes, "competitors");
    if (scopeDeniedCompetitorUpdate) return scopeDeniedCompetitorUpdate;
    try {
      const { competitor_id, brand_kit_id, dry_run, confirm: _confirm, ...fields } = args;
      if (!competitor_id || !brand_kit_id) return toolError("competitor_id and brand_kit_id are required", { code: "validation_error" });

      await log("info", "Starting competitor update", { competitor_id });
      await progress(10, 100, "Validating input");

      const shapeErr = validateCompetitorOptionalShapes(fields);
      if (shapeErr) return shapeErr;
      const confirmErr = requireCompetitorConfirmation(args);
      if (confirmErr) return confirmErr;

      const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
      if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
      const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
      if (mcpWriteGate) return mcpWriteGate;
      const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
      if (confirmGate) return confirmGate;

      const { data: existing } = await supabaseAdmin.from('brand_kit_competitors').select('*').eq('id', competitor_id).eq('brand_kit_id', brand_kit_id).maybeSingle();
      if (!existing) return toolError("Competitor not found or does not belong to this brand kit", { code: "not_found" });

      const allowed = [
        'name','url','logo_url','description','short_description','long_description','tagline','value_propositions','brand_personality','brand_colors','fonts',
        'color_scheme','design_framework','social_profiles','typography','button_styles','spacing',
        'color_roles','font_scale','line_heights','letter_spacing','shadow_scale','border_radius_scale',
        'input_styles','card_styles','nav_styles','max_container_width','breakpoints','dark_mode_support',
        'gradient_usage','animation_style',
      ];
      const updateData: Record<string, any> = {};
      for (const key of allowed) {
        if (fields[key] !== undefined) updateData[key] = fields[key];
      }
      // Legacy `description` aliases short_description when short_description not provided.
      if (fields.short_description === undefined && fields.description !== undefined) {
        updateData.short_description = typeof fields.description === "string"
          ? (fields.description as string).slice(0, 300)
          : fields.description;
      }

      // If url is being changed or provided, re-scrape and merge (explicit > scraped > existing).
      let scraped: VisualIdentityResult | null = null;
      const effectiveUrl = (fields.url as string | undefined) ?? existing.url;
      if (fields.url !== undefined) {
        await log("info", "URL changed — scraping new URL via Firecrawl", { url: effectiveUrl });
        await progress(50, 100, "Calling Firecrawl");
        try {
          scraped = await scrapeVisualIdentity(effectiveUrl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[update_brand_kit_competitor] Firecrawl extraction threw:", msg);
          await log("warning", "Firecrawl extraction threw during update", { error: msg });
          scraped = null;
        }
        const scrapeUsable = !!scraped && (scraped.scrape_status === "success" || scraped.scrape_status === "partial");
        if (scraped && scrapeUsable) {
          const scrapeMergeFields: Array<[string, unknown]> = [
            ['brand_colors', scraped.brand_colors],
            ['fonts', scraped.fonts],
            ['color_scheme', scraped.color_scheme],
            ['design_framework', scraped.design_framework],
            ['typography', scraped.typography],
            ['button_styles', scraped.button_styles],
            ['spacing', scraped.spacing],
            ['color_roles', scraped.color_roles],
            ['font_scale', scraped.font_scale],
            ['shadow_scale', scraped.shadow_scale],
            ['border_radius_scale', scraped.border_radius_scale],
          ];
          for (const [k, v] of scrapeMergeFields) {
            if (updateData[k] === undefined && hasMeaningfulScrapedValue(v)) {
              updateData[k] = v;
            }
          }
          updateData.raw_scrape_data = {
            css_tokens: scraped.css_tokens,
            extraction_confidence: scraped.extraction_confidence,
            scrape_status: scraped.scrape_status,
            scraped_at: new Date().toISOString(),
          };
        } else if (scraped) {
          // Scrape ran but produced no usable data (blocked/timeout/no_data/no_api_key).
          // Overwrite raw_scrape_data with a status marker so the row doesn't
          // keep stale tokens from a previous URL while the new URL is unscraped.
          updateData.raw_scrape_data = {
            css_tokens: {},
            extraction_confidence: scraped.extraction_confidence,
            scrape_status: scraped.scrape_status,
            ...(scraped.scrape_status_reason ? { scrape_status_reason: scraped.scrape_status_reason } : {}),
            scraped_at: new Date().toISOString(),
          };
        } else {
          // The scrape function threw outright (network error etc.) — record
          // that the attempt happened so callers can see why the data is stale.
          updateData.raw_scrape_data = {
            css_tokens: {},
            scrape_status: "blocked",
            scrape_status_reason: "scrapeVisualIdentity threw an exception during update",
            scraped_at: new Date().toISOString(),
          };
        }
      }

      if (Object.keys(updateData).length === 0) return toolError("At least one field must be provided.", { code: "validation_error" });

      if (dry_run) {
        await recordAuditFields(supabaseAdmin, requestId, {
          operation: 'update',
          resource_type: 'brand_kit_competitors',
          resource_id: competitor_id as string,
          before_state: summarizeRawScrape(existing),
          after_state: summarizeRawScrape({ ...existing, ...updateData }),
          was_dry_run: true,
        });
        const previewPayload = summarizeRawScrape(updateData);
        const preview = dryRunPreview('brand_kit_competitors', summarizeRawScrape(existing), previewPayload);
        const enriched = JSON.parse(preview.content[0].text);
        // Override the generic dryRunPreview message — competitor commits
        // require `confirm: true` (with dry_run omitted), not `dry_run: false`.
        enriched.message = "Preview only — no data written. Call again with confirm: true (omit dry_run) to commit.";
        enriched.extraction_confidence = scraped?.extraction_confidence ?? null;
        if (scraped?.scrape_status) enriched.scrape_status = scraped.scrape_status;
        if (scraped?.scrape_status_reason) enriched.scrape_status_reason = scraped.scrape_status_reason;
        enriched.next_call = { confirm: true };
        preview.content[0].text = JSON.stringify(enriched, null, 2);
        return preview;
      }

      const { data: row, error } = await supabaseAdmin.from('brand_kit_competitors').update(updateData).eq('id', competitor_id).select('*').single();
      if (error) return toolError(`Database error updating competitor: ${error.message}`, { code: "db_error", retryable: true, data: { db_message: error.message } });
      await recordAuditFields(supabaseAdmin, requestId, {
        operation: 'update',
        resource_type: 'brand_kit_competitors',
        resource_id: competitor_id as string,
        before_state: summarizeRawScrape(existing),
        after_state: summarizeRawScrape(row),
        was_dry_run: false,
      });
      await log("info", "Competitor update written", { competitor_id });
      await progress(100, 100, "Done");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            competitor: summarizeRawScrape(row),
            extraction_confidence: scraped?.extraction_confidence ?? null,
            ...(scraped?.scrape_status ? { scrape_status: scraped.scrape_status } : {}),
            ...(scraped?.scrape_status_reason ? { scrape_status_reason: scraped.scrape_status_reason } : {}),
          }, null, 2)
        }]
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'unknown error');
      console.error("[update_brand_kit_competitor] Unexpected failure:", msg, err);
      return toolError(
        `update_brand_kit_competitor failed: ${msg}`,
        { code: "internal_error", retryable: true, recovery: "Retry once; if it still fails, omit the URL field to skip the re-scrape." },
      );
    }
  },
};
