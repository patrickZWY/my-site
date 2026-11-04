#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

for page in index.html 404.html about/index.html \
  hometown/index.html more-places/index.html projects/index.html \
  dependent-type-theory-reading-group/index.html \
  dependent-type-theory-reading-group/schedule/index.html \
  fun/index.html poem/index.html
do
  test -s "public/$page"
done

for asset in css/site.css favicon.svg og-image.svg robots.txt sitemap.xml \
  _headers poem.js poem-sea.webp
do
  test -s "public/$asset"
done

grep -q 'directory = "../public"' cloudflare/wrangler.site.toml
grep -q 'not_found_handling = "404-page"' cloudflare/wrangler.site.toml

echo "Static pages and assets checks passed."
