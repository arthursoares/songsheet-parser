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
    const body = $("reviewStatusBody");
    if (body) body.innerHTML = "";
  }

  function paintLoading() {
    const body = $("reviewStatusBody");
    if (body) {
      body.innerHTML = '<tr><td colspan="4" class="muted">Loading verification status…</td></tr>';
    }
  }

  function paintSummary(summary) {
    const body = $("reviewStatusBody");
    if (!body) return;
    body.innerHTML = rows(summary).map((row) =>
      `<tr>` +
      `<th>${esc(row.label)}</th>` +
      `<td><span class="review-state ${esc(row.status)}">${esc(row.statusLabel)}</span></td>` +
      `<td>${esc(row.reviewer || "—")}</td>` +
      `<td title="${esc(row.evidence)}">${esc(row.evidence || "—")}</td>` +
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
    if (!flags.length) {
      list.innerHTML = `<div class="review-empty">No flagged chords ✓</div>`;
      return;
    }
    list.innerHTML = "";
    flags.forEach((flag) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "rev-row";
      row.innerHTML =
        `<span class="rnm">${esc(flag.chord || "—")}</span>` +
        `<span class="rwhere">${esc(flag.label)} · bar ${flag.bi + 1}</span>` +
        `<span class="rwhy">${esc(flag.reason)}</span>`;
      row.addEventListener("click", () => jumpToFlag(flag));
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
      sourceBox.innerHTML = issues.map((message) => `<p>${esc(message)}</p>`).join("");
    }
    paintFlags();
    void refresh();
  }

  async function recordSelected() {
    if (!state.doc) return;
    const button = $("reviewRecord");
    const message = $("reviewMsg");
    const doc = state.doc;
    const serialized = JSON.stringify(doc);
    const fieldEl = $("reviewField");
    const field = fieldEl && fieldEl.value ? fieldEl.value : "structure";
    if (button) button.disabled = true;
    if (message) message.textContent = "recording…";
    try {
      const result = await api("/api/review-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc: JSON.parse(serialized),
          field,
          status: $("reviewStatus").value,
          reviewer: $("reviewReviewer").value,
          evidence: $("reviewEvidence").value,
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
      syncedDoc = result.doc || null;
      syncedField = field;
      markDirty();
      renderProvenance();
      paintSummary(result.review);
      if (message) message.textContent = "Recorded in memory — Save song to persist.";
    } catch (error) {
      if (state.doc !== doc) return;
      if (message) message.textContent = `Could not record review: ${String(error)}`;
    } finally {
      if (button) button.disabled = !state.doc;
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
  };
});

function renderReview() { ReviewUI.render(); }
function resetReviewInputs() { ReviewUI.resetForDocument(); }
