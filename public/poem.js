(() => {
  const poem = document.querySelector(".rolling-poem");
  const pauseButton = document.querySelector("[data-poem-pause]");
  const restartButton = document.querySelector("[data-poem-restart]");

  if (!poem || !pauseButton || !restartButton) return;

  pauseButton.addEventListener("click", () => {
    const paused = poem.classList.toggle("is-paused");
    pauseButton.textContent = paused ? "Continue" : "Pause";
    pauseButton.setAttribute("aria-pressed", String(paused));
  });

  restartButton.addEventListener("click", () => {
    poem.classList.remove("is-paused");
    pauseButton.textContent = "Pause";
    pauseButton.setAttribute("aria-pressed", "false");
    poem.style.animation = "none";
    void poem.offsetWidth;
    poem.style.animation = "";
  });
})();
