/**
 * Public settings for the website.
 *
 * The Supabase "publishable" key is DESIGNED to be public: it only lets the
 * browser talk to the database, and the Row Level Security rules in
 * supabase/schema.sql decide what each signed-in user can see or change.
 * (The secret / service_role key must NEVER be put here.)
 */
export const SUPABASE_URL = 'https://dentshemqqgrezhiywic.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_YyWVYgaAcLXiN4Z0xVcnAg_jln7p31m';

/** Sign out automatically after this many minutes without activity (FR-002). */
export const IDLE_MINUTES = 30;
