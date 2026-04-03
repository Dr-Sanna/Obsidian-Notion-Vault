const { Plugin, TFile, MarkdownView, Keymap, Notice } = require("obsidian");

const CLICK_SELECTOR = ".view-header-breadcrumb";
const HEADER_SELECTOR = ".view-header";
const TITLE_PARENT_SELECTOR = ".view-header-title-parent";
const BREADCRUMB_SELECTOR = ".view-header-breadcrumb";
const SEPARATOR_SELECTOR = ".view-header-breadcrumb-separator";
const CLICKABLE_CLASS = "direct-breadcrumbs-clickable";
const MISSING_CLASS = "direct-breadcrumbs-missing";
const HIDDEN_CLASS = "direct-breadcrumbs-hidden";
const SEPARATOR_HIDDEN_CLASS = "direct-breadcrumbs-separator-hidden";
const DATA_TARGET = "data-direct-breadcrumb-target";
const DATA_LABEL = "data-direct-breadcrumb-label";
const DATA_MANAGED = "data-direct-breadcrumb-managed";

class DirectBreadcrumbsPlugin extends Plugin {
  onload() {
    this.refreshTimer = null;
    this.observer = null;

    this.registerEvent(this.app.workspace.on("file-open", () => this.requestRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.requestRefresh()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.requestRefresh()));

    this.registerDomEvent(document, "click", (event) => this.onBreadcrumbClick(event), { capture: true });
    this.registerDomEvent(document, "contextmenu", (event) => this.onBreadcrumbContextMenu(event), { capture: true });

    this.app.workspace.onLayoutReady(() => {
      this.observeWorkspace();
      this.refreshAllLeaves();
    });

    this.register(() => {
      if (this.refreshTimer !== null) {
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }

      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }

      this.resetManagedBreadcrumbs();
    });
  }

  observeWorkspace() {
    const workspaceEl = document.querySelector(".workspace");
    if (!workspaceEl || this.observer) return;

    this.observer = new MutationObserver(() => this.requestRefresh());
    this.observer.observe(workspaceEl, {
      childList: true,
      subtree: true,
    });
  }

  requestRefresh() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshAllLeaves();
    }, 40);
  }

  refreshAllLeaves() {
    this.resetManagedBreadcrumbs();

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      this.refreshLeaf(leaf);
    }
  }

  resetManagedBreadcrumbs() {
    for (const el of document.querySelectorAll(`[${DATA_MANAGED}="true"]`)) {
      this.resetElement(el);
    }
  }

  refreshLeaf(leaf) {
    if (!leaf || !(leaf.view instanceof MarkdownView)) return;

    const file = leaf.view.file;
    if (!(file instanceof TFile)) return;

    const headerEl = leaf.containerEl?.querySelector(HEADER_SELECTOR);
    if (!headerEl) return;

    const titleParentEl = headerEl.querySelector(TITLE_PARENT_SELECTOR);
    if (!titleParentEl) return;

    const crumbs = Array.from(titleParentEl.querySelectorAll(BREADCRUMB_SELECTOR));
    if (!crumbs.length) return;

    const separators = Array.from(titleParentEl.querySelectorAll(SEPARATOR_SELECTOR));
    const model = this.buildDisplayModel(file, crumbs.length);

    for (let index = 0; index < crumbs.length; index += 1) {
      const crumb = crumbs[index];
      const item = model[index] ?? null;
      this.applyItemToElement(crumb, item);
    }

    for (let index = 0; index < separators.length; index += 1) {
      const separator = separators[index];
      const relatedCrumb = crumbs[index] ?? null;
      const crumbIsVisible = Boolean(relatedCrumb && !relatedCrumb.classList.contains(HIDDEN_CLASS));
      separator.classList.toggle(SEPARATOR_HIDDEN_CLASS, !crumbIsVisible);
      separator.setAttribute(DATA_MANAGED, "true");
    }
  }

  buildDisplayModel(file, visibleCrumbCount) {
    const folders = [];
    let currentFolder = file.parent;

    while (currentFolder && currentFolder.parent) {
      folders.unshift(currentFolder);
      currentFolder = currentFolder.parent;
    }

    const isFolderNote = Boolean(file.parent && file.basename === file.parent.name);
    const foldersToShow = isFolderNote ? folders.slice(0, -1) : folders;

    const items = foldersToShow.map((folder) => ({
      label: folder.name,
      target: this.getFolderNoteFile(folder),
    }));

    while (items.length < visibleCrumbCount) {
      items.push(null);
    }

    return items;
  }

  getFolderNoteFile(folder) {
    if (!folder || !folder.path) return null;

    const candidatePath = `${folder.path}/${folder.name}.md`;
    const candidate = this.app.vault.getAbstractFileByPath(candidatePath);
    return candidate instanceof TFile ? candidate : null;
  }

  applyItemToElement(el, item) {
    this.resetElement(el);

    if (!item) {
      el.classList.add(HIDDEN_CLASS);
      el.setAttribute(DATA_MANAGED, "true");
      return;
    }

    el.setAttribute(DATA_MANAGED, "true");
    el.setAttribute(DATA_LABEL, item.label ?? "");

    if (item.target instanceof TFile) {
      el.classList.add(CLICKABLE_CLASS);
      el.setAttribute(DATA_TARGET, item.target.path);
      el.setAttribute("aria-label", `Open ${item.target.basename}`);
    } else {
      el.classList.add(MISSING_CLASS);
      el.setAttribute(DATA_TARGET, "");
      el.setAttribute("aria-label", `No note available for ${item.label}`);
    }
  }

  resetElement(el) {
    el.classList.remove(CLICKABLE_CLASS, MISSING_CLASS, HIDDEN_CLASS, SEPARATOR_HIDDEN_CLASS);
    el.removeAttribute(DATA_TARGET);
    el.removeAttribute(DATA_LABEL);
    el.removeAttribute(DATA_MANAGED);
    el.removeAttribute("aria-label");
  }

  onBreadcrumbClick(event) {
    const segment = event.target instanceof Element
      ? event.target.closest(CLICK_SELECTOR)
      : null;

    if (!segment || segment.getAttribute(DATA_MANAGED) !== "true") return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    const targetPath = segment.getAttribute(DATA_TARGET) || "";
    if (!targetPath) {
      const label = segment.getAttribute(DATA_LABEL) || segment.textContent?.trim() || "this breadcrumb";
      new Notice(`No note found for ${label}.`);
      return;
    }

    this.openTargetPath(targetPath, event);
  }

  onBreadcrumbContextMenu(event) {
    const segment = event.target instanceof Element
      ? event.target.closest(CLICK_SELECTOR)
      : null;

    if (!segment || segment.getAttribute(DATA_MANAGED) !== "true") return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  async openTargetPath(targetPath, event) {
    const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(targetFile instanceof TFile)) {
      new Notice(`Unable to open: ${targetPath}`);
      return;
    }

    const newLeaf = Boolean(event instanceof MouseEvent && Keymap.isModEvent(event));
    await this.app.workspace.openLinkText(targetFile.path, "", newLeaf);
  }
}

module.exports = DirectBreadcrumbsPlugin;
