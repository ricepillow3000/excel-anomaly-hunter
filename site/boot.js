// Runs before the page paints. data-js stays for the whole visit: styles.css hides the content that rises into view
// (.reveal-item) only under it, so with no JavaScript nothing is ever hidden, and items never show and then vanish
// when the scripts arrive (AH-83). data-ah="enter" holds the hero's blocks for their entrance (AH-72): motion.js
// lifts it at once, this timer after 1.4 s whatever happens. If motion.js never ran (blocked, failed to load, threw
// before it was ready), load takes data-js off again and every item shows. With reduced motion nothing is hidden.
(() => {
  const html = document.documentElement;
  html.setAttribute("data-js", "");
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    html.setAttribute("data-ah", "enter");
    setTimeout(() => html.removeAttribute("data-ah"), 1400);
  }
  addEventListener("load", () => { if (!window.AH) html.removeAttribute("data-js"); });
  // "Skip to content" puts focus on the page's content, not only the scroll: a <main> can't take focus, so following its
  // #page link left the next Tab on the header's links again. #page is whichever page is shown, after a page transition
  // too (transition.js gives the new page that id); the link stays in place across transitions, outside <main>
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a.skip-link"), main = a && document.getElementById("page");
    if (!main) return;
    e.preventDefault();
    main.tabIndex = -1;
    main.focus();
  });
})();
