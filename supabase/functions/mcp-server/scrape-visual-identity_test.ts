import { assert, assertEquals } from "../_shared/asserts.ts";
import {
  buildBrandKitComputedFields,
  detectDesignFramework,
  extractButtonStyles,
  extractColorRoles,
  extractColors,
  extractColorScheme,
  extractCssTokens,
  extractFonts,
  extractFontScale,
  extractFromHtml,
  extractShadowScale,
  extractSpacing,
  extractStylesheetLinks,
  extractTypography,
  scrapeVisualIdentity,
} from "./scrape-visual-identity.ts";

const sampleHtml = `
<html><head>
<link href="https://fonts.googleapis.com/css?family=Inter:400,700|Source+Serif+Pro" rel="stylesheet"/>
<style>
:root {
  --color-primary: #FF6B35;
  --color-secondary: #004E89;
  --color-background: #1A1A1A;
  --button-bg: #FF6B35;
  --button-radius: 8px;
  --spacing-md: 16px;
  --font-size-base: 16px;
  --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
  --radius-lg: 12px;
}
body { background-color: #1A1A1A; }
.btn { background-color: #FF6B35; color: #FFFFFF; border-radius: 8px; font-weight: 600; }
</style></head><body class="flex grid px-4 text-white"></body></html>
`;

Deno.test("extractCssTokens parses :root tokens", () => {
  const t = extractCssTokens(sampleHtml);
  assertEquals(t["--color-primary"], "#FF6B35");
  assertEquals(t["--button-radius"], "8px");
});

Deno.test("extractColors returns hex colors, filtering pure black/white", () => {
  const t = extractCssTokens(sampleHtml);
  const colors = extractColors(sampleHtml, t);
  assert(colors.includes("#FF6B35"));
  assert(!colors.includes("#FFFFFF"));
});

Deno.test("extractFonts pulls Google fonts", () => {
  const fonts = extractFonts(sampleHtml);
  assert(fonts.includes("Inter"));
  assert(fonts.includes("Source Serif Pro"));
});

Deno.test("extractColorScheme detects dark from background luminance", () => {
  const t = extractCssTokens(sampleHtml);
  assertEquals(extractColorScheme(sampleHtml, t), "dark");
});

Deno.test("extractButtonStyles uses tokens then falls back to .btn", () => {
  const t = extractCssTokens(sampleHtml);
  const b = extractButtonStyles(sampleHtml, t);
  assertEquals(b.background_color, "#FF6B35");
  assertEquals(b.border_radius, "8px");
  assertEquals(b.font_weight, "600");
});

Deno.test("extractTypography composes from tokens + fonts", () => {
  const t = extractCssTokens(sampleHtml);
  const ty = extractTypography(sampleHtml, t, extractFonts(sampleHtml));
  assert(ty.body !== null);
});

Deno.test("extractSpacing falls back gracefully", () => {
  const s = extractSpacing(sampleHtml, extractCssTokens(sampleHtml));
  assertEquals(s.padding, "16px");
});

Deno.test("detectDesignFramework spots Tailwind via CDN reference", () => {
  const html = `<html><head><script src="https://cdn.tailwindcss.com"></script></head></html>`;
  assertEquals(detectDesignFramework(html), "Tailwind CSS");
});

Deno.test("detectDesignFramework returns Custom for incidental utility-looking classes", () => {
  // A handful of utility-like tokens — under the 20-distinct threshold — must
  // NOT be enough to flag Tailwind. This was a real false-positive on linear.app
  // and stripe.com in live testing.
  const html = `<html><body><div class="flex grid px-4 text-white bg-blue">x</div></body></html>`;
  assertEquals(detectDesignFramework(html), "Custom");
});

Deno.test("extractColorRoles maps semantic roles", () => {
  const r = extractColorRoles(extractCssTokens(sampleHtml));
  assertEquals(r.primary, "#FF6B35");
  assertEquals(r.surface, "#1A1A1A");
});

Deno.test("extractFontScale picks size tokens", () => {
  const s = extractFontScale(extractCssTokens(sampleHtml));
  assertEquals(s.base, "16px");
});

Deno.test("extractFromHtml does not throw on empty input", () => {
  const r = extractFromHtml("");
  assertEquals(r.brand_colors.length, 0);
  assertEquals(r.extraction_confidence.brand_colors, "failed");
});

Deno.test("extractFromHtml does not throw on malformed CSS", () => {
  const r = extractFromHtml("<style>:root { --x: ; .btn { color }</style>");
  assert(Array.isArray(r.brand_colors));
});

Deno.test("scrapeVisualIdentity returns null when Firecrawl fails", async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response("err", { status: 500 }))) as unknown as typeof fetch;
  const result = await scrapeVisualIdentity("https://example.com", {
    fetchImpl: fakeFetch,
    apiKey: "test",
  });
  assertEquals(result, null);
});

Deno.test("scrapeVisualIdentity returns structured result on success", async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: { rawHtml: sampleHtml } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  const result = await scrapeVisualIdentity("https://example.com", {
    fetchImpl: fakeFetch,
    apiKey: "test",
  });
  assert(result !== null);
  assert(result!.brand_colors.includes("#FF6B35"));
  assertEquals(result!.color_scheme, "dark");
});

Deno.test("buildBrandKitComputedFields generates :root export and tailwind config", () => {
  const out = buildBrandKitComputedFields({
    color_roles: { primary: "#FF6B35", secondary: null },
    font_scale: { base: "16px" },
    border_radius_scale: { lg: "12px" },
    shadow_scale: {},
    css_custom_properties: { "--color-primary": "#FF6B35" },
    heading_font: "Inter",
    body_font: "Inter",
  });
  assert(out.css_variables_export.includes(":root"));
  assert(out.css_variables_export.includes("--color-primary"));
  assertEquals(
    (out.tailwind_config.theme as Record<string, Record<string, Record<string, string>>>)
      .extend.colors.primary,
    "#FF6B35",
  );
});

// ── Live-grounded fixtures (derived from real scrapes of scalearmy.com /
//    a linear-style external-CSS layout). Kept inline to keep the suite
//    hermetic — no network calls. ────────────────────────────────────────────

const wordpressFixture = `
<html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto:400,700|EB+Garamond"/>
<style id="wp-block-theme-inline-css">
:root {
  --wp--preset--color--black: #000000;
  --wp--preset--color--white: #ffffff;
  --wp--preset--color--cyan-bluish-gray: #abb8c3;
  --wp--preset--color--pale-pink: #f78da7;
  --wp--preset--color--vivid-red: #cf2e2e;
  --wp--preset--color--primary: #162B3E;
  --wp--preset--color--accent: #FF6432;
  --wp--preset--color--background: #FEF2DE;
  --wp--preset--font-size--small: 13px;
  --wp--preset--font-size--medium: 20px;
  --wp--preset--font-size--large: 36px;
  --wp--preset--font-size--x-large: 42px;
  --wp--preset--spacing--40: 1rem;
  --wp--preset--spacing--50: 1.5rem;
  --wp--preset--spacing--70: 3.38rem;
  --wp--preset--shadow--sharp: 6px 6px 0px rgba(0, 0, 0, 0.2);
  --wp--preset--shadow--natural: 6px 6px 9px rgba(0, 0, 0, 0.2);
  --wp--preset--shadow--deep: 12px 12px 50px rgba(0, 0, 0, 0.4);
  --wp--style--block-gap: 24px;
}
body { background-color: #FEF2DE; font-family: 'Roboto', sans-serif; color: #162B3E; }
.elementor-button { background-color: #FF6432; color: #FFFFFF; border-radius: 4px; font-weight: 700; }
.hero { background: #162B3E; color: #FEF2DE; }
.hero a { color: #FF6432; }
h1 { font-family: 'EB Garamond', serif; font-weight: inherit; }
p { font-family: inherit; }
</style>
<body class="wp-content elementor"></body></html>
`;

Deno.test("WP/Elementor fixture: roles, scales, fonts, framework all resolve", () => {
  const r = extractFromHtml(wordpressFixture);
  // Roles map via --wp--preset--color--* aliases.
  assertEquals(r.color_roles.primary, "#162B3E");
  assertEquals(r.color_roles.accent, "#FF6432");
  assertEquals(r.color_roles.surface, "#FEF2DE");
  // Font scale picks up --wp--preset--font-size--*.
  assert(Object.keys(r.font_scale).length >= 3, `expected >=3 font sizes, got ${JSON.stringify(r.font_scale)}`);
  assertEquals(r.font_scale.sm, "13px");
  assertEquals(r.font_scale.lg, "36px");
  // Shadow scale picks up --wp--preset--shadow--*.
  assert(Object.keys(r.shadow_scale).length >= 2, `expected >=2 shadows, got ${JSON.stringify(r.shadow_scale)}`);
  // Spacing maps via WP tokens.
  assertEquals(r.spacing.base_unit, "1rem");
  assertEquals(r.spacing.padding, "24px");
  // Fonts: no "inherit" leak.
  assert(!r.fonts.map((f) => f.toLowerCase()).includes("inherit"));
  assert(r.fonts.includes("Roboto") || r.fonts.includes("EB Garamond"));
  // Framework correctly identified.
  assertEquals(r.design_framework, "Elementor (WordPress)");
  // Button styles fall back through the wider selector net.
  assertEquals(r.button_styles.background_color, "#FF6432");
  assertEquals(r.button_styles.font_weight, "700");
});

Deno.test("extractColors ignores :root and --wp--preset--color value strings when ranking", () => {
  const html = `
    <style>
      :root {
        --wp--preset--color--vivid-red: #CF2E2E;
        --wp--preset--color--primary: #162B3E;
      }
      .hero { background: #162B3E; color: #162B3E; border-color: #162B3E; }
    </style>`;
  const r = extractFromHtml(html);
  // #162B3E is used on real elements; #CF2E2E only appears as a token value.
  assert(r.brand_colors.includes("#162B3E"));
  assert(!r.brand_colors.includes("#CF2E2E"), `expected #CF2E2E ranked out, got ${r.brand_colors.join(",")}`);
});

Deno.test("extractFonts rejects CSS-wide keywords and var() wrappers", () => {
  const html = `
    <style>
      h1 { font-family: 'EB Garamond', serif; }
      p  { font-family: inherit; }
      .x { font-family: initial; }
      .y { font-family: var(--font-body); }
    </style>`;
  const fonts = extractFonts(html);
  assert(fonts.includes("EB Garamond"));
  for (const bad of ["inherit", "initial", "unset", "var(--font-body)"]) {
    assert(!fonts.includes(bad), `font "${bad}" should be filtered, got ${fonts.join(",")}`);
  }
});

Deno.test("extractStylesheetLinks resolves relative + absolute hrefs and dedupes", () => {
  const html = `
    <link rel="stylesheet" href="/static/app.css"/>
    <link rel="stylesheet" href="https://cdn.example.com/lib.css"/>
    <link rel="stylesheet" href="/static/app.css"/>
    <link rel="preload" href="/static/other.css"/>
  `;
  const urls = extractStylesheetLinks(html, "https://example.com/page");
  assertEquals(urls.length, 2);
  assert(urls.includes("https://example.com/static/app.css"));
  assert(urls.includes("https://cdn.example.com/lib.css"));
});

Deno.test("scrapeVisualIdentity fetches linked stylesheets and merges into extraction", async () => {
  // Bare HTML — no inline styles, just a linked stylesheet (linear/stripe shape).
  const html = `
    <html><head>
      <link rel="stylesheet" href="https://cdn.example.com/app.css"/>
    </head><body><button>Go</button></body></html>
  `;
  const externalCss = `
    :root { --color-primary: #5E6AD2; --color-background: #FFFFFF; --font-size-base: 16px; }
    body { font-family: 'Inter', sans-serif; background-color: #FFFFFF; color: #1F2937; }
    button { background-color: #5E6AD2; color: #FFFFFF; border-radius: 6px; }
    .hero { color: #5E6AD2; background: #5E6AD2; }
  `;
  let firecrawlHit = false;
  let stylesheetHit = false;
  const fakeFetch = ((input: string | URL | Request, _init?: RequestInit) => {
    const u = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (u.includes("api.firecrawl.dev")) {
      firecrawlHit = true;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { rawHtml: html } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u === "https://cdn.example.com/app.css") {
      stylesheetHit = true;
      return Promise.resolve(new Response(externalCss, { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;

  const result = await scrapeVisualIdentity("https://example.com", {
    fetchImpl: fakeFetch,
    apiKey: "test",
  });
  assert(firecrawlHit, "Firecrawl was not called");
  assert(stylesheetHit, "Linked stylesheet was not fetched");
  assert(result !== null);
  assert(result!.brand_colors.includes("#5E6AD2"), `expected #5E6AD2, got ${result!.brand_colors.join(",")}`);
  assert(result!.fonts.includes("Inter"));
  assertEquals(result!.color_roles.primary, "#5E6AD2");
  assertEquals(result!.font_scale.base, "16px");
});

Deno.test("scrapeVisualIdentity still succeeds when stylesheet fetch fails", async () => {
  const html = `<html><head><link rel="stylesheet" href="https://broken.example/app.css"/><style>:root{--color-primary:#123456;}</style></head></html>`;
  const fakeFetch = ((input: string | URL | Request) => {
    const u = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (u.includes("api.firecrawl.dev")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { rawHtml: html } }), { status: 200 }),
      );
    }
    return Promise.reject(new Error("network down"));
  }) as unknown as typeof fetch;
  const result = await scrapeVisualIdentity("https://example.com", {
    fetchImpl: fakeFetch,
    apiKey: "test",
  });
  assert(result !== null);
  assertEquals(result!.color_roles.primary, "#123456");
});

Deno.test("extractSpacing returns null base_unit when no spacing tokens present", () => {
  const r = extractFromHtml("<style>:root{--color-primary:#000111}</style>");
  assertEquals(r.spacing.base_unit, null);
});

Deno.test("button_styles falls back to color_roles.primary when no .btn/--button-bg present", () => {
  const html = `<style>:root { --color-primary: #ABCDEF; }</style>`;
  const r = extractFromHtml(html);
  // --button-bg fallback chain inside extractButtonStyles also resolves --color-primary,
  // so background should reflect the primary role.
  assertEquals(r.button_styles.background_color, "#ABCDEF");
  assertEquals(r.extraction_confidence.button_styles, "estimated");
});
