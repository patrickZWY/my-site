const OWNER_EMAIL = "hello@zhengwangyuan-patrick.com";
const GATEWAY_FAILURE_STATUSES = new Set([502, 503, 504, 521, 522, 523, 524, 530]);
const DEMOS = {
  "demo.zhengwangyuan-patrick.com": {
    name: "TLA-Finance",
    liveOrigin: "https://live-demo.zhengwangyuan-patrick.com",
    subject: "Finance demo request",
  },
  "sps-demo.zhengwangyuan-patrick.com": {
    name: "SPS-VeriSpec Agent Workbench",
    liveOrigin: "https://live-sps-demo.zhengwangyuan-patrick.com",
    subject: "SPS-VeriSpec demo request",
  },
  "archipelago-demo.zhengwangyuan-patrick.com": {
    name: "Archipelago",
    liveOrigin: "https://live-archipelago-demo.zhengwangyuan-patrick.com",
    subject: "Archipelago demo request",
  },
};

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const demo = DEMOS[incomingUrl.hostname] || DEMOS["demo.zhengwangyuan-patrick.com"];
    const liveUrl = new URL(incomingUrl.pathname + incomingUrl.search, demo.liveOrigin);
    const liveRequest = new Request(liveUrl, request);

    let liveResponse;
    try {
      liveResponse = await fetch(liveRequest);
    } catch (_error) {
      return offlineResponse(request, demo);
    }

    if (!GATEWAY_FAILURE_STATUSES.has(liveResponse.status)) {
      return liveResponse;
    }

    return offlineResponse(request, demo);
  },
};

function offlineResponse(request, demo) {
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");

  if (request.method !== "GET" && request.method !== "HEAD" && !acceptsHtml) {
    return new Response(
      `The ${demo.name} demo is available by request. Contact ${OWNER_EMAIL} to schedule a walkthrough.`,
      {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }

  return new Response(request.method === "HEAD" ? null : offlineHtml(demo), {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function offlineHtml(demo) {
  const subject = encodeURIComponent(demo.subject);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo available by request</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f6f2;
      --surface: #ffffff;
      --text: #181816;
      --muted: #62615b;
      --line: #dedbd2;
      --accent: #1f5e56;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #161715;
        --surface: #1d1f1c;
        --text: #efede7;
        --muted: #b7b1a6;
        --line: #363831;
        --accent: #74b6a6;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
      background: var(--bg);
      color: var(--text);
      font: 17px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(100%, 720px);
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    p { margin: 0 0 16px; color: var(--muted); }
    .eyebrow {
      margin-bottom: 10px;
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 720;
      text-transform: uppercase;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2rem, 8vw, 4.25rem);
      line-height: 1.05;
      letter-spacing: 0;
    }
    a {
      color: var(--accent);
      font-weight: 650;
      text-underline-offset: 0.22em;
    }
    .button {
      display: inline-flex;
      min-height: 44px;
      align-items: center;
      justify-content: center;
      margin-top: 8px;
      padding: 0.65rem 1rem;
      border-radius: 6px;
      color: #ffffff;
      background: var(--accent);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Guided walkthrough</p>
    <h1>${demo.name} is available by request.</h1>
    <p>Contact me to schedule a guided walkthrough.</p>
    <a class="button" href="mailto:${OWNER_EMAIL}?subject=${subject}">Request a demo</a>
  </main>
</body>
</html>`;
}
