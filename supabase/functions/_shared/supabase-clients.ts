/**
 * Shared Supabase client factories for edge functions.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.87.1";

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error("Missing required Supabase environment variables");
  }

  return { url, anonKey, serviceRoleKey };
}

export function createServiceRoleClient(): SupabaseClient {
  const { url, serviceRoleKey } = getSupabaseEnv();
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export function createUserClient(authHeader: string | null): SupabaseClient {
  if (!authHeader) {
    throw new Error("Authorization header is required");
  }

  const { url, anonKey } = getSupabaseEnv();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
