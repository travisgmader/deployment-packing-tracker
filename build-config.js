// Generates config.js at deploy time from the Supabase environment variables
// Vercel provides (set by hand, or synced by the Supabase integration).
// If they aren't present — a local checkout, or GitHub Pages — the committed
// config.js is left exactly as it is, so the page still works.
const fs = require('fs');

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log('No Supabase env vars set — keeping the committed config.js.');
  process.exit(0);
}

fs.writeFileSync('config.js',
`// Generated at build time from Vercel environment variables. Do not edit.
// The anon key is publishable by design: every table sits behind row-level
// security that requires a signed-in session, and signup is disabled.
window.SUPABASE_URL = ${JSON.stringify(url)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(key)};
`);
console.log(`config.js written for ${url}`);
