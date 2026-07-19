/**
 * Shared Rate Limiting Utilities for Edge Functions
 * 
 * Provides rate limiting and token management functions.
 */

import { SupabaseClient } from "npm:@supabase/supabase-js@2.87.1";

// ========== TYPES ==========

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: Date;
}

export interface TokenResult {
    allowed: boolean;
    tokensRemaining: number;
    message?: string;
}

// ========== RATE LIMITING ==========

/**
 * Check and update rate limit for a user/function combination.
 *
 * Uses an atomic Postgres RPC (check_and_increment_rate_limit) to prevent
 * TOCTOU race conditions where concurrent requests could bypass the limit.
 * Falls back to non-atomic implementation if the RPC is not yet deployed.
 */
export async function checkRateLimit(
    supabase: SupabaseClient,
    userId: string,
    functionName: string,
    maxRequests: number,
    windowMs: number
): Promise<RateLimitResult> {
    // Try atomic RPC first
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
        'check_and_increment_rate_limit',
        {
            p_user_id: userId,
            p_function_name: functionName,
            p_max_requests: maxRequests,
            p_window_ms: windowMs,
        }
    );

    if (!rpcError && rpcResult && rpcResult.length > 0) {
        const row = rpcResult[0];
        return {
            allowed: row.allowed,
            remaining: row.remaining,
            resetAt: new Date(row.reset_at),
        };
    }

    // Fallback: non-atomic implementation (for backwards compatibility during migration)
    if (rpcError) {
        console.warn('Atomic rate limit RPC not available, using fallback:', rpcError.message);
    }

    return checkRateLimitFallback(supabase, userId, functionName, maxRequests, windowMs);
}

/**
 * Non-atomic fallback rate limiter.
 * @deprecated Use the RPC version via checkRateLimit() once migration is applied.
 */
async function checkRateLimitFallback(
    supabase: SupabaseClient,
    userId: string,
    functionName: string,
    maxRequests: number,
    windowMs: number
): Promise<RateLimitResult> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    const { data: existing } = await supabase
        .from("rate_limits")
        .select("*")
        .eq("user_id", userId)
        .eq("function_name", functionName)
        .single();

    if (!existing) {
        await supabase.from("rate_limits").insert({
            user_id: userId,
            function_name: functionName,
            request_count: 1,
            window_start: now.toISOString(),
        });
        return {
            allowed: true,
            remaining: maxRequests - 1,
            resetAt: new Date(now.getTime() + windowMs)
        };
    }

    const recordWindowStart = new Date(existing.window_start);

    // Window has expired, reset
    if (recordWindowStart < windowStart) {
        await supabase
            .from("rate_limits")
            .update({ request_count: 1, window_start: now.toISOString() })
            .eq("id", existing.id);
        return {
            allowed: true,
            remaining: maxRequests - 1,
            resetAt: new Date(now.getTime() + windowMs)
        };
    }

    // Check if limit exceeded
    if (existing.request_count >= maxRequests) {
        const resetAt = new Date(recordWindowStart.getTime() + windowMs);
        return { allowed: false, remaining: 0, resetAt };
    }

    // Increment counter
    await supabase
        .from("rate_limits")
        .update({ request_count: existing.request_count + 1 })
        .eq("id", existing.id);

    const resetAt = new Date(recordWindowStart.getTime() + windowMs);
    return {
        allowed: true,
        remaining: maxRequests - existing.request_count - 1,
        resetAt
    };
}

// ========== TOKEN MANAGEMENT ==========

/**
 * Check if user has enough tokens and deduct if so
 */
export async function checkAndDeductTokens(
    supabase: SupabaseClient,
    userId: string,
    tokenCost: number,
    functionName: string,
    brandKitId?: string
): Promise<TokenResult> {
    const { data: subscription, error } = await supabase
        .from("user_subscriptions")
        .select("*")
        .eq("user_id", userId)
        .single();

    if (error || !subscription) {
        // Create default subscription for user if none exists
        const { error: createError } = await supabase
            .from("user_subscriptions")
            .insert({
                user_id: userId,
                subscription_tier: "free",
                tokens_balance: 10,
                monthly_token_allowance: 10,
            })
            .select()
            .single();

        if (createError) {
            return { allowed: false, tokensRemaining: 0, message: "Failed to create subscription" };
        }

        // Retry with new subscription
        return checkAndDeductTokens(supabase, userId, tokenCost, functionName, brandKitId);
    }

    // Calculate max allowed with overage
    const overagePercent = subscription.overage_limit_percent || 0;
    const maxOverage = Math.floor(subscription.monthly_token_allowance * (overagePercent / 100));
    const minBalance = -maxOverage;

    // Check if user has enough tokens (including overage)
    if (subscription.tokens_balance - tokenCost < minBalance) {
        return {
            allowed: false,
            tokensRemaining: subscription.tokens_balance,
            message: `Insufficient tokens. Balance: ${subscription.tokens_balance}, Required: ${tokenCost}. Upgrade your plan for more tokens.`,
        };
    }

    // Deduct tokens
    const newBalance = subscription.tokens_balance - tokenCost;
    const newUsed = (subscription.tokens_used_this_period || 0) + tokenCost;

    await supabase
        .from("user_subscriptions")
        .update({
            tokens_balance: newBalance,
            tokens_used_this_period: newUsed,
        })
        .eq("user_id", userId);

    // Log the transaction
    await supabase.from("token_transactions").insert({
        user_id: userId,
        transaction_type: "api_usage",
        tokens_amount: -tokenCost,
        tokens_balance_after: newBalance,
        description: `API call: ${functionName}`,
        function_name: functionName,
        brand_kit_id: brandKitId || null,
        metadata: { function: functionName, cost: tokenCost },
    });

    return { allowed: true, tokensRemaining: newBalance };
}
