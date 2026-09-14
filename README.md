# Deployment Packing Tracker

A shared packing board for a deployment: five lists (Before You Leave, Carry-On,
72-Hr Bag, A-Bag, Long Term) that several people track together in real time.

Static HTML + [Supabase](https://supabase.com) — no build step, no framework.

## How it works

- **One shared board.** Everyone signed in sees and edits the same rows. Marking
  something *Packed* marks it packed for the whole group.
- **Live.** Changes arrive over Supabase Realtime, so an open tab updates itself.
- **Invite only.** Public signup is disabled on the project; only accounts an
  admin creates can request a magic link.
- **Auditable.** A database trigger records who moved what, shown on the Activity tab.

## Layout

    index.html                 markup + styles
    app.js                     all client logic
    config.js                  Supabase URL + anon key
    supabase/migrations/       schema and row-level security

`config.js` holds the project's **anon** key. That key is publishable by design —
every table is behind row-level security that requires an authenticated session,
and signup is disabled, so the key alone grants nothing.

The item catalog itself is *not* in this repo. It lives in the database, reachable
only after signing in.

## Deploying

The page is static. Any host works; this copy is served by GitHub Pages from
the default branch.

After changing the host, add the new URL to the project's auth redirect allow-list
(Authentication → URL Configuration) or magic links will bounce.

## Schema

| table      | purpose                                              |
|------------|------------------------------------------------------|
| `lists`    | the five bags/checklists                             |
| `items`    | every tracked line, with status, qty, unit, notes     |
| `profiles` | display name per signed-in member                     |
| `activity` | append-only change log, written by trigger            |

Statuses run `Need → Ordered → Prepped → Packed` for bags and
`To Do → In Progress → Done` for the admin checklist.
