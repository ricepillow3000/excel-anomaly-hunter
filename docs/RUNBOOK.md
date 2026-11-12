# Rollback and backup runbook

How John takes each piece back to a version that worked, and what to keep a copy of. John is the only admin: every
step below goes through his GitHub or Cloudflare account, never through anything inside the app (AH-107).

## The app (Arcas.exe)

Every release stays on the GitHub Releases page. The download link on the website and in the README is
`.../releases/latest/download/Arcas.exe`, so it gives whichever release is marked latest.

1. Mark the last good release latest: `gh release edit v0.1.N --latest`, or open it on the Releases page, tick
   "Set as the latest release" and save. From then on the download link gives that file.
2. Revert the bad commit on main. The next build of main publishes a new release and marks it latest again, so a
   rollback by step 1 alone lasts only until the next push to main.
3. Users who already installed the bad version download the file again and double-click it. Installing an older exe
   over a newer one works: it stops the running engine, replaces the file and starts its own.

Only a release from v0.1.263 on can be marked latest. Releases before it (AH-101, the rename) carry only
`AnomalyHunter.exe`, so with one of them marked latest the website's and the README's `Arcas.exe` link finds no file.

Going back across the rename has a catch on the user's PC. A release before v0.1.263 stops only `AnomalyHunter.exe`
when it installs, never `Arcas.exe`. The newer `Arcas.exe` engine keeps port 5055, the old install finds an engine
answering and says it is installed, and the pane goes on talking to the newer engine. The old engine takes over only
after the user signs out of Windows and back in (its startup entry now points at `AnomalyHunter.exe`), or after they
end `Arcas.exe` in Task Manager and double-click the old file again.

Going back past the release that seals the AI key (AH-104) costs the user their key. An older version reads the sealed
`gemini-key.txt` or `invite-code.txt` as if it were the key itself, so Ask AI fails until they paste the key or invite
code again (or run their invite kit again).

## The relay (Cloudflare Worker)

From `relay/`, run `npx wrangler@4.151.1 rollback` and pick the last good version (`npx wrangler@4.151.1 deployments
list` shows them). Use the wrangler version pinned in `relay/wrangler.toml`, never a bare `npx wrangler`. A rollback
can bring back the secrets that version had, so check that the invite list and the Gemini key are the current ones
afterwards; if not, upload them again with `secret put` as `relay/wrangler.toml` says. Then run the Relay live
probe workflow on the Actions tab (`relay-live.yml`): it checks that strangers are still refused, that a real call with
no invite still works through the public tier and, with the canary invite set, that one with the invite does too.

## The website (GitHub Pages)

Either revert the bad commit on main (the Website workflow publishes again once its check passes), or open the
Website workflow's last good run on the Actions tab and click Re-run all jobs. A re-run publishes that run's own
commit. GitHub lets a run be re-run for 30 days.

## The Office manifest

Office caches the add-in by the manifest's `<Version>`. A manifest taken back to older content must still get a
higher `<Version>` than the bad one, and new icon file names if the icons changed, or Excel keeps what it cached.

## What to back up

- `relay/tokens.json` exists only on John's PC. It is gitignored, and the `TOKENS` secret it was uploaded to can't be
  read back from Cloudflare. Keep a copy in a second private place (it holds hashes and names, never the invite codes
  themselves). Without it, the next `secret put TOKENS` switches off every invite missing from the new list, so every
  invite would have to be issued again.
- The Gemini key lives in John's Google account (aistudio.google.com) and can be made again there; the relay only
  holds a copy.
- The local certificate authority's key is never kept, by design: nothing can sign another certificate with it. A
  user whose chain breaks runs the installer again and it makes a new one.
- Users' own cells: every change the pane writes has Undo. Their files stay theirs to back up.

## Restoring the invite list

Restore rehearsed (automated), 2026-11-04 (AH-124): `relay/restore-test.mjs` runs with `node relay/test.mjs` on
every push, in `tools/check.py` and in CI's security job. It writes a `tokens.json` with two invites the way
`relay/new-invite.mjs` does, copies it to a second folder, deletes the original, restores it from the copy, loads it
the way the relay loads the `TOKENS` secret, and checks that both invites still work and the daily caps still count.
It also checks the danger the backup guards against: a fresh list made without it switches every old invite off.

What the rehearsal can't do is talk to Cloudflare. When John restores for real:

1. Copy `tokens.json` from the second private place back to `relay/tokens.json` on the PC that makes invites.
2. Open it and check that every person who should have AI help has a line (a hash and their name).
3. From `relay/`, upload the whole list: `type tokens.json | npx wrangler@4.151.1 secret put TOKENS`. The upload
   replaces the old list at once, with no deploy.
4. Run the Relay live probe workflow on the Actions tab. With the canary invite in the list, its real call proves the
   restored list is live.
5. Ask one invited person to try Ask AI. If an invite still says it isn't valid, that person's line is missing:
   make them a new kit with `node relay/new-invite.mjs "Name"` and upload the list again.

Do the real restore once a year, or after any change to how invites are made, on a day the shared AI is quiet. Write
the date here: Restore rehearsed against Cloudflare: not yet.
