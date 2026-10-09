const GATEWAY_FAILURE_STATUSES = new Set([502, 503, 504, 521, 522, 523, 524, 530]);
const DEMOS = {
  "demo.zhengwangyuan-patrick.com": {
    name: "TLA-Finance",
    liveOrigin: "https://live-demo.zhengwangyuan-patrick.com",
    repository: "https://github.com/patrickZWY/TLA-Finance",
  },
  "sps-demo.zhengwangyuan-patrick.com": {
    name: "SPS-VeriSpec Agent Workbench",
    liveOrigin: "https://live-sps-demo.zhengwangyuan-patrick.com",
    repository: "https://github.com/patrickZWY/SPS-VeriSpec",
  },
  "archipelago-demo.zhengwangyuan-patrick.com": {
    name: "Archipelago",
    liveOrigin: "https://live-archipelago-demo.zhengwangyuan-patrick.com",
    repository: "https://github.com/patrickZWY/archipelago",
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
      `The ${demo.name} demo is offline. Repository: ${demo.repository}`,
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo offline</title>
</head>
<body>
  <main>
    <h1>${demo.name} is offline.</h1>
    <p><a href="${demo.repository}">GitHub repository</a></p>
  </main>
</body>
</html>`;
}
