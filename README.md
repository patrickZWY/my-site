Static personal site built with Hakyll and deployed to Cloudflare Workers static assets.

## Local Development

```sh
stack build
stack exec site rebuild
stack exec site watch
```

Hakyll writes the generated site to `_site`.

## Content

- `content/` contains Markdown pages.
- `templates/` contains shared HTML templates.
- `css/site.css` contains the visual system.
- `static/` contains files copied to the site root, including favicons, headers, and robots.txt.
- `docs/design-system.md` records layout rules, including the reading-rail
  pattern for long multi-topic pages.

The first version is profile and projects focused, not blog first. Replace the placeholder copy in `content/*.md` as real content becomes available.

## Cloudflare

The personal site deploys to the `round-recipe-030e` Worker/static-assets app.

Required GitHub Actions secrets:

- `CLOUDFLARE_WORKERS_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow in `.github/workflows/deploy.yml` builds with Stack and deploys `_site` using Wrangler:

```sh
npx wrangler deploy --config cloudflare/wrangler.site.toml
```

Attach these custom domains to `round-recipe-030e`:

- `zhengwangyuan-patrick.com`
- `my-site.zhengwangyuan-patrick.com`, redirecting to the apex domain

The apex domain is the canonical public URL. `site.hs` uses
`https://zhengwangyuan-patrick.com` for canonical links, Open Graph URLs, and
the generated sitemap. `static/robots.txt` also points crawlers at the apex
sitemap.

Keep the old `my-site.zhengwangyuan-patrick.com` hostname proxied through
Cloudflare, but redirect it at the zone level:

- Dashboard path: `zhengwangyuan-patrick.com` > Rules > Redirect Rules.
- Rule name: `Redirect old my-site subdomain to apex`.
- Match: `Hostname` `equals` `my-site.zhengwangyuan-patrick.com`.
- URL redirect type: `Dynamic`.
- Expression: `concat("https://zhengwangyuan-patrick.com", http.request.uri.path)`.
- Status code: `301 - Permanent Redirect`.
- Preserve query string: enabled.

This rule is intentionally scoped to only the old personal-site hostname. It
does not match `demo.zhengwangyuan-patrick.com`,
`sps-demo.zhengwangyuan-patrick.com`,
`archipelago-demo.zhengwangyuan-patrick.com`, or any `live-*` tunnel hostname.

For a durable demo reminder, put a Cloudflare Worker in front of
the live-demo frontdoor hostnames:

- `demo.zhengwangyuan-patrick.com` routes to the Worker.
- `live-demo.zhengwangyuan-patrick.com` routes to the local `cloudflared`
  `tla-finance-demo` tunnel when the TLA-Finance walkthrough is running.
- `sps-demo.zhengwangyuan-patrick.com` routes to the same Worker.
- `live-sps-demo.zhengwangyuan-patrick.com` routes to the local SPS-VeriSpec
  workbench service through the separate `sps-verispec-demo` tunnel when the
  SPS walkthrough is running.
- `archipelago-demo.zhengwangyuan-patrick.com` routes to the same Worker.
- `live-archipelago-demo.zhengwangyuan-patrick.com` routes to the local
  Archipelago Spring Boot demo through the separate `archipelago-demo` tunnel
  when the fun demo is running.
- The Worker proxies to `live-demo` when it is reachable and returns a clear
  `503` offline page when the selected local app is unavailable. This avoids
  exposing a raw Cloudflare 530 page to visitors.

The Worker template is in `cloudflare/demo-router-worker.js`. If a live app
checks allowed hosts, include its `live-*` tunnel hostname in that allowlist.
Keep TLA-Finance, SPS-VeriSpec, and Archipelago on separate named tunnels;
reusing one tunnel for multiple services can make a frontdoor show the wrong
local app.

Deploy the demo router Worker after the static site is deployed.

Minimum token permissions for `CLOUDFLARE_WORKERS_API_TOKEN`:

- Account / Workers Scripts / Edit
- Zone / Workers Routes / Edit
- Zone / Zone / Read
- User / User Details / Read, optional but avoids Wrangler's user-settings
  warning

```sh
stack exec site rebuild
npx wrangler deploy --config cloudflare/wrangler.site.toml
npx wrangler deploy --config cloudflare/wrangler.worker.toml
```

If `https://demo.zhengwangyuan-patrick.com/` still shows a Cloudflare Tunnel
error, the request is not reaching this Worker yet. In Cloudflare, remove the
tunnel public hostname for `demo.zhengwangyuan-patrick.com`, add the Worker
route above, and route the tunnel to `live-demo.zhengwangyuan-patrick.com`
instead.

Useful checks:

```sh
curl --head https://zhengwangyuan-patrick.com/demo/
curl --head https://demo.zhengwangyuan-patrick.com/
curl --head https://live-demo.zhengwangyuan-patrick.com/
curl --head https://sps-demo.zhengwangyuan-patrick.com/
curl --head https://live-sps-demo.zhengwangyuan-patrick.com/
curl --head https://archipelago-demo.zhengwangyuan-patrick.com/
curl --head https://live-archipelago-demo.zhengwangyuan-patrick.com/
```

- `/demo/` returning `404` means the personal site has not been redeployed since
  `content/demo.md` was added.
- `demo` returning Cloudflare `530` means it is still routed directly to a
  tunnel, or the Worker route is not deployed.
- `live-demo` failing DNS means the tunnel hostname has not been created yet.
- `sps-demo` uses the same Worker pattern for the SPS-VeriSpec Agent Workbench.
- `live-sps-demo` should route through the `sps-verispec-demo` tunnel, not the
  `tla-finance-demo` tunnel.
- `archipelago-demo` uses the same Worker pattern for the Archipelago fun demo.
- `live-archipelago-demo` should route through the `archipelago-demo` tunnel and
  can optionally be protected by a by-request Cloudflare Access policy. Without
  Access, Archipelago is public while the local app and tunnel are running.

For the exact runbook and the fixes from the first Archipelago demo bring-up,
see `docs/archipelago-demo-bugs-and-fixes.md`.

## Production Checks

After the first deployment:

```sh
curl --head https://zhengwangyuan-patrick.com/
curl --head 'https://my-site.zhengwangyuan-patrick.com/demo/?x=1'
curl --head https://demo.zhengwangyuan-patrick.com/
curl --head https://sps-demo.zhengwangyuan-patrick.com/
curl --head https://archipelago-demo.zhengwangyuan-patrick.com/
```

Expected results:

- Personal site returns `200`.
- Old `my-site` URLs return `301` to the same apex path and query string.
- `demo`, `sps-demo`, and `archipelago-demo` return their live apps when the
  matching tunnel is running.
- `demo`, `sps-demo`, and `archipelago-demo` return clear `503` offline pages
  when the local apps are not intentionally live.
