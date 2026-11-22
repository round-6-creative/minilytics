# Minilytics

Revenue-first web analytics for your own websites, inspired by DataFast. It shows where visitors came from (which
tweet, article, Google page or AI assistant), what they did, and **which source made you money**. It runs on
Cloudflare's free plan.

This is Round 6's copy, used for its own products. It started as a fork of
[surendrapandar/minilytics](https://github.com/surendrapandar/minilytics).

![Dashboard](docs/dashboard.png)

## What it tracks

- **Visitors, revenue, conversion rate, revenue per visitor, bounce rate, session time, online now**, each with a % change against the previous period
- A chart of visitors (line) and revenue (bars), hourly, daily, weekly or monthly
- Date ranges: today, yesterday, last 24h, last 2 days, 7/30/90 days, 12 months, all time and custom, with ‹ › to step back and forward
- **Where visitors come from**: channel, referrer (X, Google, ChatGPT, Reddit…), campaign (`utm_campaign`), keyword (`utm_term`), `?ref=` tags
- **Where they are and what they use**: country, region, city, browser, OS, device
- **What they did**: pages, entry pages, exit links (outbound clicks), button clicks and custom goals, funnels
- **Who paid**: a Journey list of every customer with their source, amount, time to convert, and a full visitor timeline (visit → pages → clicks → payment)
- **Live globe** (press `M`): every visitor on your site right now, on a 3D globe or 2D map, with a live feed of page views, goals and payments, optional sounds, light/dark map and fullscreen. Map tiles from [OpenFreeMap](https://openfreemap.org), free with no API key
- Anonymous visitors get friendly, stable names like "brown fox"
- Click any row to filter the whole dashboard (for example "only visitors from the launch tweet")
- **Every site on one screen**: revenue, visitors, conversion and a trend line per site, against the previous period,
  with totals across sites and who is online now
- **Revenue detail**: new versus repeat revenue, refunds, estimated MRR and churn, value per customer, and customers and
  revenue by source, campaign, country or entry page
- **First touch or last touch**: switch which visit gets the credit for a payment
- **Who comes back**: new and returning visitors per day, and weekly retention cohorts
- **What buyers read**: the pages customers saw before paying, against how many of all visitors saw them
- **Page quality**: how far each page is scrolled, Core Web Vitals (LCP, INP, CLS) from visitors' own browsers, form
  starts and submits, JavaScript errors and missing pages (404)
- **Alerts**: a busy site stops sending visits, a payment webhook keeps being rejected, traffic spikes. Shown on the home
  page and sent to Slack, Discord, Telegram, ntfy or any webhook, together with each sale and a weekly summary
- **Notes on the chart** (a launch, a post), **saved views**, **CSV export** of any breakdown and of payments
- **Read-only share links** for a client or partner: totals and sources, never visitors or customers
- **Read access for AI agents**: an MCP server and a small HTTP API with read-only tokens

## Deploy for free (about 10 minutes)

Every person deploys **their own copy** on their own free Cloudflare account. Your data stays on your account, and you
get your own dashboard with its own password.

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up), [Node.js 20+](https://nodejs.org) and Git.
Run these commands in a terminal on your computer. You only do this once; afterwards the app runs on Cloudflare.

**1. Download the code and log in to Cloudflare**

```bash
git clone https://github.com/round-6-creative/minilytics.git
cd minilytics
npm install
npx wrangler login          # opens your browser; click "Allow"
```

**2. Create the database**

```bash
npx wrangler d1 create minilytics
```

If Wrangler asks *"Would you like Wrangler to add it on your behalf?"*, answer **No**. Answer **No** to the optional
"Cloudflare skills" questions too. Then copy the printed `database_id` and paste it into `wrangler.jsonc`, replacing
`00000000-0000-0000-0000-000000000000`. There must be exactly **one** entry under `d1_databases`, with `"binding": "DB"`.

**3. Set your password and a signing secret**

```bash
npx wrangler secret put ADMIN_PASSWORD     # the password you'll log in with (use a strong one)
npx wrangler secret put SESSION_SECRET     # any long random text, e.g. the output of: openssl rand -hex 32
```

Typing is hidden; that's normal. If asked *"There doesn't seem to be a Worker called minilytics… create it?"*, answer **Yes**.

**4. Deploy**

```bash
npm run deploy
```

This builds the dashboard, creates the database tables and deploys. It prints your link, e.g.
`https://minilytics.<you>.workers.dev`. Open it, log in, add a website and copy its script tag. Each site's Settings
page also has a **Copy AI prompt** button that lets Claude Code / Cursor do the install in your codebase for you.

If you see `fetch failed`, it's a network hiccup (VPN, proxy, Wi-Fi). Run `npm run deploy` again.

You can attach a custom domain such as `analytics.yourdomain.com` in Cloudflare → Workers & Pages → minilytics →
Settings → Domains & Routes.

**Updating later**

```bash
git stash          # keeps your database_id edit in wrangler.jsonc safe
git pull
git stash pop
npm run deploy
```

### What the free plan covers

| Cloudflare free limit | What it means here |
| --- | --- |
| 100,000 Worker requests/day | About 100k tracked events per day across all sites. The script and dashboard files are static and don't count. |
| 100,000 D1 rows written/day | About 10k pageviews per day |
| 5M D1 rows read/day | A dashboard load reads roughly 10 times the sessions in the range, so with 10k visitors/month that's hundreds of loads a day |
| 5 GB D1 storage | Years of data at side-project traffic |
| Cron triggers | One job an hour (daily totals, tracking checks, exchange rates, the weekly summary) |

At 5–10k visitors a month you'll use a few percent of this. If you outgrow it, Cloudflare's Workers Paid plan is $5/month.

## Run it as a hosted SaaS (optional)

By default Minilytics is single-user with a password. Set the Google values below and it becomes a hosted product:
a landing page with pricing, **Sign in with Google**, a paid plan through Dodo Payments, and every customer sees only
their own sites. Tracking stops (quietly) for sites whose owner's plan has ended.

```bash
npx wrangler secret put GOOGLE_CLIENT_ID        # Google Cloud → Credentials → OAuth client (Web)
npx wrangler secret put GOOGLE_CLIENT_SECRET    # redirect URI: https://YOUR-DOMAIN/api/auth/google/callback
npx wrangler secret put ADMIN_EMAILS            # your Google email(s): free, and you keep the existing sites
npx wrangler secret put PLAN_CHECKOUT_URL       # Dodo payment link for the plan
npx wrangler secret put PLAN_PRODUCT_ID         # that product's id (pdt_...)
npx wrangler secret put BILLING_WEBHOOK_SECRET  # Dodo webhook → https://YOUR-DOMAIN/api/billing/webhook
npx wrangler secret put PLAN_PRICE              # e.g. $29
npx wrangler secret put PLAN_INTERVAL           # lifetime | month | year
npx wrangler secret put PLAN_SPOTS              # e.g. 5 ("3 of 5 spots left"); optional
npx wrangler secret put PLAN_NEXT_PRICE         # e.g. $49 ("…, then $49"); optional
npx wrangler secret put PLAN_TIERS              # optional: "$29:5, $49:pdt_b:5, $100" steps the price up as spots sell
                                                # (one Dodo product per price; no pdt_ = sold out or only announced).
                                                # Replaces PRICE/SPOTS/NEXT_PRICE; sold-out prices show as "5 sold at $29"
npx wrangler secret put SUPPORT_EMAIL           # shown on pricing, billing and legal pages
npm run deploy
```

Subscribe the billing webhook to `payment.succeeded`, `subscription.*` and `refund.succeeded`. A one-time product
(`PLAN_INTERVAL=lifetime`) gives lifetime access; a subscription gives access until it expires or is refunded.
The Terms, Privacy and Refund pages (`/terms`, `/privacy`, `/refund`) are plain-language starting points: review them.

## Install on a website

```html
<script defer data-website-id="SITE_ID" src="https://YOUR-MINILYTICS-HOST/js/script.js"></script>
```

- **Button clicks / goals:** `<button data-ml-goal="signup_click">`, or `window.minilytics('goal', 'signup', { plan: 'pro' })`
- **Identify logged-in users:** `window.minilytics('identify', { user_id, email, name })`
- **Ignore your own visits:** open `https://yoursite.com/?ml_ignore=true` once per browser
- **Single-page apps** (Next.js, React Router…) are handled automatically
- **Page quality** is measured without any setup: scroll depth, page speed, JavaScript errors, missing pages and forms.
  Switch any of them off with `data-disable="errors, forms, vitals, scroll, 404"`.
  - A page counts as missing when its title starts with "404" or says "page not found", or when it carries
    `data-ml-404` (or `<meta name="minilytics:404">`), which is the reliable way.
  - Forms are named by `data-ml-form`, then `id`, `name` or the path they post to. `data-ml-ignore` skips a form.
    Only the form's name is sent, never what was typed.
  - Error reports carry the message and file location, at most five different ones per page load.
- **Subdomains:** `app.yoursite.com` and `yoursite.com` share the same visitor, because the cookie is set on the root domain
- **No cookies:** add `data-cookieless`. The script then sets no cookies and stores nothing. The server counts a visitor
  from a hash of their IP, user agent and a random salt that is replaced every UTC day and the old one deleted, so the
  same person on another day counts as new and no IP is kept. A session ends after 30 minutes without activity.
  Revenue attribution through checkout links and `identify` are off on such a site. Load the script and send events
  straight to the Minilytics host: a proxy in between hides the visitor's IP and merges everyone into one visitor.

### Tracking a specific tweet / article

X, Medium, LinkedIn and others hide which exact post sent someone; the referrer only says `t.co` or `medium.com`.
To see the exact post, tag each link. Settings has a link builder for this:

```
https://yoursite.com/?utm_source=x&utm_medium=social&utm_campaign=launch-tweet
https://yoursite.com/?ref=launch-tweet            (short version)
```

For SEO, Google never shares the search keyword, but **Entry page** with the **Google** referrer tells you which
article people found you through.

## Revenue attribution

Pick your provider in site settings → **Connect payments**.

### Dodo Payments

1. In Dodo → Developer → Webhooks, add `https://YOUR-HOST/api/webhooks/dodo/SITE_ID` and subscribe to
   `payment.succeeded` and `refund.succeeded`. Paste the signing secret (`whsec_…`) into the site settings.
2. Pass the visitor cookies as metadata when creating a checkout:

```ts
const jar = await cookies(); // next/headers
await dodo.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_xxx', quantity: 1 }],
  metadata: { ml_visitor_id: jar.get('ml_vid')?.value ?? '', ml_session_id: jar.get('ml_sid')?.value ?? '' },
});
```

Using Dodo **payment links**? The script adds `metadata_ml_visitor_id` / `metadata_ml_session_id` to any
`checkout.dodopayments.com` link when it's clicked. That metadata doesn't always reach the payment, so also do step 3.

3. Recommended: set the checkout's return / redirect URL to a page on your site (e.g. `/thanks`) that loads the
   script. Dodo adds `?payment_id=…` to it, and Minilytics uses that to link the payment to the exact visitor even when
   metadata doesn't come through.

### Stripe

1. In Stripe → Developers → Webhooks, add `https://YOUR-HOST/api/webhooks/stripe/SITE_ID` and subscribe to
   `checkout.session.completed`, `invoice.paid` and `charge.refunded`. Paste the signing secret (`whsec_…`) into the
   site settings.
2. Pass the visitor cookies as metadata when creating a Checkout Session, and add `{CHECKOUT_SESSION_ID}` to the success URL:

```ts
const jar = await cookies(); // next/headers
await stripe.checkout.sessions.create({
  // ...your existing options
  success_url: 'https://yoursite.com/thanks?session_id={CHECKOUT_SESSION_ID}',
  metadata: { ml_visitor_id: jar.get('ml_vid')?.value ?? '', ml_session_id: jar.get('ml_sid')?.value ?? '' },
});
```

Using Stripe **Payment Links** (`buy.stripe.com`)? The script puts the visitor in `client_reference_id` when the link is
clicked (unless you already set your own). Set the link's confirmation page to redirect to
`https://yoursite.com/thanks?session_id={CHECKOUT_SESSION_ID}` so the payment is also matched on the return page.

Subscription renewals (`invoice.paid`) are credited to the visitor who first subscribed. Refunds are subtracted.

Selling other products from the same Stripe account? Every webhook receives all of them. Add `app` to the metadata of the
Checkout Session and to `subscription_data.metadata`, then enter that value in the site's Stripe settings. Payments
without it are ignored.

### First touch and last touch

Every payment keeps two visits: the last one that came from somewhere (the default credit) and the visitor's very first.
The **Last touch / First touch** switch in the dashboard decides which one the revenue columns, the breakdowns and the
revenue panel use. The Journey list shows both when they differ.

### Subscriptions and currencies

MRR is worked out from payments: a subscription is active while the period its last payment covers (plus a few days) has
not run out and that payment was not refunded. Stripe invoices carry the period; Dodo sends it on its `subscription.*`
events, so subscribe the webhook to those too. A subscription with one payment and no period on record is counted as
monthly and the figure is labelled an estimate. There is no cancellation event, so a cancelled subscription counts until
the time it paid for ends.

A payment in another currency is stored in the site's currency at that day's reference rate (European Central Bank), with
the amount actually charged kept next to it.

### How credit is given

A payment goes to the paying visitor's last visit that came from a real source (last non-direct
touch). So "clicked a tweet, came back directly 17 days later and paid" is credited to the tweet. If metadata is
missing, Minilytics tries, in order: the return page (`?payment_id=` / `?session_id=`), an earlier payment by the same customer
(renewals), an email you `identify()`'d, and finally checkout timing (used only when exactly one visitor clicked a Dodo or
Stripe checkout link in the 3 hours before the payment). The Journey tab shows how each payment was matched, and **Try
matching again** re-runs this for older payments.
Refunds are subtracted from revenue.

### Other providers (API)

Any other provider can use the generic API (the key is in site settings):

```bash
curl -X POST https://YOUR-HOST/api/v1/payments -H "Authorization: Bearer ml_..." -H "Content-Type: application/json" \
  -d '{"transaction_id":"txn_1","amount":29.99,"currency":"USD","visitor_id":"<ml_vid cookie>","email":"jane@acme.com"}'
```

## Accuracy notes

No analytics tool is 100% accurate. These are the main gaps and how this project handles them:

- **Ad blockers** block some analytics domains. Proxy the script through your own domain (Settings shows a Next.js
  rewrite). Payments are always recorded by the webhook, even when the visitor's browser blocked tracking.
- **Safari** keeps cookies set by JavaScript for at most 7 days. A Safari visitor who returns after more than a week counts as new. The
  email fallback above recovers most of these payments.
- **Bots** are filtered by user agent and the `navigator.webdriver` flag. Visits that come straight from a cloud
  provider's network (Amazon, Google Cloud, Azure, DigitalOcean, Hetzner and others) are most likely scripts too. They
  are marked and counted, not dropped, because a person on a cloud desktop or a self-hosted VPN looks the same. See them
  under **Network** in the browser panel and click to filter.
- Revenue in a different currency than the site's is converted only when Dodo gives a settlement amount in the site's currency.

## Alerts and notifications

Once an hour Minilytics checks every site. It raises an alert when a site that normally gets visits has had none for far
longer than usual, when a payment webhook is rejected three times in a row, and when the last 24 hours brought more than
three times a normal day. On Monday morning it writes a summary of the week per site. Alerts show on the home page.

To get them in a chat, open **Workspace** on the home page and paste a webhook address (Slack, Discord, Telegram, ntfy or
any https address that accepts a JSON POST). Each payment and refund is sent too, with the source that brought the
customer. Messages never include a customer's name or email.

## Read access for AI agents and scripts

Create a read token in **Workspace**. It can read every site's statistics and nothing else.

```bash
# MCP (Claude Code shown; any MCP client that speaks HTTP works)
claude mcp add --transport http minilytics https://YOUR-HOST/api/mcp --header "Authorization: Bearer mlr_..."

# or plain HTTP
curl -H "Authorization: Bearer mlr_..." "https://YOUR-HOST/api/v1/reports/portfolio?period=30d"
curl -H "Authorization: Bearer mlr_..." "https://YOUR-HOST/api/v1/reports"   # every report and its parameters
```

Reports: `list_sites`, `portfolio`, `site_summary`, `breakdown`, `payments`, `revenue`, `tracking_health`,
`page_quality`. Money is in minor units (cents) of the site's currency. Customer names and emails are never returned.

Reports that read individual visits (`breakdown`, `payments`) cover at most 92 days per call; `site_summary` and
`portfolio` are answered from daily totals and work for any range. A token has a daily allowance, charged by how many
days of visits a call reads, so an agent cannot use up the database's daily read limit.

## Share a dashboard

Site settings → **Share a read-only dashboard** creates a link that opens without a login. It shows totals, sources,
pages, goals, funnels and revenue for up to 90 days at a time. It never shows visitors, customers, the live view or
settings. Deleting the link stops it at once.

## Local development

```bash
cp .dev.vars.example .dev.vars        # password: change-me
npm run db:migrate:local
npm run build && npm run dev:api      # http://localhost:8787
npm run dev:web                       # optional: hot-reloading dashboard on http://localhost:5173

npm run seed                          # optional: 30 days of demo data ("ShipKit" site)
npm test                              # unit tests, including database code against SQLite with every migration applied
npm run smoke                         # end-to-end test against the running dev server (use a fresh local database)
node scripts/smoke-hosted.mjs         # hosted-mode test (see the comment at the top for how to start it)
```

## How it's built

- `public/js/script.js`: the tracker, 17 KB (about 6 KB gzipped). It handles cookies, pageviews, engaged time, goals, outbound links, checkout link tagging, scroll depth, page speed, errors and forms
- `src/worker`: a Hono app on Cloudflare Workers that handles event ingestion, the payment webhooks, the payments and goals API, stats queries on D1 (SQLite), the hourly job (`cron.ts`) and the read API and MCP endpoint (`agent.ts`)
- `daily_stats` (`rollups.ts`): one row per site and day, with a count of that day's visitors by how long ago they last came. That makes unique visitors over any range of days an exact sum of a few rows, which is what the home page, the summaries and the checks read
- `src/dashboard`: the React dashboard (Vite, Tailwind, Recharts), served as static files by the same Worker
- `migrations/`: the database schema

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run typecheck && npm test`.

## License

[MIT](LICENSE): free to use, modify and self-host, including commercially.
