// Shared interaction feedback. Keep guard callers synchronous: a pending dialog
// returns false and resumes the captured action only after a successful choice.
let unsavedDialogPending = false;

function showToast(message, action) {
  const root = $("toastStatus");
  if (!root) return;
  root.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = message;
  root.appendChild(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    root.appendChild(button);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.addEventListener("click", () => { root.hidden = true; });
  root.appendChild(dismiss);
  root.hidden = false;
}

function showUndoToast(message) {
  const previous = undoStack[undoStack.length - 1];
  const doc = state.doc;
  showToast(message, { label: "Undo (⌘Z / Ctrl+Z)", run() {
    if (state.doc !== doc || undoStack[undoStack.length - 1] !== previous) {
      showToast("This is no longer the latest edit. Use Undo to step back through your changes.");
      return;
    }
    undo();
  } });
}

function guardUnsavedChanges({ message, applyLabel = "Apply & Continue", apply, discard, resume }) {
  if (unsavedDialogPending) return false;
  const dialog = $("unsavedDialog");
  // Node harnesses and older hosts retain the same synchronous discard guard.
  if (!dialog || typeof dialog.showModal !== "function" || typeof dialog.close !== "function") {
    if (typeof confirm !== "function" || !confirm(message)) return false;
    discard?.();
    return true;
  }
  let doc = state.doc;
  const album = state.album, file = state.file;
  const generation = typeof loadGeneration === "number" ? loadGeneration : null;
  const currentSong = () => state.album === album && state.file === file &&
    (generation === null || loadGeneration === generation);
  const applyButton = $("unsavedApply"), discardButton = $("unsavedDiscard"), cancelButton = $("unsavedCancel");
  const error = $("unsavedError");
  $("unsavedMessage").textContent = message;
  applyButton.textContent = applyLabel;
  error.textContent = "";
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    applyButton.disabled = discardButton.disabled = cancelButton.disabled = value;
  };
  const finish = (proceed) => {
    dialog.close();
    unsavedDialogPending = false;
    if (proceed && currentSong()) resume?.();
  };
  dialog.oncancel = (event) => { event.preventDefault(); if (!busy) finish(false); };
  cancelButton.onclick = () => finish(false);
  discardButton.onclick = () => {
    if (busy || !currentSong() || state.doc !== doc) { if (!busy) finish(false); return; }
    discard?.();
    finish(true);
  };
  applyButton.onclick = async () => {
    if (busy) return;
    if (!currentSong() || state.doc !== doc) { finish(false); return; }
    setBusy(true);
    try {
      const pending = apply();
      doc = state.doc; // Applying JSON may replace the document before saving.
      const result = await pending;
      if (!currentSong()) { finish(false); return; }
      if (result === false || result?.ok === false) {
        error.textContent = result?.error || "Fix the highlighted edits before continuing.";
        return;
      }
      finish(true);
    } catch (failure) {
      error.textContent = failure.message || String(failure);
    } finally { setBusy(false); }
  };
  setBusy(false);
  unsavedDialogPending = true;
  dialog.showModal();
  cancelButton.focus();
  return false;
}

function barsDisplayPreferences() {
  try { return JSON.parse(localStorage.getItem("qaBarsDisplay") || "{}") || {}; }
  catch (_error) { return {}; }
}

function wireBarsDisplay() {
  const toolbar = $("barsDisplay");
  if (!toolbar) return;
  const preferences = barsDisplayPreferences();
  toolbar.querySelectorAll("input").forEach((input) => {
    const name = input.dataset.display;
    input.checked = preferences[name] ?? name !== "compact";
    const sync = () => $("bars").classList.toggle("bars-" + name, input.checked);
    sync();
    input.addEventListener("change", () => {
      preferences[name] = input.checked;
      sync();
      try { localStorage.setItem("qaBarsDisplay", JSON.stringify(preferences)); }
      catch (_error) { /* Display preferences still work without storage. */ }
    });
  });
}
