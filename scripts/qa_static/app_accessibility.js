// Static accessibility wiring; view changes still pass through showView's draft guards.
function wireAccessibility() {
  const tabs = [...document.querySelectorAll(".viewtabs > button")];
  const views = ["bars", "lyrics", "review", "dict", "harmony", "preview", "json"];
  const tablist = document.querySelector(".viewtabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Song views");
  tabs.forEach((tab, index) => {
    const view = views[index];
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", view);
    tab.setAttribute("aria-selected", String(index === 0));
    tab.tabIndex = index === 0 ? 0 : -1;
    const panel = $(view);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const enabled = tabs.filter((item) => !item.disabled);
      const current = enabled.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
      // Manual activation keeps unsaved drafts intact until Enter/Space activates the tab.
      tabs.forEach((item) => { item.tabIndex = item === enabled[next] ? 0 : -1; });
      enabled[next]?.focus();
    });
  });
  for (const [id, name] of Object.entries({
    keySel: "Song key", songSel: "Song", cmSource: "Generated ChordMark source",
    jsonSource: "Song JSON", spellToggle: "Use flat note spelling",
  })) $(id)?.setAttribute("aria-label", name);
  $("spellToggle")?.setAttribute("aria-pressed", String(window.ChordNaming.getSpelling() === "flat"));
  $("previewFrame").title = "Songsheet preview";
  for (const id of ["reviewMsg", "jsonMsg", "pvExportMsg", "hmExportMsg", "cmCopyMsg"]) {
    $(id)?.setAttribute("role", "status");
    $(id)?.setAttribute("aria-live", "polite");
  }
  $("shortcutDialog").addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
  });
}
