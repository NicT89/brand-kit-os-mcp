// Server-side Firecrawl visual identity extraction.
//
// Called internally by create/update_brand_kit_competitor when a `url` is
// provided. NOT exposed as an MCP tool. All extractors are non-throwing —
// they return empty/null values when patterns don't match. Firecrawl failure
// is non-fatal: the competitor write proceeds with explicit fields only.

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape";
const SCRAPE_TIMEOUT_MS = 10_000;
const STYLESHEET_BUDGET_MS = 8_000;
const MAX_STYLESHEETS = 5;
const MAX_STYLESHEET_BYTES = 750_000;
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "169.254.169.254",
  "metadata",
  "metadata.google.internal",
]);

export type ButtonStyles = {
  background_color: string | null;
  text_color: string | null;
  border_radius: string | null;
  font_weight: string | null;
};

export type Typography = {
  heading: string | null;
  body: string | null;
};

export type Spacing = {
  base_unit: string | null;
  padding: string | null;
  margin: string | null;
};

export type ColorRoles = {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  surface: string | null;
  border: string | null;
  text_primary: string | null;
  text_muted: string | null;
  success: string | null;
  error: string | null;
};

export type ExtractionConfidence = {
  brand_colors: "high" | "estimated" | "failed";
  fonts: "high" | "estimated" | "failed";
  button_styles: "high" | "estimated" | "failed";
  spacing: "high" | "estimated" | "failed";
};

export type ScrapeStatus =
  | "success"
  | "partial"
  | "blocked"
  | "timeout"
  | "no_api_key"
  | "no_data";

export type VisualIdentityResult = {
  brand_colors: string[];
  fonts: string[];
  color_scheme: "light" | "dark" | null;
  design_framework: string | null;
  typography: Typography;
  button_styles: ButtonStyles;
  spacing: Spacing;
  color_roles: ColorRoles;
  font_scale: Record<string, string>;
  shadow_scale: Record<string, string>;
  border_radius_scale: Record<string, string>;
  css_tokens: Record<string, string>;
  extraction_confidence: ExtractionConfidence;
  scrape_status: ScrapeStatus;
  scrape_status_reason?: string;
};

const CSS_WIDE_KEYWORDS = new Set([
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "currentcolor",
  "none",
  "auto",
]);

// ── Extractors ──────────────────────────────────────────────────────────────

export function extractCssTokens(source: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  try {
    const rootBlocks = source.matchAll(/:root\s*\{([^}]+)\}/g);
    for (const block of rootBlocks) {
      const declarations = block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g);
      for (const [, key, value] of declarations) {
        tokens[`--${key}`] = value.trim();
      }
    }
  } catch {
    // non-throwing
  }
  return tokens;
}

/** Returns a copy of `source` with all `:root { ... }` blocks removed, so colour
 *  occurrence counts reflect actual usage on elements rather than token declarations. */
function stripRootBlocks(source: string): string {
  try {
    return source.replace(/:root\s*\{[^}]*\}/g, "");
  } catch {
    return source;
  }
}

export function extractColors(source: string, tokens: Record<string, string>): string[] {
  const hexSet = new Set<string>();
  try {
    for (const value of Object.values(tokens)) {
      const hex = value.match(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/);
      if (hex) hexSet.add(hex[0].toUpperCase());
    }
    const styleBlocks = source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    for (const block of styleBlocks) {
      const hexMatches = block[1].matchAll(/#([0-9A-Fa-f]{6})\b/g);
      for (const [hex] of hexMatches) hexSet.add(hex.toUpperCase());
    }
    // Also harvest from any raw CSS we appended.
    const rawHex = source.matchAll(/#([0-9A-Fa-f]{6})\b/g);
    for (const [hex] of rawHex) hexSet.add(hex.toUpperCase());
  } catch {
    // non-throwing
  }
  const filtered = [...hexSet].filter((h) => !["#000000", "#FFFFFF"].includes(h));
  // Count usage only outside :root declarations and ignore `--wp--preset--color--*`
  // value strings so palette presets don't dominate the ranking.
  const usageSource = stripRootBlocks(source).replace(
    /--wp--preset--color--[\w-]+\s*:\s*#[0-9A-Fa-f]{6}/g,
    "",
  );
  const scored = filtered
    .map((hex) => {
      let count = 0;
      try {
        // Count only "applied" property usages — colour values that follow a
        // property like color/background/border-color/fill/stroke.
        const re = new RegExp(
          `(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)\\s*:\\s*[^;]*${hex}`,
          "gi",
        );
        count = (usageSource.match(re) ?? []).length;
        if (count === 0) {
          // Fallback: count plain occurrences outside :root and preset-value strings.
          count = (usageSource.match(new RegExp(hex, "gi")) ?? []).length;
        }
      } catch {
        count = 0;
      }
      return { hex, count };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((s) => s.hex);
  return scored;
}

export function extractFonts(source: string): string[] {
  const fonts = new Set<string>();
  try {
    const googleFonts = source.matchAll(/fonts\.googleapis\.com\/css[^"']*family=([^"'&]+)/g);
    for (const [, family] of googleFonts) {
      const names = family.split("|").map((f) => f.split(":")[0].replace(/\+/g, " ").trim());
      names.forEach((n) => n && fonts.add(n));
    }
    const fontFaces = source.matchAll(/@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"]+)['"]?/g);
    for (const [, name] of fontFaces) fonts.add(name.trim());

    const fontFamily = source.matchAll(/font-family:\s*['"]?([A-Za-z][^;,'"]+?)['"]?\s*[;,}]/g);
    for (const [, name] of fontFamily) {
      const clean = name.trim().split(",")[0].replace(/['"]/g, "").trim();
      const lower = clean.toLowerCase();
      if (
        clean &&
        !lower.includes("sans-serif") &&
        !lower.includes("serif") &&
        !lower.includes("monospace") &&
        !lower.startsWith("var(") &&
        !lower.includes("var(") &&
        !CSS_WIDE_KEYWORDS.has(lower)
      ) {
        fonts.add(clean);
      }
    }
  } catch {
    // non-throwing
  }
  return [...fonts]
    .filter((f) => !CSS_WIDE_KEYWORDS.has(f.toLowerCase()) && !f.toLowerCase().includes("var("))
    .slice(0, 4);
}

function luminanceFromHex(hex: string): number | null {
  const m = hex.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function extractColorScheme(
  source: string,
  tokens: Record<string, string>,
): "light" | "dark" {
  try {
    const bgToken =
      tokens["--color-background"] ?? tokens["--bg-color"] ?? tokens["--background"];
    if (bgToken) {
      const hex = bgToken.match(/#([0-9A-Fa-f]{6})/);
      if (hex) {
        const l = luminanceFromHex(hex[0]);
        if (l !== null) return l < 0.5 ? "dark" : "light";
      }
    }
    const bodyBg = source.match(/body\s*\{[^}]*background(?:-color)?:\s*(#[0-9A-Fa-f]{6})/i);
    if (bodyBg) {
      const l = luminanceFromHex(bodyBg[1]);
      if (l !== null) return l < 0.5 ? "dark" : "light";
    }
  } catch {
    // non-throwing
  }
  return "light";
}

export function extractButtonStyles(
  source: string,
  tokens: Record<string, string>,
  colorRoles?: ColorRoles,
): ButtonStyles {
  const bgToken = tokens["--button-bg"] ?? tokens["--btn-bg"] ?? tokens["--color-primary"] ?? null;
  const textToken = tokens["--button-color"] ?? tokens["--btn-color"] ?? null;
  const radiusToken =
    tokens["--button-radius"] ?? tokens["--btn-radius"] ?? tokens["--border-radius"] ?? null;

  let btnBlock = "";
  try {
    const patterns = [
      /\.btn[^{]*\{([^}]+)\}/,
      /\.elementor-button[^{]*\{([^}]+)\}/,
      /\[class\*="button"\][^{]*\{([^}]+)\}/,
      /button(?:\.[\w-]+)?[^{]*\{([^}]+)\}/,
    ];
    for (const p of patterns) {
      const m = source.match(p);
      if (m) {
        btnBlock = m[1];
        break;
      }
    }
  } catch {
    btnBlock = "";
  }
  const background =
    bgToken ??
    btnBlock.match(/background(?:-color)?:\s*(#[0-9A-Fa-f]{6})/i)?.[1] ??
    colorRoles?.primary ??
    null;
  return {
    background_color: background,
    text_color:
      textToken ?? btnBlock.match(/(?:^|;)\s*color:\s*(#[0-9A-Fa-f]{6})/i)?.[1] ?? null,
    border_radius:
      radiusToken ?? btnBlock.match(/border-radius:\s*([^;]+)/i)?.[1]?.trim() ?? null,
    font_weight: btnBlock.match(/font-weight:\s*([^;]+)/i)?.[1]?.trim() ?? null,
  };
}

export function extractTypography(
  _source: string,
  tokens: Record<string, string>,
  fonts: string[],
): Typography {
  const headingFont = tokens["--font-heading"] ?? tokens["--heading-font"] ?? fonts[0] ?? null;
  const bodyFont =
    tokens["--font-body"] ?? tokens["--body-font"] ?? fonts[1] ?? fonts[0] ?? null;
  const h1Size = tokens["--font-size-h1"] ?? tokens["--text-5xl"] ?? null;
  const bodySize = tokens["--font-size-base"] ?? tokens["--text-base"] ?? null;
  const h1Weight = tokens["--font-weight-heading"] ?? null;

  const heading = [headingFont, h1Weight, h1Size].filter(Boolean).join(" ");
  const body = [bodyFont, bodySize].filter(Boolean).join(" ");
  return {
    heading: heading || null,
    body: body || null,
  };
}

export function extractSpacing(_source: string, tokens: Record<string, string>): Spacing {
  const base =
    tokens["--spacing-unit"] ??
    tokens["--space-1"] ??
    tokens["--base-unit"] ??
    tokens["--wp--preset--spacing--40"] ??
    null;
  const padding =
    tokens["--spacing-md"] ??
    tokens["--space-4"] ??
    tokens["--container-padding"] ??
    tokens["--wp--style--block-gap"] ??
    tokens["--wp--preset--spacing--50"] ??
    null;
  const margin =
    tokens["--spacing-xl"] ??
    tokens["--space-8"] ??
    tokens["--wp--preset--spacing--70"] ??
    null;
  return { base_unit: base, padding, margin };
}

const TAILWIND_CDN_RE =
  /(?:cdn\.tailwindcss\.com|tailwindcss(?:@[\w.-]+)?\/|\btailwindcss\b)/i;

function detectTailwind(source: string): boolean {
  if (TAILWIND_CDN_RE.test(source)) return true;
  // Count distinct utility-like class tokens that look like Tailwind (px-N, py-N,
  // bg-NAME, text-NAME, rounded-NAME, flex-NAME, gap-N, etc.).
  try {
    const matches = source.matchAll(
      /\b(?:tw-)?(?:px|py|pl|pr|pt|pb|mx|my|ml|mr|mt|mb|w|h|gap|space-[xy]|rounded|text|bg|border|grid-cols|col-span)-[a-z0-9/.]+/g,
    );
    const distinct = new Set<string>();
    for (const [m] of matches) {
      distinct.add(m);
      if (distinct.size >= 20) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function detectDesignFramework(source: string): string {
  if (source.includes("wp-content") || source.includes("elementor")) return "Elementor (WordPress)";
  if (source.includes("data-wf-") || source.includes("webflow")) return "Webflow";
  if (source.includes("framer-") || source.includes("framerusercontent")) return "Framer";
  if (detectTailwind(source)) return "Tailwind CSS";
  if (source.includes("bootstrap")) return "Bootstrap";
  if (source.includes("mui") || source.includes("material-ui")) return "Material UI";
  if (source.includes("chakra")) return "Chakra UI";
  return "Custom";
}

function pickHex(value: string): string | null {
  const hex = value.match(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/);
  return hex ? hex[0] : value.trim();
}

export function extractColorRoles(tokens: Record<string, string>): ColorRoles {
  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = tokens[k];
      if (v) return pickHex(v);
    }
    return null;
  };
  let primary = get(
    "--color-primary",
    "--primary",
    "--brand-primary",
    "--wp--preset--color--primary",
    "--wp--preset--color--brand",
  );
  // WP fallback: pick first preset colour that isn't black/white if no explicit primary.
  if (!primary) {
    for (const [k, v] of Object.entries(tokens)) {
      if (!k.startsWith("--wp--preset--color--")) continue;
      const hex = v.match(/#([0-9A-Fa-f]{6})/)?.[0]?.toUpperCase();
      if (hex && !["#000000", "#FFFFFF"].includes(hex)) {
        primary = hex;
        break;
      }
    }
  }
  return {
    primary,
    secondary: get(
      "--color-secondary",
      "--secondary",
      "--brand-secondary",
      "--wp--preset--color--secondary",
    ),
    accent: get("--color-accent", "--accent", "--wp--preset--color--accent"),
    surface: get(
      "--color-surface",
      "--surface",
      "--color-background",
      "--background",
      "--wp--preset--color--background",
      "--wp--preset--color--white",
    ),
    border: get("--color-border", "--border"),
    text_primary: get(
      "--color-text",
      "--text-primary",
      "--color-foreground",
      "--foreground",
      "--wp--preset--color--foreground",
      "--wp--preset--color--black",
    ),
    text_muted: get("--color-text-muted", "--text-muted", "--muted-foreground"),
    success: get("--color-success", "--success"),
    error: get("--color-error", "--color-danger", "--error", "--danger"),
  };
}

export function extractFontScale(tokens: Record<string, string>): Record<string, string> {
  const scale: Record<string, string> = {};
  const map: Record<string, string[]> = {
    xs: ["--font-size-xs", "--text-xs"],
    sm: ["--font-size-sm", "--text-sm", "--wp--preset--font-size--small"],
    base: ["--font-size-base", "--text-base", "--wp--preset--font-size--medium"],
    lg: ["--font-size-lg", "--text-lg", "--wp--preset--font-size--large"],
    xl: ["--font-size-xl", "--text-xl", "--wp--preset--font-size--x-large"],
    display: ["--font-size-display", "--text-5xl", "--font-size-h1"],
  };
  for (const [k, keys] of Object.entries(map)) {
    for (const tk of keys) {
      if (tokens[tk]) {
        scale[k] = tokens[tk];
        break;
      }
    }
  }
  return scale;
}

export function extractShadowScale(tokens: Record<string, string>): Record<string, string> {
  const scale: Record<string, string> = {};
  const map: Record<string, string[]> = {
    sm: ["--shadow-sm", "--box-shadow-sm", "--wp--preset--shadow--sharp"],
    md: ["--shadow-md", "--box-shadow-md", "--wp--preset--shadow--natural"],
    lg: ["--shadow-lg", "--box-shadow-lg", "--wp--preset--shadow--deep"],
  };
  for (const [k, keys] of Object.entries(map)) {
    for (const tk of keys) {
      if (tokens[tk]) {
        scale[k] = tokens[tk];
        break;
      }
    }
  }
  return scale;
}

export function extractBorderRadiusScale(tokens: Record<string, string>): Record<string, string> {
  const scale: Record<string, string> = {};
  for (const k of ["sm", "md", "lg", "full"]) {
    const v = tokens[`--radius-${k}`] ?? tokens[`--border-radius-${k}`];
    if (v) scale[k] = v;
  }
  if (tokens["--border-radius"] && !scale.md) scale.md = tokens["--border-radius"];
  return scale;
}

// ── Stylesheet fetching ─────────────────────────────────────────────────────

export function extractStylesheetLinks(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  try {
    const linkRe = /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi;
    for (const [tag] of html.matchAll(linkRe)) {
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      try {
        const resolved = new URL(href, pageUrl);
        if (isSafeStylesheetUrl(resolved)) urls.add(resolved.toString());
      } catch {
        // skip invalid hrefs
      }
      if (urls.size >= MAX_STYLESHEETS) break;
    }
  } catch {
    // non-throwing
  }
  return [...urls];
}

function isSafeStylesheetUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return false;

  return true;
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) return false;

  const nums = octets.map((o) => Number(o));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;

  return false;
}

function isPrivateIpv6(host: string): boolean {
  // URL.hostname for IPv6 strips [] brackets and lowercases.
  if (!host.includes(":")) return false;
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique-local
  return false;
}

async function fetchStylesheets(
  urls: string[],
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  if (urls.length === 0) return "";
  const budgetController = new AbortController();
  const onAbort = () => budgetController.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const budget = setTimeout(() => budgetController.abort(), STYLESHEET_BUDGET_MS);
  try {
    const results = await Promise.all(
      urls.slice(0, MAX_STYLESHEETS).map(async (u) => {
        try {
          const r = await fetchImpl(u, { signal: budgetController.signal });
          if (!r.ok) {
            await r.body?.cancel().catch(() => {});
            return "";
          }
          const text = await r.text();
          return text.slice(0, MAX_STYLESHEET_BYTES);
        } catch {
          return "";
        }
      }),
    );
    return results.filter(Boolean).join("\n");
  } finally {
    clearTimeout(budget);
    signal.removeEventListener("abort", onAbort);
  }
}

// ── Firecrawl call ──────────────────────────────────────────────────────────

function emptyVisualIdentityResult(status: ScrapeStatus, reason?: string): VisualIdentityResult {
  return {
    brand_colors: [],
    fonts: [],
    color_scheme: null,
    design_framework: null,
    typography: { heading: null, body: null },
    button_styles: { background_color: null, text_color: null, border_radius: null, font_weight: null },
    spacing: { base_unit: null, padding: null, margin: null },
    color_roles: {
      primary: null, secondary: null, accent: null, surface: null, border: null,
      text_primary: null, text_muted: null, success: null, error: null,
    },
    font_scale: {},
    shadow_scale: {},
    border_radius_scale: {},
    css_tokens: {},
    extraction_confidence: {
      brand_colors: "failed",
      fonts: "failed",
      button_styles: "failed",
      spacing: "failed",
    },
    scrape_status: status,
    ...(reason ? { scrape_status_reason: reason } : {}),
  };
}

export async function scrapeVisualIdentity(
  url: string,
  options: { fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<VisualIdentityResult> {
  // Caller-supplied apiKey wins (even if empty/whitespace — useful for tests that
  // need to force the no-key branch deterministically without depending on the
  // env). Only fall back to FIRECRAWL_API_KEY when the caller omits the field.
  // Important: accessing Deno.env.get() requires `--allow-env`. We only call it
  // when we actually need the fallback, so the contract test (which passes an
  // explicit apiKey) doesn't require the env permission.
  const explicitKey = typeof options.apiKey === "string" ? options.apiKey.trim() : null;
  let apiKey: string;
  if (explicitKey !== null) {
    apiKey = explicitKey;
  } else {
    try {
      apiKey = Deno.env.get("FIRECRAWL_API_KEY")?.trim() ?? "";
    } catch {
      // No --allow-env permission — treat as missing key.
      apiKey = "";
    }
  }
  if (!apiKey) {
    console.warn("[scrapeVisualIdentity] FIRECRAWL_API_KEY missing — skipping scrape");
    return emptyVisualIdentityResult("no_api_key", "FIRECRAWL_API_KEY is not configured on the server.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  let rawHtml = "";
  try {
    const res = await fetchImpl(FIRECRAWL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["rawHtml", "links"],
        actions: [{ type: "wait", milliseconds: 2000 }],
        onlyMainContent: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[scrapeVisualIdentity] Firecrawl HTTP ${res.status}`);
      await res.text().catch(() => "");
      clearTimeout(timer);
      return emptyVisualIdentityResult(
        "blocked",
        `Firecrawl HTTP ${res.status} — the site may be blocking the scraper, behind auth, or unreachable.`,
      );
    }
    const data = await res.json();
    rawHtml = data?.data?.rawHtml ?? data?.rawHtml ?? "";
  } catch (err) {
    clearTimeout(timer);
    const msg = (err as Error)?.message ?? String(err);
    const aborted = (err as { name?: string })?.name === "AbortError" || msg.toLowerCase().includes("abort");
    console.warn("[scrapeVisualIdentity] Firecrawl call failed:", msg);
    return emptyVisualIdentityResult(aborted ? "timeout" : "blocked", msg);
  }

  let cssText = "";
  try {
    const sheetUrls = extractStylesheetLinks(rawHtml, url);
    if (sheetUrls.length > 0) {
      cssText = await fetchStylesheets(sheetUrls, fetchImpl, controller.signal);
    }
  } catch (err) {
    console.warn("[scrapeVisualIdentity] Stylesheet fetch failed:", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }

  return extractFromHtml(rawHtml, cssText);
}

// Exposed so tests can run the extraction pipeline against fixture HTML.
export function extractFromHtml(rawHtml: string, cssText = ""): VisualIdentityResult {
  const source = cssText ? `${rawHtml}\n${cssText}` : rawHtml;
  const tokens = extractCssTokens(source);
  const fonts = extractFonts(source);
  const brandColors = extractColors(source, tokens);
  const colorRoles = extractColorRoles(tokens);
  const hasTokens = Object.keys(tokens).length > 0;
  const hasBtnSelector = /\.(?:btn|elementor-button)[^{]*\{/.test(source);
  const hasSpacingTokens = Object.keys(tokens).some(
    (k) => k.includes("spacing") || k.includes("space") || k.includes("--wp--preset--spacing"),
  );

  const buttonStyles = extractButtonStyles(source, tokens, colorRoles);
  const buttonHasReal =
    !!(tokens["--button-bg"] || tokens["--btn-bg"]) || hasBtnSelector;

  const confidence: ExtractionConfidence = {
    brand_colors: brandColors.length === 0 ? "failed" : hasTokens ? "high" : "estimated",
    fonts: fonts.length === 0 ? "failed" : "high",
    button_styles: buttonHasReal ? "high" : "estimated",
    spacing: hasSpacingTokens ? "high" : "estimated",
  };

  const failedCount = Object.values(confidence).filter((v) => v === "failed").length;
  const scrape_status: ScrapeStatus =
    rawHtml.trim().length === 0 ? "no_data"
    : failedCount === Object.keys(confidence).length ? "no_data"
    : failedCount === 0 ? "success"
    : "partial";

  return {
    brand_colors: brandColors,
    fonts,
    color_scheme: extractColorScheme(source, tokens),
    design_framework: detectDesignFramework(source),
    typography: extractTypography(source, tokens, fonts),
    button_styles: buttonStyles,
    spacing: extractSpacing(source, tokens),
    color_roles: colorRoles,
    font_scale: extractFontScale(tokens),
    shadow_scale: extractShadowScale(tokens),
    border_radius_scale: extractBorderRadiusScale(tokens),
    css_tokens: tokens,
    extraction_confidence: confidence,
    scrape_status,
  };
}

// ── Brand kit computed fields ───────────────────────────────────────────────

export function buildBrandKitComputedFields(brandKit: Record<string, unknown>): {
  tailwind_config: Record<string, unknown>;
  css_variables_export: string;
} {
  const colorRoles = (brandKit.color_roles ?? {}) as Record<string, string | null>;
  const fontScale = (brandKit.font_scale ?? {}) as Record<string, string>;
  const radiusScale = (brandKit.border_radius_scale ?? {}) as Record<string, string>;
  const shadowScale = (brandKit.shadow_scale ?? {}) as Record<string, string>;
  const cssTokens = (brandKit.css_custom_properties ?? {}) as Record<string, string>;

  const tailwind_config = {
    theme: {
      extend: {
        colors: Object.fromEntries(
          Object.entries(colorRoles).filter(([, v]) => v !== null && v !== undefined),
        ),
        fontFamily: {
          heading: brandKit.heading_font ? [brandKit.heading_font as string] : undefined,
          body: brandKit.body_font ? [brandKit.body_font as string] : undefined,
        },
        fontSize: fontScale,
        borderRadius: radiusScale,
        boxShadow: shadowScale,
      },
    },
  };

  const tokenLines = Object.entries(cssTokens).map(([k, v]) => `  ${k}: ${v};`);
  for (const [role, value] of Object.entries(colorRoles)) {
    if (value) tokenLines.push(`  --color-${role.replace(/_/g, "-")}: ${value};`);
  }
  const css_variables_export = tokenLines.length > 0 ? `:root {\n${tokenLines.join("\n")}\n}` : "";

  return { tailwind_config, css_variables_export };
}
