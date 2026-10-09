# Site Design System

This document records design rules for the personal site. Treat these rules as
the default direction for new pages.

## Core Direction

Use bare HTML and browser defaults: a white background, black text, default
fonts, ordinary links, native inputs and buttons, and normal document flow.
Do not add web fonts, decorative backgrounds, cards, custom typography, or a
centred application shell. The poem retains its playback with plain browser
type and controls, without a photograph or gradient.

`public/css/site.css` contains only the few rules needed for photograph sizing,
overflow, and poem playback. The homepage introduces the author through
personal photographs and a short line in their own words.

## Navigation

There is no header menu or interpreter. Navigation uses ordinary hyperlinks
inside the page text, after the reader has reached the relevant introduction.

The main reading sequence is Home → Hometown → More places → About → Projects
→ Writing → Reading group → Fun → Contact. Each page ends with a sentence linking to the next
section. Contact links back to the introduction. Do not add a section menu,
next/previous toolbar, or navigation links above the introduction.

Projects and Archipelago are ordinary links to their GitHub repositories,
without descriptions or demo-request prompts. Existing project detail routes
contain only a repository link and a sentence returning to Projects. The poem
links back to Fun. Section labels have no numeric addresses. Reading-group
subpage, external, and email links remain ordinary links in the content.

## Multi-Topic Reading Pattern

Long study pages use normal document flow, semantic headings, stable anchor
IDs, and plain section links. The Rabbit Hole section navigation remains in
`cloudflare/private-study.html`; it does not need a styled or sticky rail.
Code blocks scroll horizontally when needed.

## Security Note For Private Pages

Private content must not be generated at a public route and hidden only by UI.
The Rabbit Hole page lives in `cloudflare/private-study.html`, outside the
`public/` directory. Wrangler imports it as a Worker-only text module; it is
never uploaded as a public asset. Public
requests to old internal private asset paths must return `404`. The gate page rendered by `cloudflare/site-worker.js` uses the same plain
browser controls as the rest of the site.
