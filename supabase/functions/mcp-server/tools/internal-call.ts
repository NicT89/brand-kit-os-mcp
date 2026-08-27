/**
 * Call one of the app's own edge functions as a trusted internal caller: the
 * service-role key as bearer plus `internal_user_id`. The MCP server has
 * already authenticated the API key and verified brand-kit access; the target
 * function re-checks access for the resolved user id.
 *
 * Single source of truth for every MCP handler that delegates to an edge
 * function, so auth headers and error shaping cannot drift per handler.
 */
export async function callInternalFunction(
  name: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: "Service is not configured (missing SUPABASE_URL / service key).", status: 500 };
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ ...body, internal_user_id: userId }),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.slice(0, 400) };
  }

  if (!response.ok || parsed.success !== true) {
    const message = typeof parsed.error === "string" ? parsed.error : `Request failed with status ${response.status}`;
    return { ok: false, error: message, status: response.status };
  }
  return { ok: true, data: parsed };
}
