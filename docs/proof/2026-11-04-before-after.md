# Before and after John's ship lists (AH-102), measured on what is live

John asked for proof that the AH-102 changes made Arcas better than the old version on the live website and in the
real tool. This page is that proof, measured on 2026-11-04 (AH-122). The picture beside it is the same numbers with
screenshots: `2026-11-04-before-after.png`.

## What was compared
- Old: main before the changes, e9b308f.
- New, the website: `site/` at 44edd72, which `pages.yml` published (run 41761244641, green). The cloud session can't
  reach github.io, so the published folder was served locally from that commit.
- New, the tool: the pane taken out of the Arcas.exe a user downloads today, release v0.1.270. Its SHA-256 (a870d6d5...)
  matches the release; 45 of its 46 pane files are byte for byte main's once Windows line endings are ignored (the 46th
  is version.txt, stamped at build), and its engine code holds `sealed.py` and `open_log`. The pane ran against the
  engine from the same commit.
- The same Playwright measurements on both, in Chromium on one machine. Speed runs took turns, old then new then old.

## Speed (a slow phone: CPU 4x slower, 150 ms latency, 1.6 Mbps)
| | Old | New |
|---|---|---|
| Website, first words on screen (median of 10, range) | 1048 ms (988 to 1084) | 1044 ms (940 to 1120) |
| Website, biggest block on screen | 2828 ms (2760 to 2944) | 2788 ms (2764 to 2900) |
| Website, layout shift | 0 | 0 |
| Website, bytes downloaded | 177.8 KB | 182.3 KB |
| Pane ready (median of 5) | 350 ms | 318 ms |
| Pane, scan of 300 rows | 487 ms | 490 ms |

Speed is the same: every difference is smaller than the spread between runs. The changes were not speed work; they
added 4.5 KB of style rules.

## Looks
| | Old | New |
|---|---|---|
| Page width at 200% text on a 320 px phone | 421, 587 and 357 px | 320 px on all three pages |
| Pane width when squeezed to 160 px | 194 px | 160 px |
| Smallest text on the home page | 10.9 px | 12 px |
| Headings that end with a period (site) | 6 | 0 |
| Negative letter-spacing rules | 7 site, 7 pane | 0 |
| High Contrast, Find problems button border | 0 px | 2 px solid |
| High Contrast, "worth a check" cells marked | no | yes, a dashed box |

## Ease of use
| | Old | New |
|---|---|---|
| Controls under 24 x 24 px | 20 site, 7 pane | 0 (one site link sits inside a sentence, which WCAG allows) |
| Error while a cell is being typed in | "Something went wrong: InvalidOperationInCellEditMode" | "Excel is busy editing a cell. Press Enter or Esc, then try again." |
| A clean sheet | the result plus an empty list, "Click a row" and Remove highlights | the result alone |
| Undo after the pane is closed and opened | gone | offered |
| Support form sent empty at 390 x 420 | focus stays on the button, no field marked, message off screen | first missing field focused, 3 fields marked, message on screen |
| Pressed-state styles in the pane | 1 | 6 |
| Sitemap, canonical and sharing tags | none | on all three pages |

The new version also carries Pod 1's logo texture (AH-103), merged after these changes.
