import { assert, assertEquals } from "../_shared/asserts.ts";
import {
  brandKitSectionScope,
  MCP_SCOPES,
  normalizeMcpScopes,
} from "../_shared/mcp-scopes.ts";
import { toolErrorToRpc } from "./tool-rpc.ts";
import { executeTool } from "./execute-tool.ts";
import { extractStylesheetLinks } from "./scrape-visual-identity.ts";
import { validateUuidParam } from "./validation.ts";
import { authorizeMcpRequest } from "./authorize.ts";
import { LAST_USED_THROTTLE_MS, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "./constants.ts";
import { normalizeGovernanceForRead, toJsonArray, wrapWritingConstraintsForWrite } from "./json-helpers.ts";
import { summarizeRawScrape } from "./helpers.ts";
import { scrapeVisualIdentity } from "./scrape-visual-identity.ts";
import { buildBrandKitSectionToolMap } from "./tools/section-map.ts";
import { tools } from "./tools-catalog.ts";
import { SseWriter } from "./sse-writer.ts";
import { buildNotifyContext, DEFAULT_LOG_LEVEL, isLogLevel } from "./notify.ts";

Deno.test("toolErrorToRpc returns null for success-shaped results", () => {
  assertEquals(toolErrorToRpc({ content: [{ type: "text", text: "ok" }] }), null);
  assertEquals(toolErrorToRpc(null), null);
});

Deno.test("toolErrorToRpc maps isError tool results to JSON-RPC error envelope", () => {
  const rpc = toolErrorToRpc({
    content: [{ type: "text", text: "Scope denied" }],
    isError: true,
    _meta: { error_code: "scope_denied", retryable: false },
  });
  assert(rpc !== null && rpc !== undefined);
  assertEquals(rpc.error.code, -32603);
  assertEquals(rpc.error.message, "Scope denied");
  assertEquals((rpc.error.data as { error_code: string }).error_code, "scope_denied");
});


Deno.test("toolErrorToRpc merges extra data into error.data", () => {
  const rpc = toolErrorToRpc(
    {
      content: [{ type: "text", text: "Denied" }],
      isError: true,
      _meta: { error_code: "access_denied" },
    },
    { request_id: "req-1", tool_name: "upsert_brand_kit_governance" },
  );
  assert(rpc !== null && rpc !== undefined);
  const data = rpc.error.data as { error_code: string; request_id: string; tool_name: string };
  assertEquals(data.error_code, "access_denied");
  assertEquals(data.request_id, "req-1");
  assertEquals(data.tool_name, "upsert_brand_kit_governance");
});

Deno.test("validateUuidParam normalizes valid RFC4122 UUID", () => {
  const r = validateUuidParam("550E8400-E29B-41D4-A716-446655440000", "brand_kit_id");
  assert("ok" in r);
  assertEquals(r.value, "550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("validateUuidParam returns tool error for placeholder id", () => {
  const r = validateUuidParam("PASTE_UUID_HERE", "brand_kit_id");
  assert("isError" in r && r.isError === true);
});

function createEditorMemberSupabase() {
  return {
    from(table: string) {
      const state = { table, columns: "" };
      const builder = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        order(_column: string, _opts?: unknown) {
          return builder;
        },
        async maybeSingle() {
          const key = `${state.table}:${state.columns}`;
          if (key === "brand_kits:id") return { data: null, error: null };
          if (key === "brand_kit_members:id") return { data: { id: "member-1" }, error: null };
          if (key === "brand_kit_members:role") return { data: { role: "editor" }, error: null };
          throw new Error(`Unexpected maybeSingle call for ${key}`);
        },
        async insert(_payload: unknown) {
          throw new Error("Unexpected write call (insert)");
        },
        update(_payload: unknown) {
          throw new Error("Unexpected write call (update)");
        },
        async upsert(_payload: unknown, _opts?: unknown) {
          throw new Error("Unexpected write call (upsert)");
        },
      };
      return builder;
    },
  };
}

Deno.test("write tools deny non-admin member roles", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const scopes = [MCP_SCOPES.BRAND_KIT_WRITE];
  const writeCases: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: "update_brand_kit", args: { brand_kit_id: brandKitId, name: "Updated name" } },
    { tool: "update_brand_kit_visuals", args: { brand_kit_id: brandKitId, primary_color: "#111111" } },
    { tool: "upsert_brand_kit_seo", args: { brand_kit_id: brandKitId, keywords: [] } },
    {
      tool: "create_expression_example",
      args: { brand_kit_id: brandKitId, platform: "linkedin", context_type: "post", user_response: "Example" },
    },
    {
      tool: "create_brand_kit_competitor",
      args: { brand_kit_id: brandKitId, url: "https://example.com", tagline: "Tagline", confirm: true },
    },
    {
      tool: "update_brand_kit_competitor",
      args: { brand_kit_id: brandKitId, competitor_id: "comp-1", name: "Updated competitor", confirm: true },
    },
    {
      tool: "update_logo_asset",
      args: { brand_kit_id: brandKitId, asset_id: "asset-1", label: "Updated label" },
    },
  ];

  for (const testCase of writeCases) {
    const supabase = createEditorMemberSupabase();
    const result = await executeTool(testCase.tool, testCase.args, "user-1", supabase, scopes);
    assert((result as { isError?: boolean }).isError === true, `Expected tool error for ${testCase.tool}`);
    const meta = (result as { _meta?: Record<string, unknown> })._meta ?? {};
    assertEquals(meta.error_code, "access_denied");
    assertEquals(meta.membership_role, "editor");
  }
});

Deno.test("preview tools do not require brand_kit:write scope", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = {
    from(table: string) {
      const builder = {
        select(_columns: string) {
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        async maybeSingle() {
          if (table === "brand_kits") return { data: { id: brandKitId, user_id: "user-1" }, error: null };
          if (table === "brand_kit_members") return { data: null, error: null };
          if (table === "brand_kit_personality") return { data: null, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };

  const result = await executeTool(
    "preview_brand_kit_personality_update",
    { brand_kit_id: brandKitId, personality_traits: [{ title: "Direct", description: "Clear and concise." }] },
    "user-1",
    supabase,
    ["read"],
  );

  assert((result as { isError?: boolean }).isError !== true, "Preview should succeed with read-only scope");
  const text = (result as { content: { text: string }[] }).content[0].text;
  assert(text.includes("dry_run") || text.includes("proposed") || text.includes("preview"), "Expected dry-run preview payload");
});

Deno.test("extractStylesheetLinks blocks localhost, metadata, and private networks", () => {
  const html = `
    <link rel="stylesheet" href="/styles/site.css">
    <link rel="stylesheet" href="https://cdn.example.com/app.css">
    <link rel="stylesheet" href="http://127.0.0.1:8080/admin.css">
    <link rel="stylesheet" href="http://169.254.169.254/latest/meta-data/iam/security-credentials/">
    <link rel="stylesheet" href="http://metadata.google.internal/computeMetadata/v1/">
    <link rel="stylesheet" href="http://[::1]/loopback.css">
    <link rel="stylesheet" href="file:///etc/passwd">
  `;

  const urls = extractStylesheetLinks(html, "https://brand.example");
  assertEquals(urls, [
    "https://brand.example/styles/site.css",
    "https://cdn.example.com/app.css",
  ]);
});

Deno.test("extractStylesheetLinks blocks private-link-local relative targets", () => {
  const html = `<link rel="stylesheet" href="/internal.css">`;
  const urls = extractStylesheetLinks(html, "http://192.168.1.50");
  assertEquals(urls, []);
});

type RpcResponse = { data: unknown; error: unknown };

function createAuthorizeRpcSupabase(response: RpcResponse) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  };
}

function createLegacyFallbackSupabase(opts: {
  authorizeRpc: "missing_function" | "empty_row";
  oauthTokenExists?: boolean;
}) {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "authorize_mcp_request") {
        if (opts.authorizeRpc === "missing_function") {
          return Promise.resolve({
            data: null,
            error: {
              code: "PGRST202",
              message: "Could not find the function public.authorize_mcp_request",
            },
          });
        }
        return Promise.resolve({ data: [], error: null });
      }
      if (fn === "consume_rate_limit") {
        return Promise.resolve({
          data: [{ allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 2, reset_at: resetAt }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `Unexpected RPC ${fn}` } });
    },
    from(table: string) {
      if (table === "api_keys") {
        const state: { keyHash?: unknown; mode: "read" | "update" } = { mode: "read" };
        const builder = {
          select(_columns: string) {
            return builder;
          },
          eq(field: string, value: unknown) {
            if (state.mode === "read" && field === "key_hash") state.keyHash = value;
            return builder;
          },
          async maybeSingle() {
            if (!state.keyHash) return { data: null, error: null };
            return {
              data: {
                id: "key-legacy-1",
                user_id: "user-legacy-1",
                scopes: ["read", "brand_kit:write"],
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                last_used_at: new Date(Date.now() - (LAST_USED_THROTTLE_MS + 1000)).toISOString(),
              },
              error: null,
            };
          },
          update(_payload: Record<string, unknown>) {
            state.mode = "update";
            return {
              eq(_field: string, _value: unknown) {
                return Promise.resolve({ error: null });
              },
            };
          },
        };
        return builder;
      }

      if (table === "oauth_access_tokens") {
        const builder = {
          select(_columns: string) {
            return builder;
          },
          eq(_field: string, _value: unknown) {
            return builder;
          },
          async maybeSingle() {
            if (opts.oauthTokenExists === false) return { data: null, error: null };
            return {
              data: {
                user_id: "oauth-user-1",
                scopes: ["read"],
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
              error: null,
            };
          },
        };
        return builder;
      }

      if (table === "user_subscriptions") {
        const builder = {
          select(_columns: string) {
            return builder;
          },
          eq(_field: string, _value: unknown) {
            return builder;
          },
          async maybeSingle() {
            return { data: { subscription_tier: "base" }, error: null };
          },
        };
        return builder;
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

// authorizeMcpRequest consolidates validateAuth + checkSubscription +
// checkRateLimit into one authorize_mcp_request RPC. These tests prove the
// verdict -> result mapping preserves the prior status codes / messages /
// rate-limit semantics exactly.

Deno.test("authorizeMcpRequest rejects a missing/non-Bearer header without hitting the DB", async () => {
  const supabase = createAuthorizeRpcSupabase({ data: null, error: null });
  const result = await authorizeMcpRequest(null, supabase as never);
  assertEquals(result.kind, "unauthorized");
  assert(result.kind === "unauthorized" && result.error === "Missing or invalid Authorization header");
  assertEquals(supabase.calls.length, 0);
});

Deno.test("authorizeMcpRequest calls authorize_mcp_request with bk_ flag and limit params", async () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const supabase = createAuthorizeRpcSupabase({
    data: [{
      verdict: "authorized",
      user_id: "user-1",
      api_key_id: "key-1",
      scopes: ["read", "brand_kit:write"],
      subscription_tier: "base",
      rate_remaining: RATE_LIMIT_MAX_REQUESTS - 4,
      rate_reset_at: resetAt,
    }],
    error: null,
  });

  const result = await authorizeMcpRequest("Bearer bk_live_secret", supabase as never);

  assertEquals(supabase.calls.length, 1);
  assertEquals(supabase.calls[0].fn, "authorize_mcp_request");
  assertEquals(supabase.calls[0].args._is_api_key, true);
  assertEquals(supabase.calls[0].args._function_name, "mcp-server");
  assertEquals(supabase.calls[0].args._max, RATE_LIMIT_MAX_REQUESTS);
  assertEquals(supabase.calls[0].args._window_ms, RATE_LIMIT_WINDOW_MS);
  assertEquals(supabase.calls[0].args._last_used_throttle_ms, LAST_USED_THROTTLE_MS);
  // token is hashed edge-side, never sent raw.
  assert(supabase.calls[0].args._token_hash !== "bk_live_secret");
  assert(result.kind === "authorized");
  assertEquals(result.userId, "user-1");
  assertEquals(result.apiKeyId, "key-1");
  assertEquals(result.tier, "base");
  assertEquals(result.scopes, ["read", "brand_kit:write"]);
  assertEquals(result.remaining, RATE_LIMIT_MAX_REQUESTS - 4);
  assertEquals(result.resetAt.toISOString(), resetAt);
});

// The subscription gate lives in authorize_mcp_request and admits base/premium/max
// (see the RPC migration). A 'max'-tier key must resolve to an authorized verdict —
// regression guard for the max-tier access fix folded into the consolidated path.
Deno.test("authorizeMcpRequest authorizes the max subscription tier", async () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const supabase = createAuthorizeRpcSupabase({
    data: [{
      verdict: "authorized",
      user_id: "user-max",
      api_key_id: "key-max",
      scopes: ["read"],
      subscription_tier: "max",
      rate_remaining: RATE_LIMIT_MAX_REQUESTS - 1,
      rate_reset_at: resetAt,
    }],
    error: null,
  });

  const result = await authorizeMcpRequest("Bearer bk_max_tier", supabase as never);

  assert(result.kind === "authorized");
  assertEquals(result.tier, "max");
  assertEquals(result.userId, "user-max");
});

Deno.test("authorizeMcpRequest flags non-bk tokens as OAuth (_is_api_key false)", async () => {
  const supabase = createAuthorizeRpcSupabase({
    data: [{ verdict: "invalid_token", user_id: null, api_key_id: null, scopes: null, subscription_tier: null, rate_remaining: null, rate_reset_at: null }],
    error: null,
  });
  const result = await authorizeMcpRequest("Bearer oauth_abc", supabase as never);
  assertEquals(supabase.calls[0].args._is_api_key, false);
  assert(result.kind === "unauthorized" && result.error === "Invalid access token");
});

Deno.test("authorizeMcpRequest maps credential verdicts to the exact prior messages", async () => {
  const cases: Array<[string, string]> = [
    ["invalid_key", "Invalid API key"],
    ["expired_key", "API key has expired"],
    ["invalid_token", "Invalid access token"],
    ["expired_token", "Access token has expired"],
  ];
  for (const [verdict, message] of cases) {
    const supabase = createAuthorizeRpcSupabase({
      data: [{ verdict, user_id: null, api_key_id: null, scopes: null, subscription_tier: null, rate_remaining: null, rate_reset_at: null }],
      error: null,
    });
    const result = await authorizeMcpRequest("Bearer bk_x", supabase as never);
    assert(result.kind === "unauthorized" && result.error === message);
  }
});

Deno.test("authorizeMcpRequest maps subscription_required (carries user/tier for logging)", async () => {
  const supabase = createAuthorizeRpcSupabase({
    data: [{ verdict: "subscription_required", user_id: "user-2", api_key_id: "key-2", scopes: ["read"], subscription_tier: "free", rate_remaining: null, rate_reset_at: null }],
    error: null,
  });
  const result = await authorizeMcpRequest("Bearer bk_y", supabase as never);
  assert(result.kind === "subscription_required");
  assertEquals(result.userId, "user-2");
  assertEquals(result.apiKeyId, "key-2");
  assertEquals(result.tier, "free");
  assertEquals(result.scopes, ["read"]);
});

Deno.test("authorizeMcpRequest maps rate_limited with remaining 0 and reset time", async () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const supabase = createAuthorizeRpcSupabase({
    data: [{ verdict: "rate_limited", user_id: "user-3", api_key_id: "key-3", scopes: ["read"], subscription_tier: "base", rate_remaining: 0, rate_reset_at: resetAt }],
    error: null,
  });
  const result = await authorizeMcpRequest("Bearer bk_z", supabase as never);
  assert(result.kind === "rate_limited");
  assertEquals(result.remaining, 0);
  assertEquals(result.resetAt.toISOString(), resetAt);
});

Deno.test("authorizeMcpRequest fails closed when the RPC errors", async () => {
  const supabase = createAuthorizeRpcSupabase({ data: null, error: { message: "rpc unavailable" } });
  const result = await authorizeMcpRequest("Bearer bk_q", supabase as never);
  assert(result.kind === "unauthorized" && result.error === "Invalid API key");
});

Deno.test("authorizeMcpRequest falls back to legacy auth when authorize RPC is missing", async () => {
  const supabase = createLegacyFallbackSupabase({ authorizeRpc: "missing_function" });
  const result = await authorizeMcpRequest("Bearer bk_legacy_valid", supabase as never);
  assert(result.kind === "authorized");
  assertEquals(result.userId, "user-legacy-1");
  assertEquals(result.apiKeyId, "key-legacy-1");
  assertEquals(result.tier, "base");
  assert(supabase.calls.some((c) => c.fn === "consume_rate_limit"));
});

Deno.test("authorizeMcpRequest fallback still rejects unknown OAuth token", async () => {
  const supabase = createLegacyFallbackSupabase({ authorizeRpc: "empty_row", oauthTokenExists: false });
  const result = await authorizeMcpRequest("Bearer oauth_missing", supabase as never);
  assert(result.kind === "unauthorized" && result.error === "Invalid access token");
});

function createBrandKitSummarySupabase(opts: {
  writingConstraints: unknown;
  behavioralConstraints?: unknown;
  personalityTraits?: unknown;
  brandValues?: unknown;
}) {
  return {
    from(table: string) {
      const state = { table, columns: "" };
      const builder = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        async maybeSingle() {
          const key = `${state.table}:${state.columns}`;
          if (key === "brand_kits:id") return { data: { id: "bk-1" }, error: null };
          if (key === "brand_kits:name, tagline, description, brand_voice") {
            return {
              data: {
                name: "Kit",
                tagline: "Tagline",
                description: "Desc",
                brand_voice: "Voice",
              },
              error: null,
            };
          }
          if (key === "brand_kit_core:mission, vision") {
            return { data: { mission: "Mission", vision: "Vision" }, error: null };
          }
          if (key === "brand_kit_personality:personality_traits, brand_values") {
            return {
              data: {
                personality_traits: opts.personalityTraits ?? [{ title: "Bold" }],
                brand_values: opts.brandValues ?? [{ name: "Transparency" }],
              },
              error: null,
            };
          }
          if (key === "brand_kit_expression:tone_of_voice, tone_dimensions") {
            return {
              data: { tone_of_voice: { primary: "Direct" }, tone_dimensions: { formality: 60 } },
              error: null,
            };
          }
          if (key === "brand_kit_governance:behavioral_constraints, writing_constraints") {
            return {
              data: {
                behavioral_constraints: opts.behavioralConstraints ?? [{ rule: "No hype" }],
                writing_constraints: opts.writingConstraints,
              },
              error: null,
            };
          }
          throw new Error(`Unexpected maybeSingle call for ${key}`);
        },
        async insert(_payload: unknown) {
          throw new Error("Unexpected write call (insert)");
        },
        update(_payload: unknown) {
          throw new Error("Unexpected write call (update)");
        },
        async upsert(_payload: unknown, _opts?: unknown) {
          throw new Error("Unexpected write call (upsert)");
        },
        order(_column: string, _opts?: unknown) {
          return builder;
        },
        then(resolve: (v: unknown) => void, _reject?: (e: unknown) => void) {
          const key = `${state.table}:${state.columns}`;
          if (key === "brand_kit_products:name, type, usp") {
            return Promise.resolve(resolve({ data: [{ name: "Product", type: "Service", usp: "Fast" }], error: null }));
          }
          if (key === "brand_kit_target_audience:persona_name, persona_type, is_primary, demographics") {
            return Promise.resolve(
              resolve({
                data: [{ persona_name: "Primary", persona_type: "b2b", is_primary: true, demographics: {} }],
                error: null,
              }),
            );
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return builder;
    },
  };
}

Deno.test("get_brand_kit_summary does not crash when writing_constraints is an array", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandKitSummarySupabase({
    writingConstraints: [{ rule: "Max 25 words" }],
  });
  const result = await executeTool("get_brand_kit_summary", { brand_kit_id: brandKitId }, "user-1", supabase, [
    MCP_SCOPES.READ,
  ]);
  assert((result as { isError?: boolean }).isError !== true);
});

Deno.test("get_brand_kit_summary does not crash when writing_constraints is a plain object", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandKitSummarySupabase({
    writingConstraints: { max_sentence_length: 25, active_voice_preference: true },
  });
  const result = await executeTool("get_brand_kit_summary", { brand_kit_id: brandKitId }, "user-1", supabase, [
    MCP_SCOPES.READ,
  ]);
  assert((result as { isError?: boolean }).isError !== true);
});

Deno.test("get_brand_kit_summary does not crash when writing_constraints is wrapped {constraints:[...]}", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandKitSummarySupabase({
    writingConstraints: { constraints: [{ rule: "No slang" }] },
  });
  const result = await executeTool("get_brand_kit_summary", { brand_kit_id: brandKitId }, "user-1", supabase, [
    MCP_SCOPES.READ,
  ]);
  assert((result as { isError?: boolean }).isError !== true);
});

Deno.test("get_brand_kit_summary does not crash when personality fields are plain objects", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandKitSummarySupabase({
    writingConstraints: [{ rule: "No slang" }],
    personalityTraits: { primary: { title: "Bold" } },
    brandValues: { north_star: "Trust" },
  });
  const result = await executeTool("get_brand_kit_summary", { brand_kit_id: brandKitId }, "user-1", supabase, [
    MCP_SCOPES.READ,
  ]);
  assert((result as { isError?: boolean }).isError !== true);
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  const payload = JSON.parse(text);
  assert(Array.isArray(payload.top_personality_traits));
  assert(Array.isArray(payload.top_values));
});

Deno.test("normalizeGovernanceForRead preserves the writing_constraints wrapper (G-3)", () => {
  const normalized = normalizeGovernanceForRead({
    writing_constraints: { constraints: [{ rule: "Short sentences" }], platformSpecificEnabled: true },
    behavioral_constraints: { constraints: [{ rule: "No hype" }] },
  });
  // G-3: writing_constraints round-trips as the full wrapper object (not a bare
  // array), so platformSpecificEnabled and other wrapper keys survive the read.
  const wc = normalized?.writing_constraints as { constraints: unknown[]; platformSpecificEnabled?: boolean };
  assert(wc !== null && typeof wc === "object" && !Array.isArray(wc));
  assert(Array.isArray(wc.constraints));
  assertEquals(wc.constraints.length, 1);
  assertEquals(wc.platformSpecificEnabled, true);
  // behavioral_constraints is still coerced to a bare array.
  assert(Array.isArray(normalized?.behavioral_constraints));
});


Deno.test("toJsonArray returns empty array for nullish values", () => {
  assertEquals(toJsonArray(null), []);
  assertEquals(toJsonArray(undefined), []);
});

Deno.test("wrapWritingConstraintsForWrite leaves null/undefined alone", () => {
  assertEquals(wrapWritingConstraintsForWrite(null), null);
  assertEquals(wrapWritingConstraintsForWrite(undefined), undefined);
});

Deno.test("wrapWritingConstraintsForWrite wraps a bare array into {constraints:[...]}", () => {
  const wrapped = wrapWritingConstraintsForWrite([{ rule: "Sentences <= 18 words" }]) as { constraints: unknown[] };
  assertEquals(Array.isArray(wrapped.constraints), true);
  assertEquals(wrapped.constraints.length, 1);
});

Deno.test("wrapWritingConstraintsForWrite normalizes bare-string array items into {rule}", () => {
  const wrapped = wrapWritingConstraintsForWrite(["No slang", "Active voice"]) as { constraints: Array<{ rule: string }> };
  assertEquals(wrapped.constraints[0].rule, "No slang");
  assertEquals(wrapped.constraints[1].rule, "Active voice");
});

Deno.test("wrapWritingConstraintsForWrite passes through canonical shape (and normalizes items)", () => {
  const wrapped = wrapWritingConstraintsForWrite({
    constraints: ["No slang", { rule: "Active voice" }],
    preferences: { active_voice: true },
  }) as { constraints: Array<{ rule: string }>; preferences: Record<string, unknown> };
  assertEquals(wrapped.constraints.length, 2);
  assertEquals(wrapped.constraints[0].rule, "No slang");
  assertEquals(wrapped.preferences.active_voice, true);
});

Deno.test("wrapWritingConstraintsForWrite rewrites {rules:[...]} into {constraints:[...]} preserving extras", () => {
  const wrapped = wrapWritingConstraintsForWrite({
    rules: [{ rule: "Be concise" }],
    active_voice: true,
  }) as { constraints: unknown[]; preferences: Record<string, unknown> };
  assertEquals(wrapped.constraints.length, 1);
  assertEquals(wrapped.preferences.active_voice, true);
});

Deno.test("wrapWritingConstraintsForWrite merges existing preferences instead of nesting", () => {
  const wrapped = wrapWritingConstraintsForWrite({
    rules: [{ rule: "Be concise" }],
    preferences: { active_voice: true, readability_level: "grade 8" },
    extra_top_level: "kept",
  }) as { constraints: unknown[]; preferences: Record<string, unknown> };
  assertEquals(wrapped.constraints.length, 1);
  assertEquals(wrapped.preferences.active_voice, true);
  assertEquals(wrapped.preferences.readability_level, "grade 8");
  assertEquals(wrapped.preferences.extra_top_level, "kept");
  // The inner preferences object should NOT be nested under a second preferences key.
  assertEquals((wrapped.preferences as { preferences?: unknown }).preferences, undefined);
});

Deno.test("wrapWritingConstraintsForWrite buckets flat key/value objects under preferences", () => {
  const wrapped = wrapWritingConstraintsForWrite({
    active_voice_preference: true,
    max_sentence_length: "20 words",
  }) as { constraints: unknown[]; preferences: Record<string, unknown> };
  assertEquals(wrapped.constraints.length, 0);
  assertEquals(wrapped.preferences.active_voice_preference, true);
  assertEquals(wrapped.preferences.max_sentence_length, "20 words");
});

Deno.test("wrapWritingConstraintsForWrite wraps a bare string as a single rule", () => {
  const wrapped = wrapWritingConstraintsForWrite("Sentences must be short") as { constraints: Array<{ rule: string }> };
  assertEquals(wrapped.constraints.length, 1);
  assertEquals(wrapped.constraints[0].rule, "Sentences must be short");
});

Deno.test("summarizeRawScrape strips css_tokens and reports a count", () => {
  const summarized = summarizeRawScrape({
    competitor: "x",
    raw_scrape_data: {
      css_tokens: { "--a": "1", "--b": "2", "--c": "3" },
      extraction_confidence: { brand_colors: "high" },
      scraped_at: "2026-05-28T00:00:00Z",
      scrape_status: "success",
    },
  }) as { raw_scrape_data: Record<string, unknown> };
  assertEquals(summarized.raw_scrape_data.css_token_count, 3);
  assertEquals((summarized.raw_scrape_data as Record<string, unknown>).css_tokens, undefined);
  assertEquals(summarized.raw_scrape_data.scrape_status, "success");
  assertEquals((summarized.raw_scrape_data.extraction_confidence as Record<string, string>).brand_colors, "high");
});

Deno.test("summarizeRawScrape is a no-op when raw_scrape_data is missing", () => {
  const input = { competitor: "x" } as const;
  assertEquals(summarizeRawScrape(input), input);
});

Deno.test("scrapeVisualIdentity returns scrape_status: 'no_api_key' when key missing", async () => {
  // Whitespace explicit apiKey forces the no-key branch even if CI has
  // FIRECRAWL_API_KEY set — the caller-supplied param is authoritative.
  const result = await scrapeVisualIdentity("https://brandkitos.com", { apiKey: "   " });
  assertEquals(result.scrape_status, "no_api_key");
  assertEquals(result.brand_colors, []);
  assertEquals(result.fonts, []);
});

Deno.test("scrapeVisualIdentity returns scrape_status: 'blocked' on HTTP 403", async () => {
  const fakeFetch = (() => Promise.resolve(new Response("forbidden", { status: 403 }))) as unknown as typeof fetch;
  const result = await scrapeVisualIdentity("https://example.com", { apiKey: "test", fetchImpl: fakeFetch });
  assertEquals(result.scrape_status, "blocked");
  assert(typeof result.scrape_status_reason === "string");
});

Deno.test("buildBrandKitSectionToolMap covers core read/preview/write", () => {
  const map = buildBrandKitSectionToolMap();
  assert(map.core?.read?.includes("get_brand_kit_core"));
  assert(map.core?.preview?.includes("preview_brand_kit_core_update"));
  assert(map.core?.write?.includes("upsert_brand_kit_core"));
});

Deno.test("buildBrandKitSectionToolMap references only tools that exist in the catalog", () => {
  const map = buildBrandKitSectionToolMap();
  const knownToolNames = new Set(tools.map((t: { name: string }) => t.name));
  for (const [section, group] of Object.entries(map)) {
    for (const bucket of ["read", "preview", "write", "generate"] as const) {
      for (const name of group[bucket] ?? []) {
        assert(knownToolNames.has(name), `section '${section}' bucket '${bucket}' references unknown tool '${name}'`);
      }
    }
  }
});

Deno.test("list_brand_kit_tools tool is registered as read-only", () => {
  const t = tools.find((x: { name: string }) => x.name === "list_brand_kit_tools") as
    | { annotations?: { readOnlyHint?: boolean } }
    | undefined;
  assert(t !== undefined);
  assertEquals(t!.annotations?.readOnlyHint, true);
});

Deno.test("list_brand_kit_tools returns the section map without a brand_kit_id", async () => {
  const result = await executeTool("list_brand_kit_tools", {}, "user-1", {} as Record<string, unknown>, [MCP_SCOPES.READ]);
  assert((result as { isError?: boolean }).isError !== true);
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  const payload = JSON.parse(text);
  assertEquals(typeof payload.sections, "object");
  assert(Array.isArray(payload.sections.core.read));
});

Deno.test("list_brand_kit_tools scopes to a single section when requested", async () => {
  const result = await executeTool(
    "list_brand_kit_tools",
    { section: "competitors" },
    "user-1",
    {} as Record<string, unknown>,
    [MCP_SCOPES.READ],
  );
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  assertEquals(payload.section, "competitors");
  assert(payload.tools.write.includes("create_brand_kit_competitor"));
});

Deno.test("formatPersonality no longer emits short-key aliases", async () => {
  // Use the live module rather than re-importing to ensure we test the deployed shape.
  const { formatPersonality } = await import("./ai-gateway.ts");
  const out = formatPersonality({
    personality_traits: [{ title: "Bold" }],
    brand_values: [{ name: "Honesty" }],
    brand_principles: [{ name: "Do good" }],
    brand_moods: [{ name: "Bright" }],
  }) as Record<string, unknown>;
  assertEquals(out.traits, undefined);
  assertEquals(out.values, undefined);
  assertEquals(out.principles, undefined);
  assertEquals(out.moods, undefined);
  assertEquals(Array.isArray(out.personality_traits), true);
});

Deno.test("get_brand_kit_governance returns normalized constraint arrays", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = {
    from(table: string) {
      const state = { table, columns: "" };
      const builder = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        async maybeSingle() {
          const key = `${state.table}:${state.columns}`;
          if (key === "brand_kits:id") return { data: { id: brandKitId }, error: null };
          if (key === "brand_kit_governance:*") {
            return {
              data: {
                brand_kit_id: brandKitId,
                writing_constraints: { constraints: [{ rule: "Active voice" }] },
                behavioral_constraints: [{ rule: "Be concise" }],

              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };

  const result = await executeTool(
    "get_brand_kit_governance",
    { brand_kit_id: brandKitId },
    "user-1",
    supabase,
    [MCP_SCOPES.READ],
  );
  assert((result as { isError?: boolean }).isError !== true);
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  const payload = JSON.parse(text);
  // G-3: writing_constraints is the wrapper object with an inner constraints array.
  assert(payload.writing_constraints && typeof payload.writing_constraints === "object" && !Array.isArray(payload.writing_constraints));
  assert(Array.isArray(payload.writing_constraints.constraints));
  assert(Array.isArray(payload.behavioral_constraints));

});

Deno.test("normalizeMcpScopes accepts granular section write scopes", () => {
  const scopes = normalizeMcpScopes([
    MCP_SCOPES.READ,
    brandKitSectionScope("core"),
    brandKitSectionScope("expression"),
  ]);
  assert(scopes.includes(brandKitSectionScope("core")));
  assert(scopes.includes(brandKitSectionScope("expression")));
  assert(!scopes.includes(MCP_SCOPES.BRAND_KIT_WRITE));
});

Deno.test("section scope allows matching upsert and denies other sections", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const coreOnly = [MCP_SCOPES.READ, brandKitSectionScope("core")];

  const ownerSupabase = {
    from(table: string) {
      const builder = {
        select(_columns: string) {
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        async maybeSingle() {
          if (table === "brand_kits") return { data: { id: brandKitId, user_id: "user-1" }, error: null };
          if (table === "brand_kit_members") return { data: null, error: null };
          return { data: null, error: null };
        },
        async upsert(_payload: unknown, _opts?: unknown) {
          return { data: null, error: null };
        },
        async selectAfterUpsert() {
          return { data: { brand_kit_id: brandKitId, mission: "Test" }, error: null };
        },
      };
      return builder;
    },
  };

  const denied = await executeTool(
    "upsert_brand_kit_expression",
    { brand_kit_id: brandKitId, tone_of_voice: { professional: 80 }, dry_run: true },
    "user-1",
    ownerSupabase,
    coreOnly,
  );
  assert((denied as { isError?: boolean }).isError === true);
  const deniedMeta = (denied as { _meta?: Record<string, unknown> })._meta ?? {};
  assertEquals(deniedMeta.error_code, "scope_denied");
  assertEquals(deniedMeta.required_section, "expression");

  const supabaseWithCore = {
    from(table: string) {
      const builder = {
        select(_columns: string) {
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        async maybeSingle() {
          if (table === "brand_kits") return { data: { id: brandKitId, user_id: "user-1" }, error: null };
          if (table === "brand_kit_members") return { data: { role: "owner" }, error: null };
          if (table === "brand_kit_core") return { data: { mission: "Old" }, error: null };
          return { data: null, error: null };
        },
        upsert(_payload: unknown, _opts?: unknown) {
          return {
            select() {
              return {
                async maybeSingle() {
                  return { data: { brand_kit_id: brandKitId, mission: "New" }, error: null };
                },
              };
            },
          };
        },
      };
      return builder;
    },
  };

  const allowed = await executeTool(
    "upsert_brand_kit_core",
    { brand_kit_id: brandKitId, mission: "New", dry_run: true },
    "user-1",
    supabaseWithCore,
    coreOnly,
  );
  assert((allowed as { isError?: boolean }).isError !== true);
});

function createBrandContextSupabase(opts: { goalsMotivations?: unknown; valuePropositions?: unknown }) {
  return {
    from(table: string) {
      const state = { table, columns: "" };
      const builder = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        async maybeSingle() {
          const key = `${state.table}:${state.columns}`;
          if (key === "brand_kits:id") return { data: { id: "bk-1" }, error: null };
          if (key === "brand_kits:name, tagline, description, brand_voice") {
            return { data: { name: "Kit", tagline: "T", description: "D", brand_voice: "V" }, error: null };
          }
          if (key === "brand_kit_core:mission, vision") {
            return { data: { mission: "M", vision: "Vi" }, error: null };
          }
          if (key === "brand_kit_expression:tone_of_voice, tone_dimensions, verbal_style, preferred_terminology") {
            return { data: { tone_of_voice: { primary: "Direct" } }, error: null };
          }
          if (key === "brand_kit_governance:behavioral_constraints, negative_directory, writing_constraints") {
            return {
              data: { behavioral_constraints: [], writing_constraints: [], negative_directory: {} },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(resolve: (v: unknown) => void, _reject?: (e: unknown) => void) {
          const key = `${state.table}:${state.columns}`;
          if (key.startsWith("brand_kit_target_audience:")) {
            return Promise.resolve(
              resolve({
                data: [{
                  persona_name: "Primary",
                  persona_type: "b2b",
                  is_primary: true,
                  demographics: {},
                  goals_motivations: opts.goalsMotivations,
                  core_motivation: "Save time",
                }],
                error: null,
              }),
            );
          }
          if (key.startsWith("brand_kit_competitors:")) {
            return Promise.resolve(
              resolve({
                data: [{
                  name: "Acme",
                  tagline: "We build things",
                  value_propositions: opts.valuePropositions,
                  brand_personality: {},
                }],
                error: null,
              }),
            );
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return builder;
    },
  };
}

Deno.test("get_brand_context_for_agent does not crash when goals_motivations is a plain object", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandContextSupabase({
    goalsMotivations: { primary: "Save time", secondary: "Reduce cost" },
  });
  const result = await executeTool(
    "get_brand_context_for_agent",
    { brand_kit_id: brandKitId, task_type: "content_creation" },
    "user-1",
    supabase,
    [MCP_SCOPES.READ],
  );
  assert((result as { isError?: boolean }).isError !== true);
});

Deno.test("get_brand_context_for_agent does not crash when goals_motivations is wrapped {constraints:[...]}", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandContextSupabase({
    goalsMotivations: { constraints: ["Grow revenue", "Improve retention"] },
  });
  const result = await executeTool(
    "get_brand_context_for_agent",
    { brand_kit_id: brandKitId, task_type: "content_creation" },
    "user-1",
    supabase,
    [MCP_SCOPES.READ],
  );
  assert((result as { isError?: boolean }).isError !== true);
});

Deno.test("get_brand_context_for_agent does not crash when value_propositions is a plain object", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandContextSupabase({
    valuePropositions: { primary: "Speed", secondary: "Reliability" },
  });
  const result = await executeTool(
    "get_brand_context_for_agent",
    { brand_kit_id: brandKitId, task_type: "competitive_analysis" },
    "user-1",
    supabase,
    [MCP_SCOPES.READ],
  );
  assert((result as { isError?: boolean }).isError !== true);
});

Deno.test("get_brand_context_for_agent does not crash when value_propositions is wrapped {constraints:[...]}", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createBrandContextSupabase({
    valuePropositions: { constraints: ["Faster than competitor X", "10x cheaper"] },
  });
  const result = await executeTool(
    "get_brand_context_for_agent",
    { brand_kit_id: brandKitId, task_type: "competitive_analysis" },
    "user-1",
    supabase,
    [MCP_SCOPES.READ],
  );
  assert((result as { isError?: boolean }).isError !== true);
});

function createGenerateAudiencePersonaSupabase(opts: { personalityTraits: unknown }) {
  return {
    from(table: string) {
      const state = { table, columns: "", mode: "" as "" | "update" | "insert" };
      const builder = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        eq(_field: string, _value: unknown) {
          return builder;
        },
        update(_payload: unknown) {
          state.mode = "update";
          return builder;
        },
        insert(_payload: unknown) {
          state.mode = "insert";
          return Promise.resolve({ data: null, error: null });
        },
        async maybeSingle() {
          const key = `${state.table}:${state.columns}`;
          if (key === "brand_kits:id") return { data: { id: "bk-1" }, error: null };
          if (key === "brand_kits:name, tagline, description, brand_voice") {
            return { data: { name: "Kit", tagline: "T", description: "D", brand_voice: "V" }, error: null };
          }
          if (key === "brand_kit_core:mission, vision") {
            return { data: { mission: "M", vision: "Vi" }, error: null };
          }
          if (key === "brand_kit_expression:tone_of_voice") {
            return { data: { tone_of_voice: { primary: "Direct" } }, error: null };
          }
          if (key === "brand_kit_personality:personality_traits") {
            return { data: { personality_traits: opts.personalityTraits }, error: null };
          }
          if (key === "user_subscriptions:tokens_balance, tokens_used_this_period") {
            return { data: { tokens_balance: 99, tokens_used_this_period: 1 }, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          const key = `${state.table}:${state.columns}`;
          if (key === "user_subscriptions:*") {
            return {
              data: {
                tokens_balance: 100,
                monthly_token_allowance: 100,
                tokens_used_this_period: 0,
                overage_limit_percent: 0,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(resolve: (v: unknown) => void, _reject?: (e: unknown) => void) {
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return builder;
    },
  };
}

Deno.test("generate_audience_persona does not crash when personality_traits is a plain object", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createGenerateAudiencePersonaSupabase({
    personalityTraits: { primary: { title: "Bold" }, secondary: { title: "Direct" } },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("stubbed: AI gateway unreachable in tests"));
  try {
    const result = await executeTool(
      "generate_audience_persona",
      {
        brand_kit_id: brandKitId,
        persona_name: "Test Persona",
        persona_type: "b2b",
      },
      "user-1",
      supabase,
      [MCP_SCOPES.BRAND_KIT_WRITE],
    );
    const meta = (result as { _meta?: { error_code?: string } })._meta;
    assertEquals(meta?.error_code, "ai_gateway_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("preview_generate_* tools are registered as read-only", () => {
  for (const n of ["preview_generate_audience_persona", "preview_generate_ai_persona"]) {
    const t = tools.find((x: { name: string }) => x.name === n) as
      | { annotations?: { readOnlyHint?: boolean } }
      | undefined;
    assert(t !== undefined, `${n} missing from catalog`);
    assertEquals(t!.annotations?.readOnlyHint, true);
  }
});

Deno.test("buildBrandKitSectionToolMap exposes preview_generate tools in preview buckets", () => {
  const map = buildBrandKitSectionToolMap();
  assert(map.audience?.preview?.includes("preview_generate_audience_persona"));
  assert(map.personas?.preview?.includes("preview_generate_ai_persona"));
});

Deno.test("preview_generate_audience_persona is reachable with read scope (not write-gated)", async () => {
  const brandKitId = "550e8400-e29b-41d4-a716-446655440000";
  const supabase = createGenerateAudiencePersonaSupabase({ personalityTraits: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("stubbed: AI gateway unreachable in tests"));
  try {
    const result = await executeTool(
      "preview_generate_audience_persona",
      { brand_kit_id: brandKitId, persona_name: "Solo Creator Sarah", persona_type: "b2c", description: "Indie maker" },
      "user-1",
      supabase,
      [MCP_SCOPES.READ],
    );
    // Read scope reaches the AI gateway (it is not blocked by a write-scope
    // gate); the stubbed gateway then fails. A scope gate would have returned
    // scope_denied before any gateway call.
    const meta = (result as { _meta?: { error_code?: string } })._meta;
    assertEquals(meta?.error_code, "ai_gateway_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A minimal write-tool mock: ownership checks pass, dry_run short-circuits
// before any insert. Throws if insert is ever called.
function createDryRunWriteSupabase() {
  return {
    from(_table: string) {
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        insert() { throw new Error("insert must not be called during dry_run"); },
        update() { return builder; },
        maybeSingle() { return Promise.resolve({ data: { id: "bk-1", role: "admin" }, error: null }); },
        single() { return Promise.resolve({ data: { id: "bk-1" }, error: null }); },
        then(resolve: (v: unknown) => void) { return Promise.resolve(resolve({ data: null, error: null })); },
      };
      return builder;
    },
  };
}

Deno.test("create_audience_persona carries source: ai_generated through to the insert payload", async () => {
  const result = await executeTool(
    "create_audience_persona",
    { brand_kit_id: "550e8400-e29b-41d4-a716-446655440000", persona_name: "Solo Creator Sarah", persona_type: "b2c", audience_kind: "person", source: "ai_generated", dry_run: true },
    "user-1",
    createDryRunWriteSupabase(),
    [MCP_SCOPES.BRAND_KIT_WRITE],
  );
  assert((result as { isError?: boolean }).isError !== true);
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  assertEquals(payload.proposed_changes.source, "ai_generated");
});

Deno.test("create_brand_kit_persona carries source: ai_generated through to the insert payload", async () => {
  const result = await executeTool(
    "create_brand_kit_persona",
    { brand_kit_id: "550e8400-e29b-41d4-a716-446655440000", name: "Brand Voice Agent", purpose_type: "content_creation", source: "ai_generated", dry_run: true },
    "user-1",
    createDryRunWriteSupabase(),
    [MCP_SCOPES.BRAND_KIT_WRITE],
  );
  assert((result as { isError?: boolean }).isError !== true);
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  assertEquals(payload.proposed_changes.source, "ai_generated");
});

Deno.test("create_brand_kit_persona defaults source to manual when omitted", async () => {
  const result = await executeTool(
    "create_brand_kit_persona",
    { brand_kit_id: "550e8400-e29b-41d4-a716-446655440000", name: "Manual Agent", purpose_type: "content_creation", dry_run: true },
    "user-1",
    createDryRunWriteSupabase(),
    [MCP_SCOPES.BRAND_KIT_WRITE],
  );
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  assertEquals(payload.proposed_changes.source, "manual");
});

// ---------- Live notifications (notify.ts + sse-writer.ts) ----------

function makeCollectingWriter() {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const finals: unknown[] = [];
  const decoder = new TextDecoder();

  function parseChunk(chunk: Uint8Array) {
    const text = decoder.decode(chunk);
    // Each SSE event is `[id: X\n]data: <json>\n\n`.
    for (const block of text.split("\n\n")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(6));
      if (payload && typeof payload === "object" && "method" in payload) {
        events.push({ method: payload.method as string, params: payload.params as Record<string, unknown> });
      } else {
        finals.push(payload);
      }
    }
  }

  const controller: ReadableStreamDefaultController<Uint8Array> = {
    enqueue: parseChunk,
    close: () => {},
    error: () => {},
    desiredSize: null,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  return {
    writer: new SseWriter(controller),
    events,
    finals,
  };
}

Deno.test("SseWriter collects notifications and final envelope in wire order", () => {
  const { writer, events, finals } = makeCollectingWriter();
  writer.notification("notifications/message", { level: "info", data: "first" });
  writer.notification("notifications/progress", { progressToken: "tok-1", progress: 50, total: 100 });
  writer.write({ jsonrpc: "2.0", result: { ok: true }, id: 1 }, 1);

  assertEquals(events.length, 2);
  assertEquals(events[0].method, "notifications/message");
  assertEquals(events[1].method, "notifications/progress");
  assertEquals((events[1].params as { progressToken: string }).progressToken, "tok-1");
  assertEquals(finals.length, 1);
  assertEquals((finals[0] as { result: { ok: boolean } }).result.ok, true);
});

Deno.test("SseWriter no-ops after enqueue throws (client disconnect)", () => {
  let calls = 0;
  const controller: ReadableStreamDefaultController<Uint8Array> = {
    enqueue: () => {
      calls += 1;
      throw new Error("controller closed");
    },
    close: () => {},
    error: () => {},
    desiredSize: null,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  const writer = new SseWriter(controller);
  writer.notification("notifications/message", { level: "info", data: "x" });
  assertEquals(writer.isClosed(), true);
  // Subsequent calls must not throw and must not retry the enqueue.
  writer.notification("notifications/message", { level: "info", data: "y" });
  writer.write({ jsonrpc: "2.0", result: null, id: 1 });
  assertEquals(calls, 1);
});

Deno.test("buildNotifyContext: setLevel='warning' filters info but not warning", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-1",
    progressToken: undefined,
    sessionLogLevel: "warning",
  });
  await notify.log("info", "should be dropped");
  await notify.log("debug", "should be dropped");
  await notify.log("warning", "should pass");
  assertEquals(events.length, 1);
  assertEquals((events[0].params as { level: string }).level, "warning");
});

Deno.test("buildNotifyContext: 100 info logs in 1ms produce <= 2 wire events (throttle)", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-1",
    progressToken: undefined,
    sessionLogLevel: "info",
  });
  for (let i = 0; i < 100; i++) {
    await notify.log("info", `msg ${i}`);
  }
  // First one passes (lastLog starts at 0), the rest fall inside the 100ms window.
  // Upper bound is 2 to give a tiny tolerance if the test process stalls
  // across the throttle boundary mid-loop.
  assert(events.length <= 2, `expected <= 2 events, got ${events.length}`);
  assert(events.length >= 1, "first log should always pass");
});

Deno.test("buildNotifyContext: urgent log levels bypass throttle", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-1",
    progressToken: undefined,
    sessionLogLevel: "info",
  });
  await notify.log("info", "first");
  // Without bypass the next call would be throttled (same handler, same tick).
  await notify.log("error", "urgent");
  assertEquals(events.length, 2);
  assertEquals((events[1].params as { level: string }).level, "error");
});

Deno.test("buildNotifyContext: progress completion bypasses throttle", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-1",
    progressToken: undefined,
    sessionLogLevel: "info",
  });
  await notify.progress(10, 100, "starting");
  // Sub-throttle window — would normally drop, but completion bypasses.
  await notify.progress(100, 100, "done");
  assertEquals(events.length, 2);
  assertEquals((events[1].params as { progress: number; total: number }).progress, 100);
});

Deno.test("buildNotifyContext: progressToken from _meta passes through", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-uuid",
    progressToken: "client-token-42",
    sessionLogLevel: "info",
  });
  await notify.progress(50, 100, "halfway");
  assertEquals(events.length, 1);
  assertEquals(
    (events[0].params as { progressToken: string }).progressToken,
    "client-token-42",
  );
});

Deno.test("buildNotifyContext: progressToken falls back to requestId when _meta absent", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-uuid-fallback",
    progressToken: undefined,
    sessionLogLevel: "info",
  });
  await notify.progress(50, 100, "halfway");
  assertEquals(events.length, 1);
  assertEquals(
    (events[0].params as { progressToken: string }).progressToken,
    "req-uuid-fallback",
  );
});

Deno.test("buildNotifyContext: large data payloads are truncated to 8KB", async () => {
  const { writer, events } = makeCollectingWriter();
  const notify = buildNotifyContext({
    writer,
    requestId: "req-1",
    progressToken: undefined,
    sessionLogLevel: "info",
  });
  const big = "x".repeat(20 * 1024);
  await notify.log("info", "big payload", { blob: big });
  assertEquals(events.length, 1);
  const meta = (events[0].params as { meta: { _truncated?: boolean } }).meta;
  assertEquals(meta._truncated, true);
});

Deno.test("buildNotifyContext: no writer means no-op", async () => {
  const notify = buildNotifyContext({
    writer: null,
    requestId: "req-1",
    progressToken: undefined,
    sessionLogLevel: "info",
  });
  // No throw, no observable side effects.
  await notify.log("info", "dropped");
  await notify.progress(10, 100, "dropped");
});

Deno.test("isLogLevel accepts canonical levels and rejects junk", () => {
  assertEquals(isLogLevel("info"), true);
  assertEquals(isLogLevel("emergency"), true);
  assertEquals(isLogLevel("trace"), false);
  assertEquals(isLogLevel(""), false);
  assertEquals(isLogLevel(null), false);
  assertEquals(DEFAULT_LOG_LEVEL, "info");
});


import { TOOLS_WITHOUT_BRAND_KIT_ID_ARG } from "./constants.ts";

Deno.test("list_compliance_standards is callable without brand_kit_id", async () => {
  const rows = [
    { id: "std-1", name: "WCAG 2.2", category: "accessibility" },
    { id: "std-2", name: "GDPR", category: "privacy" },
  ];
  const supabase = {
    from(_table: string) {
      const builder = {
        select(_columns: string) { return builder; },
        order(_col: string, _opts?: unknown) { return Promise.resolve({ data: rows, error: null }); },
      };
      return builder;
    },
  };
  const result = await executeTool("list_compliance_standards", {}, "user-1", supabase, [MCP_SCOPES.READ]);
  assert((result as { isError?: boolean }).isError !== true, "list_compliance_standards must not require brand_kit_id");
});

Deno.test("invariant: tools requiring brand_kit_id ⟺ NOT in TOOLS_WITHOUT_BRAND_KIT_ID_ARG", () => {
  const violations: string[] = [];
  for (const t of tools) {
    const required = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [];
    const requiresBkId = required.includes("brand_kit_id");
    const isInExempt = TOOLS_WITHOUT_BRAND_KIT_ID_ARG.has(t.name);
    if (requiresBkId && isInExempt) violations.push(`${t.name}: required brand_kit_id but listed in TOOLS_WITHOUT_BRAND_KIT_ID_ARG`);
    if (!requiresBkId && !isInExempt) violations.push(`${t.name}: not required brand_kit_id and missing from TOOLS_WITHOUT_BRAND_KIT_ID_ARG`);
  }
  assertEquals(violations, []);
});

Deno.test("registry exposes request_social_profile_scrape (trigger tool, not a direct write)", () => {
  const t = tools.find((tool) => tool.name === "request_social_profile_scrape");
  assert(t, "request_social_profile_scrape must be registered");
  assertEquals(t!.annotations?.readOnlyHint, false);
  const required = (t!.inputSchema?.required ?? []) as string[];
  assertEquals(required.sort(), ["brand_kit_id", "platform", "profile_type", "profile_url"].sort());
  // Only Instagram and Facebook are supported today.
  const platformEnum = (t!.inputSchema?.properties?.platform as { enum?: string[] })?.enum ?? [];
  assertEquals(platformEnum.sort(), ["facebook", "instagram"].sort());
  const sectionMap = buildBrandKitSectionToolMap();
  const socialBucket = sectionMap.social_profiles;
  assert(socialBucket.write?.includes("request_social_profile_scrape"), "request_social_profile_scrape must be in social_profiles write bucket");
  // The direct-write tool must be gone.
  assert(!tools.some((tool) => tool.name === "upsert_social_profile"), "upsert_social_profile direct-write tool must be removed");
});

Deno.test("update_brand_kit catalog exposes long_summary property", () => {
  const t = tools.find((tool) => tool.name === "update_brand_kit");
  assert(t, "update_brand_kit must be registered");
  const props = (t!.inputSchema?.properties ?? {}) as Record<string, unknown>;
  assert("long_summary" in props, "update_brand_kit.inputSchema.properties must include long_summary");
});

