export const MCP_SCOPES = {
  READ: "read",
  BRAND_KIT_WRITE: "brand_kit:write",
  KNOWLEDGE_FILES_WRITE: "knowledge_files:write",
} as const;

/** Brand kit sections for granular write scopes (Option C). */
export const BRAND_KIT_WRITE_SECTIONS = [
  "core",
  "personality",
  "expression",
  "governance",
  "products",
  "audience",
  "personas",
  "competitors",
  "visuals",
  "seo",
] as const;

export type BrandKitWriteSection = (typeof BRAND_KIT_WRITE_SECTIONS)[number];

export function brandKitSectionScope(section: BrandKitWriteSection): string {
  return `brand_kit:write:${section}`;
}

const SECTION_SCOPE_SET = new Set(
  BRAND_KIT_WRITE_SECTIONS.map((s) => brandKitSectionScope(s)),
);

const LEGACY_SCOPE_ALIASES: Record<string, string[]> = {
  write: [MCP_SCOPES.BRAND_KIT_WRITE, MCP_SCOPES.KNOWLEDGE_FILES_WRITE],
  "mcp:read": [MCP_SCOPES.READ],
};

const ALLOWED_SCOPES = new Set<string>([
  MCP_SCOPES.READ,
  MCP_SCOPES.BRAND_KIT_WRITE,
  MCP_SCOPES.KNOWLEDGE_FILES_WRITE,
  ...SECTION_SCOPE_SET,
]);

export function normalizeMcpScopes(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const normalized = new Set<string>();

  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    if (LEGACY_SCOPE_ALIASES[trimmed]) {
      for (const mapped of LEGACY_SCOPE_ALIASES[trimmed]) normalized.add(mapped);
      continue;
    }

    if (ALLOWED_SCOPES.has(trimmed)) {
      normalized.add(trimmed);
    }
  }

  // Read access is baseline for all MCP interactions.
  if (normalized.size === 0) normalized.add(MCP_SCOPES.READ);

  return Array.from(normalized);
}

/** Global superset or matching `brand_kit:write:<section>`. */
export function hasBrandKitSectionWrite(
  scopes: string[],
  section: BrandKitWriteSection,
): boolean {
  return scopes.includes(MCP_SCOPES.BRAND_KIT_WRITE) ||
    scopes.includes(brandKitSectionScope(section));
}

export function hasAnyBrandKitSectionWrite(scopes: string[]): boolean {
  if (scopes.includes(MCP_SCOPES.BRAND_KIT_WRITE)) return true;
  return BRAND_KIT_WRITE_SECTIONS.some((s) => scopes.includes(brandKitSectionScope(s)));
}

/** Sections enabled on this token (all sections when global write is present). */
export function getEnabledBrandKitWriteSections(scopes: string[]): BrandKitWriteSection[] {
  if (scopes.includes(MCP_SCOPES.BRAND_KIT_WRITE)) {
    return [...BRAND_KIT_WRITE_SECTIONS];
  }
  return BRAND_KIT_WRITE_SECTIONS.filter((s) => scopes.includes(brandKitSectionScope(s)));
}

export function isBrandKitSectionScope(scope: string): boolean {
  return SECTION_SCOPE_SET.has(scope);
}
