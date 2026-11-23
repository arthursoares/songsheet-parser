const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../../scripts/qa_static/app_views.js"), "utf8");

function preview(fetch, PreviewExport = {}) {
  const elements = {
    pvStyle: { value: "fork" }, pvDict: { value: "per_voicing" }, pvDiagrams: { value: "dictionary" },
    pvBars: { value: "4" }, pvSource: { checked: false },
    cmSource: { classList: { toggle() {} } }, pvSourceBar: { classList: { toggle() {} } },
    previewFrame: {}, pvPreviewMsg: {}, pvExportMsg: {},
  };
  const actions = {};
  for (const id of [
    "pvExportPdf", "pvExportPng", "pvExportHtml", "pvExportChordmark",
    "pvExportChordpro", "pvExportAlbum", "cmDownload",
  ]) {
    elements[id] = { addEventListener: (_event, handler) => { actions[id] = handler; } };
  }
  const state = { doc: { songs: [{ title: "Unsaved edit" }] }, activeView: "preview", album: "album", file: "song.json" };
  const context = vm.createContext({
    state,
    $: (id) => elements[id], fetch, PreviewExport, setTimeout() {},
  });
  vm.runInContext(source, context);
  return { elements, state, render: context.renderPreview, wireExport: context.wireExport, actions };
}

function response(html, fallback = false) {
  return {
    ok: true,
    headers: { get: (name) => name === "X-Songsheet-Preview-Style" && fallback ? "target" : null },
    text: async () => html,
  };
}

test("Preview preserves the selected style preference when the server uses Lead Sheet", async () => {
  const app = preview(async (path, options) => {
    assert.match(path, /style=fork/);
    assert.match(path, /diagrams=dictionary/);
    assert.match(options.body, /Unsaved edit/);
    return response("<html>Target</html>", true);
  });
  await app.render();
  assert.equal(app.elements.pvStyle.value, "fork");
  assert.equal(app.elements.previewFrame.srcdoc, "<html>Target</html>");
  assert.match(app.elements.pvPreviewMsg.textContent, /Showing Lead Sheet/);
});

test("single-song export sends the displayed snapshot and effective renderer", async () => {
  const requests = [];
  const app = preview(async (path, options) => {
    requests.push({ path, options });
    return path.startsWith("/api/render-doc")
      ? response("Target", true)
      : { ok: false, status: 404, json: async () => ({ error: "test" }) };
  });
  app.wireExport();
  app.actions.pvExportHtml();
  assert.equal(requests.length, 0);
  await app.render();
  app.state.doc.songs[0].title = "Later edit";
  app.actions.pvExportHtml();
  assert.match(requests[1].path, /\/api\/export-doc\/album\/song\.json[?]fmt=html&style=target/);
  assert.equal(requests[1].options.method, "POST");
  assert.match(requests[1].options.body, /Unsaved edit/);
  assert.doesNotMatch(requests[1].options.body, /Later edit/);
});

test("changing the diagram layout re-renders the selected style", async () => {
  const requests = [];
  const app = preview(async (path) => {
    requests.push(path);
    return response(path);
  });
  app.elements.pvStyle.value = "target";
  app.elements.pvDiagrams.value = "inline";
  await app.render();
  assert.equal(app.elements.pvDict.disabled, true);
  app.elements.pvDiagrams.value = "dictionary";
  await app.render();
  assert.equal(app.elements.pvDict.disabled, false);
  assert.match(requests[0], /style=target.*diagrams=inline/);
  assert.match(requests[1], /style=target.*diagrams=dictionary/);
});

test("album export uses the selected diagram layout", () => {
  const requests = [];
  const app = preview(async (path) => {
    requests.push(path);
    return { ok: false, status: 404, json: async () => ({ error: "test" }) };
  });
  app.elements.pvDiagrams.value = "inline";
  app.wireExport();
  app.actions.pvExportAlbum();
  assert.match(requests[0], /\/api\/export-album\/album[?]fmt=html.*diagrams=inline/);
});

test("PDF print uses only the loaded preview frame and never calls a server export", async () => {
  const requests = [];
  const frames = [];
  const app = preview(async (path) => {
    requests.push(path);
    return response("<html><head></head><body>Chart</body></html>");
  }, { printPreviewFrame: (frame) => frames.push(frame) });
  app.wireExport();
  await app.render();
  app.actions.pvExportPdf();
  assert.equal(frames.length, 0);
  assert.match(app.elements.pvExportMsg.textContent, /Preview is still loading/);
  app.elements.previewFrame.contentDocument = { querySelector: () => ({ content: "1" }) };
  app.actions.pvExportPdf();
  assert.deepEqual(frames, [app.elements.previewFrame]);
  assert.equal(requests.length, 1);
});

test("a late fallback response cannot replace the newest preview or selector", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  const app = preview(() => ++calls === 1 ? first : Promise.resolve(response("new Fork")));
  const pending = app.render();
  await app.render();
  resolveFirst(response("old Target", true));
  await pending;
  assert.equal(app.elements.pvStyle.value, "fork");
  assert.equal(app.elements.previewFrame.srcdoc, "new Fork");
  assert.equal(app.elements.pvPreviewMsg.textContent, "");
});

test("leaving a failed song load without a document clears prior preview content", async () => {
  const app = preview(async () => response("<html>Old song</html>"));
  await app.render();
  assert.match(app.elements.previewFrame.srcdoc, /Old song/);
  app.state.doc = null;
  app.elements.cmSource.value = "previous source";
  await app.render();
  assert.equal(app.elements.previewFrame.srcdoc, "");
  assert.equal(app.elements.cmSource.value, "");
  assert.equal(app.elements.pvExportHtml.disabled, true);
});

test("a pending render hides the old song immediately", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let requests = 0;
  const app = preview(() => ++requests === 1 ? Promise.resolve(response("Old song")) : pending);
  await app.render();
  app.state.doc = { songs: [{ title: "New song" }] };
  const render = app.render();
  assert.equal(app.elements.previewFrame.srcdoc, "");
  assert.equal(app.elements.pvExportHtml.disabled, true);
  resolve(response("New song"));
  await render;
  assert.equal(app.elements.previewFrame.srcdoc, "New song");
});
