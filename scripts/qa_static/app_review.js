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
  let requestToken = 0;

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
      const row = document.createElement("div");
      row.className = "rev-row";
      row.innerHTML =
        `<span class="rnm">${esc(flag.chord || "—")}</span>` +
        `<span class="rwhere">${esc(flag.label)} · bar ${flag.bi + 1}</span>` +
        `<span class="rwhy">${esc(flag.reason)}</span>`;
      row.addEventListener("click", () => jumpToFlag(flag));
      list.appendChild(row);
    });
  }

  async function refresh() {
    const doc = state.doc;
    const token = ++requestToken;
    if (!doc) {
      paintSummary(null);
      return;
    }
    const result = await api("/api/review-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc }),
    });
    if (token !== requestToken || state.doc !== doc) return;
    if (!result.ok) {
      $("reviewMsg").textContent = `Could not read review: ${result.error || "unknown error"}`;
      return;
    }
    paintSummary(result.review);
  }

  function render() {
    const disabled = !state.doc;
    ["reviewField", "reviewStatus", "reviewReviewer", "reviewEvidence", "reviewRecord"].forEach(
      (id) => { const el = $(id); if (el) el.disabled = disabled; });
    $("reviewMsg").textContent = disabled ? "No song loaded." : "";
    paintFlags();
    refresh().catch((error) => {
      $("reviewMsg").textContent = `Could not read review: ${String(error)}`;
    });
  }

  async function recordSelected() {
    if (!state.doc) return;
    const button = $("reviewRecord");
    const message = $("reviewMsg");
    const doc = state.doc;
    button.disabled = true;
    message.textContent = "recording…";
    try {
      const result = await api("/api/review-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc,
          field: $("reviewField").value,
          status: $("reviewStatus").value,
          reviewer: $("reviewReviewer").value,
          evidence: $("reviewEvidence").value,
        }),
      });
      if (state.doc !== doc) {
        message.textContent = "Document changed while review was recording; try again.";
        return;
      }
      if (!result.ok) {
        message.textContent = result.error || "Could not record review.";
        return;
      }
      pushUndo();
      state.doc = result.doc;
      markDirty();
      renderProvenance();
      paintSummary(result.review);
      message.textContent = "Recorded in memory — Save song to persist.";
    } catch (error) {
      message.textContent = `Could not record review: ${String(error)}`;
    } finally {
      button.disabled = false;
    }
  }

  return { FIELD_LABELS, STATUS_LABELS, rows, render, refresh, recordSelected };
});

function renderReview() { ReviewUI.render(); }
