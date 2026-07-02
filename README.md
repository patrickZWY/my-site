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

Create a Cloudflare Pages project named `my-site-zhengwangyuan-patrick`.

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow in `.github/workflows/deploy.yml` builds with Stack and deploys `_site` using Wrangler:

```sh
pages deploy _site --project-name=my-site-zhengwangyuan-patrick --branch=main
```

Attach this custom domain to the Pages project:

- `my-site.zhengwangyuan-patrick.com`

Leave `demo.zhengwangyuan-patrick.com` pointed at the existing finance demo.

## Production Checks

After the first deployment:

```sh
curl --head https://my-site.zhengwangyuan-patrick.com/
curl --head https://demo.zhengwangyuan-patrick.com/
```

Expected results:

- Personal site returns `200`.
- `demo` remains unchanged.
