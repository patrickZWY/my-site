import { PRIVATE_STUDY_HTML } from "./private-study-page.generated.js";

const PRIVATE_PATH = "/rabbithole";
const PRIVATE_ASSET_PREFIX = "/private-study-assets-v1-621b0c418a9e8c8add0633a3491d19be419716893c1fa7a844a28bf51369ca71/";
const ANSWER_HASH = "23ddda4810068cc44360dffd31b6c5a9ad13fb9e6a69c9354a5d1b07f1b9843f";
const COOKIE_NAME = "agent_study_access";
const COOKIE_VALUE = "v1.621b0c418a9e8c8add0633a3491d19be419716893c1fa7a844a28bf51369ca71";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14;
const FORCE_GATE_PARAM = "gate";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isPrivateAssetPath(url.pathname)) {
      return new Response("Not Found", {
        status: 404,
        headers: privateHeaders({
          "Content-Type": "text/plain; charset=utf-8",
        }),
      });
    }

    if (!isPrivatePath(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === PRIVATE_PATH) {
      url.pathname = `${PRIVATE_PATH}/`;
      return Response.redirect(url.toString(), 302);
    }

    if (request.method === "POST") {
      return handleUnlock(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: privateHeaders({ Allow: "GET, HEAD, POST" }),
      });
    }

    if (url.searchParams.has(FORCE_GATE_PARAM)) {
      return renderGate(false, { clearAccess: true });
    }

    if (!hasAccess(request)) {
      return renderGate(false);
    }

    return renderPrivatePage(request.method);
  },
};

async function handleUnlock(request) {
  let answer = "";

  try {
    const form = await request.formData();
    answer = String(form.get("answer") || "");
  } catch (_error) {
    return renderGate(true, { clearAccess: true });
  }

  if (!(await answerMatches(answer))) {
    return renderGate(true, { clearAccess: true });
  }

  return new Response(null, {
    status: 303,
    headers: privateHeaders({
      Location: `${PRIVATE_PATH}/`,
      "Set-Cookie": [
        `${COOKIE_NAME}=${COOKIE_VALUE}`,
        `Max-Age=${COOKIE_MAX_AGE}`,
        `Path=${PRIVATE_PATH}`,
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
      ].join("; "),
    }),
  });
}

function isPrivatePath(pathname) {
  return pathname === PRIVATE_PATH || pathname.startsWith(`${PRIVATE_PATH}/`);
}

function isPrivateAssetPath(pathname) {
  return pathname === PRIVATE_ASSET_PREFIX.slice(0, -1) || pathname.startsWith(PRIVATE_ASSET_PREFIX);
}

function hasAccess(request) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return cookies.get(COOKIE_NAME) === COOKIE_VALUE;
}

async function answerMatches(answer) {
  const normalized = answer.trim().toLowerCase();
  const hash = await sha256Hex(normalized);
  return constantTimeEqual(hash, ANSWER_HASH);
}

async function sha256Hex(value) {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left, right) {
  let diff = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function parseCookies(header) {
  const cookies = new Map();

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }

  return cookies;
}

function renderGate(hasError, options = {}) {
  const headers = privateHeaders({
    "Content-Type": "text/html; charset=utf-8",
  });

  if (options.clearAccess) {
    headers.append("Set-Cookie", clearAccessCookie());
  }

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta name="color-scheme" content="light dark">
  <title>Rabbit Hole | Zheng Wangyuan (Patrick)</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/site.css">
</head>
<body class="private-gate">
  <main class="private-gate-panel" aria-labelledby="private-gate-title">
    <p class="eyebrow">Private page</p>
    <h1 id="private-gate-title">Rabbit Hole</h1>
    <p>Answer the question to enter the study page.</p>
    <form class="private-gate-form" method="post" action="${PRIVATE_PATH}/">
      <label for="answer">Who do I like the most?</label>
      <input id="answer" name="answer" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Enter</button>
    </form>
    ${hasError ? '<p class="private-gate-error" role="alert">That answer did not match.</p>' : ""}
  </main>
</body>
</html>`,
    {
      status: hasError ? 401 : 200,
      headers,
    }
  );
}

function clearAccessCookie() {
  return [
    `${COOKIE_NAME}=`,
    "Max-Age=0",
    `Path=${PRIVATE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function renderPrivatePage(method) {
  return new Response(method === "HEAD" ? null : PRIVATE_STUDY_HTML, {
    headers: privateHeaders({
      "Content-Type": "text/html; charset=utf-8",
    }),
  });
}

function privateHeaders(extra = {}) {
  return new Headers({
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...extra,
  });
}
