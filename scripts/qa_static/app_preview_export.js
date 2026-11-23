// Browser-only export helpers for the rendered Preview iframe. These helpers
// deliberately reuse the already-rendered, same-origin preview: they never
// start another browser process or ask the QA server to rasterize content.
(function () {
  const MAX_CANVAS_DIMENSION = 16384;
  const MAX_CANVAS_PIXELS = 64 * 1024 * 1024;

  function loadedPreview(frame) {
    if (!frame || !frame.contentWindow) {
      throw new Error("Preview frame is not loaded.");
    }

    let doc;
    try {
      doc = frame.contentDocument || frame.contentWindow.document;
    } catch (_error) {
      throw new Error("Preview frame must be loaded from the same origin.");
    }
    if (!doc || !doc.documentElement || doc.readyState === "loading") {
      throw new Error("Preview frame is not loaded.");
    }
    return { doc, previewWindow: frame.contentWindow };
  }

  function printPreviewFrame(frame) {
    const { previewWindow } = loadedPreview(frame);
    if (typeof previewWindow.print !== "function") {
      throw new Error("Preview frame cannot be printed in this browser.");
    }
    previewWindow.print.call(previewWindow);
  }

  function positiveMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function previewDimensions(doc, previewWindow) {
    const root = doc.documentElement;
    const body = doc.body;
    const width = Math.ceil(Math.max(
      positiveMetric(root.scrollWidth),
      positiveMetric(root.offsetWidth),
      positiveMetric(root.clientWidth),
      positiveMetric(body && body.scrollWidth),
      positiveMetric(body && body.offsetWidth),
      positiveMetric(body && body.clientWidth),
      positiveMetric(previewWindow.innerWidth),
    ));
    const height = Math.ceil(Math.max(
      positiveMetric(root.scrollHeight),
      positiveMetric(root.offsetHeight),
      positiveMetric(root.clientHeight),
      positiveMetric(body && body.scrollHeight),
      positiveMetric(body && body.offsetHeight),
      positiveMetric(body && body.clientHeight),
      positiveMetric(previewWindow.innerHeight),
    ));
    if (!width || !height) {
      throw new Error("Preview has no renderable dimensions.");
    }
    if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION ||
        width * height > MAX_CANVAS_PIXELS) {
      throw new Error(
        `Preview is too large to export as PNG (${width}x${height}; ` +
        `limit ${MAX_CANVAS_DIMENSION}px per side and ${MAX_CANVAS_PIXELS} pixels).`,
      );
    }
    return { width, height };
  }

  function serializePreview(doc, previewWindow, width, height) {
    const XMLSerializerCtor = previewWindow.XMLSerializer ||
      (typeof XMLSerializer !== "undefined" ? XMLSerializer : null);
    if (!XMLSerializerCtor) {
      throw new Error("This browser cannot serialize the preview for PNG export.");
    }
    const html = new XMLSerializerCtor().serializeToString(doc.documentElement);
    return '<svg xmlns="http://www.w3.org/2000/svg" ' +
      `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
      `${html}</foreignObject></svg>`;
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob !== "function") {
        reject(new Error("This browser cannot encode the preview as PNG."));
        return;
      }
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("The browser could not encode the preview as PNG."));
        }, "image/png");
      } catch (error) {
        reject(new Error(`The browser could not encode the preview as PNG: ${error}`));
      }
    });
  }

  async function capturePreviewPng(frame) {
    const { doc, previewWindow } = loadedPreview(frame);
    const { width, height } = previewDimensions(doc, previewWindow);
    const svg = serializePreview(doc, previewWindow, width, height);
    const hostDocument = frame.ownerDocument || doc;
    const hostWindow = hostDocument.defaultView || previewWindow;
    const ImageCtor = hostWindow.Image || previewWindow.Image;
    if (!hostDocument.createElement || !ImageCtor) {
      throw new Error("This browser cannot rasterize the preview as PNG.");
    }

    const canvas = hostDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext && canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot create a PNG drawing surface.");

    const image = new ImageCtor();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(
        "The browser could not render the preview DOM for PNG export.",
      ));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    context.drawImage(image, 0, 0, width, height);
    return canvasBlob(canvas);
  }

  // Print a standalone HTML snapshot (for example a saved album) without
  // opening another window. The temporary frame remains alive until the
  // browser reports afterprint, because removing it earlier can blank output.
  async function printChartHtml(html) {
    const hostDocument = typeof document !== "undefined" ? document : null;
    if (!hostDocument || !hostDocument.body || !hostDocument.createElement) {
      throw new Error("This browser cannot create a printable chart frame.");
    }

    const frame = hostDocument.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.left = "-10000px";
    frame.style.top = "0";
    frame.style.width = "1px";
    frame.style.height = "1px";
    frame.style.border = "0";
    const remove = () => {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    };

    await new Promise((resolve, reject) => {
      frame.addEventListener("error", () => {
        remove();
        reject(new Error("The printable chart could not be loaded."));
      }, { once: true });
      frame.addEventListener("load", () => {
        const chartWindow = frame.contentWindow;
        if (!chartWindow || typeof chartWindow.print !== "function") {
          remove();
          reject(new Error("The printable chart frame cannot be printed."));
          return;
        }
        chartWindow.addEventListener("afterprint", remove, { once: true });
        try {
          chartWindow.print.call(chartWindow);
          resolve();
        } catch (error) {
          remove();
          reject(new Error(`The printable chart could not be printed: ${error}`));
        }
      }, { once: true });
      frame.srcdoc = String(html);
      hostDocument.body.appendChild(frame);
    });
  }

  const api = { printPreviewFrame, capturePreviewPng, printChartHtml };
  if (typeof window !== "undefined") window.PreviewExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
