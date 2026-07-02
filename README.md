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

Create a Cloudflare Pages project named `zhengwangyuan-patrick`.

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow in `.github/workflows/deploy.yml` builds with Stack and deploys `_site` using Wrangler:

```sh
pages deploy _site --project-name=zhengwangyuan-patrick --branch=main
```

Attach these custom domains to the Pages project:

- `zhengwangyuan-patrick.com`
- `www.zhengwangyuan-patrick.com`

Cloudflare Pages `_redirects` does not support domain-level redirects. Use Cloudflare Bulk Redirects to redirect `www.zhengwangyuan-patrick.com/*` to `https://zhengwangyuan-patrick.com/:splat` with a `301`, preserving query strings and path suffixes. Leave `demo.zhengwangyuan-patrick.com` pointed at the existing finance demo.

## Production Checks

After the first deployment:

```sh
curl --head https://zhengwangyuan-patrick.com/
curl --head https://www.zhengwangyuan-patrick.com/
curl --head https://demo.zhengwangyuan-patrick.com/
```

Expected results:

- Apex returns `200`.
- `www` redirects to the apex.
- `demo` remains unchanged.

