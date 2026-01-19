/**
 * Supabase Database Client
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabaseClient: SupabaseClient | null = null;

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
