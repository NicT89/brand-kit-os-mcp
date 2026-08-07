/**
 * Canonical list of platform values accepted on a
 * `writing_constraints.constraints[].platform` entry. Surfaced to MCP
 * agents via `list_governance_platforms` so they don't have to guess.
 *
 * Keep this in sync with the in-app platform selector for governance
 * rules. `all` is a sentinel meaning "applies everywhere".
 */
export interface GovernancePlatform {
  value: string;
  label: string;
  description: string;
}

export const GOVERNANCE_PLATFORMS: readonly GovernancePlatform[] = [
  { value: "all", label: "All platforms", description: "Rule applies to every channel and content type." },
  { value: "linkedin", label: "LinkedIn", description: "Professional networking posts, articles, and comments." },
  { value: "reddit", label: "Reddit", description: "Subreddit posts, comments, and replies." },
  { value: "twitter_x", label: "Twitter / X", description: "Tweets, replies, and threads on X (Twitter)." },
  { value: "instagram", label: "Instagram", description: "Feed posts, captions, Reels, and Stories." },
  { value: "tiktok", label: "TikTok", description: "Short-form video captions and descriptions." },
  { value: "facebook", label: "Facebook", description: "Pages, group posts, and comments." },
  { value: "youtube", label: "YouTube", description: "Video titles, descriptions, comments, and Community posts." },
  { value: "threads", label: "Threads", description: "Meta Threads posts and replies." },
  { value: "blog", label: "Blog", description: "Long-form blog posts and articles." },
  { value: "email", label: "Email", description: "Email marketing, newsletters, and transactional copy." },
  { value: "web", label: "Website", description: "Marketing site, landing pages, and product pages." },
  { value: "ads", label: "Paid ads", description: "Paid social, search, and display ad copy." },
  { value: "podcast", label: "Podcast", description: "Show notes, episode descriptions, transcripts." },
];

export const GOVERNANCE_PLATFORM_VALUES: ReadonlySet<string> = new Set(
  GOVERNANCE_PLATFORMS.map((p) => p.value),
);

/**
 * Validate any `platform` value found inside a `writing_constraints.constraints[]`
 * payload. Returns null when every platform is recognized (or absent), or an
 * array of the offending values for inclusion in a validation_error.
 */
export function findInvalidGovernancePlatforms(writingConstraints: unknown): string[] | null {
  if (!writingConstraints || typeof writingConstraints !== "object") return null;
  const wc = writingConstraints as Record<string, unknown>;
  const constraints = Array.isArray(wc.constraints) ? wc.constraints : [];
  const bad: string[] = [];
  for (const item of constraints) {
    if (!item || typeof item !== "object") continue;
    const platform = (item as Record<string, unknown>).platform;
    if (platform === undefined || platform === null || platform === "") continue;
    if (typeof platform !== "string" || !GOVERNANCE_PLATFORM_VALUES.has(platform)) {
      bad.push(String(platform));
    }
  }
  return bad.length > 0 ? bad : null;
}
