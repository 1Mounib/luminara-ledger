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

/**
 * Google OAuth Client ID for "Import from Gmail" (public by design - it only
 * identifies the website to Google; it is not a secret). Leave empty to hide
 * the feature. Created in Google Cloud -> Google Auth Platform -> Clients.
 */
export const GOOGLE_CLIENT_ID = '1016441196363-j3et42so1jgbaasfacuktrjib4f5bdcp.apps.googleusercontent.com';
