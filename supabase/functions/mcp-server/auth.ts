/**
 * SHA-256 hashing primitive for MCP bearer tokens (api keys + OAuth tokens).
 *
 * Credential resolution, the subscription gate, and rate limiting now run in a
 * single Postgres round-trip via authorize_mcp_request (see authorize.ts and
 * supabase/migrations/20260626120000_create_authorize_mcp_request_rpc.sql).
 * Only the hashing stays edge-side — it needs no database access.
 */
export async function hashValue(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

