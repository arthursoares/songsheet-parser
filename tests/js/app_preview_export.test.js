const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const PreviewExport = require("../../scripts/qa_static/app_preview_export.js");

test("Harmony prints its current snapshot through the in-tab helper", async () => {
  const html = "<html>Live harmony chart</html>";
  const printed = [];
  const message = {};
  const context = vm.createContext({
    document: { getElementById: () => message },
    window: { addEventListener() {} },
    PreviewExport: { printChartHtml: async (snapshot) => printed.push(snapshot) },
    setTimeout() {},
  });
  const script = readFileSync(join(__dirname, "../../scripts/qa_static/harmony.js"), "utf8");
  vm.runInContext(script, context);
  context.hmSnapshotHtml = () => html;
  await context.hmExportPdf();
  assert.deepEqual(printed, [html]);
  assert.equal(message.textContent, "");
});

function metricElement(metrics) {
  return {
    scrollWidth: 0, offsetWidth: 0, clientWidth: 0,
    scrollHeight: 0, offsetHeight: 0, clientHeight: 0,
    ...metrics,
  };
}

function pngFrame({ root = {}, body = {}, viewport = {}, serialized } = {}) {
  const drawing = { calls: [] };
  const canvas = {
    getContext(kind) {
      assert.equal(kind, "2d");
      return { drawImage: (...args) => drawing.calls.push(args) };
    },
    toBlob(callback, type) {
      drawing.blobType = type;
      callback({ type, size: 7 });
    },
  };
  class MockImage {
    set src(value) {
      drawing.src = value;
      this.onload();
    }
  }
  class MockXMLSerializer {
    serializeToString(node) {
      assert.strictEqual(node, documentElement);
      return serialized || '<html xmlns="http://www.w3.org/1999/xhtml"><body>A &amp; B &lt; C</body></html>';
    }
  }
  const documentElement = metricElement(root);
  const contentDocument = {
    readyState: "complete",
    documentElement,
    body: metricElement(body),
  };
  const contentWindow = {
    innerWidth: viewport.width || 0,
    innerHeight: viewport.height || 0,
    XMLSerializer: MockXMLSerializer,
  };
  const ownerDocument = {
    defaultView: { Image: MockImage },
    createElement(name) {
      assert.equal(name, "canvas");
      drawing.canvasCreated = true;
      return canvas;
    },
  };
  return {
    frame: { contentDocument, contentWindow, ownerDocument },
    drawing,
    canvas,
  };
}

test("printPreviewFrame prints through the loaded iframe window", () => {
  const frame = pngFrame().frame;
  let receiver;
  frame.contentWindow.print = function () { receiver = this; };
  PreviewExport.printPreviewFrame(frame);
  assert.strictEqual(receiver, frame.contentWindow);
});

test("printPreviewFrame clearly rejects a missing or loading preview", () => {
  assert.throws(() => PreviewExport.printPreviewFrame(null), /Preview frame is not loaded/);
  const frame = pngFrame().frame;
  frame.contentDocument.readyState = "loading";
  assert.throws(() => PreviewExport.printPreviewFrame(frame), /Preview frame is not loaded/);
});

test("capturePreviewPng sizes for the full document and viewport and draws once", async () => {
  const { frame, drawing, canvas } = pngFrame({
    root: { scrollWidth: 900, scrollHeight: 2400, clientWidth: 700 },
    body: { offsetWidth: 950, scrollHeight: 2300 },
    viewport: { width: 1024, height: 768 },
  });
  const blob = await PreviewExport.capturePreviewPng(frame);
  assert.equal(canvas.width, 1024);
  assert.equal(canvas.height, 2400);
  assert.equal(drawing.calls.length, 1);
  assert.deepEqual(drawing.calls[0].slice(1), [0, 0, 1024, 2400]);
  assert.equal(drawing.blobType, "image/png");
  assert.deepEqual(blob, { type: "image/png", size: 7 });
});

test("capturePreviewPng serializes XHTML safely inside an SVG foreignObject", async () => {
  const { frame, drawing } = pngFrame({
    root: { scrollWidth: 640, scrollHeight: 480 },
    serialized: '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>.diagram{stroke:#111}</style></head><body><svg class="diagram"></svg>A &amp; B &lt; C</body></html>',
  });
  await PreviewExport.capturePreviewPng(frame);
  assert.match(drawing.src, /^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(drawing.src.split(",", 2)[1]);
  assert.match(svg, /<foreignObject x="0" y="0" width="640" height="480">/);
  assert.match(svg, /<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/);
  assert.match(svg, /<style>\.diagram\{stroke:#111\}<\/style>/);
  assert.match(svg, /<svg class="diagram"><\/svg>/);
  assert.match(svg, /A &amp; B &lt; C/);
  assert.doesNotMatch(svg, /A & B < C/);
});

test("capturePreviewPng rejects oversized previews before allocating a canvas", async () => {
  const { frame, drawing } = pngFrame({
    root: { scrollWidth: 20000, scrollHeight: 100 },
  });
  await assert.rejects(
    PreviewExport.capturePreviewPng(frame),
    /too large.*20000x100.*16384px/s,
  );
  assert.equal(drawing.canvasCreated, undefined);
});

test("capturePreviewPng reports image rendering and PNG encoding failures", async () => {
  const imageFailure = pngFrame({ root: { scrollWidth: 50, scrollHeight: 50 } });
  imageFailure.frame.ownerDocument.defaultView.Image = class {
    set src(_value) { this.onerror(); }
  };
  await assert.rejects(
    PreviewExport.capturePreviewPng(imageFailure.frame),
    /could not render the preview DOM/,
  );

  const encodingFailure = pngFrame({ root: { scrollWidth: 50, scrollHeight: 50 } });
  encodingFailure.canvas.toBlob = (callback) => callback(null);
  await assert.rejects(
    PreviewExport.capturePreviewPng(encodingFailure.frame),
    /could not encode the preview as PNG/,
  );
});

test("printChartHtml prints a dedicated frame and removes it after printing", async (t) => {
  const previousDocument = global.document;
  t.after(() => { global.document = previousDocument; });
  const listeners = {};
  const chartListeners = {};
  let printReceiver;
  const chartWindow = {
    addEventListener(event, handler) { chartListeners[event] = handler; },
    print() { printReceiver = this; },
  };
  const frame = {
    contentWindow: chartWindow,
    style: {},
    setAttribute(name, value) { this[name] = value; },
    addEventListener(event, handler) { listeners[event] = handler; },
  };
  const body = {
    appendChild(child) {
      assert.strictEqual(child, frame);
      child.parentNode = body;
      listeners.load();
    },
    removeChild(child) {
      assert.strictEqual(child, frame);
      child.parentNode = null;
    },
  };
  global.document = {
    body,
    createElement(name) {
      assert.equal(name, "iframe");
      return frame;
    },
  };

  await PreviewExport.printChartHtml("<html><body>Saved album</body></html>");
  assert.equal(frame.srcdoc, "<html><body>Saved album</body></html>");
  assert.equal(frame["aria-hidden"], "true");
  assert.equal(frame.style.left, "-10000px");
  assert.equal(frame.style.width, "1px");
  assert.strictEqual(printReceiver, chartWindow);
  assert.strictEqual(frame.parentNode, body);
  chartListeners.afterprint();
  assert.equal(frame.parentNode, null);
});
