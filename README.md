# ViralAI Content Factory

Single-page content generator with optional OpenAI generation and server-side social publishing. Text/code/image generation and share links still work when the social backend is not configured. Direct publishing requires the deployed API routes; opening `index.html` from disk cannot run `/api/*` functions.

## Stack

- Static `index.html` frontend, served by Vercel
- Vercel Node.js serverless functions in `api/`
- Supabase Auth for a persistent anonymous browser identity
- Supabase Postgres for encrypted social connection tokens

## Local Setup

1. Create a Supabase project. Enable **Anonymous Sign-Ins** under Authentication settings.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor. The table has RLS enabled and no browser-role policies; only the server service-role key can access it.
3. Copy `.env.example` to `.env.local`, then fill in the Supabase and provider app values. Keep service-role keys and client secrets only in server environment variables.
4. Generate `TOKEN_ENCRYPTION_KEY` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set a separate random `OAUTH_STATE_SECRET` with at least 32 characters.
5. Install dependencies with `npm install`, then run the Vercel development server with `npx vercel dev`.

For deployment, import the repository into Vercel and set the same environment variables in the project settings. Set `APP_URL` to the deployed origin, such as `https://viralai.example.com`, with no trailing slash.

## Provider App Setup

### Meta: Facebook and Instagram

Create a Meta app with Facebook Login and the required Pages/Instagram Graph API products. Register the exact `META_REDIRECT_URI`, normally `https://<your-domain>/api/oauth`. The app requests `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, and `instagram_content_publish`.

Facebook publishing is for a Facebook Page, not a personal profile. Instagram publishing requires a Business or Creator account linked to a Facebook Page. On connect, ViralAI stores the first Page returned by Meta; connecting Instagram selects the first Page with a linked professional Instagram account. Meta may require app review and business verification before non-role users can grant publishing permissions.

### TikTok

Create a TikTok developer app with Login Kit and Content Posting API enabled. Register `TIKTOK_REDIRECT_URI` exactly as the callback URL and request `user.info.basic` and `video.publish`. Direct posting also depends on TikTok app review, account eligibility, and creator privacy settings. Photo publishing uses TikTok's pull-from-URL flow; the generated image URL must be publicly reachable and its domain may need to be verified with TikTok.

## Behavior and Limits

- Social access and refresh tokens are encrypted with AES-256-GCM before they are stored in Supabase. They are never sent back to the browser.
- Facebook publishes Page text posts or image posts. Instagram publishes image posts only. TikTok currently publishes generated image/photo posts; text-only scripts open the TikTok upload flow instead because a script is not a video file.
- Instagram and TikTok image posts require a public HTTPS image URL. OpenAI base64 image results cannot be pulled by those platforms; generate the image with a public URL provider or use the download/share fallback.
- This version connects one Facebook Page and one linked professional Instagram account per browser identity.
- Direct posting is subject to the provider's app permissions, review status, rate limits, and platform policies. Failed or unsupported posts fall back to the existing share/upload flow.
- The Supabase identity is anonymous and stored in that browser. Clearing browser storage creates a new identity; reconnect accounts in that browser if needed.

## API Routes

- `GET /api/config`: public Supabase client configuration and provider availability
- `GET /api/oauth?action=start&provider=facebook|instagram|tiktok`: start OAuth; requires a Supabase bearer token
- `GET /api/oauth`: OAuth callback registered with Meta and TikTok
- `GET /api/connections`: return connected account names; requires a bearer token
- `DELETE /api/connections?provider=...`: disconnect an account; requires a bearer token
- `POST /api/post`: publish a Facebook, Instagram, or TikTok post; requires a bearer token

Run `npm run check` to syntax-check the serverless modules.