// The website's visit counter (AH-126, John 2026-11-04: GoatCounter's kind, no cookies and so no banner). Our own few
// lines, never GoatCounter's script: one image request per page view, its only field the page's path, sent with no
// referrer, title or screen size. COUNTER is the code John chose when he signed up at goatcounter.com; while it is empty
// this file does nothing at all (docs/security-and-launch-checklist.md has his three steps). It also stays silent on a
// PC's own copy of the site, under Do Not Track and under Global Privacy Control. The CSP allows the pixel as an image
// only (img-src names its hosts, nothing else does); the pane and the engine never load this file. A page reached by a page
// transition (transition.js, "ah:page") is a page view too.
(() => {
  const COUNTER = "ricepillow3000";
  const n = navigator;
  // a code is letters, digits and hyphens, the shape of a host name's first part: anything else would aim elsewhere
  if (!/^[a-z0-9-]{1,63}$/.test(COUNTER) || location.protocol === "file:" || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname)) return;
  if (n.doNotTrack === "1" || n.globalPrivacyControl) return;
  const count = () => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = "https://" + COUNTER + ".goatcounter.com/count?p=" + encodeURIComponent(location.pathname);
  };
  count();
  document.addEventListener("ah:page", count);
})();
