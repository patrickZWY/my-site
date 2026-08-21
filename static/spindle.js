
(() => {
  const track = document.getElementById("track");
  const panels = [...track.querySelectorAll(".panel")];
  const disks = document.getElementById("disks");
  const readout = document.getElementById("readoutName");
  const hint = document.getElementById("hint");
  const spacerEnd = track.querySelector(".spacer-end");
  const ringStrip = document.getElementById("ringStrip");
  const ticks = document.getElementById("ticks");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  ticks.innerHTML = "<i></i>".repeat(420);

  /* --- the ring ---------------------------------------------------------
     Tumbles through random glyphs while the spindle is turning, then locks in
     left to right and spells out the settled section's own words. The line
     simply ends where the words run out. */
  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let cells = 0;
  let cellW = 12;
  let plain = "";
  let locked = 0;
  let resolving = false;
  let tumbleFrame = 0;
  let lastPaint = 0;
  let idleTimer = 0;

  function ringText(panel) {
    const parts = [];
    const heading = panel.querySelector("h1, h2");
    const lede = panel.querySelector("p.lede, p.body");
    if (heading) parts.push(heading.textContent);
    if (lede) parts.push(lede.textContent);
    return parts.join(" \u00b7 ").replace(/\s+/g, " ").trim().toUpperCase();
  }

  function paintRing() {
    let out = "";
    for (let i = 0; i < cells; i += 1) {
      if (i < locked) {
        if (i >= plain.length) break;
        out += plain[i];
      } else {
        out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
    }
    ringStrip.textContent = out;
  }

  function tumble(now) {
    if (now - lastPaint >= 45) {
      lastPaint = now;
      if (resolving) locked += Math.max(2, Math.ceil(cells / 15));
      paintRing();
      if (resolving && locked >= cells) {
        tumbleFrame = 0;
        ringStrip.style.transform = "translate3d(0,0,0)";
        return;
      }
    }
    tumbleFrame = requestAnimationFrame(tumble);
  }

  function stirRing() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(settleRing, 170);
    if (reduced) return;
    resolving = false;
    locked = 0;
    if (!tumbleFrame) tumbleFrame = requestAnimationFrame(tumble);
  }

  function settleRing() {
    if (reduced) {
      locked = cells;
      paintRing();
      ringStrip.style.transform = "translate3d(0,0,0)";
      return;
    }
    resolving = true;
    if (!tumbleFrame) tumbleFrame = requestAnimationFrame(tumble);
  }

  /* --- gauge ----------------------------------------------------------- */
  panels.forEach((panel, i) => {
    const button = document.createElement("button");
    button.className = "disk";
    button.type = "button";
    button.textContent = panel.dataset.code;
    button.setAttribute("aria-label", "Go to " + panel.dataset.name);
    button.addEventListener("click", () => goTo(i));
    disks.append(button);
  });
  const diskButtons = [...disks.children];

  /* --- geometry ---------------------------------------------------------
     Layout is measured once and cached. Reading offsetLeft inside the scroll
     loop forced a synchronous layout on every frame, and interleaving those
     reads with style writes thrashed layout six times per frame. */
  let indexPx = 0;
  let falloff = 400;
  const lefts = panels.map(() => 0);
  const state = panels.map(() => ({ lit: -1, inert: null, focus: null }));

  function measure() {
    indexPx = parseFloat(getComputedStyle(track).scrollPaddingLeft) || 0;
    falloff = Math.max(210, window.innerWidth * 0.21);
    panels.forEach((panel, i) => { lefts[i] = panel.offsetLeft; });
    state.forEach((entry) => { entry.lit = -1; entry.inert = null; entry.focus = null; });

    /* The tail spacer is exactly the room the last section needs to reach the
       reading position and not one pixel more, so the end of the roll is the
       last section rather than empty ground past it. The CSS guess was a flat
       4rem, which left ~220px of nothing scrollable beyond Contact. */
    const last = panels[panels.length - 1];
    spacerEnd.style.flexBasis =
      Math.max(0, track.clientWidth - indexPx - last.offsetWidth) + "px";

    /* one glyph cell, measured rather than guessed — letter-spacing is in em */
    ringStrip.textContent = "M".repeat(40);
    cellW = ringStrip.getBoundingClientRect().width / 40 || 12;
    cells = Math.ceil(ringStrip.parentElement.clientWidth / cellW) + 1;

    render();
    settleRing();
  }

  /* --- settling ---------------------------------------------------------
     Every input funnels through here: drag release, flick momentum, wheel,
     trackpad, disk buttons, keyboard. One easing curve, so a section always
     arrives the same way no matter how you asked for it. */
  let animFrame = 0;
  let animating = false;
  let settleTimer = 0;

  function cancelSettle() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = 0;
    animating = false;
  }

  function settleTo(index) {
    cancelSettle();
    const target = Math.max(0, Math.min(panels.length - 1, index));
    const limit = track.scrollWidth - track.clientWidth;
    const to = Math.max(0, Math.min(limit, lefts[target] - indexPx));
    const from = track.scrollLeft;
    const distance = to - from;

    if (reduced || Math.abs(distance) < 1) {
      track.scrollLeft = to;
      return;
    }

    const ms = Math.min(460, 180 + Math.abs(distance) * 0.42);
    const start = performance.now();
    animating = true;
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      track.scrollLeft = from + distance * eased;
      if (p < 1) {
        animFrame = requestAnimationFrame(step);
      } else {
        animFrame = 0;
        animating = false;
      }
    };
    animFrame = requestAnimationFrame(step);
  }

  /* Which section a release should land on.
     Settling to whichever section was simply nearest meant reversing out of a
     half-turned section needed a 50% swing, while the momentum that put you
     there needed far less — so a section you had entered but not settled held
     on to you. The commit point is asymmetric now: whichever way you are
     already travelling is the cheap way, 22% either direction. */
  function settleTarget() {
    const line = track.scrollLeft + indexPx;
    let i = 0;
    while (i + 1 < lefts.length && lefts[i + 1] <= line) i += 1;
    if (i + 1 >= lefts.length) return i;

    const span = lefts[i + 1] - lefts[i];
    if (span <= 0) return i;

    const progress = (line - lefts[i]) / span;
    return progress > (travel >= 0 ? 0.22 : 0.78) ? i + 1 : i;
  }

  function settleNearest() {
    if (dragging || animating) return;
    settleTo(settleTarget());
  }

  function goTo(i) { settleTo(i); }

  /* --- active disk + differential registers ---------------------------- */
  let current = -1;
  let ticking = false;
  let travel = 1;
  let prevScroll = 0;

  function render() {
    ticking = false;
    const x = track.scrollLeft;

    /* Two composited transform writes. Setting a custom property on the rig
       instead invalidated styles for every section and every node inside
       them, once per frame. */
    if (!reduced) {
      /* slide by one cell pair and wrap, so the ring never runs out of strip */
      const slide = -((x * 1.55) % (cellW * 2));
      ringStrip.style.transform = "translate3d(" + slide.toFixed(1) + "px,0,0)";
      ticks.style.transform = "translate3d(" + (-x * 0.42).toFixed(1) + "px,0,0)";
    }

    const line = x + indexPx;
    let nearest = 0;
    let best = Infinity;

    for (let i = 0; i < panels.length; i += 1) {
      const distance = Math.abs(lefts[i] - line);
      if (distance < best) { best = distance; nearest = i; }

      const t = Math.min(1, distance / falloff);
      /* cubic: the lit section holds its light, then drops off a cliff */
      const lit = 1 - t * t * t;
      const entry = state[i];

      /* Quantised to 1/40. Every --lit write recalculates the section and all
         its descendants because the colour mix depends on it, so a change too
         small to see is pure cost. */
      const step = Math.round(lit * 40) / 40;
      if (step !== entry.lit) {
        entry.lit = step;
        panels[i].style.setProperty("--lit", step);
      }

      /* a section this dark is invisible — don't leave its links hoverable.
         Keyboard focus is unaffected, so tabbing still reaches them. */
      const inert = step < 0.16;
      if (inert !== entry.inert) {
        entry.inert = inert;
        panels[i].style.pointerEvents = inert ? "none" : "";
      }

      const focus = step > 0.82;
      if (focus !== entry.focus) {
        entry.focus = focus;
        panels[i].dataset.focus = focus ? "1" : "0";
      }
    }

    if (nearest !== current) {
      current = nearest;
      diskButtons.forEach((b, i) => b.setAttribute("aria-current", String(i === nearest)));
      readout.textContent = panels[nearest].dataset.name;
      plain = ringText(panels[nearest]);
    }
  }

  track.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(render); }
    dismissHint();
    stirRing();
    /* Catches every source, including trackpad swipes we never intercept.
       Skipped while settling, so the settle's own scrolling neither reports a
       direction nor keeps rescheduling itself. */
    if (!animating) {
      const at = track.scrollLeft;
      if (Math.abs(at - prevScroll) > 0.5) travel = at > prevScroll ? 1 : -1;
      prevScroll = at;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settleNearest, 140);
    }
  }, { passive: true });

  /* --- wheel: vertical wheels drive the horizontal roll -----------------
     A mouse wheel arrives as large discrete notches. Applying each one
     directly stepped the track in visible jumps, so deltas accumulate into a
     target and the track eases toward it. Trackpad swipes carry deltaX and
     pass straight through to the browser's own inertia. */
  let wheelTarget = null;
  let wheelFrame = 0;

  function stepWheel() {
    if (wheelTarget === null) { wheelFrame = 0; return; }
    const gap = wheelTarget - track.scrollLeft;
    if (Math.abs(gap) < 0.5) {
      track.scrollLeft = wheelTarget;
      wheelTarget = null;
      wheelFrame = 0;
      /* No settle here — the idle timer handles it. Settling the instant one
         notch finished reset the next notch's starting point, so a mouse wheel
         could never accumulate enough travel to change section. */
      return;
    }
    track.scrollLeft += gap * 0.22;
    wheelFrame = requestAnimationFrame(stepWheel);
  }

  function cancelWheel() {
    if (wheelFrame) cancelAnimationFrame(wheelFrame);
    wheelFrame = 0;
    wheelTarget = null;
  }

  track.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    cancelSettle();
    const limit = track.scrollWidth - track.clientWidth;
    const from = wheelTarget === null ? track.scrollLeft : wheelTarget;
    wheelTarget = Math.max(0, Math.min(limit, from + event.deltaY));
    if (!wheelFrame) wheelFrame = requestAnimationFrame(stepWheel);
  }, { passive: false });

  /* --- drag-to-scroll with flick momentum ------------------------------- */
  let pointerId = null;
  let startX = 0;
  let startScroll = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;

  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    /* Touch gets the browser's own panning and inertia, which beat anything we
       would write; the idle settle still lands the section afterwards. */
    if (event.pointerType === "touch") return;
    if (event.target.closest("a, button")) return;
    cancelWheel();
    cancelSettle();
    pointerId = event.pointerId;
    /* Capture on press, not once the drag threshold is crossed. Capturing
       late meant a press that ended outside the track never delivered its
       pointerup here, so pointerId stayed set and every later settle bailed
       out — the track locked wherever it happened to be. */
    track.setPointerCapture(pointerId);
    startX = lastX = event.clientX;
    startScroll = track.scrollLeft;
    lastT = event.timeStamp;
    velocity = 0;
    dragging = false;
  });

  track.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    if (!dragging) {
      if (Math.abs(dx) < 6) return;
      dragging = true;
      track.classList.add("is-dragging");
      dismissHint();
    }
    const dt = event.timeStamp - lastT;
    if (dt > 0) velocity = (event.clientX - lastX) / dt;
    lastX = event.clientX;
    lastT = event.timeStamp;
    track.scrollLeft = startScroll - dx;
  });

  function endDrag(event) {
    if (event.pointerId !== pointerId) return;
    if (track.hasPointerCapture(pointerId)) track.releasePointerCapture(pointerId);
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    track.classList.remove("is-dragging");
    glide();
  }
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  /* last resort: never let a lost pointer strand the track */
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  function glide() {
    if (reduced || Math.abs(velocity) < 0.05) { settleNearest(); return; }
    let v = velocity * 16;
    const step = () => {
      const before = track.scrollLeft;
      v *= 0.93;
      track.scrollLeft -= v;
      /* stop dead at the ends — otherwise the loop kept running against a
         scrollLeft that could no longer move */
      if (Math.abs(v) > 0.6 && track.scrollLeft !== before) {
        requestAnimationFrame(step);
      } else {
        settleNearest();
      }
    };
    requestAnimationFrame(step);
  }

  /* --- keyboard --------------------------------------------------------- */
  track.addEventListener("keydown", (event) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key in keys) {
      event.preventDefault();
      goTo(current + keys[event.key]);
    } else if (event.key === "Home") {
      event.preventDefault(); goTo(0);
    } else if (event.key === "End") {
      event.preventDefault(); goTo(panels.length - 1);
    } else return;
    dismissHint();
  });

  /* tabbing into a panel brings it to the index line */
  panels.forEach((panel, i) => {
    panel.addEventListener("focusin", () => { if (i !== current) goTo(i); });
  });

  let hintOff = false;
  function dismissHint() {
    if (hintOff) return;
    hintOff = true;
    hint.dataset.off = "1";
  }

  /* --- brand returns to the start of the roll --------------------------- */
  document.getElementById("brand").addEventListener("click", () => goTo(0));


  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; measure(); });
  });

  /* section widths are in ch, so they shift once the real face loads */
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);

  measure();
})();
