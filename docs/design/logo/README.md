# The Spear & Banner mark

Flat, like the page it sits on: solid fills in the site's own colors, square ends, no shading and no outline.
John's spear is measured from his reference image; the emblem is his sketch (two panels touching at their inner top
corners, a slashed ring above).

Why (AH-103): the header showed a blocky pixel-grid redraw and the large logo had dark brown outlines, rounded ends and
a lit and a shaded face of gold, so the mark looked out of place on a flat, square-cornered, hairline page. John kept
the design and changed only its texture ("B: flat + thin lines").

- `mark-80.svg`: the large drawing, for anything shown over 48 px (the download's logo, the exe's 256 px icon). Its
  details are navy hairlines (stroke .5, opacity .55): the collar's two rings, the end caps' grooves, the drape's two
  folds.
- `mark-32.svg`, `mark-16.svg`: the small drawing, for 48 px and under (icons, favicons, the site and pane headers). The
  same shapes with no hairlines, a bolder banner rim (2) and emblem (1.8) so they read, framed tight to fill the box
  (square here; the site header frames it to the drawing, 40 px tall). Smooth vector, never a pixel grid or crisp edges.
- Render with Chromium (transparent background): `mark-16.svg` to `frontend/assets/crest-16.png`, `mark-32.svg` to
  `crest-32.png`, `crest-64.png`, `crest-80.png` (and `site/assets/crest-32.png`, `crest-64.png` for the favicons), and
  build `packaging/AnomalyHunter.ico` from PNG entries: the small drawing at 16, 32, 48 and 64 px, the large at 256.
- Office caches ribbon icons per URL: new art gets new file names and a `<Version>` bump in `frontend/manifest.xml`
  (`crest-*.png` and 1.0.7.0 for this one).

Palette (the tokens in `site/styles.css`): gold #997D3A for the spear, pole, bar, caps, drape and the banner's rim;
navy #0C1938 for the banner and the hairlines; paper #F7F5F0 for the emblem.
