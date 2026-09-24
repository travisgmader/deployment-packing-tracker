# Deployment Packing Tracker

A shared packing board for a deployment: five lists (Before You Leave, Carry-On,
72-Hr Bag, A-Bag, Long Term) that several people track together in real time.

Static HTML + [Supabase](https://supabase.com) — no build step, no framework.

## How it works

- **A board per person.** Each account gets its own board, seeded from the
  starter list with nothing checked. Two people can be put on the same board by
  pointing their `profiles.board_id` at it — then marking something *Packed*
  marks it packed for both of them.
- **Open sign-in, email and password.** Anyone can create an account from the
  gate; it and its board exist on the spot, with no message sent. A magic link
  is still offered as the way back in for a forgotten password, and the header's
  *Password* button sets one on an account that predates passwords.
- **Why password first.** The project sends through Supabase's built-in mailer,
  which allows only a couple of messages an hour *across the whole project*.
  Anything on the everyday path that needs email breaks as soon as two people
  sign up in the same hour. `scripts/signin-link.sh <email>` mints a link
  without sending mail, so it is unaffected by that limit.
  This depends on **Confirm email** being off (Authentication -> Sign In /
  Providers); with it on, sign-up goes back to waiting on a message.
- **Live.** Changes arrive over Supabase Realtime, so an open tab updates itself.
- **Auditable.** A database trigger records who moved what, shown on the Activity tab.

## Layout

    index.html                 markup + styles
    app.js                     all client logic
    config.js                  Supabase URL + anon key
    supabase/migrations/       schema and row-level security

`config.js` holds the project's **anon** key. That key is publishable by design —
every table is behind row-level security that requires an authenticated session,
and every policy scopes rows to the signer's own board, so the key alone grants
nothing. Signing up gets you a board of your own and no view of anyone else's.

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
