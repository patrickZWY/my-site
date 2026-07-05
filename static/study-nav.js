(() => {
  const layout = document.querySelector(".private-study-layout");
  if (!layout) return;

  const fill = layout.querySelector(".private-rail-progress-fill");
  const links = [...layout.querySelectorAll("[data-private-nav]")];
  const sections = links
    .map((link) => {
      const id = decodeURIComponent(link.hash.slice(1));
      const target = document.getElementById(id);
      const section = target?.closest("[data-private-section]") || target;
      return section ? { link, section } : null;
    })
    .filter(Boolean);

  if (!fill || sections.length === 0) return;

  let ticking = false;

  const setActive = (activeLink) => {
    for (const link of links) {
      const isActive = link === activeLink;
      link.classList.toggle("is-active", isActive);
      if (isActive) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };

  const update = () => {
    ticking = false;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const pageTop = window.scrollY + layout.getBoundingClientRect().top;
    const pageBottom = pageTop + layout.scrollHeight - viewportHeight;
    const progress = pageBottom <= pageTop ? 1 : (window.scrollY - pageTop) / (pageBottom - pageTop);
    fill.style.setProperty("--private-scroll-progress", Math.min(1, Math.max(0, progress)));

    const activationLine = viewportHeight * 0.34;
    let active = sections[0];

    for (const item of sections) {
      if (item.section.getBoundingClientRect().top <= activationLine) {
        active = item;
      } else {
        break;
      }
    }

    setActive(active.link);
  };

  const requestUpdate = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  update();
})();
