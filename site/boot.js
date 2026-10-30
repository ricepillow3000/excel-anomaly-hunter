// Runs before the page paints (AH-72): marks it so the blocks that fly in on load wait hidden for motion.js instead of
// flashing at rest first. motion.js lifts the mark at once; the timer lifts it after 1.4 s whatever happens, so a
// script that fails to load never leaves the headline hidden. With reduced motion nothing is hidden at all.
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.setAttribute("data-ah", "enter");
  setTimeout(() => document.documentElement.removeAttribute("data-ah"), 1400);
}
