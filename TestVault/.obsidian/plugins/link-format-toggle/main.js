const { Plugin, Notice, addIcon, setIcon, MarkdownView } = require("obsidian");

const ICON_SHORT = `
  <path d="M18 35 H82" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="none" />
  <path d="M18 65 H58" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="none" />
`;

const ICON_ABSOLUTE = `
  <path d="M22 20 V80" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="none" />
  <path d="M22 20 H82" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="none" />
  <path d="M22 50 H68" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="none" />
  <path d="M22 80 H54" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="none" />
`;

module.exports = class LinkFormatTogglePlugin extends Plugin {
  onload() {
    addIcon("link-format-short", ICON_SHORT);
    addIcon("link-format-absolute", ICON_ABSOLUTE);

    this.headerButtons = new Map();

    this.addCommand({
      id: "toggle-link-format",
      name: "Basculer le format des liens (chemin court ↔ absolu)",
      callback: () => this.toggleLinkFormat(),
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshAllHeaderButtons())
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshAllHeaderButtons())
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshAllHeaderButtons())
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshAllHeaderButtons();
    });
  }

  onunload() {
    for (const buttonEl of this.headerButtons.values()) {
      if (buttonEl && buttonEl.isConnected) buttonEl.remove();
    }
    this.headerButtons.clear();
  }

  getCurrentFormat() {
    const value = this.app.vault.getConfig("newLinkFormat");
    if (value === "absolute" || value === "relative" || value === "shortest") {
      return value;
    }
    return "shortest";
  }

  toggleLinkFormat() {
    const current = this.getCurrentFormat();
    const next = current === "absolute" ? "shortest" : "absolute";

    this.app.vault.setConfig("newLinkFormat", next);
    this.refreshAllHeaderButtons();

    const label =
      next === "absolute"
        ? "Liens : chemin absolu dans le coffre"
        : "Liens : chemin le plus court possible";

    new Notice(label, 2000);
  }

  refreshAllHeaderButtons() {
    const liveViews = new Set();

    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;

      if (!(view instanceof MarkdownView)) return;
      liveViews.add(view);

      let buttonEl = this.headerButtons.get(view);

      if (!buttonEl || !buttonEl.isConnected) {
        buttonEl = view.addAction(
          "link-format-short",
          "Mode lien : chemin le plus court possible",
          () => this.toggleLinkFormat()
        );

        buttonEl.classList.add("link-format-toggle-header");
        this.headerButtons.set(view, buttonEl);
      }

      this.refreshOneButton(buttonEl);
    });

    for (const [view, buttonEl] of this.headerButtons.entries()) {
      if (!liveViews.has(view) || !buttonEl || !buttonEl.isConnected) {
        if (buttonEl && buttonEl.isConnected) buttonEl.remove();
        this.headerButtons.delete(view);
      }
    }
  }

  refreshOneButton(buttonEl) {
    const isAbsolute = this.getCurrentFormat() === "absolute";
    const iconId = isAbsolute ? "link-format-absolute" : "link-format-short";
    const tooltip = isAbsolute
      ? "Mode lien : chemin absolu dans le coffre"
      : "Mode lien : chemin le plus court possible";

    setIcon(buttonEl, iconId);
    buttonEl.setAttribute("aria-label", tooltip);
    buttonEl.setAttribute("title", tooltip);
    buttonEl.classList.toggle("mod-link-format-absolute", isAbsolute);
    buttonEl.classList.toggle("mod-link-format-short", !isAbsolute);
  }
};
