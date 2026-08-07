import { createServiceRoleClient } from "../_shared/supabase-clients.ts";
import {
  corsHeaders,
  PROTOCOL_VERSION,
  RATE_LIMIT_MAX_REQUESTS,
  SERVER_VERSION,
  TOOL_CALL_TIMEOUT_MS,
} from "./constants.ts";
import { toolError } from "./tool-errors.ts";
import { toolErrorToRpc } from "./tool-rpc.ts";
import { executeTool } from "./execute-tool.ts";
import { executePrompt } from "./execute-prompt.ts";
import { readResource } from "./read-resource.ts";
import { tools, resourceTemplates, prompts } from "./tools-catalog.ts";
import {
  sessions,
  generateSessionId,
  cleanExpiredSessions,
  getSessionLogLevel,
} from "./session.ts";
import { authorizeMcpRequest } from "./authorize.ts";
import { withTimeout } from "./helpers.ts";
import { SseWriter } from "./sse-writer.ts";
import {
  buildNotifyContext,
  DEFAULT_LOG_LEVEL,
  isLogLevel,
  NOOP_NOTIFY,
  type LogLevel,
  type NotifyContext,
} from "./notify.ts";

export { tools } from "./tools-catalog.ts";
export {
  hasMeaningfulScrapedValue,
  requireCompetitorConfirmation,
  validateCompetitorOptionalShapes,
  validateCompetitorVisualIdentity,
} from "./competitor-validation.ts";

/**
 * Service-role client, constructed once per isolate (module scope) instead of
 * once per request. supabase-js clients are stateless across requests — they
 * hold only config + a fetch wrapper, no per-user/session state — so a single
 * shared instance is safe and removes per-request construction overhead.
 * Memoized lazily so a missing-env boot doesn't crash module load.
 */
let cachedServiceRoleClient: ReturnType<typeof createServiceRoleClient> | null = null;
function getServiceRoleClient() {
  if (!cachedServiceRoleClient) {
    cachedServiceRoleClient = createServiceRoleClient();
  }
  return cachedServiceRoleClient;
}

/** Public site — icon URLs must not point at the authenticated MCP endpoint. */
const BRANDKITOS_PUBLIC_ORIGIN = "https://www.brandkitos.com";

/** Keep in sync with HOMEPAGE_DESCRIPTION in src/lib/seo/routes.ts */
const MCP_SERVER_DESCRIPTION =
  "AI-native brand operations for agencies and consultants. Centralize brand kits, govern AI-generated content, and ship to ChatGPT, Claude, and 50+ tools. Free plan available.";

/** MCP Implementation metadata (title, description, icons) for connector UIs. Icons use `sizes` as string[] per MCP spec. */
const MCP_SERVER_IMPLEMENTATION = {
  name: "brand-kit-os",
  title: "Brand Kit OS",
  version: SERVER_VERSION,
  description: MCP_SERVER_DESCRIPTION,
  icons: [
    {
      src: `${BRANDKITOS_PUBLIC_ORIGIN}/favicon.png`,
      mimeType: "image/png",
      sizes: ["32x32", "192x192"],
    },
    {
      src: `${BRANDKITOS_PUBLIC_ORIGIN}/og-default.png`,
      mimeType: "image/png",
      sizes: ["512x512"],
    },
  ],
};

interface DispatchInput {
  method: string;
  params: any;
  id: unknown;
  userId: string;
  supabaseAdmin: any;
  scopes: string[];
  requestId: string;
  notify: NotifyContext;
}

interface DispatchOutput {
  result: any;
  addCacheHeaders: boolean;
  toolName: string | null;
  brandKitIdForLog: string | null;
}

async function dispatchMcpMethod(input: DispatchInput): Promise<DispatchOutput> {
  const { method, params, userId, supabaseAdmin, scopes, requestId, notify } = input;
  let result: any;
  let addCacheHeaders = false;
  let toolName: string | null = null;
  let brandKitIdForLog: string | null = null;

  switch (method) {
    case "initialize":
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: { subscribe: false, listChanged: false },
          prompts: {},
          logging: {},
        },
        serverInfo: MCP_SERVER_IMPLEMENTATION,
      };
      break;

    case "tools/list":
      result = { tools };
      break;

    case "tools/call": {
      const { name, arguments: toolArgs } = params;
      toolName = name;
      if (toolArgs && typeof toolArgs.brand_kit_id === 'string') {
        brandKitIdForLog = toolArgs.brand_kit_id;
      }
      try {
        result = await withTimeout(
          executeTool(name, toolArgs || {}, userId, supabaseAdmin, scopes, requestId, notify),
          TOOL_CALL_TIMEOUT_MS,
          `Tool call (${name})`,
        );
      } catch (err: any) {
        const errMsg = err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : (() => { try { return JSON.stringify(err); } catch { return 'unknown error'; } })();
        const isTimeout = errMsg.includes('timed out');
        result = toolError(
          isTimeout
            ? `Tool '${name}' did not complete within ${Math.round(TOOL_CALL_TIMEOUT_MS / 1000)}s. The agent should retry once after a short delay; if it times out again, the underlying service may be degraded.`
            : `Tool '${name}' failed unexpectedly: ${errMsg || 'unknown error'}`,
          {
            code: isTimeout ? 'timeout' : 'internal_error',
            retryable: true,
            recovery: isTimeout
              ? 'Retry the same call once; if it still times out, fall back to a smaller scope (e.g. get_brand_kit_summary instead of get_brand_kit) and notify the user.'
              : 'Retry once; if the failure persists, surface this message to the user along with the request_id for support.',
            data: { request_id: requestId },
          }
        );
      }
      // Lift tool errors into a protocol-level JSON-RPC error so MCP clients
      // don't have to parse success payloads to detect failures.
      if ((result as { isError?: boolean })?.isError === true) {
        const rpc = toolErrorToRpc(result, {
          request_id: requestId,
          tool_name: name,
          scopes_used: scopes,
          brand_kit_id: brandKitIdForLog,
        });
        if (rpc?.error) {
          console.error(
            "[mcp-server] Tool error",
            JSON.stringify({
              request_id: requestId,
              tool_name: name,
              user_id: userId,
              scopes_used: scopes,
              brand_kit_id: brandKitIdForLog,
              error_code: (rpc.error.data as any)?.error_code,
            }),
          );
          result = rpc;
        }
      }
      addCacheHeaders = true;
      break;
    }

    case "resources/list": {
      const [{ data: ownedKits }, { data: sharedMemberships }] = await Promise.all([
        supabaseAdmin.from('brand_kits').select('id, name, tagline').eq('user_id', userId),
        supabaseAdmin.from('brand_kit_members').select('brand_kit_id, brand_kits:brand_kit_id(id, name, tagline)').eq('user_id', userId),
      ]);

      const allKits = [
        ...(ownedKits || []),
        ...((sharedMemberships || []).map((m: any) => m.brand_kits).filter(Boolean)),
      ];

      const seenIds = new Set<string>();
      const uniqueKits = allKits.filter((bk: any) => {
        if (!bk || seenIds.has(bk.id)) return false;
        seenIds.add(bk.id);
        return true;
      });

      const resources = uniqueKits.map((bk: { id: string; name: string; tagline?: string | null }) => ({
        uri: `brandkit://${bk.id}`,
        name: bk.name,
        description: `Brand kit for ${bk.name}${bk.tagline ? ` — ${bk.tagline}` : ''}. Use tools to access sections: get_brand_kit_summary (start here), get_brand_kit_core, get_brand_kit_expression, get_brand_kit_personality, get_brand_kit_governance, get_brand_kit_products, get_brand_kit_audience, get_brand_kit_personas, get_brand_kit_competitors, get_brand_kit_social_profiles, list_logo_assets, list_knowledge_files.`,
        mimeType: "application/json"
      }));

      result = { resources };
      break;
    }

    case "resources/templates/list":
      result = { resourceTemplates };
      break;

    case "resources/read": {
      const uriMatch = String(params.uri || '').match(/^brandkit:\/\/([^/]+)/);
      if (uriMatch) brandKitIdForLog = uriMatch[1];
      const resourceResult = await readResource(params.uri, userId, supabaseAdmin);
      // readResource has a wide union return type; narrow via in-operator and
      // a single permissive shape for the success branch's property access.
      const rr = resourceResult as {
        error?: unknown;
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      if (rr.error) {
        result = resourceResult;
      } else if (rr.isError === true) {
        result = toolErrorToRpc(resourceResult, { request_id: requestId }) ?? resourceResult;
      } else {
        const text = rr.content?.[0]?.text || "{}";
        result = {
          contents: [{
            uri: params.uri,
            mimeType: "application/json",
            text
          }]
        };
      }
      addCacheHeaders = true;
      break;
    }

    case "prompts/list":
      result = { prompts };
      break;

    case "prompts/get": {
      const promptName = params.name;
      const promptArgs = params.arguments || {};
      toolName = promptName;
      if (promptArgs && typeof promptArgs.brand_kit_id === 'string') {
        brandKitIdForLog = promptArgs.brand_kit_id;
      }
      const promptDef = prompts.find((p: any) => p.name === promptName);
      if (!promptDef) {
        result = { error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
      } else {
        result = await executePrompt(promptName, promptArgs, userId, supabaseAdmin);
      }
      break;
    }

    default:
      result = { error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return { result, addCacheHeaders, toolName, brandKitIdForLog };
}

function getProgressToken(params: any): string | number | undefined {
  const token = params?._meta?.progressToken;
  if (typeof token === "string" || typeof token === "number") return token;
  return undefined;
}

function classifyResult(result: any): {
  hasProtocolError: boolean;
  hasToolError: boolean;
  hasAnyError: boolean;
  errorMessage: string | undefined;
  errorCode: string | undefined;
} {
  // `result` is a wide JSON-RPC union (protocol errors, tool results, resource
  // reads, prompt envelopes). TS can't narrow across all branches reliably, so
  // we treat it permissively for the discriminator below — the runtime checks
  // are exhaustive.
  const r = result as {
    error?: { code?: number; message?: string };
    isError?: boolean;
    content?: Array<{ text?: string }>;
    _meta?: { error_code?: string };
  };
  const hasProtocolError = r?.error !== undefined;
  const hasToolError = r?.isError === true;
  const hasAnyError = hasProtocolError || hasToolError;
  const errorMessage = hasProtocolError
    ? r.error?.message
    : (hasToolError ? (r.content?.[0]?.text || 'Tool error') : undefined);
  const errorCode = hasProtocolError
    ? `protocol_${r.error?.code ?? -32603}`
    : (hasToolError ? (r?._meta?.error_code || 'internal_error') : undefined);
  return { hasProtocolError, hasToolError, hasAnyError, errorMessage, errorCode };
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // DELETE: Session termination (Streamable HTTP spec)
  if (req.method === 'DELETE') {
    const sessionId = req.headers.get('Mcp-Session-Id');
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    return new Response(
      JSON.stringify({ error: "Unknown session" }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // GET: OAuth discovery + health check (all unauthenticated)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(functions\/v1\/)?mcp-server\/?|^\/mcp\/?/, '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const PUBLIC_MCP_RESOURCE = 'https://www.brandkitos.com/mcp';

    // OAuth Protected Resource Metadata (RFC 9728)
    if (path === '.well-known/oauth-protected-resource') {
      return new Response(JSON.stringify({
        resource: PUBLIC_MCP_RESOURCE,
        authorization_servers: ["https://www.brandkitos.com"],
        bearer_methods_supported: ["header"],
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // OAuth Authorization Server Metadata (RFC 8414)
    if (path === '.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify({
        issuer: "https://www.brandkitos.com",
        authorization_endpoint: "https://www.brandkitos.com/oauth/authorize",
        token_endpoint: "https://www.brandkitos.com/oauth/token",
        registration_endpoint: "https://www.brandkitos.com/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Health check (default GET)
    return new Response(
      JSON.stringify({ status: "ok", version: SERVER_VERSION }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let supabaseAdmin: any = null;
  let userId: string = '';
  let apiKeyId: string | null = null;
  let method: string = 'unknown';
  let toolName: string | null = null;
  let scopesUsed: string[] = [];
  let brandKitIdForLog: string | null = null;

  // Fire-and-forget terminal logging. We previously did a two-phase insert
  // (`in_flight` row + terminal update) to spot edge-runtime kills, but no
  // dashboard ever consumed those rows and they doubled DB writes per request.
  // Now we write a single terminal row and don't block the HTTP response on it.
  function logRequest(status: string, errorMessage?: string, errorCode?: string) {
    if (!supabaseAdmin || !userId) return;
    const payload: Record<string, any> = {
      user_id: userId,
      api_key_id: apiKeyId,
      method: method,
      tool_name: toolName,
      request_status: status,
      error_message: errorMessage || null,
      error_code: errorCode || null,
      response_time_ms: Date.now() - startTime,
      request_id: requestId,
      scopes_used: scopesUsed.length > 0 ? scopesUsed : null,
      brand_kit_id: brandKitIdForLog,
    };
    supabaseAdmin
      .from('mcp_request_logs')
      .insert(payload)
      .then(({ error }: { error: unknown }) => {
        if (error) console.error('Failed to log MCP request:', error);
      });
  }

  try {
    supabaseAdmin = getServiceRoleClient();

    // Authorize (credential + subscription + rate limit) in ONE DB round-trip.
    // Replaces the prior three sequential PostgREST/RPC calls; see authorize.ts
    // and the authorize_mcp_request migration. Verdict mapping below preserves
    // the exact status codes, messages, logging, and rate-limit increment
    // ordering of the original path.
    const authHeader = req.headers.get('Authorization');
    const auth = await authorizeMcpRequest(authHeader, supabaseAdmin);

    if (auth.kind === 'unauthorized') {
      console.error('Auth validation failed:', auth.error);
      const mcpServerUrl = 'https://www.brandkitos.com/mcp';
      const wwwAuth = `Bearer error="unauthorized", error_description="Authorization needed", resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: auth.error }, id: null }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuth } }
      );
    }

    userId = auth.userId;
    apiKeyId = auth.apiKeyId;
    scopesUsed = auth.scopes;

    if (auth.kind === 'subscription_required') {
      console.error('User does not have MCP access. Tier:', auth.tier);
      logRequest('error', 'Subscription required', 'quota_exceeded');
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "MCP access requires a paid subscription (Base, Premium, or Max plan)" }, id: null }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (auth.kind === 'rate_limited') {
      console.log(`Rate limit exceeded for user ${userId}. Reset at: ${auth.resetAt.toISOString()}`);
      logRequest('rate_limited', 'Rate limit exceeded', 'quota_exceeded');
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32003, message: "Rate limit exceeded. Maximum 100 requests per minute. Please try again later." }, id: null }),
        {
          status: 429,
          headers: {
            ...corsHeaders, 'Content-Type': 'application/json',
            'X-RateLimit-Limit': String(RATE_LIMIT_MAX_REQUESTS),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': auth.resetAt.toISOString()
          }
        }
      );
    }

    // auth.kind === 'authorized' from here on.
    const rateLimit = { remaining: auth.remaining, resetAt: auth.resetAt };

    // Parse MCP request
    const body = await req.json();
    console.log('MCP Request:', JSON.stringify(body));

    const { jsonrpc, method: reqMethod, params, id } = body;
    method = reqMethod || 'unknown';

    if (jsonrpc !== "2.0") {
      logRequest('error', 'Invalid JSON-RPC version', 'validation_error');
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid JSON-RPC version" }, id }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Methods handled inline before the streaming dispatch path. These
    // either don't carry an `id` (notifications) or mutate session state
    // without producing a result envelope.
    if (method === "notifications/initialized") {
      logRequest('success');
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", result: null, id: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    cleanExpiredSessions();
    let sessionId = req.headers.get('Mcp-Session-Id') || '';

    if (method === "logging/setLevel") {
      const requestedLevel = params?.level;
      if (!isLogLevel(requestedLevel)) {
        logRequest('error', 'Invalid log level', 'validation_error');
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: `Invalid log level: ${String(requestedLevel)}. Expected one of debug/info/notice/warning/error/critical/alert/emergency.` }, id }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.logLevel = requestedLevel;
        session.createdAt = Date.now();
      }
      logRequest('success');
      const baseHeaders: Record<string, string> = {
        ...corsHeaders,
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX_REQUESTS),
        'X-RateLimit-Remaining': String(rateLimit.remaining),
        'X-RateLimit-Reset': rateLimit.resetAt.toISOString(),
        'Mcp-Request-Id': requestId,
      };
      if (sessionId) baseHeaders['Mcp-Session-Id'] = sessionId;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", result: {}, id }),
        { headers: { ...baseHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (method === 'initialize') {
      sessionId = generateSessionId();
      sessions.set(sessionId, { userId, createdAt: Date.now(), logLevel: DEFAULT_LOG_LEVEL });
    } else if (sessionId && sessions.has(sessionId)) {
      sessions.get(sessionId)!.createdAt = Date.now();
    }

    const sessionLogLevel: LogLevel = getSessionLogLevel(sessionId || null);
    const progressToken = getProgressToken(params);

    const acceptHeader = req.headers.get('Accept') || '';
    const wantsSse = acceptHeader.includes('text/event-stream');

    const baseHeaders: Record<string, string> = {
      ...corsHeaders,
      'X-RateLimit-Limit': String(RATE_LIMIT_MAX_REQUESTS),
      'X-RateLimit-Remaining': String(rateLimit.remaining),
      'X-RateLimit-Reset': rateLimit.resetAt.toISOString(),
      'Mcp-Request-Id': requestId,
    };
    if (sessionId) baseHeaders['Mcp-Session-Id'] = sessionId;

    const dispatchInput = (notify: NotifyContext): DispatchInput => ({
      method,
      params,
      id,
      userId,
      supabaseAdmin,
      scopes: scopesUsed,
      requestId,
      notify,
    });

    const finalizeAndLog = (result: any) => {
      const { hasProtocolError, hasAnyError, errorMessage, errorCode } = classifyResult(result);
      logRequest(hasAnyError ? 'error' : 'success', errorMessage, errorCode);
      console.log('MCP Response:', JSON.stringify({ jsonrpc: "2.0", result, id }));
      const rpcResponse = hasProtocolError
        ? { jsonrpc: "2.0", error: (result as { error: unknown }).error, id }
        : { jsonrpc: "2.0", result, id };
      return { rpcResponse, hasAnyError };
    };

    if (wantsSse) {
      // Streaming SSE path: open the stream, run dispatch with a live notify
      // context so handlers can emit notifications/message and notifications/progress
      // events mid-call, then write the final envelope and close.
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const writer = new SseWriter(controller);
          const notify = buildNotifyContext({
            writer,
            requestId,
            progressToken,
            sessionLogLevel,
          });
          let dispatchResult: any;
          try {
            const out = await dispatchMcpMethod(dispatchInput(notify));
            dispatchResult = out.result;
            toolName = out.toolName;
            brandKitIdForLog = out.brandKitIdForLog;
          } catch (err: any) {
            console.error('MCP dispatch error (SSE):', err);
            dispatchResult = {
              error: {
                code: -32603,
                message: err?.message || 'Internal error',
                data: { request_id: requestId },
              },
            };
          }
          const { rpcResponse } = finalizeAndLog(dispatchResult);
          writer.write(rpcResponse, id as string | number | undefined);
          writer.close();
        },
      });
      const sseHeaders = {
        ...baseHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      };
      return new Response(stream, { headers: sseHeaders });
    }

    // JSON path — notifications are silently dropped via NOOP_NOTIFY.
    const out = await dispatchMcpMethod(dispatchInput(NOOP_NOTIFY));
    toolName = out.toolName;
    brandKitIdForLog = out.brandKitIdForLog;
    const { rpcResponse, hasAnyError } = finalizeAndLog(out.result);
    if (out.addCacheHeaders && !hasAnyError) baseHeaders['Cache-Control'] = 'max-age=300';

    return new Response(
      JSON.stringify(rpcResponse),
      { headers: { ...baseHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('MCP Server Error:', error);
    logRequest('error', error?.message || 'Internal error', 'internal_error');
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: error?.message || 'Internal error', data: { request_id: requestId } }, id: null }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Mcp-Request-Id': requestId } }
    );
  }
});
