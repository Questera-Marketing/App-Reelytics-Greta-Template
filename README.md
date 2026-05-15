# Reelytics

Instagram Reels analytics — connect Instagram Business / Creator accounts via Composio, then generate a graded report on your reels powered by Composio MCP + Claude Agent SDK.

## What you get

- Landing page that explains the tool.
- **Email-based login with 2FA** — first-time users get a 6-digit OTP via email. No passwords. Returning verified users skip the OTP.
- Multiple Instagram accounts per user, with a toggle to switch between them.
- **Team access per Instagram account** — invite teammates by email as `admin` (can generate reports) or `viewer` (read-only). Invites auto-accept the next time the invitee signs in.
- "Add Instagram account" flow via Composio OAuth.
- Per-user **Settings**: bring-your-own Composio key + LLM provider/model/key.
- One-click report generation that:
  - Fetches the last **15 days** of reels via `INSTAGRAM_GET_IG_USER_MEDIA`.
  - Pulls private insights via `INSTAGRAM_GET_IG_MEDIA_INSIGHTS`.
  - Computes `watch_s`, `share_pct`, `save_pct`, `replay_rate`, `hook_rate`, `engagement_rate`, and a composite `hook_score`.
  - Extrapolates 30-day **projections** for views, reach, and reels.
  - Downloads each thumbnail via `curl` into `./thumbs/<post_id>.jpg`.
  - Runs a second Claude pass for a team **action headline** + "Do more / Do less of" advice.
  - Saves the full report to Supabase so it survives reloads.
- **Tabbed Trends** chart: Hook /100, Views, Reach, Watch s, Day of week, Caption patterns.

## Setup (local)

1. **Supabase**: run [`supabase-schema.sql`](supabase-schema.sql) in your project's SQL editor.
2. **`.env`** — only Supabase is needed at boot:
   ```env
   PORT=3000
   SUPABASE_URL=https://...supabase.co
   SUPABASE_KEY=eyJhbGciOi...   # service-role key
   ```
   Composio + LLM keys are entered per-user in the Settings UI; no server-wide default is required.

   Optional fallbacks for local dev:
   - `COMPOSIO_API_KEY` — used when a user hasn't set their own.
   - `ANTHROPIC_API_KEY` — read by the Claude Agent SDK at runtime.
   - `PUBLIC_URL` — defaults to `http://localhost:$PORT` (set this to your deployed URL in prod).
   - `COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID` — skip auto-discovery of the IG auth config.
   - `RESEND_API_KEY` + `EMAIL_FROM` — required in production for OTP + team-invite emails. Without it the server runs in **dev mode**: codes are printed to the server console AND surfaced in the API response as `devCode` so you can test locally without setting up email. Get a free Resend key (3000 emails/mo) at https://resend.com.

3. `npm install && npm run dev`. Visit `http://localhost:3000`, sign in, open the **⚙ Settings** modal, and paste your Composio key + Anthropic key.

## Hook score formulas

```
watch_s     = ig_reels_avg_watch_time ÷ 1000
hook_rate   = watch_s ÷ duration_s × 100         (uses a 30s estimate if Instagram doesn't return duration)
replay_rate = views ÷ reach
share_pct   = shares ÷ reach × 100
save_pct    = saved  ÷ reach × 100
hook_score  = watch_s × √reach × (1 + share_pct/100 + save_pct/200)
hook /100   = min-max normalized within the report (top reel = 100, weakest = 0)
```

## Project layout

- `server.ts` — Express server, all API routes, Composio + Claude integration, report enrichment, thumbnail download, suggestions pass.
- `public/index.html` — Single-page front-end: landing, auth modal, dashboard, report viewer, tabbed trends, settings modal.
- `public/generate.html` — Live progress page during a report run (SSE).
- `supabase-schema.sql` — Tables: `users` (with `settings` jsonb), `connected_accounts`, `reports`.
- `thumbs/` — Per-post thumbnails downloaded via curl; served at `/thumbs/<id>.jpg`.

## Deployment

**Important: Reelytics is not a good fit for Netlify or Vercel free tiers.** The app relies on:
- A **persistent Express server** (SSE for live progress streaming).
- A **writable filesystem** (`./thumbs/` for downloaded reel images served at `/thumbs/*`).
- **Long-running requests** (the Claude Agent SDK fetch can take 60–120s — past Vercel's 10s and Netlify's 26s free-tier function timeouts).

Netlify/Vercel run code as serverless functions: ephemeral, read-only filesystem, short timeouts, no native SSE. You'd need a major rewrite (queue-based job runner + object storage for thumbs + polling instead of SSE) before they'd work.

The path of least resistance is a **container/Node hosting** free tier. **Railway** is the cleanest fit — see steps below. Render, Fly.io, and Koyeb all work similarly.

### Deploy to Railway (recommended)

1. **Push to GitHub.** Make sure `.env` is in `.gitignore` so secrets don't ship. (If you haven't already: `echo .env >> .gitignore`.)

2. Create a Railway account at https://railway.app (GitHub auth, no credit card required for the free $5/month starter credit).

3. **New Project → Deploy from GitHub repo** → pick this repo.

4. Add environment variables in Railway's project Settings → Variables:
   ```
   SUPABASE_URL=<your-supabase-url>
   SUPABASE_KEY=<your-service-role-key>
   PUBLIC_URL=<your-railway-app-url>   # set this AFTER step 6
   ```
   Optional: `COMPOSIO_API_KEY`, `ANTHROPIC_API_KEY` for server-wide defaults.

5. Railway auto-detects Node via `package.json`. It'll run `npm install` and execute `npm start`. Confirm in Settings → Deploy that the start command is `npm start` (which runs `tsx server.ts`).

6. Once deployed, Railway gives you a URL like `https://reelytics-production.up.railway.app`. **Copy it and set `PUBLIC_URL` to that exact value** — the Composio OAuth callback needs to match, otherwise Instagram will redirect to localhost. Restart the deployment after updating.

7. Open the URL, sign in, and configure your Composio + Anthropic keys per-user via the ⚙ Settings modal.

8. (Optional) Railway's free volume can persist `./thumbs/`. In Settings → Volumes, mount a volume at `/app/thumbs`. Without this, thumbnails work fine but are re-downloaded on every deploy.

### Deploy to Render (alternative)

Same idea: New Web Service → connect repo → Build `npm install` → Start `npm start` → add the env vars above → update `PUBLIC_URL` after first deploy. Render's free tier sleeps after 15 minutes of inactivity, so report generation may cold-start awkwardly.

### Deploy to Fly.io (alternative)

`flyctl launch` from the repo root, accept the Node detection, set env vars via `flyctl secrets set SUPABASE_URL=… SUPABASE_KEY=…`, then `flyctl deploy`. Free tier covers 3 small VMs.

### What about Netlify / Vercel?

If you specifically need them, you'd have to:
- Replace SSE with polling against a serverless function (and persist job logs in Supabase).
- Move thumbnail storage to Supabase Storage or S3 (the FS is read-only).
- Split the Claude agent call into multiple short serverless invocations or use a Vercel Function with `maxDuration: 300` (Pro plan only — not free).

Not worth it. Stick with Railway for a free tier deployment.
