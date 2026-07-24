import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy Supabase client singleton (web build). Construction is deferred to first
// call so that when the app runs WITHOUT Supabase configured (local dev against
// the decoded demo tileset), nothing throws at import — `isSupabaseConfigured()`
// lets the app pick the in-memory dev backend and skip the auth gate instead.
let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
  );
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured: set VITE_SUPABASE_URL and " +
        "VITE_SUPABASE_ANON_KEY (copy .env.example to .env.local).",
    );
  }

  // Session persists in localStorage and auto-refreshes, so a reload keeps the
  // labeler signed in.
  client = createClient(url, anonKey);
  return client;
}
