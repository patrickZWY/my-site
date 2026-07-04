# Cloudflare Worker Assets Deployment Fix

Date: 2026-07-02

## Summary

The personal site deployment was failing because the GitHub Actions workflow was
using the Cloudflare Pages deploy command against a Cloudflare Workers project.

The project shown in the Cloudflare dashboard is `round-recipe-030e`, but it is
a Worker with static assets, not a Pages project. Because of that,
`wrangler pages deploy` could not find it and returned:

```text
Project not found. The specified project name does not match any of your
existing projects. [code: 8000007]
```

## Symptoms

- The personal-site custom domain served the old deployed site.
- The personal-site `/demo/` route returned `404` because the new
  static `/demo/` page had not been deployed.
- GitHub Actions failed at the Cloudflare deploy step.
- `wrangler pages project list` produced no Pages project names.
- The Cloudflare dashboard showed `round-recipe-030e` under Workers & Pages as
  a Worker/static-assets project.

The Node 20 deprecation warning in GitHub Actions was unrelated.

## Root Cause

The workflow used this Pages command:

```sh
wrangler pages deploy _site --project-name=round-recipe-030e --branch=main --commit-dirty=true
```

That command only deploys to Cloudflare Pages projects. Since
`round-recipe-030e` is a Worker with static assets, Cloudflare correctly
reported that no Pages project with that name existed.

## Fix

Deploy the personal site as a Worker static-assets project instead of as a Pages
project.

The full site workflow now builds the Hakyll site into `_site`, then deploys the
assets with:

```sh
wrangler deploy --config cloudflare/wrangler.site.toml
```

The Worker static-assets config is:

```toml
name = "round-recipe-030e"
compatibility_date = "2026-07-02"
workers_dev = false

[assets]
directory = "../_site"
```

The `../_site` path is required because this config file lives in the
`cloudflare/` directory, and Wrangler resolves the assets path relative to the
config file.

## Related Demo Fix

The public demo URL needed a separate Worker:

- `round-recipe-030e`: personal site static-assets Worker
- `demo-router`: fallback router for `demo.zhengwangyuan-patrick.com`

`demo-router` proxies to `live-demo.zhengwangyuan-patrick.com` when the local
tunnel is running. When the live tunnel is offline or returns a Cloudflare
gateway error, it serves a custom `503` offline page instead of exposing the
default Cloudflare Tunnel error.

## Files Changed

- `.github/workflows/deploy.yml`
  - Replaced `wrangler pages deploy` with Worker static-assets deploy.
- `.github/workflows/deploy-worker.yml`
  - Added a fast Worker-only deploy path for `demo-router`.
- `cloudflare/wrangler.site.toml`
  - Configures the personal site Worker static-assets deployment.
- `cloudflare/wrangler.worker.toml`
  - Configures the demo fallback Worker.
- `cloudflare/demo-router-worker.js`
  - Serves the live demo when available and a custom offline page when not.
- `content/demo.md`
  - Adds the static demo request/offline page to the personal site.

## Verification

Run locally:

```sh
stack exec site rebuild
npx wrangler deploy --config cloudflare/wrangler.site.toml --dry-run
node --check cloudflare/demo-router-worker.js
```

Expected results:

- Wrangler reads files from `_site`.
- The Worker dry run exits successfully.
- The demo router script passes Node syntax checking.

Check production:

```sh
curl --head https://zhengwangyuan-patrick.com/demo/
curl --head https://demo.zhengwangyuan-patrick.com/
```

Expected results:

- `zhengwangyuan-patrick.com/demo/` returns the deployed static demo
  request page after the personal site Worker deploy completes.
- `demo.zhengwangyuan-patrick.com` returns the live app when the local tunnel is
  running, or the custom `503 text/html` offline page when it is not.
