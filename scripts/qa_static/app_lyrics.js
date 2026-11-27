// Flow and Arrange edit chord anchors over rendered lyrics. Text mode is
// available for editing a whole lyric line at once.
let lyDrag = null;
let lyPicked = null;
let lySelection = null;
let lyFlowObserver = null;
const lyDrafts = new WeakMap();
let lyDropTimer = null;

function lyricDrafts() {
  if (!lyDrafts.has(state.doc)) lyDrafts.set(state.doc, new Map());
  return lyDrafts.get(state.doc);
}

function hasLyricDrafts() {
  if (!state.doc) return false;
  const inputs = [...($("lyrics")?.querySelectorAll(".ly-line-edit, .ly-edit") || [])];
  return Boolean(lyricDrafts().size || inputs.some((input) => input._hasLyricDraft?.()));
}

function discardLyricDrafts() {
  if (!state.doc) return;
  const inputs = [...($("lyrics")?.querySelectorAll(".ly-line-edit, .ly-edit") || [])];
  lyricDrafts().clear();
  inputs.forEach((input) => input._discardDraft?.());
}

function confirmLyricDraftDiscard(resume) {
  if (!hasLyricDrafts()) return true;
  if (typeof guardUnsavedChanges === "function") return guardUnsavedChanges({
    message: "Apply your lyric edits before continuing? Invalid marker counts must be fixed first.",
    apply: () => flushBlurCommittedInputs() && !hasLyricDrafts(),
    discard: discardLyricDrafts,
    resume,
  });
  if (!confirm("Discard unapplied lyric edits? Invalid marker counts cannot be applied.")) return false;
  discardLyricDrafts();
  return true;
}

// "grid" is the saved name of the visual mode in existing browser preferences.
function lyMode() {
  const saved = localStorage.getItem("qaLyMode");
  return saved === "text" || saved === "grid" ? saved : "flow";
}

function stopLyricResize() {
  lyFlowObserver?.disconnect();
  lyFlowObserver = null;
}

function renderLyrics() {
  const root = $("lyrics");
  if (!root) return;
  stopLyricResize();
  if (!state.doc) { root.innerHTML = `<div class="empty">No song loaded.</div>`; return; }
  const scrollTop = root.scrollTop;
  if (lySelection?.doc !== state.doc) lySelection = null;
  lyDrag = lyPicked = null;
  root.classList.remove("ly-moving");
  if (lyDropTimer !== null) clearTimeout(lyDropTimer);
  lyDropTimer = null;
  root.onkeydown = null;
  root.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "ly-modebar";
  const mode = lyMode();
  bar.innerHTML = [["Flow", "flow"], ["Arrange", "grid"], ["Text", "text"]].map(([label, name]) =>
    `<button type="button" class="tab ${mode === name ? "active" : ""}" aria-pressed="${mode === name}" data-mode="${name}">${label}</button>`
  ).join("");
  bar.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirmLyricDraftDiscard(() => { localStorage.setItem("qaLyMode", b.dataset.mode); renderLyrics(); })) return;
      localStorage.setItem("qaLyMode", b.dataset.mode); renderLyrics();
    }));
  root.appendChild(bar);

  if (mode === "text") renderLyricsText(root);
  else if (mode === "flow") renderLyricsFlow(root);
  else renderLyricsGrid(root);
  root.scrollTop = scrollTop;
}

// ---- text mode: ChordMark lyric lines ----
// One row per 4 bars: a read-only chord line above an editable lyric line with
// one `_` marker per chord entry. Commit on Enter/blur; Esc reverts. The only
// invariant is the marker count — a mismatch refuses the commit with a message.
// Gluing a marker into a word ("tris_te") stores a continuation dash; text
// before the row's first marker flows back to the previous entry.
const LY_BARS_PER_ROW = 4;

function renderLyricsText(root) {
  const hint = document.createElement("div");
  hint.className = "ly-hint";
  hint.textContent = "Each _ anchors the chord shown above it. Edit text freely: " +
    "delete the space before a _ to split a word across chords (tris_te), " +
    "add one to separate. Enter/blur applies, Esc reverts. ⌘Z undoes.";
  root.appendChild(hint);

  let prevEntry = null; // last entry of the previous row (for leading text)
  song().sections.forEach((sec, si) => {
    const secEl = document.createElement("div");
    secEl.className = "ly-section";
    const lab = document.createElement("div");
    lab.className = "ly-seclabel";
    lab.textContent = sec.label || `Section ${si + 1}`;
    secEl.appendChild(lab);

    const bars = sec.bars || [];
    for (let b0 = 0; b0 < bars.length; b0 += LY_BARS_PER_ROW) {
      const rowBars = bars.slice(b0, b0 + LY_BARS_PER_ROW);
      const entries = rowBars.flat();
      if (!entries.length) continue;
      const rowEl = document.createElement("div");
      rowEl.className = "ly-row";
      const chordLine = document.createElement("div");
      chordLine.className = "ly-chordline";
      rowEl.appendChild(chordLine);

      const input = document.createElement("input");
      input.className = "ly-line-edit";
      input.setAttribute("aria-label", `Lyrics, section ${si + 1}, starting bar ${b0 + 1}`);
      input.value = window.DocOps.buildLyricLine(entries);
      const key = `${si}:${b0}`;
      input.spellcheck = false;
      let original = input.value;
      input.value = lyricDrafts().get(key) ?? original;
      const counter = document.createElement("span");
      counter.className = "ly-marker-count";
      counter.setAttribute("aria-live", "polite");
      rowEl.appendChild(counter);
      const refresh = () => {
        const markers = [...input.value.matchAll(/_/g)].map((match) => match.index);
        counter.textContent = `${markers.length}/${entries.length} _`;
        counter.className = "ly-marker-count " + (markers.length === entries.length ? "ok" : "bad");
        chordLine.innerHTML = "";
        const caret = input.selectionStart ?? 0;
        const active = Math.max(0, markers.filter((index) => index <= caret).length - 1);
        entries.forEach((entry, index) => {
          const chord = document.createElement("span");
          chord.className = "ly-text-chord" + (index === active ? " active" : "");
          chord.textContent = entry.chord;
          chord.style.insetInlineStart = `${markers[index] ?? input.value.length}ch`;
          chord.style.transform = `translateX(-${input.scrollLeft || 0}px)`;
          chordLine.appendChild(chord);
        });
        if (input.value === original) lyricDrafts().delete(key);
        else lyricDrafts().set(key, input.value);
      };
      for (const event of ["input", "click", "keyup", "focus", "scroll"]) input.addEventListener(event, refresh);
      const errEl = document.createElement("div");
      errEl.className = "ly-line-err";
      errEl.setAttribute("role", "alert");
      const prevRef = prevEntry; // entry preceding this row, frozen at render
      let cancelled = false;
      let committing = false;
      const parseDraft = () => {
        if (cancelled) return null;
        if (input.value === original) {
          errEl.textContent = "";
          return null;
        }
        const parsed = window.DocOps.parseLyricLine(input.value, entries.length);
        if (parsed === null) {
          const got = (input.value.match(/_/g) || []).length;
          errEl.textContent =
            `needs exactly ${entries.length} markers for the chords above (found ${got}) — not applied`;
          return false;
        }
        errEl.textContent = "";
        return parsed;
      };
      const validate = () => parseDraft() !== false;
      const commit = (opts = {}) => {
        if (committing) return false;
        const parsed = parseDraft();
        if (parsed === false) return false;
        if (parsed === null) return true;
        committing = true;
        if (!opts?.skipChordDraftDiscard && !prepareLyricEdit(() => commit(opts))) { committing = false; return false; }
        original = input.value;
        pushUndo();
        if (parsed.leading) {
          if (prevRef) prevRef.text = ((prevRef.text || "") + " " + parsed.leading).trim();
          else parsed.fragments[0] = (parsed.leading + " " + parsed.fragments[0]).trim();
        }
        entries.forEach((e, k) => {
          const frag = parsed.fragments[k];
          if (frag) e.text = frag; else delete e.text;
        });
        markDirty();
        // Leading text may have changed the preceding row too. Refresh clean
        // inputs in place and retain dirty drafts; canonicalizing this row
        // also prevents its leading text from being appended twice later.
        root.querySelectorAll(".ly-line-edit").forEach((field) => field._syncLyricInput?.());
        if (opts?.deferRender) {
          opts.onCommit?.();
        } else {
          renderBars();
        }
        committing = false;
        return true;
      };
      input._hasLyricDraft = () => input.value !== original;
      input._discardDraft = () => { input.value = original; refresh(); };
      input._syncLyricInput = () => {
        const clean = input.value === original;
        original = window.DocOps.buildLyricLine(entries);
        if (clean) input.value = original;
        refresh();
      };
      input._validateOnSave = validate;
      input._commitOnSave = commit;
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (commit()) {
            const rows = [...root.querySelectorAll(".ly-line-edit")];
            (rows[rows.indexOf(input) + 1] || input).focus();
          }
        }
        else if (ev.key === "Escape") { cancelled = true; input.value = original; errEl.textContent = ""; refresh(); input.blur(); cancelled = false; }
      });
      input.addEventListener("blur", commit);
      rowEl.appendChild(input);
      rowEl.appendChild(errEl);
      refresh();
      secEl.appendChild(rowEl);
      prevEntry = entries[entries.length - 1];
    }
    root.appendChild(secEl);
  });
}

// ---- Arrange mode ----
function lyChordKey({ si, bi, ei }) { return `${si}:${bi}:${ei}`; }

function lyArrangeStatus(message) {
  const status = $("lyArrangeStatus");
  if (status && status.textContent !== message) status.textContent = message;
}

function cancelLyricMove() {
  if (lyDropTimer !== null) clearTimeout(lyDropTimer);
  lyDropTimer = null;
  if (lyPicked) selectLyricChord(lyPicked.coords);
  lyArrangeStatus("Move cancelled.");
}

function selectLyricChord(coords, { pick = false, focus = false } = {}) {
  if (!state.doc) return;
  const entry = song().sections[coords.si]?.bars[coords.bi]?.[coords.ei];
  if (!entry || entry.chord === "%") return;
  const root = $("lyrics");
  const previous = root.querySelector(".ly-chord.selected");
  if (previous) {
    previous.classList.remove("selected", "armed");
    previous.setAttribute("aria-pressed", "false");
  }
  lySelection = { doc: state.doc, coords };
  lyPicked = pick ? lySelection : null;
  root.classList.toggle("ly-moving", pick);
  const cancel = $("lyMoveCancel");
  if (cancel) cancel.hidden = !pick;
  const token = root.querySelector(`[data-ly-chord="${lyChordKey(coords)}"]`);
  if (token) {
    token.classList.add("selected");
    token.classList.toggle("armed", pick);
    token.setAttribute("aria-pressed", String(pick));
    if (focus) {
      token.focus({ preventScroll: true });
      token.scrollIntoView({ block: "nearest" });
    }
  }
  syncScanSelection(coords, true);
  if (pick) {
    const destination = lyMode() === "flow" ? "lyric" : "lyric or bar start";
    lyArrangeStatus(`Moving ${entry.chord} — click destination ${destination} or Esc`);
  } else lyArrangeStatus("");
}

function prepareLyricEdit(resume) {
  if (typeof confirmChordDraftDiscard === "function" && !confirmChordDraftDiscard(resume)) return false;
  state.sel = null;
  $("editor")?.classList.remove("open");
  return true;
}

function lyAnchorMove(source, target) {
  if (!source || source.doc !== state.doc) return;
  lyDrag = null;
  const plan = window.DocOps.planLyricAnchorMove(song(), source.coords, target);
  if (!plan) { lyArrangeStatus("The chord is already at that anchor."); return; }
  if (plan.error) { lyArrangeStatus(plan.error); return; }
  if (!prepareLyricEdit(() => lyAnchorMove(source, target))) return;
  pushUndo();
  for (const { si, bi, bar } of plan.changes) song().sections[si].bars[bi] = bar;
  markDirty();
  lySelection = { doc: state.doc, coords: plan.selection };
  renderBars();
  renderLyrics();
  selectLyricChord(plan.selection, { focus: true });
  lyArrangeStatus(`Chord moved to bar ${plan.selection.bi + 1}.`);
}

function wireLyricDrop(element, target, clickTarget = element) {
  element.addEventListener("dragover", (ev) => {
    if (!lyDrag || lyDrag.doc !== state.doc) return;
    ev.preventDefault();
    const plan = window.DocOps.planLyricAnchorMove(song(), lyDrag.coords, target);
    const allowed = Boolean(plan?.changes);
    element.classList.toggle("drop-ok", allowed);
    element.classList.toggle("drop-blocked", !allowed);
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = allowed ? "move" : "none";
    lyArrangeStatus(plan?.error || "");
  });
  element.addEventListener("dragleave", (ev) => {
    if (!element.contains(ev.relatedTarget)) element.classList.remove("drop-ok", "drop-blocked");
  });
  element.addEventListener("drop", (ev) => {
    if (!lyDrag) return;
    ev.preventDefault();
    element.classList.remove("drop-ok", "drop-blocked");
    lyAnchorMove(lyDrag, target);
  });
  clickTarget.addEventListener("click", (event) => {
    if (!lyPicked) return;
    if (lyDropTimer !== null) clearTimeout(lyDropTimer);
    // Give a double-click its normal text-edit meaning before mutating anchors.
    if (event.detail > 1) return;
    const picked = lyPicked;
    lyDropTimer = setTimeout(() => {
      lyDropTimer = null;
      if (lyPicked === picked) lyAnchorMove(picked, target);
    }, 500);
  });
}

function addLyricControls(root, message) {
  const hint = document.createElement("div");
  hint.className = "ly-hint";
  hint.textContent = message;
  root.appendChild(hint);
  const status = document.createElement("div");
  status.id = "lyArrangeStatus";
  status.className = "ly-arrange-message";
  status.setAttribute("role", "status");
  const banner = document.createElement("div");
  banner.className = "ly-move-banner";
  banner.appendChild(status);
  const cancel = document.createElement("button");
  cancel.id = "lyMoveCancel";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.hidden = true;
  cancel.addEventListener("click", cancelLyricMove);
  banner.appendChild(cancel);
  root.appendChild(banner);
  root.onkeydown = (ev) => {
    if (ev.key !== "Escape" || !lyPicked) return;
    ev.preventDefault();
    ev.stopPropagation();
    const coords = lyPicked.coords;
    cancelLyricMove();
    root.querySelector(`[data-ly-chord="${lyChordKey(coords)}"]`)?.focus();
  };
}

function restoreLyricSelection(root) {
  if (!lySelection) return;
  const token = root.querySelector(`[data-ly-chord="${lyChordKey(lySelection.coords)}"]`);
  if (token) {
    token.classList.add("selected");
    token.classList.toggle("armed", Boolean(lyPicked));
    token.setAttribute("aria-pressed", String(Boolean(lyPicked)));
    syncScanSelection(lySelection.coords);
  }
}

function renderLyricsGrid(root) {
  addLyricControls(root, "Drag a chord onto a lyric or bar start, or select the chord and click its destination. Double-click a lyric or press F2 to edit.");
  song().sections.forEach((section, si) => {
    const secEl = document.createElement("div");
    secEl.className = "ly-section";
    const label = document.createElement("div");
    label.className = "ly-seclabel";
    label.textContent = section.label || `Section ${si + 1}`;
    secEl.appendChild(label);
    const bars = section.bars || [];
    for (let start = 0; start < bars.length; start += LY_BARS_PER_ROW) {
      const line = document.createElement("div");
      line.className = "ly-line";
      bars.slice(start, start + LY_BARS_PER_ROW).forEach((bar, i) => {
        line.appendChild(renderLyBar(si, start + i, bar));
      });
      secEl.appendChild(line);
    }
    if (!bars.length) {
      const empty = document.createElement("p");
      empty.className = "ly-text empty";
      empty.textContent = "Empty section";
      secEl.appendChild(empty);
    }
    root.appendChild(secEl);
  });
  restoreLyricSelection(root);
}

function lyricFlowGroups(sections) {
  const groups = [];
  let group;
  sections.forEach((section, si) => {
    const label = typeof section.label === "string" ? section.label.trim() : "";
    if (!group || label) {
      group = { label, bars: [], barCoords: [] };
      groups.push(group);
    }
    (section.bars || []).forEach((bar, bi) => {
      group.bars.push(bar);
      group.barCoords.push({ si, bi });
    });
  });
  return groups;
}

function lyFlowColumns(text) { return Array.from(text.normalize("NFC")).length; }

function flowChord(group, anchor) {
  const entry = group.bars[anchor.bi][anchor.ei];
  const token = makeLyChord({ ...group.barCoords[anchor.bi], ei: anchor.ei }, entry);
  if (!anchor.hasLyric) {
    token.title = entry.voicing ? `${entry.voicing} · No lyric anchor` : "No lyric anchor";
    token.addEventListener("dblclick", () => {
      cancelLyricMove();
      editLyricToken(token.parentElement || token.parentNode, token, entry, "", 0);
    });
    token.addEventListener("keydown", (event) => {
      if (event.key !== "F2") return;
      event.preventDefault();
      cancelLyricMove();
      editLyricToken(token.parentElement || token.parentNode, token, entry, "", 0);
    });
  }
  return token;
}

function renderFlowSystem(section, group, row, layout) {
  const system = document.createElement("div");
  system.className = "ly-flow-system";
  const chordRow = document.createElement("div");
  chordRow.className = "ly-flow-chords";
  const lyric = document.createElement("div");
  lyric.className = "ly-flow-lyric";
  const fragments = new Map();
  let last = row.start;
  for (const span of row.spans) {
    if (span.start > last) lyric.appendChild(document.createTextNode(
      row.text.slice(last - row.start, span.start - row.start)
    ));
    const text = document.createElement("button");
    text.type = "button";
    text.className = "ly-flow-fragment";
    text.textContent = span.text;
    const entry = group.bars[span.bi][span.ei];
    const raw = window.DocOps.lySyllables(entry.text)[span.k];
    text.dataset.lyText = `${lyChordKey({ ...group.barCoords[span.bi], ei: span.ei })}:${span.k}`;
    if (span.syllable === 0) text.classList.add("ly-flow-bar-start");
    wireLyricEdit(lyric, text, entry, raw, span.k);
    wireLyricDrop(text, { ...group.barCoords[span.bi], syllable: span.syllable });
    lyric.appendChild(text);
    fragments.set(span.start, text);
    last = span.end;
  }
  if (last < row.end) lyric.appendChild(document.createTextNode(row.text.slice(last - row.start)));
  system.appendChild(chordRow);
  system.appendChild(lyric);
  section.appendChild(system);

  // Keep anchored chords at their character positions. Group consecutive
  // textless chords there so instrumental runs don't create tall label stacks.
  const labels = [];
  const clusterWidth = Math.max(14 * layout.unit, layout.width * 0.6);
  for (const anchor of row.anchors) {
    const token = flowChord(group, anchor);
    const width = layout.measure(token.textContent) + 3 * layout.unit;
    const previous = labels.at(-1);
    if (!anchor.hasLyric && previous && !previous.hasLyric &&
        previous.at === anchor.at && previous.width + width <= clusterWidth) {
      previous.width += width;
      previous.tokens.push(token);
    } else {
      labels.push({ at: anchor.at, width, hasLyric: anchor.hasLyric, tokens: [token] });
    }
  }
  for (const label of labels) {
    const element = document.createElement("div");
    element.className = label.hasLyric ? "ly-flow-label" : "ly-flow-label ly-flow-unanchored";
    label.tokens.forEach((token) => element.appendChild(token));
    chordRow.appendChild(element);
    label.element = element;
  }
  const lyricLeft = lyric.getBoundingClientRect().left;
  const finalFragment = fragments.get(row.spans.at(-1)?.start);
  for (const label of labels) {
    const point = label.at === row.end ? finalFragment?.getBoundingClientRect().right
      : fragments.get(label.at)?.getBoundingClientRect().left;
    label.position = layout.cssUnit === "px" && Number.isFinite(point - lyricLeft)
      ? point - lyricLeft : layout.measure(row.text.slice(0, label.at - row.start));
    if (layout.cssUnit === "px") {
      label.width = Math.max(label.width, label.element.getBoundingClientRect().width);
    }
  }
  labels.sort((a, b) => a.position - b.position || Number(b.hasLyric) - Number(a.hasLyric));
  const ends = [];
  for (const { position, width, element } of labels) {
    let lane = ends.findIndex((end) => end <= position);
    if (lane < 0) lane = ends.length;
    ends[lane] = position + width;
    element.style.insetInlineStart = `${position}${layout.cssUnit}`;
    element.style.setProperty("--ly-lane", lane);
  }
  system.style.setProperty("--ly-lanes", ends.length);
  system.style.minWidth = `${Math.max(layout.measure(row.text), ...ends, 0) + layout.unit}${layout.cssUnit}`;
}

function renderLyricsFlow(root) {
  addLyricControls(root, "Drag a chord onto a lyric, or select the chord and click its destination. Double-click a lyric or press F2 to edit.");
  const content = document.createElement("div");
  content.className = "ly-flow-content";
  const measure = document.createElement("span");
  measure.className = "ly-flow-measure";
  measure.setAttribute("aria-hidden", "true");
  content.appendChild(measure);
  const systems = document.createElement("div");
  content.appendChild(systems);
  root.appendChild(content);

  const doc = state.doc;
  const groups = lyricFlowGroups(song().sections).map((group) =>
    ({ ...group, flow: window.DocOps.buildLyricFlow(group) }));
  const canvas = document.createElement("canvas").getContext?.("2d");
  if (canvas && typeof getComputedStyle === "function") {
    const font = getComputedStyle(content);
    canvas.font = `${font.fontSize} ${font.fontFamily}`;
  }
  let previousWidth = 0;
  const reflow = () => {
    if (state.doc !== doc || lyMode() !== "flow" || lyDrag || systems.querySelector(".ly-edit")) return;
    const glyphWidth = measure.getBoundingClientRect().width;
    const pixels = Boolean(glyphWidth && content.clientWidth);
    const unit = pixels ? glyphWidth : 1;
    const width = pixels ? Math.max(16 * unit, content.clientWidth - 2 * unit) : 56;
    if (width === previousWidth) return;
    previousWidth = width;
    const layout = {
      width, unit, cssUnit: pixels ? "px" : "ch",
      measure: pixels && canvas ? (text) => canvas.measureText(text).width
        : (text) => lyFlowColumns(text) * unit,
    };
    const focusedChord = document.activeElement?.dataset.lyChord;
    systems.innerHTML = "";
    for (const group of groups) {
      const section = document.createElement("div");
      section.className = "ly-flow-section";
      if (group.label) {
        const label = document.createElement("div");
        label.className = "ly-seclabel";
        label.textContent = group.label;
        section.appendChild(label);
      }
      systems.appendChild(section);
      if (group.flow.text) {
        for (const row of window.DocOps.wrapLyricFlow(group.flow, width, layout.measure)) {
          renderFlowSystem(section, group, row, layout);
        }
      } else {
        const instrumental = document.createElement("div");
        instrumental.className = "ly-flow-instrumental";
        for (const anchor of group.flow.anchors) instrumental.appendChild(flowChord(group, anchor));
        if (!group.flow.anchors.length) instrumental.textContent = "No lyrics in this section";
        section.appendChild(instrumental);
      }
    }
    restoreLyricSelection(root);
    if (focusedChord && /^\d+:\d+:\d+$/.test(focusedChord)) {
      root.querySelector(`[data-ly-chord="${focusedChord}"]`)?.focus({ preventScroll: true });
    }
  };
  reflow();
  if (typeof ResizeObserver === "function") {
    lyFlowObserver = new ResizeObserver(reflow);
    lyFlowObserver.observe(content);
  }
}

function renderLyBar(si, bi, bar) {
  const wrap = document.createElement("div");
  wrap.className = "ly-bar";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "ly-bar-start";
  start.textContent = `Bar ${bi + 1}`;
  start.title = "Move the selected chord to this bar’s start";
  wireLyricDrop(start, { si, bi, syllable: 0 });
  wrap.appendChild(start);

  const content = document.createElement("div");
  content.className = "ly-bar-content";
  let syllable = 0;
  bar.forEach((entry, ei) => {
    const words = window.DocOps.lySyllables(entry.text);
    if (words.length) {
      words.forEach((word, k) => {
        content.appendChild(makeLySyllable({ si, bi, ei }, entry, word, k, syllable++));
      });
    } else {
      content.appendChild(makeLySyllable({ si, bi, ei }, entry, "", 0, syllable));
    }
  });
  wrap.appendChild(content);
  return wrap;
}

function makeLyChord(coords, entry) {
  const carry = entry.chord === "%";
  const token = document.createElement(carry ? "span" : "button");
  token.className = carry ? "ly-chord pct" : "ly-chord";
  token.textContent = entry.chord;
  if (entry.voicing) token.title = entry.voicing;
  if (carry) return token;
  token.type = "button";
  token.draggable = true;
  token.dataset.lyChord = lyChordKey(coords);
  token.setAttribute("aria-pressed", "false");
  token.addEventListener("click", () => {
    if (lyPicked && lyChordKey(lyPicked.coords) === lyChordKey(coords)) cancelLyricMove();
    else selectLyricChord(coords, { pick: true });
  });
  token.addEventListener("dragstart", (ev) => {
    selectLyricChord(coords);
    lyDrag = lySelection;
    token.classList.add("dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", entry.chord);
    }
  });
  token.addEventListener("dragend", () => {
    token.classList.remove("dragging");
    lyDrag = null;
    $("lyrics").querySelectorAll(".drop-ok, .drop-blocked").forEach((target) => {
      target.classList.remove("drop-ok", "drop-blocked");
    });
  });
  return token;
}

function makeLySyllable(coords, entry, word, wordIndex, syllable) {
  const column = document.createElement("span");
  column.className = "ly-syl";
  if (wordIndex === 0) {
    column.appendChild(makeLyChord(coords, entry));
  } else {
    const spacer = document.createElement("span");
    spacer.className = "ly-chordrow-spacer";
    column.appendChild(spacer);
  }

  const text = document.createElement("button");
  text.type = "button";
  text.className = word ? "ly-text" : "ly-text ly-inst";
  text.textContent = word || "—";
  text.dataset.lyText = `${lyChordKey(coords)}:${wordIndex}`;
  wireLyricEdit(column, text, entry, word, wordIndex);
  if (!word) text.setAttribute("aria-label", "Add lyrics or place chord at this position");
  column.appendChild(text);
  wireLyricDrop(column, { si: coords.si, bi: coords.bi, syllable }, text);
  return column;
}

function wireLyricEdit(container, text, entry, word, wordIndex) {
  text.title = "Double-click or press F2 to edit";
  text.setAttribute("aria-keyshortcuts", "F2");
  const edit = () => {
    cancelLyricMove();
    editLyricToken(container, text, entry, word, wordIndex);
  };
  text.addEventListener("dblclick", edit);
  text.addEventListener("keydown", (ev) => {
    if (ev.key !== "F2") return;
    ev.preventDefault();
    ev.stopPropagation();
    edit();
  });
}

function editLyricToken(column, text, entry, word, wordIndex) {
  if (lyPicked) return;
  const input = document.createElement("input");
  input.className = "ly-edit";
  input.value = word;
  input.size = Math.max(3, word.length + 2);
  input.setAttribute("aria-label", "Edit lyric");
  column.replaceChild(input, text);
  input.focus();
  input.select();
  let done = false;
  let committing = false;
  const restoreFocus = () => {
    const targets = $("lyrics").querySelectorAll(".ly-text, .ly-flow-fragment, .ly-chord");
    [...targets].find((target) => text.dataset.lyText
      ? target.dataset.lyText === text.dataset.lyText
      : target.dataset.lyChord === text.dataset.lyChord)?.focus({ preventScroll: true });
  };
  const commit = (opts = {}) => {
    if (done) return true;
    if (committing) return false;
    const next = !entry.text && wordIndex === 0 ? input.value.trim().replace(/\s+/g, " ")
      : window.DocOps.replaceTextToken(entry.text, wordIndex, input.value);
    if (next !== null && next !== entry.text) {
      committing = true;
      if (!opts?.skipChordDraftDiscard && !prepareLyricEdit(() => commit(opts))) { committing = false; return false; }
      done = true;
      pushUndo();
      if (next) entry.text = next; else delete entry.text;
      markDirty();
      if (opts?.deferRender) {
        opts.onCommit?.();
      } else {
        renderBars();
        renderLyrics();
        restoreFocus();
      }
    } else {
      done = true;
      if (opts?.deferRender) {
        opts.onCommit?.();
      } else {
        renderLyrics();
        restoreFocus();
      }
    }
    return true;
  };
  input._commitOnSave = commit;
  input._hasLyricDraft = () => !done && input.value !== word;
  input._discardDraft = () => { input.value = word; };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") {
      ev.stopPropagation();
      done = true;
      renderLyrics();
      restoreFocus();
    }
  });
  input.addEventListener("blur", commit);
}
