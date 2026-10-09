# Site Design System

This document records design rules for the personal site. Treat these rules as
the default direction for new pages.

## Core Direction

Use bare HTML and browser defaults: a white background, black text, default
fonts, ordinary links, native inputs and buttons, and normal document flow.
Centre text, photographs, lists, and tables across the site. About and the
reading-group schedule retain their left-aligned browser layout.
Do not add web fonts, decorative backgrounds, cards, custom typography, or a
centred application shell. The poem is the exception: it uses the original sea
photograph with a dark overlay and light text, retaining plain browser type and
controls.

`public/css/site.css` contains only the few rules needed for centring, photograph
sizing, overflow, and poem playback. The homepage introduces the author through
personal photographs and a short line in their own words.
Photo pages contain no author names, including in titles and descriptions.
Only About introduces the author's names using three left-aligned judgments
as its largest, bold heading (the browser's default `h1`):
`Γ ⊢ 郑汪元 : A`, `Δ ⊢ Zheng Wangyuan : A[γ]`, and
`Θ ⊢ Patrick : A[γ][δ]`. Keep substitution rules and explanations implicit.

## Navigation

There is no header menu or interpreter. Navigation uses ordinary hyperlinks
inside the page text, after the reader has reached the relevant introduction.

The main reading sequence is Home → Hometown → More places → About → Projects
→ Reading group → Fun → Contact. Each page ends with a sentence linking to the next
section, except Fun, which ends with its poem and project links. Contact links
back to the introduction. Do not add a section menu,
next/previous toolbar, or navigation links above the introduction.

Projects and Archipelago are ordinary links to their GitHub repositories,
without descriptions or demo-request prompts. Existing project detail routes
contain only a repository link and a sentence returning to Projects. The poem
links back to Fun, and its heading, controls, and poem are horizontally centred.
Preserve the poem's whitespace; let it scroll horizontally on narrow screens.
Section labels have no numeric addresses. Reading-group
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
