import { normalizeMcpScopes } from "../_shared/mcp-scopes.ts";
import {
  LAST_USED_THROTTLE_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "./constants.ts";
import { hashValue } from "./auth.ts";

/**
 * Consolidated MCP authorization.
 *
 * Replaces the three sequential round-trips (validateAuth + checkSubscription +
 * checkRateLimit) with a SINGLE call to the `authorize_mcp_request` Postgres
 * function. Token parsing + hashing stays edge-side (no DB needed); the RPC
 * performs credential resolution, the subscription gate, and the rate-limit
 * consume in one round-trip. Semantics are identical to the prior path — see
 * supabase/migrations/20260626120000_create_authorize_mcp_request_rpc.sql.
 */

/** Verdicts returned by the authorize_mcp_request RPC. */
type RpcVerdict =
  | "invalid_key"
  | "expired_key"
  | "invalid_token"
  | "expired_token"
  | "subscription_required"
  | "rate_limited"
  | "authorized";

interface AuthorizeRpcRow {
  verdict: RpcVerdict;
  user_id: string | null;
  api_key_id: string | null;
  scopes: unknown;
  subscription_tier: string | null;
  rate_remaining: number | null;
  rate_reset_at: string | null;
}

interface LegacyRateLimitRow {
  allowed?: boolean | null;
  remaining?: number | null;
  reset_at?: string | null;
}

/** Auth-error messages — must match the prior validateAuth strings exactly. */
const AUTH_ERROR_MESSAGE: Record<string, string> = {
  invalid_key: "Invalid API key",
  expired_key: "API key has expired",
  invalid_token: "Invalid access token",
  expired_token: "Access token has expired",
};

const MCP_ELIGIBLE_TIERS = new Set(["base", "premium", "max"]);

export type AuthorizeResult =
  | { kind: "unauthorized"; error: string }
  | { kind: "subscription_required"; userId: string; apiKeyId: string | null; scopes: string[]; tier: string }
  | {
      kind: "rate_limited";
      userId: string;
      apiKeyId: string | null;
      scopes: string[];
      tier: string;
      remaining: number;
      resetAt: Date;
    }
  | {
      kind: "authorized";
      userId: string;
      apiKeyId: string | null;
      scopes: string[];
      tier: string;
      remaining: number;
      resetAt: Date;
    };

function parseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function parseErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function shouldFallbackToLegacy(error: unknown): boolean {
  const code = parseErrorCode(error);
  const message = parseErrorMessage(error);
  if (code === "PGRST202" || code === "42883") return true;
  return message.includes("authorize_mcp_request");
}

async function authorizeViaLegacyPath(
  supabaseAdmin: any,
  tokenHash: string,
  isApiKey: boolean,
): Promise<AuthorizeResult> {
  let userId: string | null = null;
  let apiKeyId: string | null = null;
  let scopes: string[] = [];

  if (isApiKey) {
    const { data: keyData, error: keyError } = await supabaseAdmin
      .from("api_keys")
      .select("*")
      .eq("key_hash", tokenHash)
      .eq("is_active", true)
      .maybeSingle();

    if (keyError || !keyData) {
      return { kind: "unauthorized", error: "Invalid API key" };
    }

    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      return { kind: "unauthorized", error: "API key has expired" };
    }

    userId = keyData.user_id;
    apiKeyId = keyData.id ?? null;
    scopes = normalizeMcpScopes(keyData.scopes);

    const lastUsed = keyData.last_used_at ? new Date(keyData.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
      supabaseAdmin
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", keyData.id)
        .then(({ error }: { error: unknown }) => {
          if (error) console.error("Failed to update api_keys.last_used_at:", error);
        });
    }
  } else {
    const { data: tokenData, error: tokenError } = await supabaseAdmin
      .from("oauth_access_tokens")
      .select("*")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (tokenError || !tokenData) {
      return { kind: "unauthorized", error: "Invalid access token" };
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      return { kind: "unauthorized", error: "Access token has expired" };
    }

    userId = tokenData.user_id;
    scopes = normalizeMcpScopes(tokenData.scopes);
  }

  if (!userId) {
    return { kind: "unauthorized", error: isApiKey ? "Invalid API key" : "Invalid access token" };
  }

  const { data: subscription, error: subscriptionError } = await supabaseAdmin
    .from("user_subscriptions")
    .select("subscription_tier")
    .eq("user_id", userId)
    .maybeSingle();

  const tier = subscriptionError || !subscription ? "free" : (subscription.subscription_tier ?? "free");
  if (!MCP_ELIGIBLE_TIERS.has(tier)) {
    return { kind: "subscription_required", userId, apiKeyId, scopes, tier };
  }

  const { data: rateData, error: rateError } = await supabaseAdmin.rpc("consume_rate_limit", {
    _user_id: userId,
    _function_name: "mcp-server",
    _max: RATE_LIMIT_MAX_REQUESTS,
    _window_ms: RATE_LIMIT_WINDOW_MS,
  });
  const rateRow: LegacyRateLimitRow | undefined = Array.isArray(rateData) ? rateData[0] : rateData;

  if (rateError || !rateRow) {
    return {
      kind: "rate_limited",
      userId,
      apiKeyId,
      scopes,
      tier,
      remaining: 0,
      resetAt: new Date(Date.now() + RATE_LIMIT_WINDOW_MS),
    };
  }

  const remaining = typeof rateRow.remaining === "number" ? rateRow.remaining : 0;
  const resetAt = new Date(rateRow.reset_at ?? Date.now() + RATE_LIMIT_WINDOW_MS);
  if (!rateRow.allowed) {
    return { kind: "rate_limited", userId, apiKeyId, scopes, tier, remaining, resetAt };
  }

  return { kind: "authorized", userId, apiKeyId, scopes, tier, remaining, resetAt };
}

/**
 * Authorize an MCP request in one DB round-trip. The header is parsed and the
 * token hashed edge-side; everything else happens inside authorize_mcp_request.
 * Fails closed (treated as unauthorized) on any RPC error or missing row.
 */
export async function authorizeMcpRequest(
  authHeader: string | null,
  supabaseAdmin: any,
): Promise<AuthorizeResult> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { kind: "unauthorized", error: "Missing or invalid Authorization header" };
  }

  const token = authHeader.replace("Bearer ", "");
  const tokenHash = await hashValue(token);
  const isApiKey = token.startsWith("bk_");

  const { data, error } = await supabaseAdmin.rpc("authorize_mcp_request", {
    _token_hash: tokenHash,
    _is_api_key: isApiKey,
    _function_name: "mcp-server",
    _max: RATE_LIMIT_MAX_REQUESTS,
    _window_ms: RATE_LIMIT_WINDOW_MS,
    _last_used_throttle_ms: LAST_USED_THROTTLE_MS,
  });

  if (error) {
    if (shouldFallbackToLegacy(error)) {
      console.warn("authorize_mcp_request unavailable; falling back to legacy auth path");
      return await authorizeViaLegacyPath(supabaseAdmin, tokenHash, isApiKey);
    }
    // Fail closed — never dispatch when authorization cannot be evaluated.
    console.error("authorize_mcp_request RPC error:", error);
    return { kind: "unauthorized", error: isApiKey ? "Invalid API key" : "Invalid access token" };
  }

  const row: AuthorizeRpcRow | undefined = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // Deploy/schema mismatches can yield empty rows while legacy auth data is
    // still available; fallback preserves availability.
    console.error("authorize_mcp_request returned no row; falling back to legacy auth path");
    return await authorizeViaLegacyPath(supabaseAdmin, tokenHash, isApiKey);
  }

  switch (row.verdict) {
    case "invalid_key":
    case "expired_key":
    case "invalid_token":
    case "expired_token":
      return { kind: "unauthorized", error: AUTH_ERROR_MESSAGE[row.verdict] };

    case "subscription_required":
      return {
        kind: "subscription_required",
        userId: row.user_id!,
        apiKeyId: row.api_key_id,
        scopes: normalizeMcpScopes(row.scopes),
        tier: row.subscription_tier ?? "free",
      };

    case "rate_limited":
      return {
        kind: "rate_limited",
        userId: row.user_id!,
        apiKeyId: row.api_key_id,
        scopes: normalizeMcpScopes(row.scopes),
        tier: row.subscription_tier ?? "free",
        remaining: row.rate_remaining ?? 0,
        resetAt: new Date(row.rate_reset_at ?? Date.now() + RATE_LIMIT_WINDOW_MS),
      };

    case "authorized":
      return {
        kind: "authorized",
        userId: row.user_id!,
        apiKeyId: row.api_key_id,
        scopes: normalizeMcpScopes(row.scopes),
        tier: row.subscription_tier ?? "free",
        remaining: row.rate_remaining ?? 0,
        resetAt: new Date(row.rate_reset_at ?? Date.now() + RATE_LIMIT_WINDOW_MS),
      };

    default: {
      // Unknown verdict — fail closed.
      const exhaustive: never = row.verdict;
      console.error("authorize_mcp_request unknown verdict:", exhaustive);
      return { kind: "unauthorized", error: isApiKey ? "Invalid API key" : "Invalid access token" };
    }
  }
}

