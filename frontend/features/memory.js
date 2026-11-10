import { MEMORY_KEY } from "../constants/index.js";

// Ask AI remembers the user (AH-143, John 2026-11-06): each fix Accept writes is kept on this PC, across workbooks, as
// its column's header, the kind of fix (the reason's part about that column), and the old and new value. Ask AI hands
// the engine up to OFFERED of them whose header is the flagged column's, newest first, and the engine ranks them and
// sends up to SENT to the AI (AH-153, ai/memory.py: the newest five held a fix of another step and pulled answers to
// it). Undo takes its fix back out; "Forget what the AI learned" removes them all. At most MAX_KEPT.
export const MAX_KEPT = 200, SENT = 5, OFFERED = 20;
const cut = (v, n) => { const t = String(v ?? "").split(/\s+/).filter(Boolean).join(" "); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const entry = (header, kind, old, nw) => ({ h: cut(header, 30), k: cut(kind, 60), o: cut(old, 30), n: cut(nw, 30) });
const same = (h) => String(h ?? "").replace(/\s+/g, "").toLowerCase(); // "Unit Price" is "unitprice"
const ok = (e) => !!e && typeof e === "object" && ["h", "k", "o", "n"].every((x) => typeof e[x] === "string" && e[x].length <= 60);
// localStorage can be off (private mode) or hold anything another page wrote: nothing kept, never a failed Accept
const kept = () => { try { const v = JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]"); return Array.isArray(v) ? v.filter(ok).slice(-MAX_KEPT) : []; } catch { return []; } };
const save = (list) => { try { localStorage.setItem(MEMORY_KEY, JSON.stringify(list.slice(-MAX_KEPT))); } catch { /* not kept */ } };

export function remember(header, kind, old, nw) {
  save([...kept(), entry(header, kind, old, nw)]);
}

// Undo: the newest entry of this column with these values goes (the kind is not compared: after a reload the pane no
// longer has the reason the fix was accepted for)
export function forget(header, old, nw) {
  const e = entry(header, "", old, nw), list = kept();
  const k = list.map((x) => x.h === e.h && x.o === e.o && x.n === e.n).lastIndexOf(true);
  if (k < 0) return;
  list.splice(k, 1);
  save(list);
}

export const recall = (header) => kept().filter((e) => same(e.h) === same(cut(header, 30))).reverse().slice(0, OFFERED)
  .map(({ h, k, o, n }) => ({ h, k, o, n })); // the four fields only: the engine refuses any other

export function clearAll() {
  try { localStorage.removeItem(MEMORY_KEY); } catch { /* nothing kept */ }
}
