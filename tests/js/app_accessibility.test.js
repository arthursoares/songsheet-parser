const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const root = join(__dirname, "../../scripts/qa_static");

test("tab keyboard navigation wraps, skips disabled tabs and does not activate drafts", () => {
  let focused;
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, attributes: {}, handlers: {}, disabled: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      focus() { focused = this.id; },
    });
    return nodes.get(id);
  };
  const ids = ["Bars", "Lyrics", "Review", "Dict", "Harmony", "Preview", "Json"];
  const tabs = ids.map((id) => node(`tab${id}`));
  const context = vm.createContext({
    $: node,
    document: { querySelectorAll: () => tabs, querySelector: () => node("tablist") },
    window: { ChordNaming: { getSpelling: () => "sharp" } },
  });
  vm.runInContext(readFileSync(join(root, "app_accessibility.js"), "utf8"), context);
  context.wireAccessibility();
  assert.equal(node("tablist").attributes.role, "tablist");
  assert.equal(node("bars").attributes["aria-labelledby"], "tabBars");
  tabs[1].disabled = true;
  function key(tab, key) {
    let prevented = false;
    tab.handlers.keydown({ key, preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.ok(prevented);
  }
  key(tabs[0], "ArrowRight");
  assert.equal(focused, "tabReview");
  assert.equal(tabs[0].attributes["aria-selected"], "true");
  assert.equal(tabs[2].attributes["aria-selected"], "false");
  key(tabs[2], "End");
  assert.equal(focused, "tabJson");
  key(tabs[6], "ArrowRight");
  assert.equal(focused, "tabBars");
  key(tabs[0], "ArrowLeft");
  assert.equal(focused, "tabJson");
  key(tabs[6], "Home");
  assert.equal(focused, "tabBars");
});

function luminance(hex) {
  if (hex.length === 4) hex = "#" + [...hex.slice(1)].map((value) => value + value).join("");
  return hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}
test("semantic text palette and interactive boundaries meet AA contrast thresholds", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const styles = [...html.matchAll(/href="([^"/]+\.css)"/g)]
    .map((match) => readFileSync(join(root, match[1]), "utf8"));
  const tokens = Object.fromEntries([...([html, ...styles].join("\n")).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})(?=[;\s}])/g)]
    .map((match) => [match[1], match[2]]));
  for (const background of ["sel", "panel", "chip"]) {
    for (const foreground of ["text", "muted", "accent", "ok", "bad", "note", "civ", "iv", "warn",
      "fn-tonic", "fn-subdominant", "fn-dominant", "fn-secondary", "fn-passing", "fn-chromatic", "fn-chrombass"]) {
      assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${foreground} on ${background}`);
    }
    assert.ok(contrast(tokens["control-border"], tokens[background]) >= 3, `boundary on ${background}`);
  }
  for (const color of ["#34577a", "#9a6700", "#23733b", "#a05304"]) {
    assert.ok(contrast(color, "#ffffff") >= 3, `scan boundary ${color}`);
  }
});
