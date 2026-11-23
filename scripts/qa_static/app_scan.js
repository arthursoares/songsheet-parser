// The scan follows immutable observations. A linked page may have no diagram
// box, in which case the page itself is the only source location we show.
let scanReview = { request: null, locations: {}, selection: null, follow: false };
let legacyScanOrder = null;
let legacyScanLength = 0;
let scanShowEdits = false;
try { scanShowEdits = localStorage.getItem("qaShowScanEdits") === "1"; }
catch (_error) { /* The toggle still works for this session. */ }
let savedScanEdits = new Map();
const SCAN_EDIT_FIELDS = [["chord", "Chord"], ["voicing", "Voicing"], ["text", "Lyric"]];
const SCAN_MATCH_LABELS = {
  legacy_exact_count: "Scan reading-order match",
  legacy_unique_alignment: "Aligned by neighboring scan matches",
  legacy_editorial_fallback: "Scan match from chart fingering",
};
const SCAN_PROPOSAL_BASIS = "legacy_anchored_proposal";

function scanEditValue(entry, field) {
  return String(entry?.[field] ?? "").trim();
}

// A new boundary divides two observations that were in one extracted bar.
// Comparing source groups avoids marking every bar that was merely renumbered.
function scanEditSnapshot(doc) {
  const entries = new Map();
  const observations = doc?._meta?.observations;
  for (const section of doc?.songs?.[0]?.sections || []) {
    let previousBar = null;
    let previousSourceBar = null;
    for (const bar of section.bars) {
      for (const entry of bar) {
        if (entry.chord === "%") continue;
        const observation = observations?.[entry.observation_id];
        const position = observation?.position;
        const sourceBar = observation?.source_id && Array.isArray(position) && position.length === 4
          ? JSON.stringify([observation.source_id, ...position.slice(0, 3)]) : null;
        if (observation) {
          entries.set(entry.observation_id, {
            values: SCAN_EDIT_FIELDS.map(([field]) => scanEditValue(entry, field)),
            newBar: sourceBar !== null && sourceBar === previousSourceBar && bar !== previousBar,
          });
        }
        previousBar = bar;
        previousSourceBar = sourceBar;
      }
    }
  }
  return entries;
}

function scanEditsForDocument(doc, savedEntries) {
  const changes = new Map();
  for (const [id, current] of scanEditSnapshot(doc)) {
    const original = doc._meta.observations[id].value;
    const saved = savedEntries.get(id);
    const rows = [];
    SCAN_EDIT_FIELDS.forEach(([field, label], index) => {
      const now = current.values[index];
      const before = original ? scanEditValue(original, field) : null;
      const lastSaved = saved?.values[index];
      const unsaved = lastSaved !== undefined && lastSaved !== now;
      if ((before !== null && before !== now) || unsaved) {
        rows.push({ field, label, before, now, lastSaved, unsaved });
      }
    });
    const joined = Boolean(saved?.newBar && !current.newBar);
    if (!rows.length && !current.newBar && !joined) continue;
    changes.set(id, {
      rows, newBar: current.newBar, joined,
      unsaved: saved
        ? rows.some((row) => row.unsaved) || saved.newBar !== current.newBar
        : Boolean(state.dirty),
    });
  }
  return changes;
}

function isCurrentScan(request) {
  return request && scanReview.request === request &&
    state.album === request.album && state.file === request.file;
}

function scanPages() {
  return (song().pages || []).filter((n) => Number.isInteger(n) && n > 0);
}

function scanSourceKey() {
  const meta = state.doc?._meta;
  const ids = new Set(entryCoords().map((c) => chordAt(c).observation_id).filter(Boolean));
  return JSON.stringify([
    scanPages(), meta?.assembly_fingerprint,
    [...ids].sort().map((id) => {
      const source = meta?.observations?.[id]?.source_id;
      const evidence = meta?.diagram_evidence?.[id];
      return [id, source, meta?.page_sources?.[source]?.page, evidence?.record_sha256];
    }),
  ]);
}

function syncScanDocument() {
  if (!isCurrentScan(scanReview.request) || scanSourceKey() === scanReview.sourceKey) return;
  renderPages(scanReview.savedSourceKey);
}

function syncSavedScanDocument(savedDoc = state.doc, unchanged = true) {
  if (!isCurrentScan(scanReview.request)) return;
  savedScanEdits = scanEditSnapshot(savedDoc);
  if (unchanged && (scanSourceKey() !== scanReview.savedSourceKey ||
      (!state.doc._meta?.observations && scanReview.request.doc !== state.doc))) {
    renderPages(scanSourceKey());
    syncScanSelection(activeChordSelection(), true);
  } else {
    renderScanReviewMarks();
  }
}

function renderPages(savedSourceKey) {
  const pages = scanPages();
  const root = $("pages");
  const sourceKey = scanSourceKey();
  if (savedSourceKey === undefined) {
    savedSourceKey = sourceKey;
    savedScanEdits = scanEditSnapshot(state.doc);
    const ordered = state.doc._meta?.observations ? [] : entryCoords().map(chordAt);
    legacyScanOrder = ordered.length ? new WeakMap(ordered.map((entry, i) => [entry, i])) : null;
    legacyScanLength = ordered.length;
  }
  root.innerHTML = `<div class="scan-toolbar">
    <label class="scan-edits-toggle"><input id="scanShowEdits" type="checkbox" ${scanShowEdits ? "checked" : ""}> Show edits</label>
    <div id="scanReviewLegend" class="scan-review-legend" hidden>
      <span style="--legend-color:#1760bd">Unreviewed</span>
      <span style="--legend-color:#23733b">Reviewed</span>
      <span style="--legend-color:#a05304">Deferred</span>
      <span style="--legend-color:#b73531">Needs re-review</span>
      <span class="scan-proposal-legend">Proposed position</span>
    </div>
    <div id="scanFocusStatus" class="muted" role="status" hidden></div>
    <div id="scanEditDetails" class="scan-edit-details" hidden></div>
  </div>` + pages.map((n) => `
    <figure class="scan-page" id="scan-page-${n}">
      <div class="scan-image">
        <img src="/api/page/${encodeURIComponent(state.album)}/${encodeURIComponent(state.file)}/${encodeURIComponent(n)}" alt="page ${esc(n)}">
        <div class="scan-review-marks"></div>
      </div>
      <figcaption class="pagecap">page ${esc(n)}</figcaption>
    </figure>`).join("");
  const request = { album: state.album, file: state.file, doc: state.doc, revision: state.songRevision };
  scanReview = {
    request, locations: {}, legacyLocations: new WeakMap(), edits: new Map(),
    selection: null, follow: false, pending: false,
    sourceKey, savedSourceKey,
  };
  if (typeof syncActiveChordProposal === "function") syncActiveChordProposal();
  $("scanShowEdits")?.addEventListener("change", (event) => {
    scanShowEdits = event.target.checked;
    try { localStorage.setItem("qaShowScanEdits", scanShowEdits ? "1" : "0"); }
    catch (_error) { /* Keep the in-memory preference. */ }
    renderScanReviewMarks();
  });
  if (scanShowEdits) renderScanReviewMarks();
  root.querySelectorAll(".scan-image img").forEach((image) => {
    image.addEventListener("load", () => {
      if (isCurrentScan(request) && scanReview.follow) updateScanSelection(true);
    });
  });
  if (scanReview.sourceKey !== savedSourceKey) return;
  // Legacy boxes describe the saved revision. Bind them to the original
  // entry objects so moving a chord still follows its printed position.
  const legacyEntries = request.revision && !state.doc._meta?.observations
    ? new Map(entryCoords().map((c) => [`${c.si}:${c.bi}:${c.ei}`, chordAt(c)]))
    : new Map();
  scanReview.pending = true;
  api(`/api/diagram-location/${encodeURIComponent(request.album)}/${encodeURIComponent(request.file)}`,
    { cache: "no-store" })
    .then((data) => {
      if (!isCurrentScan(request)) return;
      scanReview.locations = data.locations || {};
      if (request.revision && data.revision === request.revision) {
        for (const [key, location] of Object.entries(data.coordinates || {})) {
          const entry = legacyEntries.get(key);
          if (entry) scanReview.legacyLocations.set(entry, location);
        }
      }
      renderScanReviewMarks();
      if (typeof syncActiveChordProposal === "function") syncActiveChordProposal();
    })
    .catch(() => { /* Page-level source information is still available. */ })
    .finally(() => {
      if (!isCurrentScan(request)) return;
      scanReview.pending = false;
      updateScanSelection(scanReview.follow);
    });
}

function scanLocation(entry) {
  return entry.observation_id
    ? scanReview.locations[entry.observation_id]
    : scanReview.legacyLocations?.get(entry);
}

// Keep all consumers on the request guard used by the scan overlay. In
// particular, an editor opened while the request is pending must not see a
// location left over from a different song.
function scanLookup(entry) {
  if (!entry || !isCurrentScan(scanReview.request)) return null;
  const location = scanLocation(entry);
  return location?.basis === SCAN_PROPOSAL_BASIS &&
    scanReview.request.revision !== state.songRevision ? null : location;
}

function scanProposal(entry) {
  const location = scanLookup(entry);
  if (location?.basis !== SCAN_PROPOSAL_BASIS || typeof location.proposal !== "string") return "";
  const tokens = location.proposal.split(",").map((token) => token.trim().toLowerCase());
  if (tokens.length !== 6 || tokens.some((token) => token !== "x" &&
      (!/^\d{1,2}$/.test(token) || Number(token) > 24))) return "";
  return tokens.join(",");
}

function copyLegacyScanLinks(snapshot) {
  const locations = scanReview.legacyLocations;
  if (!locations || !isCurrentScan(scanReview.request)) return;
  for (const coords of entryCoords()) {
    const from = chordAt(coords);
    const location = locations.get(from);
    const entry = snapshot.songs[0].sections[coords.si].bars[coords.bi][coords.ei];
    if (location) locations.set(entry, location);
    if (legacyScanOrder?.has(from)) legacyScanOrder.set(entry, legacyScanOrder.get(from));
  }
}

function legacyScanOrderChanged() {
  if (!legacyScanOrder || !isCurrentScan(scanReview.request)) return false;
  const entries = entryCoords();
  return entries.length !== legacyScanLength ||
    entries.some((coords, index) => legacyScanOrder.get(chordAt(coords)) !== index);
}

function sourcePageForChord(entry) {
  const located = scanLookup(entry)?.page;
  if (located !== undefined) return located;
  const meta = state.doc?._meta;
  const id = entry.observation_id;
  if (id) {
    const source = meta?.observations?.[id]?.source_id;
    return meta?.page_sources?.[source]?.page
      ?? meta?.diagram_evidence?.[id]?.record?.page;
  }
  const pages = song().pages || [];
  return pages.length === 1 ? pages[0] : null;
}

function scanReviewBox(box) {
  return Array.isArray(box) && box.length === 4 &&
    box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
    box[0] < box[2] && box[1] < box[3];
}

function renderScanReviewMarks() {
  const root = $("pages");
  if (!state.doc || !isCurrentScan(scanReview.request)) return;
  scanReview.edits = scanShowEdits ? scanEditsForDocument(state.doc, savedScanEdits) : new Map();
  const pages = new Map();
  for (const coords of entryCoords()) {
    const entry = chordAt(coords);
    const location = scanLookup(entry);
    if (!location || !scanReviewBox(location.box)) continue;
    const [left, top, right, bottom] = location.box;
    const status = chordReviewStatus(entry);
    const edit = scanReview.edits.get(entry.observation_id);
    const editStatus = edit ? (edit.unsaved ? "Unsaved edit" : "Saved edit") : "";
    const matchLabel = SCAN_MATCH_LABELS[location.basis];
    const proposal = scanProposal(entry);
    const label = `${entry.chord} · ${CHORD_REVIEW_LABELS[status]} · bar ${coords.bi + 1}` +
      (edit ? ` · ${editStatus}` : "") + (matchLabel ? ` · ${matchLabel}` : "") +
      (location.basis === SCAN_PROPOSAL_BASIS
        ? ` · Proposed position, not verified${proposal ? ` · proposed fingering ${proposal}` : ""}` : "");
    const captions = [];
    if (edit?.rows.some(({ field }) => field === "chord")) captions.push(entry.chord);
    if (edit?.newBar) captions.push(`Starts bar ${coords.bi + 1}`);
    if (edit?.joined) captions.push("Bar joined");
    const badge = edit ? `<span class="scan-edit-badge" data-edit-status="${edit.unsaved ? "unsaved" : "saved"}">${esc(captions.join(" · ") || "Edited")}</span>` : "";
    const proposalAttr = location.basis === SCAN_PROPOSAL_BASIS ? ' data-scan-proposal="true"' : "";
    const mark = `<button type="button" tabindex="-1" class="scan-review-mark" data-scan-chord="${coords.si}:${coords.bi}:${coords.ei}"${proposalAttr}
      data-review-status="${status}" aria-label="${esc(label)}" title="${esc(label)}"
      style="left:${left * 100}%;top:${top * 100}%;width:${(right - left) * 100}%;height:${(bottom - top) * 100}%">${badge}</button>`;
    if (!pages.has(location.page)) pages.set(location.page, []);
    pages.get(location.page).push(mark);
  }
  root.querySelectorAll(".scan-page").forEach((page) => {
    const number = Number(page.id.slice("scan-page-".length));
    page.querySelector(".scan-review-marks").innerHTML = (pages.get(number) || []).join("");
  });
  const legend = $("scanReviewLegend");
  if (legend) legend.hidden = pages.size === 0;
  updateScanSelection(false);
}

function syncScanSelection(coords, follow = false) {
  scanReview.selection = coords || null;
  scanReview.follow = Boolean(coords) && (scanReview.follow || follow);
  updateScanSelection(follow);
}

function renderScanEditDetails(entry, coords) {
  const panel = $("scanEditDetails");
  if (!panel) return;
  const edit = scanReview.edits?.get(entry?.observation_id);
  panel.hidden = !edit;
  if (!edit) {
    panel.innerHTML = "";
    return;
  }
  const rows = edit.rows.map(({ label, before, now, lastSaved, unsaved }) => `
    <tr><th scope="row">${label}</th><td>${esc(before || "—")}</td><td>${esc(now || "—")}
    ${unsaved && before === now ? `<small>Last saved ${esc(lastSaved || "—")}</small>` : ""}</td></tr>`).join("");
  panel.innerHTML = `<div class="scan-edit-heading"><b>${esc(entry.chord)}</b>
    <span>${edit.unsaved ? "Unsaved edit" : "Saved edit"}</span></div>
    ${edit.newBar ? `<div>Starts bar ${coords.bi + 1}</div>` : ""}
    ${edit.joined ? "<div>Removed the saved bar split</div>" : ""}
    ${rows ? `<table><thead><tr><th></th><th scope="col">As extracted</th><th scope="col">Current</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    ${state.activeView !== "bars" ? '<button type="button" id="scanEditOpen" class="tab">Edit chord</button>' : ""}`;
}

function updateScanSelection(follow) {
  const root = $("pages");
  const coords = scanReview.selection;
  const entry = coords && state.doc && isCurrentScan(scanReview.request) &&
    song().sections[coords.si]?.bars[coords.bi]?.[coords.ei];
  renderScanEditDetails(entry, coords);
  const page = entry && $(`scan-page-${sourcePageForChord(entry)}`);
  const mark = page && page.querySelector(`[data-scan-chord="${coords.si}:${coords.bi}:${coords.ei}"]`);
  const focusStatus = $("scanFocusStatus");
  if (focusStatus) {
    focusStatus.hidden = !entry || Boolean(mark);
    focusStatus.textContent = scanReview.pending
      ? "Locating chord on the scan…" : "A precise scan position is unavailable for this chord.";
  }
  const previousPage = root.querySelector(".scan-page.current");
  const previousMark = root.querySelector(".scan-review-mark.selected");
  if (previousPage !== page) {
    previousPage?.classList.remove("current");
    page?.classList.add("current");
  }
  if (previousMark !== mark) {
    previousMark?.classList.remove("selected");
    previousMark?.removeAttribute("aria-current");
    mark?.classList.add("selected");
    mark?.setAttribute("aria-current", "true");
  }
  if (!follow || !page || !root.clientHeight) return;
  const viewport = root.getBoundingClientRect();
  const toolbar = root.querySelector(".scan-toolbar");
  const visibleTop = Math.max(viewport.top, toolbar?.getBoundingClientRect().bottom ?? viewport.top);
  const target = (mark || page).getBoundingClientRect();
  if (mark) {
    if (target.top < visibleTop || target.bottom > viewport.bottom) {
      root.scrollTop += (target.top + target.bottom - visibleTop - viewport.bottom) / 2;
    }
  } else if (previousPage !== page || target.bottom <= visibleTop || target.top >= viewport.bottom) {
    root.scrollTop += target.top - visibleTop;
  }
}

function wireScanReview() {
  $("pages").addEventListener("click", (ev) => {
    if (ev.target.closest("#scanEditOpen") && scanReview.selection && isCurrentScan(scanReview.request)) {
      jumpToEntry(scanReview.selection);
      return;
    }
    const button = ev.target.closest("[data-scan-chord]");
    if (!button || !state.doc || !isCurrentScan(scanReview.request)) return;
    const [si, bi, ei] = button.dataset.scanChord.split(":").map(Number);
    const coords = { si, bi, ei };
    if (state.activeView === "chordReview") selectChordReviewEntry(coords);
    else if (state.activeView === "lyrics" && lyMode() !== "text") selectLyricChord(coords, { focus: true });
    else jumpToEntry(coords);
  });
}
