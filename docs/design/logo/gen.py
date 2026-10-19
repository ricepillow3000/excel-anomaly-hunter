"""The logo, drawn as code: one fluid colour field (blurred glows: navy base, red body, gold peak) clipped to the
mark at each size. python docs/design/logo/gen.py writes logo-80/32/16.svg; render them to PNG with Chromium (80 also
gives 64/48/256) and build packaging/AnomalyHunter.ico from 16/32/48/64/256. Office caches icons per URL: new art needs
new file names and a manifest Version bump (CLAUDE.md)."""
SHAPES = {  # the mark: 80-unit outlines measured from John's reference spear; 32 and 16 drawn on the pixel grid
 80: '''<path d="M40 4.5 C39.9 13 38.9 20.5 36.6 24.1 L38.4 25.3 H41.6 L43.4 24.1 C41.1 20.5 40.1 13 40 4.5 Z"/>
  <path d="M40 26.9 C38 25.9 35 25.6 33.2 26.6 C31.7 27.4 31.4 29.8 32.5 32.3 C32.6 30.6 33.1 29.5 34.1 29.1 C36 28.5 38.3 28.9 40 29.5 C41.7 28.9 44 28.5 45.9 29.1 C46.9 29.5 47.4 30.6 47.5 32.3 C48.6 29.8 48.3 27.4 46.8 26.6 C45 25.6 42 25.9 40 26.9 Z"/>
  <rect x="38.4" y="25" width="3.2" height="1.9"/><rect x="38.5" y="25" width="3" height="19"/>
  <rect x="37.4" y="35.6" width="5.2" height="4.4" rx=".9"/>
  <rect x="17" y="43" width="46" height="4" rx="2"/><rect x="12" y="42.5" width="6.5" height="5" rx="1.2"/><rect x="61.5" y="42.5" width="6.5" height="5" rx="1.2"/>
  <rect x="37.8" y="42.8" width="4.4" height="4.4" rx="1"/>
  <path d="M18.9 45.4 H61.1 V71.9 L40 75.6 L18.9 71.9 Z"/>''',
 32: '''<path d="M16 2 L17.2 8.2 L16 10 L14.8 8.2 Z"/><rect x="15" y="9" width="2" height="8"/>
  <path d="M10.9 13.8 C10.9 10.6 13.8 9.5 16 10.8 C18.2 9.5 21.1 10.6 21.1 13.8 H19.7 C19.7 12 18 11.5 16 12.6 C14 11.5 12.3 12 12.3 13.8 Z"/>
  <rect x="7" y="18" width="18" height="12"/><rect x="5" y="16" width="22" height="2"/><rect x="3" y="15" width="3" height="4"/><rect x="26" y="15" width="3" height="4"/>''',
 16: '''<rect x="7" y="0" width="2" height="6"/><rect x="5" y="4" width="6" height="1"/><rect x="1" y="5" width="14" height="2"/><rect x="2" y="6" width="12" height="9"/>''',
}
EMBLEM = {
 80: '''<path d="M30.4 63.4 H40 L36 69 H26.4 Z M49.6 63.4 H40 L44 69 H53.6 Z"/>
  <circle cx="40" cy="58.7" r="2.7" fill="none" stroke="currentColor" stroke-width="1.15"/><path d="M35.75 62.05 L44.25 55.35" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/>''',
 32: '''<g shape-rendering="crispEdges"><rect x="14" y="20" width="4" height="1"/><rect x="14" y="25" width="4" height="1"/><rect x="13" y="21" width="1" height="4"/><rect x="18" y="21" width="1" height="4"/>
  <rect x="19" y="19" width="1" height="1"/><rect x="18" y="20" width="1" height="1"/><rect x="17" y="21" width="1" height="1"/><rect x="16" y="22" width="1" height="1"/><rect x="15" y="23" width="1" height="1"/><rect x="14" y="24" width="1" height="1"/><rect x="13" y="25" width="1" height="1"/><rect x="12" y="26" width="1" height="1"/></g>''',
 16: '''<g shape-rendering="crispEdges"><rect x="7" y="8" width="3" height="1"/><rect x="7" y="12" width="3" height="1"/><rect x="6" y="9" width="1" height="3"/><rect x="10" y="9" width="1" height="3"/>
  <rect x="11" y="7" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/></g>''',
}
SHEEN = '''<g fill="none" stroke="#fff3d8" stroke-linecap="round">
    <path d="M19.5 46.8 Q40 57 60.5 46.8" stroke-width=".7" opacity=".42"/><path d="M22 47.3 Q40 54 58 47.3M25 47.1 Q40 51.4 55 47.1" stroke-width=".45" opacity=".26"/>
    <path d="M40 7 V24" stroke-width=".5" opacity=".38"/><path d="M19 44.2 H61" stroke-width=".7" opacity=".3"/>
    <path d="M14.4 42.9v4.2M16.4 42.9v4.2M63.6 42.9v4.2M65.6 42.9v4.2M37.4 37.1h5.2M37.4 38.5h5.2" stroke-width=".4" opacity=".3"/></g>'''
# the field, in 80 units: (cx, cy, rx, ry, colour, opacity) blobs over a deep navy base, then blurred together
FIELD = [(40, 34, 40, 40, "#13265a", 1), (26, 72, 20, 12, "#2b1f5e", .9),
         (40, 47, 34, 9, "#c4313f", .95), (30, 56, 12, 8, "#a32641", .7), (40, 33, 10, 12, "#e06a3a", .95),
         (40, 13, 7, 16, "#f6c25a", 1), (40, 4, 4, 6, "#fff0c2", .9), (47, 59, 9, 7, "#f0b84e", .5)]
def svg(size, out_px=600, glow=True):
    k = size / 80
    blobs = "".join(f'<ellipse cx="{cx*k:.2f}" cy="{cy*k:.2f}" rx="{rx*k:.2f}" ry="{ry*k:.2f}" fill="{c}" opacity="{o}"/>' for cx, cy, rx, ry, c, o in FIELD)
    blur, pad = 4.6 * k, (.97 if size == 80 else 1)
    em_glow = f'<g filter="url(#eg)" fill="#ffd27a" color="#ffd27a" opacity=".85">{EMBLEM[size]}</g>' if glow and size == 80 else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{out_px}" height="{out_px}">
  <defs>
    <clipPath id="m">{SHAPES[size]}</clipPath>
    <filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{blur:.2f}"/></filter>
    <filter id="eg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{1.4*k:.2f}"/></filter>
  </defs>
  <g transform="translate({size/2} {size/2}) scale({pad}) translate({-size/2} {-size/2})">
    <g clip-path="url(#m)"><rect width="{size}" height="{size}" fill="#10224f"/><g filter="url(#f)">{blobs}</g></g>
    {em_glow}{SHEEN if size == 80 else ""}<g fill="#fff6e2" color="#fff6e2">{EMBLEM[size]}</g>
  </g>
</svg>'''
for s in (80, 32, 16):
    open(f"logo-{s}.svg", "w").write(svg(s))
