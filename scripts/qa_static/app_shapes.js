// Library-wide repeated-fingering review. The parent app owns navigation and
// song reloading; this file owns only the #shapes workspace and its API calls.
const SHAPE_UNDO_KEY = "qaShapesLastBatch";
const SHAPE_STRINGS = ["low E", "A", "D", "G", "B", "high E"];
const shapesUI = {
  container: null, query: "", album: "", page: 1, pages: 1,
  groups: [], counts: {}, albums: [], detail: null, selected: new Set(),
  targetVoicing: "", targetName: "", fretboard: null,
  latestBatch: null, loaded: false, stale: false, listGeneration: 0, detailGeneration: 0,
  listPending: false, detailPending: false, writePending: false, searchTimer: null, listTimer: null,
};

function shapeEsc(value) {
  if (typeof esc === "function") return esc(value);
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function shapeCount(value) {
  if (Array.isArray(value)) return value.length;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function shapeDisagreementCount(group) {
  return shapeCount(group?.disagreements ?? group?.matches);
}

function shapeLabels(group) {
  return Array.isArray(group?.labels) ? group.labels.filter(Boolean).map(String) : [];
}

function shapeTitle(group) {
  return normalizeShapeVoicing(group?.voicing) || group?.pattern || `Shape ${group?.id ?? ""}`;
}

function shapeVoicingCells(value) {
  return typeof value === "string" ? value.split(",").map((cell) => cell.trim()) : [];
}

function normalizeShapeVoicing(value) {
  const cells = shapeVoicingCells(value);
  if (cells.length !== 6) return "";
  const normalized = [];
  for (const cell of cells) {
    if (cell.toLowerCase() === "x") { normalized.push("x"); continue; }
    if (!/^\d{1,2}$/.test(cell)) return "";
    const fret = Number(cell);
    if (fret < 0 || fret > 24) return "";
    normalized.push(String(fret));
  }
  return normalized.join(",");
}

function shapeEffectiveVoicing(group) {
  if (!normalizeShapeVoicing(group?.voicing)) return "";
  return normalizeShapeVoicing(group?.correction) || normalizeShapeVoicing(group.voicing);
}

function shapeVoicingsDiffer(left, right) {
  const normalizedRight = normalizeShapeVoicing(right);
  if (!normalizedRight) return false;
  return normalizeShapeVoicing(left) !== normalizedRight;
}

// columns are the relative dot positions. Null means the string is muted;
// voicing is the proposed absolute PDF fingering, when it could be resolved.
function normalizeShapeColumns(group) {
  const columns = Array.isArray(group?.columns) ? group.columns : [];
  const absolute = shapeVoicingCells(group?.voicing);
  const pattern = String(group?.pattern || "");
  return Array.from({ length: Math.max(columns.length, absolute.length) }, (_, index) => ({
    string: SHAPE_STRINGS[index] || `String ${index + 1}`,
    relative: columns[index] ?? null,
    mark: pattern[index] || "",
    absolute: absolute[index] ?? "",
  }));
}

function shapePositionLabel(column) {
  if (column.mark.toUpperCase() === "O" || String(column.absolute) === "0") return "open";
  if (column.relative === null || column.mark.toUpperCase() === "M") return "muted";
  return Number.isInteger(column.relative) ? `column ${column.relative + 1}` : "fingered";
}

function shapeFretLabel(value) {
  const text = String(value ?? "").trim();
  return text.toLowerCase() === "x" ? "muted" : text === "0" ? "open" : text || "unresolved";
}

function shapeFretPill(value) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  if (text.toLowerCase() === "x") return "×";
  return text;
}

function renderShapeVoicing(group) {
  const columns = normalizeShapeColumns(group);
  if (!columns.length) return '<p class="shape-empty">No voicing preview is available.</p>';
  return `<table class="shape-voicing"><thead><tr><th scope="col">String</th>` +
    `<th scope="col">Printed shape</th><th scope="col">Detected fret</th></tr></thead><tbody>` +
    columns.map((column) => `<tr><th scope="row">${shapeEsc(column.string)}</th>` +
      `<td>${shapeEsc(shapePositionLabel(column))}</td>` +
      `<td>${shapeEsc(shapeFretLabel(column.absolute))}</td></tr>`).join("") + "</tbody></table>";
}

function shapeChordNaming() {
  return typeof window !== "undefined" ? window.ChordNaming : null;
}

function shapeTargetName() {
  return String(shapesUI.targetName || "").trim();
}

function shapeNameValidation(name = shapeTargetName()) {
  const target = String(name || "").trim();
  if (!target) return { valid: true, explicit: false };
  if (target === "%") return { valid: false, explicit: true };
  const naming = shapeChordNaming();
  if (!naming || typeof naming.validateName !== "function") return { valid: false, explicit: true };
  try { return { ...naming.validateName(target), explicit: true }; }
  catch (_error) { return { valid: false, explicit: true }; }
}

function shapeTargetLabel(item, name = shapeTargetName()) {
  const explicit = String(name || "").trim();
  return explicit || String(item?.label || "");
}

function shapeNameCompatibility(item, voicing = shapeTargetVoicing(), name = shapeTargetName()) {
  const label = shapeTargetLabel(item, name);
  const target = normalizeShapeVoicing(voicing);
  const naming = shapeChordNaming();
  if (!label || !target || !naming || typeof naming.nameMatchesVoicing !== "function") return null;
  try { return naming.nameMatchesVoicing(label, shapeVoicingArray(target)); }
  catch (_error) { return null; }
}

function shapeOccurrenceNeedsChange(item, voicing = item?.printed, name = shapeTargetName()) {
  const explicit = String(name || "").trim();
  return shapeVoicingsDiffer(item?.editorial, voicing) || Boolean(explicit && item?.label !== explicit);
}

function isSelectableShapeOccurrence(item, target = item?.printed, name = shapeTargetName()) {
  if (!normalizeShapeVoicing(target)) return false;
  return Boolean(item?.editable) && shapeOccurrenceNeedsChange(item, target, name) &&
    shapeNameCompatibility(item, target, name) !== false;
}

function representativeShapeOccurrences(occurrences, limit = 3) {
  const result = [], albums = new Set();
  for (const item of occurrences || []) {
    const album = String(item?.album ?? "");
    if (item?.id === undefined || item?.id === null || albums.has(album)) continue;
    albums.add(album); result.push(item);
    if (result.length === limit) break;
  }
  return result;
}

function shapeLocation(item) {
  const parts = [];
  if (Number.isInteger(item.si)) parts.push(`section ${item.si + 1}`);
  if (Number.isInteger(item.bi)) parts.push(`bar ${item.bi + 1}`);
  if (Number.isInteger(item.ei)) parts.push(`chord ${item.ei + 1}`);
  return parts.join(", ");
}

function shapeRequest(path, options) {
  if (typeof api === "function") return api(path, options);
  return fetch(path, options).then((response) => response.json());
}

function shapeResponse(payload, fallback) {
  if (!payload || payload.error) {
    const stale = payload?.stale ? " The library changed; refresh and try again." : "";
    throw new Error((payload?.error || fallback) + stale);
  }
  return payload;
}

function shapeError(error) { return String(error?.message || error || "Unknown error"); }
function shapeCropUrl(id) { return `/api/shapes/crop/${encodeURIComponent(id)}`; }

function setShapeStatus(message, kind = "info") {
  const element = typeof $ === "function" ? $("shapeStatus") : null;
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
  element.setAttribute("role", kind === "error" ? "alert" : "status");
}

function shapeWriteBlockReason() {
  try {
    if (typeof chordEditorHasDraft === "function" && chordEditorHasDraft())
      return "Apply or discard the open chord editor draft first.";
  } catch (_error) { return "Close the open chord editor before changing library files."; }
  if (typeof state !== "undefined" && state?.dirty)
    return "Save or discard the current song’s unsaved changes first.";
  return "";
}

function restoreShapeUndo() {
  if (shapesUI.latestBatch) return;
  try {
    const saved = JSON.parse(localStorage.getItem(SHAPE_UNDO_KEY) || "null");
    if (saved && typeof saved.id === "string") shapesUI.latestBatch = saved;
  } catch (_error) { /* Storage can be unavailable; session undo still works. */ }
}

function rememberShapeUndo(batch) {
  shapesUI.latestBatch = batch;
  try {
    if (batch) localStorage.setItem(SHAPE_UNDO_KEY, JSON.stringify(batch));
    else localStorage.removeItem(SHAPE_UNDO_KEY);
  } catch (_error) { /* Undo remains available until this page is closed. */ }
}

function ensureShapesWorkspace() {
  const container = typeof $ === "function" ? $("shapes") : null;
  if (!container) return null;
  if (shapesUI.container === container && container.dataset.shapesReady === "true") return container;
  shapesUI.container = container;
  restoreShapeUndo();
  container.dataset.shapesReady = "true";
  container.innerHTML = `<div class="shapes-workspace">
    <div class="shapes-head">
      <div><h1>Library shapes</h1><p>Repeated printed-diagram disagreements, ranked by affected songs and then disagreement count.</p></div>
      <div class="shapes-filters" aria-label="Shape filters">
        <label for="shapeSearch">Search<input id="shapeSearch" type="search" autocomplete="off" placeholder="Name, voicing, or song"></label>
        <label for="shapeAlbum">Album<select id="shapeAlbum"><option value="">All albums</option></select></label>
        <p class="shape-filter-help">Search finds an exact shape group; Album limits its counts and member rows.</p>
      </div>
    </div>
    <div class="shape-status-row"><div id="shapeStatus" class="shape-status" role="status" aria-live="polite"></div>
      <button type="button" id="shapeRefresh" data-shape-refresh>Refresh index</button>
      <button type="button" id="shapeGlobalUndo" data-shape-undo ${shapesUI.latestBatch ? "" : "disabled"}>Undo most recent batch</button></div>
    <div class="shapes-layout">
      <section class="shapes-results-pane" aria-labelledby="shapeResultsTitle">
        <h2 id="shapeResultsTitle">Ranked disagreements</h2>
        <div id="shapeResults" class="shape-results"></div>
        <nav id="shapePager" class="shape-pager" aria-label="Shape result pages"></nav>
      </section>
      <section id="shapeDetail" class="shape-detail" aria-label="Selected shape detail">
        <div class="shape-empty">Choose a shape to compare its evidence.</div>
      </section>
    </div>
  </div>`;
  $("shapeSearch").value = shapesUI.query;
  wireShapesWorkspace(container);
  return container;
}

function wireShapesWorkspace(container) {
  $("shapeSearch").addEventListener("input", (event) => {
    clearTimeout(shapesUI.searchTimer);
    shapesUI.searchTimer = setTimeout(() => {
      shapesUI.query = event.target.value.trim(); shapesUI.page = 1;
      loadShapeGroups({ resetDetail: true });
    }, 220);
  });
  $("shapeAlbum").addEventListener("change", (event) => {
    shapesUI.album = event.target.value; shapesUI.page = 1;
    loadShapeGroups({ resetDetail: true });
  });
  container.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-shape-select]");
    if (input && shapesUI.detail) {
      if (input.checked) shapesUI.selected.add(String(input.dataset.shapeSelect));
      else shapesUI.selected.delete(String(input.dataset.shapeSelect));
      renderShapeSelection();
      return;
    }
    const voicing = event.target.closest?.("[data-shape-voicing-text],.shape-fretboard .fb-text");
    if (voicing) commitShapeEditorInput(voicing);
  });
  container.addEventListener("input", (event) => {
    const name = event.target.closest?.("[data-shape-name]");
    if (name) {
      setShapeNameProposal(name.value, { announce: false, refreshControl: false });
      updateShapeNameFeedback(name);
      return;
    }
    const input = event.target.closest?.("[data-shape-voicing-text],.shape-fretboard .fb-text");
    if (!input) return;
    const typed = normalizeShapeVoicing(input.value);
    input.setAttribute("aria-invalid", typed ? "false" : "true");
    if (typed) setShapeProposal(typed, { syncFretboard: false });
  });
  container.addEventListener("keydown", (event) => {
    const input = event.target.closest?.("[data-shape-voicing-text]");
    if (input && event.key === "Enter") {
      event.preventDefault(); commitShapeEditorInput(input);
    }
  });
  container.addEventListener("click", handleShapesClick);
  container.addEventListener("error", (event) => {
    if (!event.target.matches?.(".shape-crop")) return;
    event.target.hidden = true;
    const fallback = event.target.parentElement?.querySelector(".shape-crop-unavailable");
    if (fallback) fallback.hidden = false;
  }, true);
}

function shapeListUrl() {
  const params = new URLSearchParams();
  if (shapesUI.query) params.set("q", shapesUI.query);
  if (shapesUI.album) params.set("album", shapesUI.album);
  params.set("page", String(shapesUI.page));
  return `/api/shapes?${params}`;
}

function resetShapeDetail() {
  shapesUI.detailGeneration += 1; shapesUI.detailPending = false;
  shapesUI.detail = null; shapesUI.targetVoicing = ""; shapesUI.targetName = ""; shapesUI.fretboard = null;
  shapesUI.selected.clear();
  if ($("shapeDetail")) $("shapeDetail").innerHTML = '<div class="shape-empty">Choose a shape to compare its evidence.</div>';
}

async function loadShapeGroups({ resetDetail = false, quiet = false } = {}) {
  if (!ensureShapesWorkspace()) return false;
  clearInterval(shapesUI.listTimer);
  shapesUI.listTimer = null;
  const generation = ++shapesUI.listGeneration;
  const indexing = !shapesUI.loaded;
  shapesUI.listPending = true;
  if (resetDetail) resetShapeDetail();
  syncShapeControls();
  const statusMessage = (seconds = 0) => {
    const base = indexing
      ? "Indexing library shapes (first run may take 10–60s)…"
      : "Loading library shapes…";
    return seconds > 0 ? `${base} (${seconds}s)` : base;
  };
  const emptyMessage = (seconds = 0) =>
    `<div class="shape-empty">${shapeEsc(indexing
      ? `Indexing library shapes (first run may take 10–60s)…${seconds > 0 ? ` (${seconds}s)` : ""}`
      : `Loading…${seconds > 0 ? ` (${seconds}s)` : ""}`)}</div>`;
  if (!quiet && !shapesUI.detailPending) setShapeStatus(statusMessage(0));
  if (!shapesUI.groups.length) $("shapeResults").innerHTML = emptyMessage(0);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (generation !== shapesUI.listGeneration || !shapesUI.listPending) return;
    const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (!quiet && !shapesUI.detailPending) setShapeStatus(statusMessage(seconds));
    if (!shapesUI.groups.length && $("shapeResults")) $("shapeResults").innerHTML = emptyMessage(seconds);
  }, 1000);
  shapesUI.listTimer = timer;
  try {
    const payload = shapeResponse(await shapeRequest(shapeListUrl()), "Could not load shapes.");
    if (generation !== shapesUI.listGeneration) return false;
    if (!Array.isArray(payload.groups)) throw new Error("The shapes response is incomplete.");
    shapesUI.groups = payload.groups; shapesUI.counts = payload.counts || {};
    shapesUI.albums = Array.isArray(payload.albums) ? payload.albums : [];
    shapesUI.page = Math.max(1, Number(payload.page) || 1);
    shapesUI.pages = Math.max(1, Number(payload.pages) || 1);
    shapesUI.loaded = true;
    shapesUI.stale = false;
    renderShapeAlbumFilter(); renderShapeResults(); renderShapePager();
    if (!quiet && !shapesUI.detailPending) setShapeStatus(shapeResultsSummary());
    return true;
  } catch (error) {
    if (generation !== shapesUI.listGeneration) return false;
    $("shapeResults").innerHTML = `<div class="shape-error">${shapeEsc(shapeError(error))}</div>`;
    setShapeStatus(shapeError(error), "error");
    return false;
  } finally {
    clearInterval(timer);
    if (shapesUI.listTimer === timer) shapesUI.listTimer = null;
    if (generation === shapesUI.listGeneration) {
      shapesUI.listPending = false; syncShapeControls();
    }
  }
}

async function refreshShapesWorkspace({ preserveDetail = false } = {}) {
  if (shapesUI.listPending || shapesUI.detailPending || shapesUI.writePending) return false;
  if (!ensureShapesWorkspace()) return false;
  const activeGroupId = preserveDetail ? shapesUI.detail?.id : null;
  shapesUI.loaded = false;
  if (shapesUI.detail) resetShapeDetail();
  const detailGen = shapesUI.detailGeneration;
  const loaded = await loadShapeGroups({ resetDetail: false });
  if (loaded && activeGroupId !== undefined && activeGroupId !== null &&
      !shapesUI.detailPending && shapesUI.detailGeneration === detailGen) {
    await openShapeGroup(activeGroupId, { quiet: true });
  }
  return loaded;
}

function shapeResultsSummary() {
  const total = shapeCount(shapesUI.counts.filtered_groups ?? shapesUI.counts.groups ?? shapesUI.groups.length);
  const compared = shapeCount(shapesUI.counts.compared);
  return `${shapesUI.groups.length.toLocaleString()} of ${total.toLocaleString()} groups` +
    (compared ? ` · ${compared.toLocaleString()} fingerings compared` : "");
}

function renderShapeAlbumFilter() {
  const select = $("shapeAlbum");
  select.innerHTML = '<option value="">All albums</option>' + shapesUI.albums.map((album) =>
    `<option value="${shapeEsc(album)}">${shapeEsc(album)}</option>`).join("");
  select.value = shapesUI.album;
  if (select.value !== shapesUI.album) { shapesUI.album = ""; select.value = ""; }
}

function renderShapeResults() {
  if (!shapesUI.groups.length) {
    $("shapeResults").innerHTML = '<div class="shape-empty">No repeated disagreements match these filters.</div>';
    return;
  }
  const offset = (shapesUI.page - 1) * 60;
  $("shapeResults").innerHTML = shapesUI.groups.map((group, index) => {
    const labels = shapeLabels(group), songs = shapeCount(group.songs);
    const matches = shapeCount(group.matches), disagreements = shapeDisagreementCount(group);
    return `<article class="shape-result-card"><span class="shape-rank" aria-label="Rank ${offset + index + 1}">#${offset + index + 1}</span>
      ${group.sample_id !== undefined && group.sample_id !== null ? `<div class="shape-result-thumb"><img class="shape-crop" loading="lazy" src="${shapeEsc(shapeCropUrl(group.sample_id))}" alt="Representative diagram for ${shapeEsc(shapeTitle(group))}"><span class="shape-crop-unavailable" hidden>Crop unavailable</span></div>` : '<div class="shape-result-thumb shape-no-crop">No crop</div>'}
      <button type="button" class="shape-result-open" data-shape-open="${shapeEsc(group.id)}">
        <span class="shape-result-title">${shapeEsc(shapeTitle(group))}</span>
        <span class="shape-result-labels">Chart labels: ${labels.length ? labels.map(shapeEsc).join(" · ") : "none recognized"}</span>
        <code class="shape-result-pair">Detected: ${shapeEsc(group.voicing || group.pattern || "unresolved")}</code>
        ${normalizeShapeVoicing(group.correction) ? `<code class="shape-result-pair shape-result-correction">Correction: ${shapeEsc(normalizeShapeVoicing(group.correction))}</code>` : ""}
        <span class="shape-result-count"><b>${songs}</b> ${songs === 1 ? "song" : "songs"} · ${matches} occurrences · ${disagreements} disagreements</span>
      </button></article>`;
  }).join("");
}

function renderShapePager() {
  if (shapesUI.pages <= 1) { $("shapePager").innerHTML = ""; return; }
  $("shapePager").innerHTML = `<button type="button" data-shape-page="${shapesUI.page - 1}" ${shapesUI.page <= 1 ? "disabled" : ""}>Previous</button>
    <span>Page ${shapesUI.page} of ${shapesUI.pages}</span>
    <button type="button" data-shape-page="${shapesUI.page + 1}" ${shapesUI.page >= shapesUI.pages ? "disabled" : ""}>Next</button>`;
}

async function openShapeGroup(id, { quiet = false, library = false } = {}) {
  if (id === undefined || id === null || shapesUI.writePending) return false;
  if (!ensureShapesWorkspace()) return false;
  if (library && (shapesUI.query || shapesUI.album || shapesUI.page !== 1)) {
    clearTimeout(shapesUI.searchTimer);
    shapesUI.query = ""; shapesUI.album = ""; shapesUI.page = 1;
    $("shapeSearch").value = ""; $("shapeAlbum").value = "";
    loadShapeGroups({ quiet: true });
  }
  const generation = ++shapesUI.detailGeneration;
  shapesUI.detailPending = true; shapesUI.targetName = ""; shapesUI.selected.clear(); syncShapeControls();
  $("shapeDetail").innerHTML = '<div class="shape-empty">Loading shape evidence…</div>';
  if (!quiet) setShapeStatus("Loading shape evidence…");
  try {
    const album = !library && shapesUI.album
      ? `?album=${encodeURIComponent(shapesUI.album)}` : "";
    const detail = shapeResponse(await shapeRequest(`/api/shapes/${encodeURIComponent(id)}${album}`),
      "Could not load shape evidence.");
    if (generation !== shapesUI.detailGeneration) return false;
    if (!Array.isArray(detail.occurrences)) throw new Error("The shape detail response is incomplete.");
    shapesUI.detail = detail; shapesUI.targetVoicing = shapeEffectiveVoicing(detail); shapesUI.targetName = "";
    renderShapeDetail();
    if (!quiet) setShapeStatus(`Loaded ${shapeTitle(detail)} evidence.`);
    return true;
  } catch (error) {
    if (generation !== shapesUI.detailGeneration) return false;
    shapesUI.detail = null;
    $("shapeDetail").innerHTML = `<div class="shape-error">${shapeEsc(shapeError(error))}</div>`;
    setShapeStatus(shapeError(error), "error");
    return false;
  } finally {
    if (generation === shapesUI.detailGeneration) {
      shapesUI.detailPending = false; syncShapeControls();
    }
  }
}

function shapeTargetVoicing() {
  return normalizeShapeVoicing(shapesUI.targetVoicing);
}

function commitShapeEditorInput(input) {
  const target = normalizeShapeVoicing(input?.value);
  if (!target) {
    input?.setAttribute("aria-invalid", "true");
    setShapeStatus("Enter exactly six comma-separated values: x or frets 0–24.", "error");
    return false;
  }
  input.setAttribute("aria-invalid", "false");
  return setShapeProposal(target);
}

function shapeVoicingArray(value) {
  return shapeVoicingCells(value).map((cell) => cell.toLowerCase() === "x" ? "x" : Number(cell));
}

function shapeCorrectionControl(group) {
  const detected = normalizeShapeVoicing(group?.voicing);
  if (!detected) {
    return `<section class="shape-correction shape-inspect-only" aria-labelledby="shapeCorrectionTitle">
      <h3 id="shapeCorrectionTitle">Fingering correction</h3>
      <p class="shape-help">This scan has no resolved source/base fingering, so the group is inspect-only. Open an individual song to edit it.</p>
    </section>`;
  }
  const target = shapeTargetVoicing() || detected;
  return `<section class="shape-correction" aria-labelledby="shapeCorrectionTitle">
    <div class="shape-section-head"><div><h3 id="shapeCorrectionTitle">Edit fingering to apply</h3>
      <p class="shape-help">This correction is prospective: only explicitly selected songs will be changed.</p></div>
      <button type="button" data-shape-use-detected ${target === detected ? "disabled" : ""}>Use detected fingering</button></div>
    <div class="shape-detected"><span>Detected scan</span><code>${shapeEsc(detected)}</code></div>
    <div class="shape-effective"><span>Effective target</span><code id="shapeEffectiveVoicing">${shapeEsc(target)}</code></div>
    <div id="shapeFretboard" class="shape-fretboard">
      <label for="shapeVoicingText">Six string values (low E to high E)</label>
      <input id="shapeVoicingText" data-shape-voicing-text type="text" inputmode="text"
        value="${shapeEsc(target)}" aria-describedby="shapeVoicingHelp">
      <small id="shapeVoicingHelp">Use x for muted or frets 0–24, separated by commas. Press Enter to preview.</small>
    </div>
  </section>`;
}

function shapeNameSuggestions(voicing = shapeTargetVoicing()) {
  const naming = shapeChordNaming(), target = normalizeShapeVoicing(voicing);
  if (!naming || !target || typeof naming.suggestNames !== "function") return [];
  try {
    const suggestions = naming.suggestNames(shapeVoicingArray(target));
    return Array.isArray(suggestions) ? suggestions.filter((item) => item && item.name).slice(0, 8) : [];
  } catch (_error) { return []; }
}

function shapeNameControl(group = shapesUI.detail) {
  if (!normalizeShapeVoicing(group?.voicing) && !shapeTargetVoicing()) {
    return `<section class="shape-name-editor shape-inspect-only" aria-labelledby="shapeNameTitle">
      <div class="shape-section-head"><div><h3 id="shapeNameTitle">Chord name</h3>
        <p class="shape-help">Chord name batch edits are unavailable until the scan fingering is resolved.</p></div></div>
    </section>`;
  }
  const name = shapeTargetName(), validation = shapeNameValidation(name);
  const suggestions = shapeNameSuggestions();
  const compatibility = name && validation.valid
    ? shapeNameCompatibility({ label: name }, shapeTargetVoicing(), name) : null;
  const invalid = Boolean(name && !validation.valid);
  const conflict = Boolean(name && validation.valid && compatibility === false);
  const badge = invalid ? "Not a valid ChordMark chord name."
    : conflict ? `“${shapeEsc(name)}” conflicts with the target fingering.`
      : name ? (compatibility === true ? "Name matches the target fingering." : "Name is valid; compatibility is unknown.")
        : "Blank keeps each selected row’s stored chord name exactly as written.";
  return `<section class="shape-name-editor" aria-labelledby="shapeNameTitle">
    <div class="shape-section-head"><div><h3 id="shapeNameTitle">Chord name</h3>
      <p class="shape-help">Optional. Enter one exact name for selected rows, or leave blank to retain every row’s current name.</p></div></div>
    <label for="shapeChordName">Chord name to apply</label>
    <input id="shapeChordName" data-shape-name type="text" value="${shapeEsc(name)}"
      placeholder="Keep stored names" aria-invalid="${invalid || conflict ? "true" : "false"}" aria-describedby="shapeNameStatus">
    <p id="shapeNameStatus" class="shape-name-status ${invalid || conflict ? "shape-error" : ""}">${badge}</p>
    <div id="shapeNameSuggestions" class="shape-name-suggestions" aria-label="Suggested chord names">${suggestions.length
      ? suggestions.map(({ name: suggestion }) => `<button type="button" data-shape-name-suggestion="${shapeEsc(suggestion)}">${shapeEsc(suggestion)}</button>`).join("")
      : '<span class="shape-help">No chord-name suggestions for this fingering.</span>'}</div>
  </section>`;
}

function pruneShapeSelection(target = shapeTargetVoicing(), name = shapeTargetName()) {
  const byId = new Map((shapesUI.detail?.occurrences || []).map((item) => [String(item.id), item]));
  let removed = 0;
  for (const id of [...shapesUI.selected]) {
    const item = byId.get(String(id));
    if (!item || !isSelectableShapeOccurrence(item, target, name)) {
      shapesUI.selected.delete(id);
      removed += 1;
    }
  }
  return removed;
}

function shapeDeselectionMessage(removed) {
  if (!removed) return "";
  return `${removed} selected ${removed === 1 ? "occurrence" : "occurrences"} became incompatible and ${removed === 1 ? "was" : "were"} deselected.`;
}

function refreshShapeOccurrenceRows() {
  const occurrences = typeof $ === "function" ? $("shapeOccurrenceList") : null;
  const detail = typeof $ === "function" ? $("shapeDetail") : null;
  if (occurrences) {
    const listScrollTop = occurrences.scrollTop || 0;
    const detailScrollTop = detail ? (detail.scrollTop || 0) : 0;
    occurrences.innerHTML = (shapesUI.detail?.occurrences || []).map(renderShapeOccurrence).join("") ||
      '<div class="shape-empty">No occurrences found.</div>';
    occurrences.scrollTop = listScrollTop;
    if (detail) detail.scrollTop = detailScrollTop;
  }
}

function refreshShapeNameControl() {
  const current = shapesUI.container?.querySelector(".shape-name-editor");
  if (!current || !shapesUI.detail || typeof document === "undefined") return;
  const detail = typeof $ === "function" ? $("shapeDetail") : null;
  const detailScrollTop = detail ? (detail.scrollTop || 0) : 0;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = shapeNameControl(shapesUI.detail);
  current.replaceWith(wrapper.firstElementChild);
  if (detail) detail.scrollTop = detailScrollTop;
}

function updateShapeNameFeedback(input) {
  const name = shapeTargetName(), validation = shapeNameValidation(name);
  const compatibility = name && validation.valid
    ? shapeNameCompatibility({ label: name }, shapeTargetVoicing(), name) : null;
  const invalid = Boolean(name && !validation.valid);
  const conflict = Boolean(name && validation.valid && compatibility === false);
  input?.setAttribute("aria-invalid", invalid || conflict ? "true" : "false");
  const status = typeof $ === "function" ? $("shapeNameStatus") : null;
  if (!status) return;
  status.classList.toggle("shape-error", invalid || conflict);
  status.textContent = invalid ? "Not a valid ChordMark chord name."
    : conflict ? `“${name}” conflicts with the target fingering.`
      : name ? (compatibility === true ? "Name matches the target fingering." : "Name is valid; compatibility is unknown.")
        : "Blank keeps each selected row’s stored chord name exactly as written.";
}

function setShapeNameProposal(value, { announce = true, refreshControl = true } = {}) {
  if (!shapeTargetVoicing()) return false;
  const target = String(value ?? "").trim();
  if (target === shapeTargetName()) return true;
  shapesUI.targetName = target;
  const removed = pruneShapeSelection(shapeTargetVoicing(), target);
  refreshShapeOccurrenceRows();
  if (refreshControl) refreshShapeNameControl();
  renderShapeSelection();
  const deselected = shapeDeselectionMessage(removed);
  if (announce) {
    const base = target
      ? "Updated the chord-name target. Review compatibility and select the occurrences to change."
      : "Chord names will be retained exactly as stored. Review and select the occurrences to change.";
    setShapeStatus(deselected ? `${base} ${deselected}` : base);
  } else if (deselected) {
    setShapeStatus(deselected);
  }
  return true;
}

function decorateShapeFretboard(holder) {
  if (!holder?.isConnected && typeof document !== "undefined") return;
  const input = holder?.querySelector(".fb-text");
  if (input) {
    input.id = "shapeVoicingText";
    input.setAttribute("aria-label", "Fingering to apply, six comma-separated string values");
    input.setAttribute("aria-describedby", "shapeVoicingHelp");
  }
  if (!holder?.querySelector("#shapeVoicingHelp") && typeof document !== "undefined") {
    const help = document.createElement("small");
    help.id = "shapeVoicingHelp";
    help.className = "shape-fretboard-help";
    help.textContent = "Use x for muted or frets 0–24, separated by commas. Press Enter to preview.";
    holder.appendChild(help);
  }
}

function mountShapeFretboard() {
  const target = shapeTargetVoicing();
  const holder = typeof $ === "function" ? $("shapeFretboard") : null;
  if (!target || !holder || typeof window === "undefined" || typeof window.Fretboard !== "function") return;
  holder.innerHTML = "";
  holder.setAttribute("role", "group");
  holder.setAttribute("aria-label", "Fingering correction editor");
  shapesUI.fretboard = window.Fretboard(holder, (voicing) => {
    setShapeProposal(voicing.join(","), { syncFretboard: false });
    queueMicrotask(() => decorateShapeFretboard(holder));
  }, { showIntervals: false });
  shapesUI.fretboard.set(shapeVoicingArray(target));
  decorateShapeFretboard(holder);
}

function setShapeProposal(value, options = {}) {
  const { announce = true, syncFretboard = false, force = false } = options || {};
  const target = normalizeShapeVoicing(value);
  if (!target || !normalizeShapeVoicing(shapesUI.detail?.voicing)) return false;
  if (target === shapeTargetVoicing() && !force) return true;
  shapesUI.targetVoicing = target;
  const removed = pruneShapeSelection(target, shapeTargetName());
  const detail = typeof $ === "function" ? $("shapeDetail") : null;
  const detailScrollTop = detail ? (detail.scrollTop || 0) : 0;
  const effective = typeof $ === "function" ? $("shapeEffectiveVoicing") : null;
  if (effective) effective.textContent = target;
  refreshShapeOccurrenceRows();
  refreshShapeNameControl();
  const useDetected = shapesUI.container?.querySelector("[data-shape-use-detected]");
  if (useDetected) useDetected.disabled = target === normalizeShapeVoicing(shapesUI.detail?.voicing);
  renderShapeSelection();
  if (syncFretboard && shapesUI.fretboard) {
    shapesUI.fretboard.set(shapeVoicingArray(target));
    const holder = typeof $ === "function" ? $("shapeFretboard") : null;
    decorateShapeFretboard(holder);
  }
  if (detail) detail.scrollTop = detailScrollTop;
  const deselected = shapeDeselectionMessage(removed);
  if (announce) {
    const base = "Updated the effective target. Review and select the occurrences to change.";
    setShapeStatus(deselected ? `${base} ${deselected}` : base);
  } else if (deselected) {
    setShapeStatus(deselected);
  }
  return true;
}

function resetShapeProposal() {
  const detected = normalizeShapeVoicing(shapesUI.detail?.voicing);
  if (!detected) return false;
  const changed = detected !== shapeTargetVoicing();
  if (!setShapeProposal(detected)) return false;
  if (changed && shapesUI.fretboard) {
    shapesUI.fretboard.set(shapeVoicingArray(detected));
    const holder = typeof $ === "function" ? $("shapeFretboard") : null;
    decorateShapeFretboard(holder);
  }
  return true;
}

function renderShapeDetail() {
  const group = shapesUI.detail;
  if (!group) return;
  const occurrences = group.occurrences || [];
  const selectable = occurrences.filter((item) =>
    isSelectableShapeOccurrence(item, shapeTargetVoicing(), shapeTargetName()));
  const samples = representativeShapeOccurrences(occurrences);
  $("shapeDetail").innerHTML = `<div class="shape-detail-head">
      <div><p class="shape-eyebrow">Shape comparison</p><h2>${shapeEsc(shapeTitle(group))}</h2>
        <p class="shape-detail-labels">Recognized chart labels: ${shapeLabels(group).length
          ? shapeLabels(group).map(shapeEsc).join(" · ") : "none"}</p>
        <p class="shape-detail-scope">${shapesUI.album ? `In album ${shapeEsc(shapesUI.album)}` : "All matching occurrences in this library"}</p></div>
      <span class="shape-detail-count">${shapeCount(group.songs)} songs · ${shapeCount(group.matches)} occurrences</span>
    </div>
    <dl class="shape-metadata">
      ${group.pattern ? `<div><dt>Pattern</dt><dd>${shapeEsc(group.pattern)}</dd></div>` : ""}
      ${group.base !== undefined && group.base !== null ? `<div><dt>Base fret</dt><dd>${shapeEsc(group.base)}</dd></div>` : ""}
      <div><dt>Detected scan fingering</dt><dd>${shapeEsc(group.voicing || "Unresolved")}</dd></div>
    </dl>
    ${shapeNameControl(group)}
    ${shapeCorrectionControl(group)}
    <details class="shape-comparison">
      <summary>Decoded scan preview</summary>${renderShapeVoicing(group)}
    </details>
    <section class="shape-evidence" aria-labelledby="shapeEvidenceTitle">
      <h3 id="shapeEvidenceTitle">Representative evidence</h3>
      <p class="shape-help">Up to three examples from separate albums. Inspect the scan before applying a printed reading.</p>
      ${samples.length ? `<div class="shape-evidence-grid">${samples.map(renderShapeEvidence).join("")}</div>` : '<p class="shape-empty">No representative crop is available.</p>'}
    </section>
    <section class="shape-occurrences" aria-labelledby="shapeOccurrencesTitle">
      <div class="shape-section-head"><div><h3 id="shapeOccurrencesTitle">Affected occurrences</h3>
        <p class="shape-help">Only editable changes compatible with the retained or explicit chord name can be selected. Nothing is selected automatically.</p></div>
        <div class="shape-select-actions"><button type="button" data-shape-select-all ${selectable.length ? "" : "disabled"}>Select all editable</button>
          <button type="button" data-shape-select-none disabled>Clear selection</button></div></div>
      <div id="shapeOccurrenceList" class="shape-occurrence-list">${occurrences.map(renderShapeOccurrence).join("") || '<div class="shape-empty">No occurrences found.</div>'}</div>
      <div id="shapeSelection" class="shape-selection" aria-live="polite"></div>
    </section>
    <section class="shape-write-actions" aria-label="Apply shape changes">
      <button type="button" id="shapeApply" class="btn-primary" data-shape-apply disabled>Apply selected changes</button>
      <button type="button" id="shapeUndo" data-shape-undo ${shapesUI.latestBatch ? "" : "disabled"}>Undo most recent batch</button>
    </section>`;
  mountShapeFretboard();
  renderShapeSelection();
}

function renderShapeEvidence(item) {
  const crop = shapeCropUrl(item.id);
  return `<figure class="shape-evidence-card"><div class="shape-evidence-image">
    <img class="shape-crop" loading="lazy" src="${shapeEsc(crop)}" alt="Printed diagram evidence for ${shapeEsc(item.title || item.label || "shape")}">
    <span class="shape-crop-unavailable" hidden>Evidence crop unavailable</span></div>
    <figcaption><b>${shapeEsc(item.title || item.file)}</b><br><span>${shapeEsc(item.album)}${item.page ? ` · page ${shapeEsc(item.page)}` : ""}</span><br>
    <span>${shapeEsc(item.label || "")}${shapeLocation(item) ? ` · ${shapeEsc(shapeLocation(item))}` : ""}</span>
    ${item.basis ? `<small>${shapeEsc(shapeBasisLabel(item.basis))}</small>` : ""}
    <a class="shape-evidence-open" href="${shapeEsc(crop)}" target="_blank" rel="noopener">Inspect full crop</a></figcaption></figure>`;
}

function shapeBasisLabel(basis) {
  return ({
    recorded_evidence: "Recorded source link",
    legacy_exact_count: "Legacy reading-order match",
  })[basis] || String(basis || "").replaceAll("_", " ");
}

function renderOccurrenceFingering(value, other) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return '<span class="shape-occurrence-string shape-unresolved">—</span>';
  const cells = shapeVoicingCells(trimmed);
  const otherTrimmed = String(other ?? "").trim();
  const comparison = otherTrimmed ? shapeVoicingCells(otherTrimmed) : [];
  const comparable = comparison.length === cells.length && Boolean(normalizeShapeVoicing(otherTrimmed));
  return cells.map((cell, index) => {
    const stringName = SHAPE_STRINGS[index] || `String ${index + 1}`;
    const fretLabel = shapeFretLabel(cell);
    const accessible = `${stringName}: ${fretLabel}`;
    const changed = comparable && cell.toLowerCase() !== String(comparison[index] ?? "").toLowerCase();
    return `<span class="shape-occurrence-string${changed ? " shape-changed" : ""}" aria-label="${shapeEsc(accessible)}" title="${shapeEsc(accessible)}">${shapeEsc(shapeFretPill(cell))}</span>`;
  }).join(" ");
}

function renderShapeOccurrence(item) {
  const target = shapeTargetVoicing();
  const targetName = shapeTargetName();
  const targetLabel = shapeTargetLabel(item, targetName);
  const compatibility = shapeNameCompatibility(item, target, targetName);
  const needsChange = shapeOccurrenceNeedsChange(item, target, targetName);
  const selectable = isSelectableShapeOccurrence(item, target, targetName);
  const checked = selectable && shapesUI.selected.has(String(item.id));
  let explanation = "";
  if (!item.editable) explanation = "Read-only evidence.";
  else if (!target) explanation = "Group fingering is unresolved; edit this occurrence in its song.";
  else if (compatibility === false && targetName)
    explanation = `Target chord name “${shapeEsc(targetName)}” is incompatible with the target fingering; choose another name or fingering.`;
  else if (compatibility === false)
    explanation = `Target fingering conflicts with retained chord label “${shapeEsc(item.label || "(blank)")}”; edit this exception in its song.`;
  else if (!needsChange) explanation = "Current and target name and fingering already agree.";
  return `<article class="shape-occurrence ${selectable ? "shape-editable" : "shape-readonly"}">
    <div class="shape-occurrence-select">${selectable
      ? `<input type="checkbox" data-shape-select="${shapeEsc(item.id)}"${checked ? " checked" : ""} aria-label="Select ${shapeEsc(item.title || item.file)}">`
      : '<span class="shape-lock" aria-label="Not editable" title="This occurrence cannot be changed">—</span>'}</div>
    <div class="shape-occurrence-main"><b>${shapeEsc(item.title || item.file)}</b>
      <span>${shapeEsc(item.album)} / ${shapeEsc(item.file)}${shapeLocation(item) ? ` · ${shapeEsc(shapeLocation(item))}` : ""}</span>
      <span class="shape-occurrence-label">${shapeEsc(item.label || "")}</span>
      <div class="shape-occurrence-names"><span>Current name</span><code>${shapeEsc(item.label || "(blank)")}</code>
        <span>Target name</span><code>${shapeEsc(targetLabel || "(blank)")}</code></div>
      <div class="shape-occurrence-voicings"><span>Current fingering</span><code>${renderOccurrenceFingering(item.editorial, target)}</code>
        <span>Target fingering</span><code>${renderOccurrenceFingering(target, item.editorial)}</code></div>
      ${!selectable && explanation ? `<small class="shape-occurrence-warning">${explanation}</small>` : ""}</div>
    <button type="button" class="shape-jump" data-shape-jump="${shapeEsc(item.id)}">Jump to song</button>
  </article>`;
}

function selectedShapeOccurrences() {
  return (shapesUI.detail?.occurrences || []).filter((item) =>
    shapesUI.selected.has(String(item.id)) &&
      isSelectableShapeOccurrence(item, shapeTargetVoicing(), shapeTargetName()));
}

function renderShapeSelection() {
  const selection = typeof $ === "function" ? $("shapeSelection") : null;
  if (!selection || !shapesUI.detail) return;
  const items = selectedShapeOccurrences(), files = [], seen = new Set();
  for (const item of items) {
    const label = `${item.album}/${item.file}`;
    if (!seen.has(label)) { seen.add(label); files.push(label); }
  }
  selection.innerHTML = items.length
    ? `<b>${items.length} ${items.length === 1 ? "occurrence" : "occurrences"} selected</b><span>Affected saved files:</span><ul>${files.map((file) => `<li>${shapeEsc(file)}</li>`).join("")}</ul>`
    : "No changes selected.";
  const clear = shapesUI.container.querySelector("[data-shape-select-none]");
  if (clear) clear.disabled = !items.length || shapesUI.writePending;
  syncShapeControls();
}

function syncShapeControls() {
  if (!shapesUI.container || typeof $ !== "function") return;
  const disabled = shapesUI.listPending || shapesUI.detailPending || shapesUI.writePending;
  if ($("shapeSearch")) $("shapeSearch").disabled = shapesUI.writePending;
  if ($("shapeAlbum")) $("shapeAlbum").disabled = shapesUI.writePending;
  shapesUI.container?.querySelectorAll("[data-shape-open],[data-shape-jump],[data-shape-refresh]")
    .forEach((button) => { button.disabled = disabled; });
  if ($("shapeRefresh")) $("shapeRefresh").disabled = disabled;
  shapesUI.container?.querySelectorAll("[data-shape-page]").forEach((button) => {
    const page = Number(button.dataset.shapePage);
    button.disabled = disabled || page < 1 || page > shapesUI.pages;
  });
  const selectAll = shapesUI.container?.querySelector("[data-shape-select-all]");
  if (selectAll) {
    selectAll.disabled = disabled || !(shapesUI.detail?.occurrences || [])
      .some((item) => isSelectableShapeOccurrence(item, shapeTargetVoicing(), shapeTargetName()));
  }
  const apply = $("shapeApply");
  const name = shapeTargetName(), validation = shapeNameValidation(name);
  const nameConflict = Boolean(name && validation.valid &&
    shapeNameCompatibility({ label: name }, shapeTargetVoicing(), name) === false);
  if (apply) apply.disabled = disabled || !shapeTargetVoicing() || !validation.valid || nameConflict || selectedShapeOccurrences().length === 0;
  shapesUI.container?.querySelectorAll("[data-shape-undo]").forEach((undo) => {
    undo.disabled = disabled || !shapesUI.latestBatch;
  });
}

function handleShapesClick(event) {
  const refresh = event.target.closest?.("[data-shape-refresh]");
  if (refresh && !refresh.disabled) { refreshShapesWorkspace({ preserveDetail: Boolean(shapesUI.detail) }); return; }
  const open = event.target.closest?.("[data-shape-open]");
  if (open) { openShapeGroup(open.dataset.shapeOpen); return; }
  const page = event.target.closest?.("[data-shape-page]");
  if (page && !page.disabled) {
    shapesUI.page = Number(page.dataset.shapePage); loadShapeGroups({ resetDetail: true }); return;
  }
  if (event.target.closest?.("[data-shape-select-all]")) {
    for (const item of shapesUI.detail?.occurrences || [])
      if (isSelectableShapeOccurrence(item, shapeTargetVoicing(), shapeTargetName()))
        shapesUI.selected.add(String(item.id));
    shapesUI.container.querySelectorAll("[data-shape-select]").forEach((input) => { input.checked = true; });
    renderShapeSelection(); return;
  }
  if (event.target.closest?.("[data-shape-select-none]")) {
    shapesUI.selected.clear();
    shapesUI.container.querySelectorAll("[data-shape-select]").forEach((input) => { input.checked = false; });
    renderShapeSelection(); return;
  }
  if (event.target.closest?.("[data-shape-use-detected]")) {
    resetShapeProposal(); return;
  }
  const suggestion = event.target.closest?.("[data-shape-name-suggestion]");
  if (suggestion) { setShapeNameProposal(suggestion.dataset.shapeNameSuggestion); return; }
  const jump = event.target.closest?.("[data-shape-jump]");
  if (jump) { jumpToShapeOccurrence(jump.dataset.shapeJump); return; }
  if (event.target.closest?.("[data-shape-apply]")) { applySelectedShapeOccurrences(); return; }
  if (event.target.closest?.("[data-shape-undo]")) undoLatestShapeBatch();
}

async function jumpToShapeOccurrence(id) {
  const item = (shapesUI.detail?.occurrences || []).find((row) => String(row.id) === String(id));
  if (!item) return;
  if (typeof openShapeOccurrence !== "function") {
    setShapeStatus("Song navigation is unavailable.", "error"); return;
  }
  try {
    setShapeStatus(`Opening ${item.title || item.file}…`);
    const opened = await openShapeOccurrence(item); // Includes document_sha256 for revalidation.
    if (opened === false) setShapeStatus("The song was not opened; unsaved work may still be active.", "error");
  } catch (error) { setShapeStatus(`Could not open the song: ${shapeError(error)}`, "error"); }
}

function shapeWritesAvailable(files) {
  if (typeof shapeWritesReady === "function") {
    try { return Boolean(shapeWritesReady(files)); }
    catch (_error) { return false; }
  }
  return !shapeWriteBlockReason();
}

function refreshedShapeStateMessage(result) {
  return result === false || result?.ok === false || result?.stale
    ? " The library changed, but the open song could not be refreshed; reload it before editing." : "";
}

async function refreshAfterShapesWrite(files) {
  if (typeof refreshAfterShapeWrite !== "function") return "";
  try { return refreshedShapeStateMessage(await refreshAfterShapeWrite(files || [])); }
  catch (_error) {
    return " The library changed, but the open song could not be refreshed; reload it before editing.";
  }
}

async function reloadShapesAfterWrite(groupId) {
  shapesUI.groups = []; shapesUI.loaded = false;
  const loaded = await loadShapeGroups({ quiet: true });
  if (loaded && groupId !== undefined && groupId !== null) await openShapeGroup(groupId, { quiet: true });
}

function shapeApplyPayload(items, voicing = shapeTargetVoicing(), name = shapeTargetName()) {
  const target = normalizeShapeVoicing(voicing);
  if (!target) return null;
  const chord = String(name || "").trim();
  return {
    selected: (items || []).map((item) => item.id), voicing: target,
    ...(chord ? { chord } : {}),
  };
}

function validatedShapeEditorTarget() {
  const target = shapeTargetVoicing();
  const input = shapesUI.container?.querySelector("#shapeFretboard .fb-text, [data-shape-voicing-text]");
  if (!input) return target;
  const typed = normalizeShapeVoicing(input.value);
  if (!typed || typed !== target) {
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return "";
  }
  return target;
}

async function applySelectedShapeOccurrences() {
  if (shapesUI.writePending || !shapesUI.detail) return;
  const target = validatedShapeEditorTarget();
  if (!target) {
    setShapeStatus("The fingering editor contains an invalid or unconfirmed value; no files were changed.", "error");
    return;
  }
  const nameInput = shapesUI.container?.querySelector("[data-shape-name]");
  const name = String(nameInput ? nameInput.value : shapeTargetName()).trim();
  if (name !== shapeTargetName()) {
    setShapeStatus("The chord-name editor contains an unconfirmed value; no files were changed.", "error");
    return;
  }
  const validation = shapeNameValidation(name);
  if (!validation.valid) {
    nameInput?.setAttribute("aria-invalid", "true"); nameInput?.focus();
    setShapeStatus("Enter a valid ChordMark chord name other than %, or leave the field blank; no files were changed.", "error");
    return;
  }
  if (name && shapeNameCompatibility({ label: name }, target, name) === false) {
    nameInput?.setAttribute("aria-invalid", "true"); nameInput?.focus();
    setShapeStatus(`Chord name “${name}” is incompatible with the target fingering; no files were changed.`, "error");
    return;
  }
  const items = selectedShapeOccurrences();
  if (!shapeWritesAvailable(items)) {
    setShapeStatus(shapeWriteBlockReason() || "Wait for the current song operation to finish before changing library files.", "error"); return;
  }
  if (!items.length) { setShapeStatus("Select at least one editable difference.", "error"); return; }
  const groupId = shapesUI.detail.id;
  shapesUI.writePending = true; shapesUI.listGeneration += 1; shapesUI.detailGeneration += 1;
  syncShapeControls(); setShapeStatus(`Applying ${items.length} selected ${items.length === 1 ? "reading" : "readings"}…`);
  try {
    // Recheck at the last possible moment: saving/loading may have started since the click.
    if (!shapeWritesAvailable(items)) throw new Error("The current song became busy or unsaved; no library files were changed.");
    const payload = shapeResponse(await shapeRequest(`/api/shapes/${encodeURIComponent(groupId)}/apply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shapeApplyPayload(items, target, name)),
    }), "Could not apply the selected readings.");
    if (!payload.ok) throw new Error("The server did not confirm the shape update.");
    rememberShapeUndo(payload.batch_id ? { id: String(payload.batch_id), files: payload.files || [] } : null);
    shapesUI.selected.clear();
    const warning = await refreshAfterShapesWrite(payload.files);
    await reloadShapesAfterWrite(groupId);
    setShapeStatus(`Applied ${shapeCount(payload.entries)} entries in ${shapeCount(payload.songs)} songs.${warning}`,
      warning ? "error" : "success");
  } catch (error) { setShapeStatus(`Apply failed: ${shapeError(error)}`, "error"); }
  finally { shapesUI.writePending = false; syncShapeControls(); }
}

async function undoLatestShapeBatch() {
  if (shapesUI.writePending || !shapesUI.latestBatch) return;
  const batch = shapesUI.latestBatch;
  if (!shapeWritesAvailable(batch.files)) {
    setShapeStatus(shapeWriteBlockReason() || "Wait for the current song operation to finish before changing library files.", "error"); return;
  }
  const groupId = shapesUI.detail?.id;
  shapesUI.writePending = true; shapesUI.listGeneration += 1; shapesUI.detailGeneration += 1;
  syncShapeControls(); setShapeStatus("Undoing the most recent shape batch…");
  try {
    if (!shapeWritesAvailable(batch.files)) throw new Error("The current song became busy or unsaved; no library files were changed.");
    const payload = shapeResponse(await shapeRequest(`/api/shapes/batch/${encodeURIComponent(batch.id)}/undo`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), "Could not undo the shape batch.");
    if (!payload.ok) throw new Error("The server did not confirm the undo.");
    rememberShapeUndo(null);
    const warning = await refreshAfterShapesWrite(payload.files || batch.files);
    await reloadShapesAfterWrite(groupId);
    setShapeStatus(`Undid the most recent batch across ${shapeCount(payload.songs)} songs.${warning}`,
      warning ? "error" : "success");
  } catch (error) { setShapeStatus(`Undo failed: ${shapeError(error)}`, "error"); }
  finally { shapesUI.writePending = false; syncShapeControls(); }
}

function renderShapes() {
  if (!ensureShapesWorkspace()) return;
  if (!shapesUI.loaded && !shapesUI.listPending) {
    refreshShapesWorkspace({ preserveDetail: Boolean(shapesUI.detail) });
  }
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    SHAPE_STRINGS, SHAPE_UNDO_KEY, applySelectedShapeOccurrences, ensureShapesWorkspace,
    handleShapesClick, loadShapeGroups, pruneShapeSelection, refreshShapeOccurrenceRows,
    refreshShapesWorkspace, renderShapeDetail, setShapeStatus, shapeCorrectionControl,
    shapeCount, shapeApplyPayload, shapeDisagreementCount, shapeEffectiveVoicing,
    shapeFretLabel, shapeFretPill, shapeNameControl, isSelectableShapeOccurrence,
    normalizeShapeColumns, openShapeGroup, normalizeShapeVoicing, resetShapeProposal,
    representativeShapeOccurrences, renderOccurrenceFingering, renderShapeOccurrence,
    renderShapeVoicing, renderShapes, setShapeNameProposal, setShapeProposal,
    shapeBasisLabel, shapeNameCompatibility, shapeNameValidation,
    shapeOccurrenceNeedsChange, shapeTargetLabel, shapeTargetName, shapeTargetVoicing,
    shapeTitle, shapeListUrl, shapeWritesAvailable, shapeWriteBlockReason, shapesUI,
    syncShapeControls, undoLatestShapeBatch, wireShapesWorkspace,
  };
}
