/* START: a small Forth that is the only way around this site.
   Integer data stack, colon definitions, ( comments ), and GO, which
   pops the top of the stack and goes to the page at that address.
   The session (stack, user words, transcript) persists across pages. */
(() => {
  const panel = document.getElementById("forth");
  const toggles = [...document.querySelectorAll("[data-forth-toggle]")];
  if (!panel || !toggles.length) return;

  const ADDR = [
    { n: 0, path: "/rabbithole/?gate=1", name: "?", hidden: true },
    { n: 1, path: "/about/", name: "About" },
    { n: 2, path: "/projects/", name: "Projects" },
    { n: 3, path: "/writing/", name: "Writing" },
    { n: 4, path: "/dependent-type-theory-reading-group/", name: "Reading group" },
    { n: 5, path: "/fun/", name: "Fun" },
    { n: 6, path: "/contact/", name: "Contact" },
    { n: 7, path: "/projects/tla-finance/", name: "TLA-Finance" },
    { n: 8, path: "/projects/price-manipulation/", name: "Price manipulation" },
    { n: 9, path: "/projects/sps-verispec/", name: "SPS-VeriSpec" },
  ];
  const STORE = "forth-session-v1";

  // ---------- session ----------
  let stack = [];
  let userWords = {};
  let log = [];
  const load = () => {
    try {
      const raw = sessionStorage.getItem(STORE);
      if (!raw) return false;
      const s = JSON.parse(raw);
      stack = Array.isArray(s.stack) ? s.stack.map((v) => v | 0) : [];
      userWords = s.userWords && typeof s.userWords === "object" ? s.userWords : {};
      log = Array.isArray(s.log) ? s.log : [];
      return true;
    } catch (_e) { return false; }
  };
  const save = () => {
    try { sessionStorage.setItem(STORE, JSON.stringify({ stack, userWords, log: log.slice(-40) })); } catch (_e) { /* private mode */ }
  };

  // ---------- the machine ----------
  const need = (n, w) => { if (stack.length < n) throw new Error("stack underflow in " + w); };
  const pop = () => stack.pop();
  const push = (v) => stack.push(v | 0);
  const PRIM = {
    "+": () => { need(2, "+"); const b = pop(), a = pop(); push(a + b); },
    "-": () => { need(2, "-"); const b = pop(), a = pop(); push(a - b); },
    "*": () => { need(2, "*"); const b = pop(), a = pop(); push(a * b); },
    "/": () => { need(2, "/"); const b = pop(), a = pop(); if (b === 0) throw new Error("division by zero"); push(Math.trunc(a / b)); },
    MOD: () => { need(2, "MOD"); const b = pop(), a = pop(); if (b === 0) throw new Error("division by zero"); push(a % b); },
    NEGATE: () => { need(1, "NEGATE"); push(-pop()); },
    ABS: () => { need(1, "ABS"); push(Math.abs(pop())); },
    "1+": () => { need(1, "1+"); push(pop() + 1); },
    "1-": () => { need(1, "1-"); push(pop() - 1); },
    "2*": () => { need(1, "2*"); push(pop() * 2); },
    MIN: () => { need(2, "MIN"); push(Math.min(pop(), pop())); },
    MAX: () => { need(2, "MAX"); push(Math.max(pop(), pop())); },
    DUP: () => { need(1, "DUP"); const a = pop(); push(a); push(a); },
    DROP: () => { need(1, "DROP"); pop(); },
    SWAP: () => { need(2, "SWAP"); const b = pop(), a = pop(); push(b); push(a); },
    OVER: () => { need(2, "OVER"); const b = pop(), a = pop(); push(a); push(b); push(a); },
    ROT: () => { need(3, "ROT"); const c = pop(), b = pop(), a = pop(); push(b); push(c); push(a); },
    NIP: () => { need(2, "NIP"); const b = pop(); pop(); push(b); },
    TUCK: () => { need(2, "TUCK"); const b = pop(), a = pop(); push(b); push(a); push(b); },
    DEPTH: () => { push(stack.length); },
    "=": () => { need(2, "="); push(pop() === pop() ? -1 : 0); },
    "<": () => { need(2, "<"); const b = pop(), a = pop(); push(a < b ? -1 : 0); },
    ">": () => { need(2, ">"); const b = pop(), a = pop(); push(a > b ? -1 : 0); },
    AND: () => { need(2, "AND"); push(pop() & pop()); },
    OR: () => { need(2, "OR"); push(pop() | pop()); },
    XOR: () => { need(2, "XOR"); push(pop() ^ pop()); },
    ABORT: () => { stack = []; },
  };

  function run(line) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    const out = [];
    let go = null;
    let depth = 0;
    const exec = (toks) => {
      if (++depth > 64) throw new Error("nesting too deep");
      for (let j = 0; j < toks.length; j++) {
        const w = toks[j].toUpperCase();
        if (w === "(") { while (j < toks.length && toks[j] !== ")") j++; continue; }
        if (/^-?\d+$/.test(w)) { push(parseInt(w, 10)); continue; }
        if (w === ".") { need(1, "."); out.push(String(pop())); continue; }
        if (w === ".S") { out.push("<" + stack.length + "> " + stack.join(" ")); continue; }
        if (w === "GO") { need(1, "GO"); go = pop(); continue; }
        if (w === ":") {
          const name = (toks[++j] || "").toUpperCase();
          if (!name) throw new Error(": needs a name");
          const body = [];
          j++;
          while (j < toks.length && toks[j] !== ";") body.push(toks[j++]);
          if (toks[j] !== ";") throw new Error("definition of " + name + " has no ;");
          userWords[name] = body;
          out.push(name + " defined");
          continue;
        }
        if (userWords[w]) { exec(userWords[w]); continue; }
        if (PRIM[w]) { PRIM[w](); continue; }
        throw new Error(w + " ?");
      }
      depth--;
    };
    try { exec(tokens); } catch (e) { return { out: out.concat([e.message]), ok: false, go: null }; }
    return { out, ok: true, go };
  }

  // ---------- the panel ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const term = $("forth-term"), form = $("forth-form"), input = $("forth-input");
  const stackEl = $("forth-stack"), outEl = $("forth-out"), wiring = $("forth-wiring"), status = $("forth-status");
  const here = location.pathname.replace(/index\.html$/, "");

  const drawTerm = () => {
    term.innerHTML = log.slice(-12).map((l) => `<div><span class="in">&gt; ${esc(l.in)}</span>  ${esc(l.out)}</div>`).join("");
    term.scrollTop = term.scrollHeight;
  };
  const drawStack = () => {
    stackEl.innerHTML = stack.length
      ? stack.slice().reverse().map((v, i) => `<div class="cell ${i === 0 ? "tos" : ""}"><span>${v}</span><span class="lbl">${i === 0 ? "TOS" : "-" + i}</span></div>`).join("")
      : `<div class="empty lbl">&lt;0&gt; empty</div>`;
  };
  const drawWiring = () => {
    wiring.innerHTML = ADDR.filter((a) => !a.hidden).map((a) =>
      `<div class="${a.path === here ? "cur" : ""}"><b>${a.n}</b><span>${a.name}</span></div>`).join("");
    status.textContent = "";
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const line = input.value;
    if (!line.trim()) return;
    const r = run(line);
    log.push({ in: line, out: r.out.join(" ") + (r.ok ? "  ok" : "") });
    input.value = "";
    save();
    drawTerm(); drawStack();
    if (r.go !== null) {
      const a = ADDR.find((x) => x.n === r.go);
      if (a) {
        outEl.innerHTML = `<span class="lbl">GO</span><br><span class="verdict">${a.n} · ${a.hidden ? "?" : a.name}</span>`;
        setTimeout(() => { location.href = a.path; }, 500);
      } else {
        outEl.innerHTML = `<span class="lbl">GO ${r.go}</span><br><span class="lbl">no address ${r.go}</span>`;
      }
    } else {
      outEl.innerHTML = `<span class="lbl">${r.ok ? "ok" : "error"}</span>`;
    }
  });

  const setOpen = (open) => {
    panel.hidden = !open;
    document.body.classList.toggle("forth-open", open);
    toggles.forEach((t) => t.setAttribute("aria-expanded", open ? "true" : "false"));
    if (open) input.focus();
  };
  toggles.forEach((t) => t.addEventListener("click", () => setOpen(panel.hidden)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) setOpen(false); });

  // First visit: the transcript shows a worked example instead of an explanation.
  if (!load()) {
    for (const l of ["2 3 +", "1 - .S"]) {
      const r = run(l);
      log.push({ in: l, out: r.out.join(" ") + "  ok" });
    }
    save();
  }
  drawTerm(); drawStack(); drawWiring();
})();
