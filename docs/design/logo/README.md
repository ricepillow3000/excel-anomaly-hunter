# The Spear & Banner mark

Flat and matte, like the rest of the brand: Dark Gold spear and crossbar, a Crown Navy banner, the emblem in bone.
John's spear is measured from his reference image; the emblem is his sketch (two panels touching at their inner top
corners, a slashed ring above).

- `mark-80.svg`: the master, rendered at 80 and 64 px (and 48 and 256 for the exe icon).
- `mark-32.svg`, `mark-16.svg`: redrawn on the pixel grid, never scaled down from the master.
- Render each SVG with Chromium (transparent background) to `frontend/assets/mark-<size>.png`, and build
  `packaging/AnomalyHunter.ico` from the 16, 32, 48, 64 and 256 px renders.
- Office caches ribbon icons per URL: new art gets new file names and a `<Version>` bump in `frontend/manifest.xml`.

Palette: Crown Navy #0C1938, Dark Gold #9C7A35 (light face #B8954A, edge #5E4719), bone #F4F1EA.
