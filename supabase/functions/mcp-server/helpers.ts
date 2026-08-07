export function filterFields(data: unknown, fields?: string[]): unknown {
  if (!fields || !fields.length || !data) return data;
  const out: Record<string, unknown> = {};
  const d = data as Record<string, unknown>;
  for (const f of fields) if (d[f] !== undefined) out[f] = d[f];
  return out;
}

/**
 * Strip the heavyweight `css_tokens` map out of a `raw_scrape_data` blob
 * before returning it over the MCP wire. Keeps a count and the lightweight
 * confidence/status fields so the agent has enough signal. The full token
 * map stays on the DB row — `CompetitorDetailDialog` reads it directly
 * from Supabase, not through MCP.
 */
export function summarizeRawScrape<T extends { raw_scrape_data?: unknown } | null | undefined>(
  payload: T,
): T {
  if (!payload || typeof payload !== "object") return payload;
  const rsd = (payload as { raw_scrape_data?: unknown }).raw_scrape_data;
  if (!rsd || typeof rsd !== "object") return payload;
  const inner = rsd as Record<string, unknown>;
  const cssTokens = inner.css_tokens && typeof inner.css_tokens === "object" ? inner.css_tokens as Record<string, unknown> : null;
  const summary: Record<string, unknown> = {
    extraction_confidence: inner.extraction_confidence ?? null,
    scraped_at: inner.scraped_at ?? null,
    css_token_count: cssTokens ? Object.keys(cssTokens).length : 0,
  };
  if (inner.scrape_status !== undefined) summary.scrape_status = inner.scrape_status;
  return { ...(payload as Record<string, unknown>), raw_scrape_data: summary } as T;
}

export function dryRunPreview(table: string, current: unknown, proposed: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dry_run: true,
            message: "Preview only — no data written. Call again with dry_run: false to commit.",
            table,
            current_values: current ?? null,
            proposed_changes: proposed,
            fields_to_be_updated: Object.keys(proposed),
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function refundTokens(
  supabaseAdmin: any,
  userId: string,
  amount: number,
  reason: string,
  brandKitId?: string,
): Promise<void> {
  try {
    const { data: subscription } = await supabaseAdmin
      .from("user_subscriptions")
      .select("tokens_balance, tokens_used_this_period")
      .eq("user_id", userId)
      .maybeSingle();
    if (!subscription) return;
    const newBalance = (subscription.tokens_balance ?? 0) + amount;
    const newUsed = Math.max(0, (subscription.tokens_used_this_period ?? 0) - amount);
    await supabaseAdmin
      .from("user_subscriptions")
      .update({ tokens_balance: newBalance, tokens_used_this_period: newUsed })
      .eq("user_id", userId);
    await supabaseAdmin.from("token_transactions").insert({
      user_id: userId,
      transaction_type: "refund",
      tokens_amount: amount,
      tokens_balance_after: newBalance,
      description: `Refund: ${reason}`,
      function_name: reason,
      brand_kit_id: brandKitId || null,
      metadata: { refund: true, reason },
    });
  } catch (err) {
    console.error("Failed to refund tokens:", err);
  }
}
