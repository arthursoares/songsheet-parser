// Whole-song, field-level review UI. The server owns canonical fingerprints;
// this file presents the returned status and applies the returned document to
// the existing undo/dirty/save workflow.
(function initReviewUI(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReviewUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function reviewFactory() {
  "use strict";

  const FIELD_LABELS = {
    structure: "Structure",
    chords: "Chord names",
    lyrics: "Lyrics",
    voicing: "Editorial voicings",
    voicing_printed: "Printed diagrams",
    key: "Key",
  };
  const STATUS_LABELS = {
    pending: "Pending",
    in_progress: "In progress",
    verified: "Verified",
    stale: "Stale — values changed",
    invalid: "Invalid review record",
  };
  const VALID_INPUT_STATUSES = new Set(["pending", "in_progress", "verified"]);
  let requestToken = 0;
  let syncedDoc = null;
  let syncedField = null;
  let summarySnapshot = null;
  let recording = false;
  let refreshQueued = false;

  function wire() {
    for (const [id, key] of [["reviewReviewer", "qaReviewReviewer"], ["reviewDefaultEvidence", "qaReviewEvidence"]]) {
      const input = $(id);
      if (!input) continue;
      try { input.value = localStorage.getItem(key) || ""; } catch { /* Storage is optional. */ }
      input.addEventListener("input", () => {
        try { localStorage.setItem(key, input.value); } catch { /* Recording still works. */ }
      });
    }
    $("reviewStatusBody")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-review-field]");
      if (!button || recording) return;
      if (button.dataset.reviewAction === "verify") void verifyField(button.dataset.reviewField);
      else editField(button.dataset.reviewField);
    });
    $("reviewSourceIssues")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-review-page]");
      if (button && typeof scrollScanToPage === "function") scrollScanToPage(Number(button.dataset.reviewPage));
    });
    $("verificationChordProgress")?.addEventListener("click", () => openChordReview());
    $("reviewDone")?.addEventListener("click", markDoneAndSave);
    $("reviewDoneWarning")?.addEventListener("click", () => showView("review"));
  }

  function relativeTimestamp(timestamp, now = Date.now()) {
    const date = new Date(timestamp);
    if (!timestamp || !Number.isFinite(date.getTime())) return timestamp || "";
    const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function currentSummary() {
    return summarySnapshot && documentStillCurrent(summarySnapshot.doc, summarySnapshot.serialized)
      ? summarySnapshot.review : null;
  }

  function updateBridge() {
    const summary = currentSummary();
    const fields = rows(summary);
    const stale = summary ? fields.filter((row) => row.status === "stale").length : 0;
    const flags = state.doc ? (state.flags || []).length : 0;
    const badge = $("reviewBadge");
    if (badge) {
      badge.textContent = [stale ? `${stale} stale` : "", flags ? `${flags} flags` : ""].filter(Boolean).join(" · ");
      badge.hidden = !badge.textContent;
    }
    const ready = !!summary && fields.every((row) => row.status === "verified") && !flags;
    const done = $("reviewDone");
    if (done) { done.hidden = !ready; done.disabled = recording; }
    const warning = $("reviewDoneWarning");
    if (warning) {
      const remaining = fields.filter((row) => row.status !== "verified").length;
      warning.hidden = !state.doc || state.doc.document?.status !== "done" || ready;
      warning.textContent = summary
        ? `Done with ${remaining} unverified fields${stale ? ` (${stale} stale)` : ""} and ${flags} flagged chords — Open Verification`
        : "Done — verification status needs checking. Open Verification";
    }
  }

  function documentChanged() {
    updateBridge();
    if (refreshQueued) return;
    refreshQueued = true;
    Promise.resolve().then(() => {
      refreshQueued = false;
      if (state.doc && !currentSummary()) void refresh();
      else updateBridge();
    });
  }

  function editField(field) {
    if (!Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)) return;
    $("reviewField").value = field;
    syncInputs();
    const details = $("reviewDetails");
    if (details) details.open = true;
    $("reviewStatus")?.focus?.();
  }

  function openChordReview(coords) {
    if (!state.doc) return;
    if (state.activeView !== "chordReview") toggleChordReview();
    if (state.activeView === "chordReview" && coords) selectChordReviewEntry(coords);
  }

  async function markDoneAndSave() {
    if (!state.doc || recording) return;
    if ((typeof chordEditorHasDraft === "function" && chordEditorHasDraft()) ||
        (typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits())) {
      $("reviewMsg").textContent = "Apply pending editor changes before marking the song done.";
      return;
    }
    if (typeof flushBlurCommittedInputs === "function" && !flushBlurCommittedInputs()) {
      $("reviewMsg").textContent = "Fix invalid editor input before marking the song done.";
      return;
    }
    const doc = state.doc;
    const serialized = JSON.stringify(doc);
    await refresh();
    const summary = currentSummary();
    if (!documentStillCurrent(doc, serialized) || !summary ||
        rows(summary).some((row) => row.status !== "verified") || (state.flags || []).length) return;
    pushUndo();
    state.doc.document ||= {};
    state.doc.document.status = "done";
    $("statusSel").value = "done";
    markDirty();
    updateBridge();
    await save();
  }

  function documentStillCurrent(doc, serialized) {
    return state.doc === doc && JSON.stringify(state.doc) === serialized;
  }

  function storedFieldReview(doc, field) {
    const review = doc && doc._meta && doc._meta.review;
    if (!review || typeof review !== "object" || review.version !== 1) return null;
    if (!review.fields || typeof review.fields !== "object") return null;
    const record = review.fields[field];
    return record && typeof record === "object" ? record : null;
  }

  function syncInputs() {
    const fieldEl = $("reviewField");
    const field = fieldEl && fieldEl.value ? fieldEl.value : "structure";
    const record = state.doc ? storedFieldReview(state.doc, field) : null;
    const statusEl = $("reviewStatus");
    if (statusEl) {
      statusEl.value = record && VALID_INPUT_STATUSES.has(record.status) ? record.status : "pending";
    }
    const evidenceEl = $("reviewEvidence");
    if (evidenceEl) {
      evidenceEl.value = record && typeof record.evidence === "string" ? record.evidence : "";
    }
    syncedDoc = state.doc || null;
    syncedField = field;
  }

  function rows(summary) {
    const fields = (summary && summary.fields) || {};
    return Object.keys(FIELD_LABELS).map((field) => {
      const record = fields[field] || {};
      const present = Object.prototype.hasOwnProperty.call(fields, field);
      const status = !present ? "pending" : STATUS_LABELS[record.status] ? record.status : "invalid";
      return {
        field,
        label: FIELD_LABELS[field],
        status,
        statusLabel: STATUS_LABELS[status],
        reviewer: record.reviewer || "",
        evidence: record.evidence || "",
        timestamp: record.timestamp || "",
      };
    });
  }

  function clearSummary() {
    summarySnapshot = null;
    const body = $("reviewStatusBody");
    if (body) body.innerHTML = "";
    updateBridge();
  }

  function paintLoading() {
    const body = $("reviewStatusBody");
    if (body) {
      body.innerHTML = '<tr><td colspan="5" class="muted">Loading verification status…</td></tr>';
    }
  }

  function paintSummary(summary) {
    summarySnapshot = { doc: state.doc, serialized: JSON.stringify(state.doc), review: summary };
    updateBridge();
    const body = $("reviewStatusBody");
    if (!body) return;
    body.innerHTML = rows(summary).map((row) =>
      `<tr>` +
      `<th>${esc(row.label)}</th>` +
      `<td><span class="review-state ${esc(row.status)}">${esc(row.statusLabel)}</span></td>` +
      `<td>${esc(row.reviewer || "—")}${row.timestamp ? `<time datetime="${esc(row.timestamp)}" title="${esc(row.timestamp)}">${esc(relativeTimestamp(row.timestamp))}</time>` : ""}</td>` +
      `<td title="${esc(row.evidence)}">${esc(row.evidence || "—")}</td>` +
      `<td class="review-actions"><button type="button" data-review-action="verify" data-review-field="${row.field}"${recording ? " disabled" : ""}>Verify ✓</button> ` +
      `<button type="button" data-review-action="edit" data-review-field="${row.field}"${recording ? " disabled" : ""}>Edit</button></td>` +
      `</tr>`).join("");
  }

  function sourceIssues(doc) {
    const diagnostics = doc && doc._meta && doc._meta.diagram_diagnostics;
    if (!diagnostics || typeof diagnostics !== "object") return [];
    return Object.values(diagnostics).map((wrapper) => wrapper && wrapper.record)
      .filter((record) => record && Number.isInteger(record.page) && record.page > 0)
      .map((record) => {
        const diagrams = Array.isArray(record.diagrams) ? record.diagrams.length : null;
        const entries = Number.isInteger(record.page_eligible_observation_count)
          ? record.page_eligible_observation_count
          : Array.isArray(record.eligible_observation_ids) ? record.eligible_observation_ids.length : null;
        const counts = diagrams !== null && entries !== null
          ? ` (${diagrams} detected diagrams, ${entries} chord occurrences)` : "";
        return `Page ${record.page}: automatic diagram pairing needs review${counts}. Inspect the scan before accepting fingerings.`;
      });
  }

  function paintFlags() {
    const list = $("reviewFlags");
    if (!list) return;
    const flags = state.flags || [];
    const title = $("reviewFlagsTitle");
    if (title) title.textContent = `Flagged chords (${flags.length})`;
    if (!flags.length) {
      list.innerHTML = `<div class="review-empty">No flagged chords ✓</div>`;
      return;
    }
    list.innerHTML = "";
    flags.forEach((flag) => {
      const row = document.createElement("div");
      row.className = "rev-row";
      const entry = typeof chordAt === "function" ? chordAt(flag) : {};
      const reviewStatus = typeof chordReviewStatus === "function" ? chordReviewStatus(entry) : "pending";
      const printDiff = entry.voicing_printed != null && entry.voicing_printed !== entry.voicing;
      row.innerHTML =
        `<span class="rnm">${esc(flag.chord || "—")}</span>` +
        `<span class="rwhere">${esc(flag.label)} · bar ${flag.bi + 1}</span>` +
        `<code>${esc(entry.voicing || "No voicing")}</code>` +
        `<span class="review-state">${esc(reviewStatus)}</span>` +
        (printDiff ? '<span class="review-state stale">Print differs</span>' : "") +
        `<span class="rwhy">${esc(flag.reason)}</span>`;
      for (const [label, action] of [["Review", () => openChordReview(flag)], ["Edit", () => jumpToFlag(flag)]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", action);
        row.appendChild(button);
      }
      list.appendChild(row);
    });
  }

  function resetForDocument() {
    requestToken += 1;
    syncInputs();
    clearSummary();
    const disabled = !state.doc;
    ["reviewField", "reviewStatus", "reviewReviewer", "reviewEvidence", "reviewRecord"].forEach(
      (id) => { const el = $(id); if (el) el.disabled = disabled; });
    const msg = $("reviewMsg");
    if (msg) msg.textContent = "";
    if (disabled) {
      const progress = $("verificationChordProgress");
      if (progress) progress.textContent = "";
      const sourceBox = $("reviewSourceIssues");
      if (sourceBox) {
        sourceBox.classList?.add("hidden");
        sourceBox.innerHTML = "";
      }
      const flags = $("reviewFlags");
      if (flags) flags.innerHTML = "";
    }
  }

  async function refresh() {
    const doc = state.doc;
    const serialized = doc ? JSON.stringify(doc) : "";
    const token = ++requestToken;
    if (!doc) {
      clearSummary();
      return;
    }
    paintLoading();
    updateBridge();
    let result;
    try {
      result = await api("/api/review-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"doc":${serialized}}`,
      });
    } catch (error) {
      if (token !== requestToken) return;
      if (!documentStillCurrent(doc, serialized)) {
        if (state.doc) void refresh();
        else clearSummary();
        return;
      }
      clearSummary();
      const msg = $("reviewMsg");
      if (msg) msg.textContent = `Could not read review: ${String(error)}`;
      return;
    }
    if (token !== requestToken) return;
    if (!documentStillCurrent(doc, serialized)) {
      if (state.doc) void refresh();
      else clearSummary();
      return;
    }
    if (!result || !result.ok) {
      clearSummary();
      const msg = $("reviewMsg");
      if (msg) msg.textContent = `Could not read review: ${(result && result.error) || "unknown error"}`;
      return;
    }
    const msg = $("reviewMsg");
    if (msg && msg.textContent && msg.textContent.startsWith("Could not read review:")) {
      msg.textContent = "";
    }
    paintSummary(result.review);
  }

  function render() {
    const disabled = !state.doc;
    const fieldEl = $("reviewField");
    const field = fieldEl && fieldEl.value ? fieldEl.value : "structure";
    if (!state.doc || state.doc !== syncedDoc || field !== syncedField) {
      syncInputs();
    }
    const progress = $("verificationChordProgress");
    if (progress && !disabled &&
        typeof entryCoords === "function" &&
        typeof chordReviewStatus === "function" &&
        typeof chordAt === "function") {
      const statuses = entryCoords().map((coords) => chordReviewStatus(chordAt(coords)));
      const reviewed = statuses.filter((status) => status === "reviewed").length;
      const deferred = statuses.filter((status) => status === "deferred").length;
      progress.textContent = `Chord review · ${reviewed} of ${statuses.length} reviewed · ${deferred} deferred`;
    } else if (progress) {
      progress.textContent = "";
    }
    ["reviewField", "reviewStatus", "reviewReviewer", "reviewEvidence", "reviewRecord"].forEach(
      (id) => { const el = $(id); if (el) el.disabled = disabled; });
    const msg = $("reviewMsg");
    if (msg) msg.textContent = disabled ? "No song loaded." : "";
    const sourceBox = $("reviewSourceIssues");
    if (sourceBox) {
      const issues = sourceIssues(state.doc);
      sourceBox.classList?.toggle("hidden", !issues.length);
      sourceBox.innerHTML = issues.map((message) => {
        const page = /^Page (\d+)/.exec(message)[1];
        return `<p><button type="button" data-review-page="${page}">Page ${page}</button>${esc(message.slice(`Page ${page}`.length))}</p>`;
      }).join("");
    }
    paintFlags();
    void refresh();
  }

  function recordSelected() {
    return recordField($("reviewField")?.value || "structure", $("reviewStatus").value, $("reviewEvidence").value);
  }

  function verifyField(field) {
    const selected = $("reviewField")?.value === field;
    const evidence = selected && $("reviewEvidence")?.value || $("reviewDefaultEvidence")?.value ||
      storedFieldReview(state.doc, field)?.evidence || "";
    return recordField(field, "verified", evidence);
  }

  async function recordField(field, status, evidence) {
    if (!state.doc || recording || !Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)) return;
    recording = true;
    const button = $("reviewRecord");
    const message = $("reviewMsg");
    const doc = state.doc;
    const serialized = JSON.stringify(doc);
    if (button) button.disabled = true;
    $("reviewStatusBody")?.querySelectorAll?.("button").forEach((el) => { el.disabled = true; });
    if (message) message.textContent = "recording…";
    try {
      const result = await api("/api/review-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc: JSON.parse(serialized),
          field,
          status,
          reviewer: $("reviewReviewer").value,
          evidence,
        }),
      });
      if (state.doc !== doc) return;
      if (!documentStillCurrent(doc, serialized)) {
        if (message) message.textContent = "Document changed while review was recording; try again.";
        void refresh();
        return;
      }
      if (!result || !result.ok) {
        if (message) message.textContent = (result && result.error) || "Could not record review.";
        return;
      }
      requestToken += 1;
      pushUndo();
      state.doc = result.doc;
      syncInputs();
      markDirty();
      renderProvenance();
      paintSummary(result.review);
      if (message) message.textContent = "Recorded in memory — Save song to persist.";
    } catch (error) {
      if (state.doc !== doc) return;
      if (message) message.textContent = `Could not record review: ${String(error)}`;
    } finally {
      recording = false;
      if (button) button.disabled = !state.doc;
      $("reviewStatusBody")?.querySelectorAll?.("button").forEach((el) => { el.disabled = !state.doc; });
      updateBridge();
    }
  }

  return {
    FIELD_LABELS,
    STATUS_LABELS,
    rows,
    sourceIssues,
    documentStillCurrent,
    syncInputs,
    resetForDocument,
    render,
    refresh,
    recordSelected,
    verifyField,
    relativeTimestamp,
    wire,
    updateBridge,
    documentChanged,
    markDoneAndSave,
  };
});

function renderReview() { ReviewUI.render(); }
function resetReviewInputs() { ReviewUI.resetForDocument(); }
