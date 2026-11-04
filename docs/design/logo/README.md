# The Spear & Banner mark

Flat, like the page it sits on: solid fills in the site's own colors, square ends, no shading and no outline.
John's spear is measured from his reference image; the emblem is his sketch (two panels touching at their inner top
corners, a slashed ring above).

Why (AH-103): the header showed a blocky pixel-grid redraw and the large logo had dark brown outlines, rounded ends and
a lit and a shaded face of gold, so the mark looked out of place on a flat, square-cornered, hairline page. John kept
the design and changed only its texture ("B: flat + thin lines").

Why one drawing per size (AH-121): a blind judge compared the AH-103 mark with the old one and the new one lost 5 of 9
points. At 1x the header was soft and its emblem a white blob (a ring stroke under one pixel, the panels crowding it, the
shaft between pixels, the bar and the drape one gold shape); the 16 px icon was a smudge and the 32 px mush; the large
logo had lost the old one's detail and its 55% navy hairlines read as grey on gold. It won on high-DPI crispness, on
fitting the page and on header and large logo being one drawing, so the shapes, the palette and the flat texture stay.
Each drawing is now made for the pixels it lands on: every straight edge on a whole pixel at its size. A second blind
round still lost the 16 and 32 px icons (a smooth ring and V hem rasterised to grey at those sizes) and the large logo's
character, so the 16 and 32 px icons are placed pixel by pixel (`shape-rendering="crispEdges"`, whole-pixel rects, every
pixel gold, navy, paper or empty) and the large drawing gained flat details.

| Drawing | Grid | Used for | What it keeps |
|---|---|---|---|
| `mark-80.svg` | 80, 1 unit = 1 px | the download's logo (240 and 320 px, so 3 and 4 px a unit), `crest2-80.png` (ribbon 80), the exe's 256 | everything, with solid navy details one unit wide: the blade's midrib (one navy wedge on the axis, tapering to the point), a band where the blade meets the pole, each wing's inner curl, the collar's two bands, each end cap's two bands, the X lashing the bar to the pole, a line between the bar and the drape, the drape's two folds. Pole 4, collar and lashing 6 wide on one centre, so no seam |
| `mark-64.svg` | 64 | `crest2-64.png`: the pane's logo at 2x, the manifest's high resolution icon, the 64 px favicon, the exe's 64 | the large drawing redrawn on its own grid (never 80 scaled by .8, which put every edge between pixels), a tip 2 px wide from its first row, and only the details that stay clean at 64: the blade band, the wings' curls, the collar's bands and the line between the bar and the drape (end-cap bands, drape folds, midrib and lashing read as noise there) |
| `mark-40.svg` | 32 x 40, 1 unit = 1 CSS px | the site header (inline, 40 px tall, `aspect-ratio: 32 / 40`), the exe's 48 (drawn 1:1, centred) | a tip never under 2 px wide below its first row (a needle point faded to a gradient at 1x), shaft 2, rim 1, a 1 px gap between the bar and the drape (a navy strip there read as a stray rule), a ring of 1.5 px stroke with 2 px clear above the panels, the emblem as big as the banner allows; sharp at 1x, smooth at 2x and 3x |
| `mark-32.svg` | 32 | `crest2-32.png`: favicon, ribbon 32, the pane's logo at 1x, the exe's 32 | placed pixel by pixel: tip and shaft 2 px solid, curled wings, collar, a navy row between the bar and the drape, the hem a stepped V, and the emblem as the slashed ring alone: a 2 px ring whose hole a 1 px diagonal slash splits into two navy corners (the panels were a smear at this size) |
| `mark-16.svg` | 16 | `crest2-16.png`: favicon, ribbon 16, the exe's 16 | placed pixel by pixel: a 1 px tip and shaft with a small crossguard, the bar and caps, the banner and rim with the hem one step, and a 1 px ring with a 1 px diagonal slash poking past it (a 2 px ring buried the slash and read as a white square); centred on column 7 |

- Render with Chromium at 1x on a transparent background, each file at its own size (the 16 and 32 px PNGs must hold only
  the three palette colours and fully transparent pixels): `mark-16.svg` at 16 to
  `frontend/assets/crest2-16.png`, `mark-32.svg` at 32 to `crest2-32.png`, `mark-64.svg` at 64 to `crest2-64.png`,
  `mark-80.svg` at 80 to `crest2-80.png`; copy `crest2-32.png` and `crest2-64.png` to `site/assets/` for the favicons.
  `packaging/AnomalyHunter.ico` holds PNG entries, each from its own drawing: 16, 32, 48 (`mark-40.svg` at 32 x 40 in the
  middle of a 48 square), 64 and 256 (`mark-80.svg` at 256).
- The site's inline copies are these files without comments: `mark-40.svg` in the header of every page, `mark-80.svg`
  above the Download button. Their `data-part` groups are what `tools/test_site.mjs` reads; a navy detail is a stroke
  with no fill, so each part still fills in one color; the midrib, a filled navy wedge, is its own `data-part="midrib"`.
- Office caches ribbon icons per URL: new art gets new file names and a `<Version>` bump in `frontend/manifest.xml`
  (`crest2-*.png` and 1.0.8.0 for this one).

Palette (the tokens in `site/styles.css`): gold #997D3A for the spear, pole, bar, caps, drape and the banner's rim;
navy #0C1938 for the banner and the details; paper #F7F5F0 for the emblem.
