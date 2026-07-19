// supabase-client.js — one shared client for the whole app.
//
// The URL + publishable key below are meant to be public (that's the point
// of a "publishable" key) — the real security boundary is the Row Level
// Security policy in supabase/schema.sql, which only lets these two emails
// touch any data at all.

const SUPABASE_URL = 'https://lksbplpsyyjjzjbkcvbn.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4huM-f3Y9IB5NcpGg8EByA_GNFdoEO9';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
window.sb = sb;
