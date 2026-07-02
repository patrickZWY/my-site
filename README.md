# Zhengwangyuan Patrick

Static personal site built with Hakyll and deployed to Cloudflare Pages.

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

The first version is profile and projects focused, not blog first. Replace the placeholder copy in `content/*.md` as real content becomes available.

## Cloudflare Pages

Create or select a Cloudflare Pages project for this site. The Pages project name is the Cloudflare project slug, not the custom domain. If the default Pages URL is `example.pages.dev`, then the project name is `example`.

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Required GitHub Actions repository variable:

- `CLOUDFLARE_PROJECT_NAME`

The workflow in `.github/workflows/deploy.yml` builds with Stack and deploys `_site` using Wrangler:

```sh
pages deploy _site --project-name=$CLOUDFLARE_PROJECT_NAME --branch=main --commit-dirty=true
```

Attach this custom domain to the Pages project:

- `my-site.zhengwangyuan-patrick.com`

For a durable demo reminder, put a Cloudflare Worker in front of
`demo.zhengwangyuan-patrick.com`:

- `demo.zhengwangyuan-patrick.com` routes to the Worker.
- `live-demo.zhengwangyuan-patrick.com` routes to the local `cloudflared`
  tunnel when the walkthrough is running.
- The Worker proxies to `live-demo` when it is reachable and returns a clear
  `503` offline page when the local app is unavailable. This avoids exposing a
  raw Cloudflare 530 page to visitors.

The Worker template is in `cloudflare/demo-router-worker.js`. If the live app
checks allowed hosts, include `live-demo.zhengwangyuan-patrick.com` in that
allowlist.

Deploy the Worker after the static site is deployed:

```sh
stack exec site rebuild
pages deploy _site --project-name=$CLOUDFLARE_PROJECT_NAME --branch=main --commit-dirty=true
npx wrangler deploy --config cloudflare/wrangler.toml
```

If `https://demo.zhengwangyuan-patrick.com/` still shows a Cloudflare Tunnel
error, the request is not reaching this Worker yet. In Cloudflare, remove the
tunnel public hostname for `demo.zhengwangyuan-patrick.com`, add the Worker
route above, and route the tunnel to `live-demo.zhengwangyuan-patrick.com`
instead.

Useful checks:

```sh
curl --head https://my-site.zhengwangyuan-patrick.com/demo/
curl --head https://demo.zhengwangyuan-patrick.com/
curl --head https://live-demo.zhengwangyuan-patrick.com/
```

- `/demo/` returning `404` means the personal site has not been redeployed since
  `content/demo.md` was added.
- `demo` returning Cloudflare `530` means it is still routed directly to a
  tunnel, or the Worker route is not deployed.
- `live-demo` failing DNS means the tunnel hostname has not been created yet.

## Production Checks

After the first deployment:

```sh
curl --head https://my-site.zhengwangyuan-patrick.com/
curl --head https://demo.zhengwangyuan-patrick.com/
```

Expected results:

- Personal site returns `200`.
- `demo` returns the live app when the tunnel is running.
- `demo` returns a clear `503` offline page when the local app is not
  intentionally live.
