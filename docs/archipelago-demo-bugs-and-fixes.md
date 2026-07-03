# Archipelago Demo Bugs and Fixes

Concise notes from the first `archipelago-demo` bring-up.

## What Worked

- Public frontdoor: `https://archipelago-demo.zhengwangyuan-patrick.com/`
- Live tunnel: `https://live-archipelago-demo.zhengwangyuan-patrick.com/`
- Local Spring Boot origin: `http://127.0.0.1:8080`
- Worker route deployed with:

```bash
npx wrangler deploy --config cloudflare/wrangler.worker.toml
```

## Bugs and Fixes

- `curl: (6) Could not resolve host: archipelago-demo...`
  - Cause: Worker route existed, but no proxied DNS record existed for the public frontdoor hostname.
  - Fix: add `archipelago-demo` DNS as a proxied record.

- Cloudflare rejected adding an `AAAA` record because a CNAME with the same host already existed.
  - Cause: DNS records cannot share the same host with CNAME.
  - Fix: edit/delete the existing `archipelago-demo` CNAME and use a proxied `A` record instead.

- `dscacheutil` showed only IPv6 addresses while `curl` still could not resolve the host.
  - Cause: local resolver behavior was inconsistent during DNS propagation.
  - Fix: use a proxied `A` record for `archipelago-demo`, then flush DNS cache if needed.

- Public frontdoor returned `503`.
  - Cause: the Worker was reachable but could not reach the live tunnel yet.
  - Fix: confirm both `https://live-archipelago-demo...` and `http://127.0.0.1:8080/` return `200`.

- `live-archipelago-demo...` returned `200`, local `127.0.0.1:8080` returned `200`, then frontdoor returned `200`.
  - Cause: DNS, Worker, tunnel, and Spring Boot were all wired correctly.
  - Fix: no further action; open `https://archipelago-demo.zhengwangyuan-patrick.com/`.

## Final DNS Shape

```text
archipelago-demo              A       192.0.2.1          Proxied
live-archipelago-demo         Tunnel  archipelago-demo   Proxied
```

The `192.0.2.1` address is a placeholder. Because the record is proxied and a
Worker route exists, Cloudflare runs the Worker for the public frontdoor.

## Runtime Notes

- No Git push is required for DNS or Worker route behavior after local Wrangler deployment.
- Push is still needed afterward so GitHub matches what was deployed.
- Without Cloudflare Zero Trust, the demo is public while the local app and tunnel are running.
