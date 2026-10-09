#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

for page in index.html 404.html about/index.html contact/index.html \
  hometown/index.html more-places/index.html projects/index.html \
  projects/tla-finance/index.html projects/price-manipulation/index.html \
  projects/sps-verispec/index.html demo/index.html writing/index.html \
  dependent-type-theory-reading-group/index.html \
  dependent-type-theory-reading-group/schedule/index.html \
  dependent-type-theory-reading-group/notes/index.html fun/index.html poem/index.html
do
  test -s "public/$page"
done

for asset in css/site.css favicon.svg og-image.svg robots.txt sitemap.xml \
  _headers poem.js poem-sea.webp study-nav.js skills/acl2-proof-with-ai/SKILL.md
do
  test -s "public/$asset"
done

test -s cloudflare/private-study.html
grep -q 'id="private-study-title"' cloudflare/private-study.html
grep -q 'from "./private-study.html"' cloudflare/site-worker.js
grep -q 'directory = "../public"' cloudflare/wrangler.site.toml
grep -q 'not_found_handling = "404-page"' cloudflare/wrangler.site.toml
grep -q 'assets_navigation_has_no_effect' cloudflare/wrangler.site.toml
grep -q 'type = "Text"' cloudflare/wrangler.site.toml

# Private HTML must never become a publicly served asset, at any location.
test ! -e public/rabbithole
test ! -e public/private-study.html
if grep -rl 'id="private-study-title"' public; then
  echo "Private study content found in public assets." >&2
  exit 1
fi
if find public -name 'private-study-assets*' -print | grep -q .; then
  echo "Private study assets found in public directory." >&2
  exit 1
fi

echo "Static pages, assets, and private-page separation checks passed."
