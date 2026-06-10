// Tab switching + the Review, Preview (render/source/exports), and JSON
// (CodeMirror) views.
function showView(which) {
  if (state.activeView === "harmony" && which !== "harmony" &&
      typeof hmStopPlayback === "function") hmStopPlayback();
  state.activeView = which;
  $("bars").classList.toggle("hidden", which !== "bars");
  $("lyrics").classList.toggle("hidden", which !== "lyrics");
  $("review").classList.toggle("hidden", which !== "review");
  $("dict").classList.toggle("hidden", which !== "dict");
  $("harmony").classList.toggle("hidden", which !== "harmony");
  $("preview").classList.toggle("hidden", which !== "preview");
  $("json").classList.toggle("hidden", which !== "json");
  $("tabBars").classList.toggle("active", which === "bars");
  $("tabLyrics").classList.toggle("active", which === "lyrics");
  $("tabReview").classList.toggle("active", which === "review");
  $("tabDict").classList.toggle("active", which === "dict");
  $("tabHarmony").classList.toggle("active", which === "harmony");
  $("tabPreview").classList.toggle("active", which === "preview");
  $("tabJson").classList.toggle("active", which === "json");
  if (which === "lyrics") renderLyrics();
  if (which === "review") renderReview();
  if (which === "dict") renderDict();
  if (which === "harmony") renderHarmony();
  if (which === "preview") renderPreview();
  if (which === "json") renderJson();
}

// ---- Raw JSON editor tab (CodeMirror 5) ----
// A CodeMirror instance backs the JSON tab: 2-space soft tabs, syntax coloring,
// and a custom live JSON linter (gutter markers + inline squiggle) that runs as
// you type. The existing Apply-time shape guard is unchanged. We mirror the
// editor's text into the hidden #jsonSource textarea so any legacy reader still
// works, but jsonGet()/jsonSet() are the canonical accessors.
let jsonCM = null;

// Derive a {line, ch} CodeMirror position from a JSON.parse error message.
// V8 reports "... at position N", Firefox reports "line L column C".
function jsonErrPos(cm, msg) {
  let m = /line (\d+) column (\d+)/i.exec(msg);
  if (m) return { line: Math.max(0, +m[1] - 1), ch: Math.max(0, +m[2] - 1) };
  m = /position (\d+)/i.exec(msg);
  if (m) return cm.posFromIndex(+m[1]);
  return { line: 0, ch: 0 };
}

// Custom CM lint helper: parse the text; on failure return one error annotation
// at the derived position (covering to end-of-line so it's visible).
function jsonLinter(text) {
  if (!text.trim()) return [];
  try { JSON.parse(text); return []; }
  catch (e) {
    const msg = String(e.message || e);
    const cm = jsonCM;
    const from = cm ? jsonErrPos(cm, msg) : { line: 0, ch: 0 };
    const to = cm
      ? { line: from.line, ch: (cm.getLine(from.line) || "").length }
      : { line: from.line, ch: from.ch + 1 };
    return [{ from, to, message: msg, severity: "error" }];
  }
}

// Lazily build the CodeMirror instance over #jsonEditor.
function ensureJsonCM() {
  if (jsonCM || typeof CodeMirror === "undefined") return jsonCM;
  CodeMirror.registerHelper("lint", "json", jsonLinter);
  jsonCM = CodeMirror($("jsonEditor"), {
    value: "",
    mode: { name: "javascript", json: true },
    theme: "material-darker",
    lineNumbers: true,
    tabSize: 2,
    indentUnit: 2,
    indentWithTabs: false,
    smartIndent: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: false,
    lint: { getAnnotations: jsonLinter, async: false, lintOnChange: true, delay: 250 },
    gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
    extraKeys: {
      // 2-space soft tab; indent a multi-line selection.
      Tab(cm) {
        if (cm.somethingSelected()) cm.indentSelection("add");
        else cm.replaceSelection("  ", "end");
      },
      "Shift-Tab"(cm) { cm.indentSelection("subtract"); },
      // ⌘S / Ctrl+S → Save (let our global handler not be needed inside CM).
      "Cmd-S"(cm) { save(); },
      "Ctrl-S"(cm) { save(); },
    },
  });
  // Live validity feedback as the user types (debounced ~250ms), in addition to
  // the gutter lint markers. Mirror text into the hidden textarea.
  let t = null;
  jsonCM.on("change", () => {
    $("jsonSource").value = jsonCM.getValue();
    if (t) clearTimeout(t);
    t = setTimeout(jsonValidateLive, 250);
  });
  return jsonCM;
}

// Canonical text accessors (CM if present, else the textarea fallback).
function jsonGet() { return jsonCM ? jsonCM.getValue() : $("jsonSource").value; }
function jsonSet(text) {
  if (jsonCM) jsonCM.setValue(text);
  $("jsonSource").value = text;
}

// Debounced validity readout shown in #jsonMsg while typing.
function jsonValidateLive() {
  const text = jsonGet();
  if (!text.trim()) { jsonMsg("", ""); return; }
  try {
    JSON.parse(text);
    jsonMsg("valid ✓", "ok");
  } catch (e) {
    const msg = String(e.message || e);
    const pos = jsonCM ? jsonErrPos(jsonCM, msg) : { line: 0, ch: 0 };
    jsonMsg(`invalid — ${msg} (line ${pos.line + 1}, col ${pos.ch + 1})`, "err");
  }
}

// Populate the editor from the CURRENT in-memory document so it reflects
// unsaved edits made in other tabs. Refresh CM (it mis-measures while hidden).
function renderJson() {
  ensureJsonCM();
  if (!state.doc) { jsonSet(""); jsonMsg("", ""); if (jsonCM) jsonCM.refresh(); return; }
  jsonSet(JSON.stringify(state.doc, null, 2));
  jsonMsg("", "");
  if (jsonCM) setTimeout(() => jsonCM.refresh(), 0);
}

function jsonMsg(text, cls) {
  const el = $("jsonMsg");
  el.textContent = text;
  el.className = cls || "muted";
}

// Reload: repopulate from state.doc, discarding editor edits.
function jsonReload() {
  if (!state.doc) { jsonSet(""); jsonMsg("", ""); return; }
  jsonSet(JSON.stringify(state.doc, null, 2));
  jsonMsg("", "");
}

// Format: pretty-print the editor text if it parses; otherwise show the error
// and leave the text untouched.
function jsonFormat() {
  let parsed;
  try {
    parsed = JSON.parse(jsonGet());
  } catch (e) {
    jsonMsg(String(e.message || e), "err");
    return;
  }
  jsonSet(JSON.stringify(parsed, null, 2));
  jsonMsg("formatted ✓", "ok");
}

// Apply: parse + shape-guard, then swap state.doc and re-render. If re-render
// throws (structurally bad doc), restore the pre-apply snapshot so the app
// can't be left broken. Does NOT save — Save persists + schema-validates.
function jsonApply() {
  if (!state.doc) return;
  let parsed;
  try {
    parsed = JSON.parse(jsonGet());
  } catch (e) {
    jsonMsg(String(e.message || e), "err");
    return;
  }
  const shapeOk = parsed && parsed.document && Array.isArray(parsed.songs)
    && parsed.songs[0] && Array.isArray(parsed.songs[0].sections);
  if (!shapeOk) {
    jsonMsg("Bad shape: need { document, songs: [ { sections: [...] } ] }", "err");
    return;
  }
  pushUndo();
  state.doc = parsed;
  state.sel = null;
  $("editor").classList.remove("open");
  markDirty();
  try {
    rerenderAll();
  } catch (e) {
    // Re-render failed on the new doc — roll back to the snapshot we just pushed.
    state.doc = undoStack.pop();
    state.sel = null;
    try { rerenderAll(); } catch (e2) { /* best-effort recovery */ }
    jsonMsg("Could not apply: " + String(e.message || e), "err");
    return;
  }
  jsonMsg("applied ✓ — Save to persist", "ok");
}

// Review tab: worklist of every flagged chord in the current song. Click an
// item to jump to its chip (Bars view) and open the editor.
function renderReview() {
  const root = $("review");
  if (!state.doc) { root.innerHTML = `<div class="empty">No song loaded.</div>`; return; }
  const flags = state.flags;
  if (!flags.length) {
    root.innerHTML = `<div class="review-empty">No flagged chords ✓</div>`;
    return;
  }
  root.innerHTML = "";
  flags.forEach((f) => {
    const row = document.createElement("div");
    row.className = "rev-row";
    row.innerHTML =
      `<span class="rnm">${esc(f.chord || "—")}</span>` +
      `<span class="rwhere">${esc(f.label)} · bar ${f.bi + 1}</span>` +
      `<span class="rwhy">${esc(f.reason)}</span>`;
    row.addEventListener("click", () => jumpToFlag(f));
    root.appendChild(row);
  });
}

// Switch to Bars, select the flagged chip, and open its editor.
function jumpToFlag(f) {
  showView("bars");
  openEditor(f.si, f.bi, f.ei);
  // bring the freshly-selected chip into view
  const sel = $("bars").querySelector(".chip.sel");
  if (sel) sel.scrollIntoView({ block: "center", behavior: "smooth" });
}

// Jump to the first flag positionally AFTER (si, bi, ei), wrapping to the
// start — used by "use + next" where the current entry's flag just cleared.
function nextFlaggedAfter(si, bi, ei) {
  const flags = state.flags;
  if (!flags.length) { showView("review"); return; }
  const next = flags.find((f) =>
    f.si > si || (f.si === si && (f.bi > bi || (f.bi === bi && f.ei > ei))));
  jumpToFlag(next || flags[0]);
}

// Jump to the next flagged chord after the current selection (wrapping).
function nextFlagged() {
  if (!state.doc) return;
  const flags = state.flags;
  if (!flags.length) { showView("review"); return; }
  let start = -1;
  if (state.sel) {
    start = flags.findIndex((f) =>
      f.si === state.sel.si && f.bi === state.sel.bi && f.ei === state.sel.ei);
  }
  const next = flags[(start + 1) % flags.length];
  jumpToFlag(next);
}

// Jump to the previous flagged chord before the current selection (wrapping).
function prevFlagged() {
  if (!state.doc) return;
  const flags = state.flags;
  if (!flags.length) { showView("review"); return; }
  let start = -1;
  if (state.sel) {
    start = flags.findIndex((f) =>
      f.si === state.sel.si && f.bi === state.sel.bi && f.ei === state.sel.ei);
  }
  // start === -1 (no selection / not on a flag) wraps to the last flag
  const prev = flags[(start - 1 + flags.length) % flags.length];
  jumpToFlag(prev);
}

// Copy the generated ChordMark source (current in-memory edits) to the clipboard.
function copyChordmark() {
  const ta = $("cmSource");
  const msg = $("cmCopyMsg");
  const done = () => { msg.textContent = "✓ copied"; setTimeout(() => (msg.textContent = ""), 1500); };
  navigator.clipboard.writeText(ta.value).then(done, () => {
    ta.select(); document.execCommand("copy"); done();
  });
}

// Render the CURRENT in-memory doc (state.doc) — reflects UNSAVED edits, no Save
// required. POSTs the doc to render-doc (POST can't use iframe.src, so srcdoc).
// When the Source toggle is on, also fetch the generated .chordmark source text.
async function renderPreview() {
  if (!state.doc) return;
  const frame = $("previewFrame");
  const style = $("pvStyle").value;
  const dict = $("pvDict").value;
  const inline = $("pvInline").checked ? "1" : "0";
  const bars = $("pvBars").value;
  const showSource = $("pvSource").checked;
  // Source pane: textarea + control bar visibility tracks the toggle.
  $("cmSource").classList.toggle("hidden", !showSource);
  $("pvSourceBar").classList.toggle("hidden", !showSource);

  const docBody = JSON.stringify(state.doc);
  try {
    const res = await fetch(
      `/api/render-doc?style=${style}&dict=${dict}&inline=${inline}&bars=${bars}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
    frame.srcdoc = await res.text();
  } catch (e) {
    frame.srcdoc = "<pre style='color:#b00;padding:20px'>preview failed: " + esc(e) + "</pre>";
  }

  if (showSource) {
    const ta = $("cmSource");
    try {
      const r = await fetch(`/api/chordmark-doc?bars=${bars}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
      ta.value = r.ok ? await r.text()
        : "/* could not build ChordMark: " + (await r.text()) + " */";
    } catch (e) {
      ta.value = "/* failed to load ChordMark: " + e + " */";
    }
  }
}

// Wire the Export buttons. Each fetches the response as a Blob and triggers the
// download from a blob URL, so we get real completion feedback ("Exported ✓" /
// "Export failed: …") instead of a fire-and-forget anchor click.
function wireExport() {
  const a = (id) => encodeURIComponent(id);
  const songBase = () => `/api/export/${a(state.album)}/${a(state.file)}`;
  const pvOpts = () =>
    `style=${$("pvStyle").value}&dict=${$("pvDict").value}` +
    `&inline=${$("pvInline").checked ? 1 : 0}&bars=${$("pvBars").value}`;
  const flash = (m) => {
    const s = $("pvExportMsg");
    s.textContent = m;
    if (m) setTimeout(() => { if (s.textContent === m) s.textContent = ""; }, 2500);
  };
  const guard = () => {
    if (!state.album || !state.file) { flash("no song selected"); return false; }
    return true;
  };

  // Filename from a Content-Disposition header, or a fallback.
  const filenameFrom = (res, fallback) => {
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    return (m && m[1]) || fallback;
  };

  // Fetch a URL, surface progress + completion as a toast, download the blob.
  async function exportBlob(url, pending, fallbackName) {
    flash(pending);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = res.status;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (e) { /* not json */ }
        flash("Export failed: " + detail);
        return;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objUrl;
      link.download = filenameFrom(res, fallbackName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
      flash("Exported ✓");
    } catch (e) {
      flash("Export failed: " + e);
    }
  }

  $("pvExportPdf").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=pdf&${pvOpts()}`, "exporting PDF…", `${state.file}.pdf`);
  });
  $("pvExportPng").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=png&${pvOpts()}`, "exporting PNG…", `${state.file}.png`);
  });
  $("pvExportHtml").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=html&${pvOpts()}`, "exporting HTML…", `${state.file}.html`);
  });
  $("pvExportChordmark").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=chordmark&bars=${$("pvBars").value}`,
      "exporting .chordmark…", `${state.file}.chordmark`);
  });
  $("pvExportChordpro").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=chordpro`, "exporting ChordPro…", `${state.file}.chordpro`);
  });
  $("pvExportAlbum").addEventListener("click", () => {
    if (!state.album) { flash("no album selected"); return; }
    exportBlob(
      `/api/export-album/${a(state.album)}?fmt=pdf&style=target&dict=${$("pvDict").value}&bars=${$("pvBars").value}`,
      "exporting album PDF…", `${state.album}-songbook.pdf`);
  });
  // Download .chordmark of the CURRENT in-memory source (the textarea content).
  $("cmDownload").addEventListener("click", () => {
    if (!state.album || !state.file) return;
    const text = $("cmSource").value || "";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const objUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objUrl;
    link.download = `${state.file.replace(/\.json$/i, "")}.chordmark`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    const msg = $("cmCopyMsg");
    msg.textContent = "✓ downloaded";
    setTimeout(() => (msg.textContent = ""), 1500);
  });
}
