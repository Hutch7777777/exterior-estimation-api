/**
 * Supabase Database Client
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabaseClient: SupabaseClient | null = null;
let supabaseServiceClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Missing Supabase credentials in environment variables');
    }
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });
  }
  return supabaseClient;
}

/**
 * Get Supabase client with service role key (bypasses RLS)
 * Falls back to anon key client if service role key not configured
 */
export function getSupabaseServiceClient(): SupabaseClient {
  if (!supabaseServiceClient) {
    if (!SUPABASE_URL) {
      throw new Error('Missing SUPABASE_URL in environment variables');
    }
    // Use service role key if available, otherwise fall back to anon key
    const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    if (!key) {
      throw new Error('Missing Supabase key in environment variables');
    }
    supabaseServiceClient = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false }
    });
    if (SUPABASE_SERVICE_ROLE_KEY) {
      console.log('✅ Supabase service role client initialized (bypasses RLS)');
    } else {
      console.log('⚠️ Supabase service role key not configured, using anon key');
    }
  }
  return supabaseServiceClient;
}

export function isDatabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY &&
            SUPABASE_URL !== 'your_supabase_url_here' &&
            SUPABASE_ANON_KEY !== 'your_supabase_anon_key_here');
}

export async function testConnection(): Promise<boolean> {
  try {
    if (!isDatabaseConfigured()) return false;
    const client = getSupabaseClient();
    const { error } = await client.from('pricing_items').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
