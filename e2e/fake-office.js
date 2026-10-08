// In-memory stand-in for Office.js/Excel: enough of the API surface the panel uses.
(() => {
  const L = (c) => { let s = ""; c++; while (c) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; };
  const parse = (a) => { const m = /^(?:.*!)?\$?([A-Z]+)\$?(\d+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [Number(m[2]) - 1, c - 1]; };
  const sheets = {}; let active = "Sheet1"; const log = [];
  function makeSheet(name) {
    const cells = {}; const ws = { name, cells, changed: [], selected: [] };
    const cell = (r, c) => (cells[r + "," + c] ||= { v: "", f: null, nf: "General", fill: null });
    const range = (r0, c0, nr, nc) => {
      window.__ranges = (window.__ranges || 0) + 1; // Excel objects made: highlights must only touch flagged rows
      const grid = (fn) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(cell(r0 + i, c0 + j))));
      const set = (vals, asFormula) => vals.forEach((row, i) => row.forEach((v, j) => {
        const k = cell(r0 + i, c0 + j);
        if (asFormula && typeof v === "string" && v.startsWith("=")) { k.f = v; k.v = v; }
        else { k.f = null; k.v = typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : v; }
        log.push(["write", name, L(c0 + j) + (r0 + i + 1), v]);
        ws.changed.forEach((h) => h({}));
      }));
      return {
        isNullObject: false, rowIndex: r0, columnIndex: c0, rowCount: nr, columnCount: nc,
        load() { return this; }, select() { ws.selected.forEach((h) => h({ address: L(c0) + (r0 + 1) + ":" + L(c0 + nc - 1) + (r0 + nr) })); },
        get values() { return grid((k) => k.v); }, set values(v) { set(v, false); },
        get formulas() { return grid((k) => k.f ?? k.v); }, set formulas(v) { set(v, true); },
        getCellProperties() { return { value: grid((k) => ({ format: { fill: { color: k.fill || "#FFFFFF" } } })) }; },
        get numberFormat() { return grid((k) => k.nf); }, set numberFormat(v) { v.forEach((row, i) => row.forEach((f, j) => (cell(r0 + i, c0 + j).nf = f))); },
        format: { fill: { load() { return this; }, get color() { const all = grid((k) => k.fill ?? null).flat(); return all.every((x) => x === all[0]) ? all[0] ?? "#FFFFFF" : null; },
          set color(x) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cell(r0 + i, c0 + j).fill = x; },
          clear() { this.color = null; } } },
      };
    };
    const used = () => { let R = -1, C = -1; for (const k in cells) { if (cells[k].v === "" && !cells[k].fill) continue; const [r, c] = k.split(",").map(Number); R = Math.max(R, r); C = Math.max(C, c); } return R < 0 ? null : range(0, 0, R + 1, C + 1); };
    Object.assign(ws, {
      isNullObject: false, cell, load() { return this; }, activate() { active = name; },
      getUsedRange: () => used(), getUsedRangeOrNullObject: () => used() || { isNullObject: true, load() { return this; } },
      getRangeByIndexes: range, getRange: (a) => { const [r, c] = parse(a); return range(r, c, 1, 1); },
      onChanged: { add: (h) => { ws.changed.push(h); return handle(ws.changed, h); } },
      onSelectionChanged: { add: (h) => { ws.selected.push(h); return handle(ws.selected, h); } },
    });
    return ws;
  }
  const ctx = { workbook: null, sync: async () => {} };
  const handle = (list, h) => ({ context: ctx, remove() { list.splice(list.indexOf(h), 1); } });
  ctx.workbook = { worksheets: {
    getActiveWorksheet: () => sheets[active], getItem: (n) => { if (!sheets[n]) throw new Error("ItemNotFound " + n); return sheets[n]; },
    getItemOrNullObject: (n) => sheets[n] || { isNullObject: true, load() { return this; } },
    add: (n) => (sheets[n] = makeSheet(n)),
  } };
  sheets.Sheet1 = makeSheet("Sheet1");
  const settings = {};
  window.Office = {
    HostType: { Excel: "Excel" }, onReady: (cb) => setTimeout(() => cb({ host: "Excel" }), 0),
    context: { document: { settings: { get: (k) => settings[k] ?? null, set: (k, v) => (settings[k] = v), remove: (k) => delete settings[k], saveAsync() {}, refreshAsync: (cb) => cb() } } },
  };
  window.Excel = { run: async (a, b) => (b || a)(ctx) };
  // test hooks
  window.__load = (name, rows, dateCols = []) => {
    const ws = (sheets[name] = makeSheet(name)); active = name;
    rows.forEach((row, r) => row.forEach((v, c) => { const k = ws.cell(r, c); k.v = v; if (r && dateCols.includes(c)) k.nf = "m/d/yyyy"; }));
  };
  window.__edit = (name, a, v) => { const [r, c] = parse(a); sheets[name].getRangeByIndexes(r, c, 1, 1).values = [[v]]; }; // fires onChanged
  window.__changed = (n) => sheets[n].changed.length;
  window.__drop = (n) => { delete sheets[n]; };
  window.__fill = (name, a, color) => { const [r, c] = parse(a); sheets[name].cell(r, c).fill = color; };
  window.__formula = (name, a, f) => { const [r, c] = parse(a); sheets[name].cell(r, c).f = f; }; // value stays as loaded
  window.__cell = (name, a) => { const [r, c] = parse(a); const k = sheets[name].cells[r + "," + c] || {}; return { v: k.v, f: k.f, fill: k.fill }; };
  window.__userSelect = (name, address) => sheets[name].selected.forEach((h) => h({ address }));
  window.__activate = (n) => (active = n);
  window.__log = log; window.__settings = settings; window.__handlers = (n) => sheets[n].selected.length;
})();
