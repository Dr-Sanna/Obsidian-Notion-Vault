const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  MarkdownRenderer,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  defaultShowInEmbeds: true,
  viewerPanelPosition: "right",
  showCaptionsInLivePreview: true,
  defaultCopyAsTransclusion: true,
  defaultCopyIncludeAlias: false,
  defaultCopyAsBold: false,
  defaultCopyWrapAliasInParentheses: false,
  images: {}
};

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff"
]);

module.exports = class ImageViewerCaptionsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.lastMarkdownLeaf = null;

    this.addSettingTab(new ImageViewerCaptionsSettingTab(this.app, this));

    this.registerMarkdownPostProcessor((element, context) => {
      this.decorateRenderedSection(element, context.sourcePath);
    });

    this.addCommand({
      id: "refresh-image-captions",
      name: "Refresh image captions",
      callback: () => {
        this.refreshAll();
        new Notice("Image captions refreshed.");
      }
    });

    this.addCommand({
      id: "copy-current-image-wikilink",
      name: "Copy wikilink for current image",
      callback: async () => {
        const imagePath = this.getCurrentImagePath();
        if (!imagePath) {
          new Notice("No image viewer is currently active.");
          return;
        }
        const sourcePath = this.lastMarkdownLeaf?.view?.file?.path || "";
        const wikilink = this.buildPreferredImageWikilink(
          imagePath,
          sourcePath,
          {
            asTransclusion: this.settings.defaultCopyAsTransclusion,
            includeAlias: this.settings.defaultCopyIncludeAlias,
            wrapAliasInParentheses: this.settings.defaultCopyWrapAliasInParentheses,
            asBold: this.settings.defaultCopyAsBold
          }
        );
        const copied = await this.copyText(wikilink);
        new Notice(copied ? "Wikilink copied." : "Unable to copy the wikilink.");
      }
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      this.trackLastMarkdownLeaf(leaf);
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      await this.handleRename(file, oldPath);
    }));

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const context = this.getImageWikilinkContextAtCursor(editor, info);
      if (!context) {
        return;
      }

      menu.addItem((item) => {
        item
          .setTitle("Apply stored image alias")
          .setIcon("text-cursor-input")
          .onClick(async () => {
            await this.applyStoredAliasToImageWikilink(editor, context);
          });
      });
    }));

    this.app.workspace.onLayoutReady(() => {
      this.trackLastMarkdownLeaf(this.app.workspace.getMostRecentLeaf());

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== "childList") {
            continue;
          }
          if (this.shouldIgnoreMutation(mutation)) {
            continue;
          }
          if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
            this.scheduleRefresh();
            return;
          }
        }
      });

      const workspaceContainer = this.app.workspace.containerEl;
      if (workspaceContainer) {
        observer.observe(workspaceContainer, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
      }

      this.refreshAll();
    });
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const container = this.app.workspace.containerEl;
    if (!container) {
      return;
    }

    container
      .querySelectorAll(".obsidian-image-captions-caption")
      .forEach((element) => element.remove());

    container
      .querySelectorAll(".obsidian-image-captions-viewer-layout")
      .forEach((layout) => this.restoreImageViewerHost(layout));

    container
      .querySelectorAll(".obsidian-image-captions-live-preview-host")
      .forEach((embed) => embed.classList.remove("obsidian-image-captions-live-preview-host"));

    container
      .querySelectorAll("[data-obsidian-image-captions-image-path]")
      .forEach((element) => {
        element.removeAttribute("data-obsidian-image-captions-image-path");
        element.removeAttribute("data-obsidian-image-captions-source-path");
      });
  }

  trackLastMarkdownLeaf(leaf) {
    const candidate = leaf || this.app.workspace.getMostRecentLeaf();
    if (!candidate || candidate.view?.getViewType?.() !== "markdown") {
      return;
    }
    this.lastMarkdownLeaf = candidate;
  }

  scheduleRefresh() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshAll();
    }, 80);
  }

  refreshAll() {
    this.decorateOpenMarkdownViews();
    this.refreshImageViewerPanels();
    this.refreshRenderedCaptions();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.images || typeof this.settings.images !== "object") {
      this.settings.images = {};
    }

    if (!["top", "right", "bottom", "left"].includes(this.settings.viewerPanelPosition)) {
      this.settings.viewerPanelPosition = DEFAULT_SETTINGS.viewerPanelPosition;
    }

    if (typeof this.settings.showCaptionsInLivePreview !== "boolean") {
      this.settings.showCaptionsInLivePreview = DEFAULT_SETTINGS.showCaptionsInLivePreview;
    }

    if (typeof this.settings.defaultCopyAsTransclusion !== "boolean") {
      this.settings.defaultCopyAsTransclusion = DEFAULT_SETTINGS.defaultCopyAsTransclusion;
    }

    if (typeof this.settings.defaultCopyIncludeAlias !== "boolean") {
      this.settings.defaultCopyIncludeAlias = DEFAULT_SETTINGS.defaultCopyIncludeAlias;
    }

    if (typeof this.settings.defaultCopyAsBold !== "boolean") {
      this.settings.defaultCopyAsBold = DEFAULT_SETTINGS.defaultCopyAsBold;
    }

    if (typeof this.settings.defaultCopyWrapAliasInParentheses !== "boolean") {
      this.settings.defaultCopyWrapAliasInParentheses = DEFAULT_SETTINGS.defaultCopyWrapAliasInParentheses;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getRecord(imagePath) {
    const existing = this.settings.images[imagePath];
    if (existing) {
      return {
        caption: typeof existing.caption === "string" ? existing.caption : "",
        showInEmbeds: typeof existing.showInEmbeds === "boolean"
          ? existing.showInEmbeds
          : this.settings.defaultShowInEmbeds,
        alias: typeof existing.alias === "string" ? existing.alias : "",
        prefixEnabled: typeof existing.prefixEnabled === "boolean" ? existing.prefixEnabled : false,
        prefixText: typeof existing.prefixText === "string" ? existing.prefixText : ""
      };
    }

    return {
      caption: "",
      showInEmbeds: this.settings.defaultShowInEmbeds,
      alias: "",
      prefixEnabled: false,
      prefixText: ""
    };
  }

  async upsertRecord(imagePath, caption, showInEmbeds, alias = "", prefixEnabled = false, prefixText = "", refresh = true) {
    const normalizedCaption = typeof caption === "string" ? caption.trim() : "";
    const normalizedShow = !!showInEmbeds;
    const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
    const normalizedPrefixEnabled = !!prefixEnabled;
    const normalizedPrefixText = typeof prefixText === "string" ? prefixText.trim() : "";

    if (!normalizedCaption && !normalizedAlias && normalizedShow === this.settings.defaultShowInEmbeds && !normalizedPrefixEnabled && !normalizedPrefixText) {
      delete this.settings.images[imagePath];
    } else {
      this.settings.images[imagePath] = {
        caption: normalizedCaption,
        showInEmbeds: normalizedShow,
        alias: normalizedAlias,
        prefixEnabled: normalizedPrefixEnabled,
        prefixText: normalizedPrefixText
      };
    }

    await this.saveSettings();
    if (refresh) {
      this.refreshAll();
    }
  }

  async clearRecord(imagePath) {
    delete this.settings.images[imagePath];
    await this.saveSettings();
    this.refreshAll();
  }

  async handleRename(file, oldPath) {
    if (!(file instanceof TFile)) {
      return;
    }

    if (!this.isImageFile(file)) {
      return;
    }

    if (!this.settings.images[oldPath]) {
      return;
    }

    this.settings.images[file.path] = this.settings.images[oldPath];
    delete this.settings.images[oldPath];
    await this.saveSettings();
    this.refreshAll();
  }

  isImageFile(file) {
    return file instanceof TFile && IMAGE_EXTENSIONS.has((file.extension || "").toLowerCase());
  }

  cleanLinktext(linktext) {
    if (!linktext || typeof linktext !== "string") {
      return "";
    }

    return decodeURIComponent(linktext)
      .split("|")[0]
      .split("#")[0]
      .trim();
  }

  resolveImageLink(linktext, sourcePath) {
    const cleaned = this.cleanLinktext(linktext);
    if (!cleaned) {
      return null;
    }

    const file = this.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath || "");
    if (!this.isImageFile(file)) {
      return null;
    }

    return file;
  }

  decorateOpenMarkdownViews() {
    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");

    for (const leaf of markdownLeaves) {
      const view = leaf.view;
      const sourcePath = view?.file?.path || "";
      const root = view?.containerEl;
      if (!(root instanceof HTMLElement)) {
        continue;
      }

      const readingContainers = root.querySelectorAll(".markdown-reading-view, .markdown-preview-view");
      readingContainers.forEach((container) => {
        if (container instanceof HTMLElement) {
          this.decorateRenderedSection(container, sourcePath);
        }
      });

      if (this.settings.showCaptionsInLivePreview) {
        const livePreviewContainers = root.querySelectorAll(".markdown-source-view.mod-cm6, .cm-editor");
        livePreviewContainers.forEach((container) => {
          if (container instanceof HTMLElement) {
            this.decorateRenderedSection(container, sourcePath);
          }
        });
      }
    }
  }

  decorateRenderedSection(containerEl, sourcePath) {
    if (!(containerEl instanceof HTMLElement)) {
      return;
    }

    const embeds = containerEl.querySelectorAll(".image-embed[src], .internal-embed[src]");
    embeds.forEach((embed) => this.decorateEmbed(embed, sourcePath));
  }

  decorateEmbed(embed, sourcePath) {
    if (!(embed instanceof HTMLElement)) {
      return;
    }

    const imageFile = this.resolveImageLink(embed.getAttribute("src") || "", sourcePath);
    if (!imageFile) {
      return;
    }

    embed.dataset.obsidianImageCaptionsImagePath = imageFile.path;
    embed.dataset.obsidianImageCaptionsSourcePath = sourcePath || "";
    void this.renderCaptionForEmbed(embed, imageFile.path, sourcePath || imageFile.path);
  }

  async renderCaptionForEmbed(embed, imagePath, renderSourcePath) {
    if (!(embed instanceof HTMLElement)) {
      return;
    }

    if (this.isLivePreviewEmbed(embed)) {
      await this.renderLivePreviewCaption(embed, imagePath, renderSourcePath);
      return;
    }

    await this.renderReadingCaption(embed, imagePath, renderSourcePath);
  }

  async renderLivePreviewCaption(embed, imagePath, renderSourcePath) {
    this.removeManagedCaptionSibling(embed);

    const record = this.getRecord(imagePath);
    const hasRenderableContent = !!record.caption || (record.prefixEnabled && !!record.prefixText);
    if (!hasRenderableContent || !record.showInEmbeds || !this.settings.showCaptionsInLivePreview) {
      embed.classList.remove("obsidian-image-captions-live-preview-host");
      this.removeManagedInlineCaptions(embed, true);
      return;
    }

    embed.classList.add("obsidian-image-captions-live-preview-host");
    const captionEl = this.ensureManagedInlineCaption(embed);
    captionEl.dataset.obsidianImageCaptionsFor = imagePath;

    const renderToken = `${Date.now()}-${Math.random()}`;
    captionEl.dataset.renderToken = renderToken;

    try {
      const renderedCaption = await this.buildRenderedCaptionElement(imagePath, record.caption, renderSourcePath || imagePath, {
        prefixEnabled: record.prefixEnabled,
        prefixText: record.prefixText,
        alias: record.alias
      });

      if (captionEl.dataset.renderToken !== renderToken) {
        return;
      }

      captionEl.empty();
      while (renderedCaption.firstChild) {
        captionEl.appendChild(renderedCaption.firstChild);
      }
    } catch (_error) {
      if (captionEl.dataset.renderToken !== renderToken) {
        return;
      }
      captionEl.empty();
      captionEl.setText(record.caption);
    }
  }

  async renderReadingCaption(embed, imagePath, renderSourcePath) {
    this.removeManagedInlineCaptions(embed);

    const record = this.getRecord(imagePath);
    const existingCaption = this.findManagedCaptionSibling(embed);
    const hasRenderableContent = !!record.caption || (record.prefixEnabled && !!record.prefixText);

    if (!hasRenderableContent || !record.showInEmbeds) {
      if (existingCaption) {
        existingCaption.remove();
      }
      return;
    }

    const captionEl = existingCaption || this.createCaptionSibling(embed);
    captionEl.dataset.obsidianImageCaptionsFor = imagePath;

    const renderToken = `${Date.now()}-${Math.random()}`;
    captionEl.dataset.renderToken = renderToken;

    try {
      const renderedCaption = await this.buildRenderedCaptionElement(imagePath, record.caption, renderSourcePath || imagePath, {
        prefixEnabled: record.prefixEnabled,
        prefixText: record.prefixText,
        alias: record.alias
      });

      if (captionEl.dataset.renderToken !== renderToken) {
        return;
      }

      captionEl.empty();
      while (renderedCaption.firstChild) {
        captionEl.appendChild(renderedCaption.firstChild);
      }
    } catch (_error) {
      if (captionEl.dataset.renderToken !== renderToken) {
        return;
      }
      captionEl.empty();
      captionEl.setText(record.caption);
    }
  }

  removeManagedInlineCaptions(embed, force = false) {
    if (!(embed instanceof HTMLElement)) {
      return;
    }

    embed
      .querySelectorAll(":scope > .obsidian-image-captions-caption")
      .forEach((node, index) => {
        if (index === 0) {
          return;
        }
        node.remove();
      });

    const inlineCaption = embed.querySelector(":scope > .obsidian-image-captions-caption");
    if (!(inlineCaption instanceof HTMLElement)) {
      return;
    }

    if (force || !embed.classList.contains("obsidian-image-captions-live-preview-host")) {
      inlineCaption.remove();
    }
  }

  removeManagedCaptionSibling(embed) {
    const sibling = this.findManagedCaptionSibling(embed);
    if (sibling) {
      sibling.remove();
    }
  }

  isLivePreviewEmbed(embed) {
    if (!(embed instanceof HTMLElement)) {
      return false;
    }

    return !!embed.closest(".markdown-source-view.mod-cm6, .cm-editor");
  }

  ensureManagedInlineCaption(embed) {
    let captionEl = embed.querySelector(":scope > .obsidian-image-captions-caption");
    if (captionEl instanceof HTMLElement) {
      return captionEl;
    }

    captionEl = document.createElement("figcaption");
    captionEl.className = "obsidian-image-captions-caption obsidian-image-captions-caption--inline";
    captionEl.setAttribute("contenteditable", "false");

    const imageWrapper = embed.querySelector(":scope > .image-wrapper");
    if (imageWrapper instanceof HTMLElement && imageWrapper.nextSibling) {
      embed.insertBefore(captionEl, imageWrapper.nextSibling);
    } else {
      embed.appendChild(captionEl);
    }

    return captionEl;
  }

  createCaptionSibling(embed) {
    const captionEl = document.createElement("figcaption");
    captionEl.className = "obsidian-image-captions-caption obsidian-image-captions-caption--block";
    embed.insertAdjacentElement("afterend", captionEl);
    return captionEl;
  }

  findManagedCaptionSibling(embed) {
    let sibling = embed.nextElementSibling;
    while (sibling) {
      if (sibling.classList.contains("obsidian-image-captions-caption")) {
        return sibling;
      }
      if (sibling.classList.contains("image-embed") || sibling.classList.contains("internal-embed")) {
        break;
      }
      sibling = sibling.nextElementSibling;
    }
    return null;
  }

  refreshRenderedCaptions() {
    const container = this.app.workspace.containerEl;
    if (!container) {
      return;
    }

    container
      .querySelectorAll("[data-obsidian-image-captions-image-path]")
      .forEach((embed) => {
        if (!(embed instanceof HTMLElement)) {
          return;
        }
        const imagePath = embed.dataset.obsidianImageCaptionsImagePath;
        const sourcePath = embed.dataset.obsidianImageCaptionsSourcePath || imagePath || "";
        if (!imagePath) {
          return;
        }
        void this.renderCaptionForEmbed(embed, imagePath, sourcePath);
      });
  }

  refreshImageViewerPanels() {
    const imageLeaves = this.app.workspace.getLeavesOfType("image");
    const validContainers = new Set();

    for (const leaf of imageLeaves) {
      const view = leaf.view;
      const file = view && view.file;
      if (!this.isImageFile(file)) {
        continue;
      }

      const viewContent = view.containerEl?.querySelector(".view-content") || view.containerEl;
      if (!(viewContent instanceof HTMLElement)) {
        continue;
      }

      validContainers.add(viewContent);
      this.syncImageViewerPanel(viewContent, file.path);
    }

    const workspaceContainer = this.app.workspace.containerEl;
    if (!workspaceContainer) {
      return;
    }

    workspaceContainer
      .querySelectorAll(".obsidian-image-captions-viewer-layout")
      .forEach((layout) => {
        const host = layout.parentElement;
        if (!(host instanceof HTMLElement) || !validContainers.has(host)) {
          this.restoreImageViewerHost(layout);
        }
      });
  }

  syncImageViewerPanel(host, imagePath) {
    const { layout, media } = this.ensureImageViewerLayout(host);
    layout.dataset.panelPosition = this.settings.viewerPanelPosition;

    let panel = layout.querySelector(":scope > .obsidian-image-captions-viewer-panel");
    if (!(panel instanceof HTMLElement) || panel.dataset.imagePath !== imagePath) {
      if (panel instanceof HTMLElement) {
        panel.remove();
      }
      panel = this.buildImageViewerPanel(layout, media, imagePath);
    }

    this.populateImageViewerPanel(panel, imagePath);
  }

  ensureImageViewerLayout(host) {
    host.classList.add("obsidian-image-captions-image-view-host");
    host.dataset.obsidianImageCaptionsPanelPosition = this.settings.viewerPanelPosition;

    let layout = host.querySelector(":scope > .obsidian-image-captions-viewer-layout");
    let media = layout?.querySelector(":scope > .obsidian-image-captions-viewer-media");

    if (!(layout instanceof HTMLElement) || !(media instanceof HTMLElement)) {
      layout = document.createElement("div");
      layout.className = "obsidian-image-captions-viewer-layout";
      media = document.createElement("div");
      media.className = "obsidian-image-captions-viewer-media";
      layout.appendChild(media);
      host.appendChild(layout);
    }

    Array.from(host.childNodes).forEach((node) => {
      if (node === layout) {
        return;
      }
      media.appendChild(node);
    });

    return { layout, media };
  }

  restoreImageViewerHost(layout) {
    if (!(layout instanceof HTMLElement)) {
      return;
    }

    const host = layout.parentElement;
    if (!(host instanceof HTMLElement)) {
      layout.remove();
      return;
    }

    const media = layout.querySelector(":scope > .obsidian-image-captions-viewer-media");
    if (media instanceof HTMLElement) {
      media
        .querySelectorAll(":scope > .obsidian-image-captions-viewer-preview-caption")
        .forEach((node) => node.remove());

      while (media.firstChild) {
        host.insertBefore(media.firstChild, layout);
      }
    }

    layout.remove();
    host.classList.remove("obsidian-image-captions-image-view-host");
    host.removeAttribute("data-obsidian-image-captions-panel-position");
  }

  buildImageViewerPanel(layout, media, imagePath) {
    const panel = document.createElement("div");
    panel.className = "obsidian-image-captions-viewer-panel";
    panel.dataset.imagePath = imagePath;

    const captionLabel = document.createElement("label");
    captionLabel.className = "obsidian-image-captions-viewer-field-label";
    captionLabel.textContent = "Caption";
    panel.appendChild(captionLabel);

    const toggleRow = document.createElement("label");
    toggleRow.className = "obsidian-image-captions-viewer-toggle-row";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "obsidian-image-captions-viewer-toggle";
    const toggleText = document.createElement("span");
    toggleText.textContent = "Show when transcluded";
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(toggleText);
    panel.appendChild(toggleRow);

    const prefixRow = document.createElement("div");
    prefixRow.className = "obsidian-image-captions-viewer-inline-row obsidian-image-captions-viewer-inline-row--toggle";

    const prefixToggle = document.createElement("input");
    prefixToggle.type = "checkbox";
    prefixToggle.className = "obsidian-image-captions-prefix-toggle";

    const prefixLabel = document.createElement("label");
    prefixLabel.className = "obsidian-image-captions-viewer-inline-label";
    prefixLabel.textContent = "Prefix";

    const prefixTextInput = document.createElement("input");
    prefixTextInput.type = "text";
    prefixTextInput.className = "obsidian-image-captions-viewer-input obsidian-image-captions-prefix-text-input";
    prefixTextInput.placeholder = "Ex. Fig. 1 :";

    const useAliasForPrefixButton = document.createElement("button");
    useAliasForPrefixButton.type = "button";
    useAliasForPrefixButton.className = "obsidian-image-captions-prefix-use-alias-button";
    useAliasForPrefixButton.textContent = "Use alias";

    prefixRow.appendChild(prefixToggle);
    prefixRow.appendChild(prefixLabel);
    prefixRow.appendChild(prefixTextInput);
    prefixRow.appendChild(useAliasForPrefixButton);
    panel.appendChild(prefixRow);

    const sectionDividerOne = document.createElement("div");
    sectionDividerOne.className = "obsidian-image-captions-viewer-section-divider";
    panel.appendChild(sectionDividerOne);

    const aliasRow = document.createElement("div");
    aliasRow.className = "obsidian-image-captions-viewer-inline-row";

    const aliasLabel = document.createElement("label");
    aliasLabel.className = "obsidian-image-captions-viewer-inline-label";
    aliasLabel.textContent = "Alias";

    const aliasInput = document.createElement("input");
    aliasInput.type = "text";
    aliasInput.className = "obsidian-image-captions-viewer-input obsidian-image-captions-viewer-alias-input";
    aliasInput.placeholder = "Optional alias to append as |alias";

    aliasRow.appendChild(aliasLabel);
    aliasRow.appendChild(aliasInput);
    panel.appendChild(aliasRow);

    const sectionDividerTwo = document.createElement("div");
    sectionDividerTwo.className = "obsidian-image-captions-viewer-section-divider";
    panel.appendChild(sectionDividerTwo);

    const lowerArea = document.createElement("div");
    lowerArea.className = "obsidian-image-captions-viewer-lower-area";

    const renameSection = document.createElement("div");
    renameSection.className = "obsidian-image-captions-helper-section obsidian-image-captions-helper-section--split";

    const renameControls = document.createElement("div");
    renameControls.className = "obsidian-image-captions-helper-grid obsidian-image-captions-helper-grid--range";

    const renameKindWrap = document.createElement("div");
    const renameKindLabel = document.createElement("label");
    renameKindLabel.className = "obsidian-image-captions-viewer-field-label";
    renameKindLabel.textContent = "Type";
    renameKindWrap.appendChild(renameKindLabel);

    const renameKindSelect = document.createElement("select");
    renameKindSelect.className = "dropdown obsidian-image-captions-rename-kind-select";
    renameKindSelect.appendChild(new Option("Figure", "figure"));
    renameKindSelect.appendChild(new Option("Tableau", "tableau"));
    renameKindWrap.appendChild(renameKindSelect);
    renameControls.appendChild(renameKindWrap);

    const renameStartWrap = document.createElement("div");
    const renameStartLabel = document.createElement("label");
    renameStartLabel.className = "obsidian-image-captions-viewer-field-label";
    renameStartLabel.textContent = "From";
    renameStartWrap.appendChild(renameStartLabel);

    const renameStartInput = document.createElement("input");
    renameStartInput.type = "number";
    renameStartInput.min = "1";
    renameStartInput.step = "1";
    renameStartInput.className = "obsidian-image-captions-viewer-input obsidian-image-captions-rename-start-input";
    renameStartInput.placeholder = "1";
    renameStartWrap.appendChild(renameStartInput);
    renameControls.appendChild(renameStartWrap);

    const renameEndWrap = document.createElement("div");
    const renameEndLabel = document.createElement("label");
    renameEndLabel.className = "obsidian-image-captions-viewer-field-label";
    renameEndLabel.textContent = "To";
    renameEndWrap.appendChild(renameEndLabel);

    const renameEndInput = document.createElement("input");
    renameEndInput.type = "number";
    renameEndInput.min = "1";
    renameEndInput.step = "1";
    renameEndInput.className = "obsidian-image-captions-viewer-input obsidian-image-captions-rename-end-input";
    renameEndInput.placeholder = "1";
    renameEndWrap.appendChild(renameEndInput);
    renameControls.appendChild(renameEndWrap);

    renameSection.appendChild(renameControls);

    const aliasOptionsTitle = document.createElement("label");
    aliasOptionsTitle.className = "obsidian-image-captions-viewer-field-label";
    aliasOptionsTitle.textContent = "Generated alias options";
    renameSection.appendChild(aliasOptionsTitle);

    const aliasLowercaseRow = document.createElement("label");
    aliasLowercaseRow.className = "obsidian-image-captions-viewer-toggle-row";
    const aliasLowercaseToggle = document.createElement("input");
    aliasLowercaseToggle.type = "checkbox";
    aliasLowercaseToggle.className = "obsidian-image-captions-alias-lowercase-toggle";
    const aliasLowercaseText = document.createElement("span");
    aliasLowercaseText.textContent = "Lowercase alias";
    aliasLowercaseRow.appendChild(aliasLowercaseToggle);
    aliasLowercaseRow.appendChild(aliasLowercaseText);
    renameSection.appendChild(aliasLowercaseRow);

    const aliasAbbreviateRow = document.createElement("label");
    aliasAbbreviateRow.className = "obsidian-image-captions-viewer-toggle-row";
    const aliasAbbreviateToggle = document.createElement("input");
    aliasAbbreviateToggle.type = "checkbox";
    aliasAbbreviateToggle.className = "obsidian-image-captions-alias-abbreviate-toggle";
    const aliasAbbreviateText = document.createElement("span");
    aliasAbbreviateText.textContent = "Use abbreviation (Fig. / Tab.)";
    aliasAbbreviateRow.appendChild(aliasAbbreviateToggle);
    aliasAbbreviateRow.appendChild(aliasAbbreviateText);
    renameSection.appendChild(aliasAbbreviateRow);

    const aliasTrailingPeriodRow = document.createElement("label");
    aliasTrailingPeriodRow.className = "obsidian-image-captions-viewer-toggle-row";
    const aliasTrailingPeriodToggle = document.createElement("input");
    aliasTrailingPeriodToggle.type = "checkbox";
    aliasTrailingPeriodToggle.className = "obsidian-image-captions-alias-trailing-period-toggle";
    const aliasTrailingPeriodText = document.createElement("span");
    aliasTrailingPeriodText.textContent = "Add trailing period";
    aliasTrailingPeriodRow.appendChild(aliasTrailingPeriodToggle);
    aliasTrailingPeriodRow.appendChild(aliasTrailingPeriodText);
    renameSection.appendChild(aliasTrailingPeriodRow);

    const aliasParenthesesRow = document.createElement("label");
    aliasParenthesesRow.className = "obsidian-image-captions-viewer-toggle-row";
    const aliasParenthesesToggle = document.createElement("input");
    aliasParenthesesToggle.type = "checkbox";
    aliasParenthesesToggle.className = "obsidian-image-captions-alias-parentheses-toggle";
    const aliasParenthesesText = document.createElement("span");
    aliasParenthesesText.textContent = "Wrap alias in parentheses";
    aliasParenthesesRow.appendChild(aliasParenthesesToggle);
    aliasParenthesesRow.appendChild(aliasParenthesesText);
    renameSection.appendChild(aliasParenthesesRow);

    const helperPreview = document.createElement("div");
    helperPreview.className = "obsidian-image-captions-helper-preview";

    const helperFilenamePreview = document.createElement("div");
    helperFilenamePreview.className = "obsidian-image-captions-helper-preview-line";
    helperFilenamePreview.innerHTML = '<span class="obsidian-image-captions-helper-preview-label">Filename</span><span class="obsidian-image-captions-helper-filename-preview">—</span>';
    helperPreview.appendChild(helperFilenamePreview);

    const helperAliasPreview = document.createElement("div");
    helperAliasPreview.className = "obsidian-image-captions-helper-preview-line";
    helperAliasPreview.innerHTML = '<span class="obsidian-image-captions-helper-preview-label">Alias</span><span class="obsidian-image-captions-helper-alias-preview">—</span>';
    helperPreview.appendChild(helperAliasPreview);

    renameSection.appendChild(helperPreview);

    const helperButtonRow = document.createElement("div");
    helperButtonRow.className = "obsidian-image-captions-viewer-buttons";

    const renameFileButton = document.createElement("button");
    renameFileButton.type = "button";
    renameFileButton.className = "mod-cta obsidian-image-captions-helper-rename-file-button";
    renameFileButton.textContent = "Rename file";
    helperButtonRow.appendChild(renameFileButton);

    const renameAliasButton = document.createElement("button");
    renameAliasButton.type = "button";
    renameAliasButton.className = "obsidian-image-captions-helper-rename-alias-button";
    renameAliasButton.textContent = "Rename alias";
    helperButtonRow.appendChild(renameAliasButton);

    renameSection.appendChild(helperButtonRow);
    lowerArea.appendChild(renameSection);

    const lowerAreaHorizontalDivider = document.createElement("div");
    lowerAreaHorizontalDivider.className = "obsidian-image-captions-viewer-section-divider obsidian-image-captions-viewer-lower-horizontal-divider";
    lowerArea.appendChild(lowerAreaHorizontalDivider);

    const copySection = document.createElement("div");
    copySection.className = "obsidian-image-captions-copy-section";

    const copySectionTitle = document.createElement("div");
    copySectionTitle.className = "obsidian-image-captions-helper-section-title";
    copySectionTitle.textContent = "Wikilink to copy";
    copySection.appendChild(copySectionTitle);

    const copyModeRow = document.createElement("label");
    copyModeRow.className = "obsidian-image-captions-viewer-toggle-row";

    const copyModeToggle = document.createElement("input");
    copyModeToggle.type = "checkbox";
    copyModeToggle.className = "obsidian-image-captions-viewer-copy-toggle";
    const copyModeText = document.createElement("span");
    copyModeText.textContent = "Copy as transclusion";
    copyModeRow.appendChild(copyModeToggle);
    copyModeRow.appendChild(copyModeText);
    copySection.appendChild(copyModeRow);

    const copyAliasRow = document.createElement("label");
    copyAliasRow.className = "obsidian-image-captions-viewer-toggle-row";

    const copyAliasToggle = document.createElement("input");
    copyAliasToggle.type = "checkbox";
    copyAliasToggle.className = "obsidian-image-captions-viewer-copy-alias-toggle";
    const copyAliasText = document.createElement("span");
    copyAliasText.textContent = "Include stored alias in copied link";
    copyAliasRow.appendChild(copyAliasToggle);
    copyAliasRow.appendChild(copyAliasText);
    copySection.appendChild(copyAliasRow);

    const copyAliasParenthesesRow = document.createElement("label");
    copyAliasParenthesesRow.className = "obsidian-image-captions-viewer-toggle-row";

    const copyAliasParenthesesToggle = document.createElement("input");
    copyAliasParenthesesToggle.type = "checkbox";
    copyAliasParenthesesToggle.className = "obsidian-image-captions-viewer-copy-alias-parentheses-toggle";
    const copyAliasParenthesesText = document.createElement("span");
    copyAliasParenthesesText.textContent = "Wrap copied alias in parentheses";
    copyAliasParenthesesRow.appendChild(copyAliasParenthesesToggle);
    copyAliasParenthesesRow.appendChild(copyAliasParenthesesText);
    copySection.appendChild(copyAliasParenthesesRow);

    const copyBoldRow = document.createElement("label");
    copyBoldRow.className = "obsidian-image-captions-viewer-toggle-row";

    const copyBoldToggle = document.createElement("input");
    copyBoldToggle.type = "checkbox";
    copyBoldToggle.className = "obsidian-image-captions-viewer-copy-bold-toggle";
    const copyBoldText = document.createElement("span");
    copyBoldText.textContent = "Copy as bold";
    copyBoldRow.appendChild(copyBoldToggle);
    copyBoldRow.appendChild(copyBoldText);
    copySection.appendChild(copyBoldRow);

    const copyPreview = document.createElement("div");
    copyPreview.className = "obsidian-image-captions-helper-preview obsidian-image-captions-copy-preview";

    const copyPreviewLine = document.createElement("div");
    copyPreviewLine.className = "obsidian-image-captions-helper-preview-line";
    copyPreviewLine.innerHTML = '<span class="obsidian-image-captions-helper-preview-label">Preview</span><span class="obsidian-image-captions-copy-preview-value">[[link]]</span>';
    copyPreview.appendChild(copyPreviewLine);
    copySection.appendChild(copyPreview);

    const buttonRow = document.createElement("div");
    buttonRow.className = "obsidian-image-captions-viewer-buttons";

    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy wikilink";

    buttonRow.appendChild(copyButton);
    copySection.appendChild(buttonRow);

    lowerArea.appendChild(copySection);

    renameSection.insertBefore(aliasRow, aliasOptionsTitle);
    renameSection.remove();
    copySection.remove();
    lowerAreaHorizontalDivider.remove();
    lowerArea.remove();

    panel.insertBefore(renameSection, captionLabel);
    panel.insertBefore(sectionDividerOne, captionLabel);
    panel.appendChild(sectionDividerTwo);
    panel.appendChild(copySection);

    const setStatus = () => {};

    const refreshRenameHelperPreview = () => {
      this.updateRenameHelperPreview(panel);
    };

    let autoSaveTimer = null;
    let autoSaveRunId = 0;

    const saveCurrentPanelState = async (statusText = "", refresh = true) => {
      const currentPath = panel.dataset.imagePath;
      if (!currentPath) {
        return false;
      }
      const captionValue = this.getPanelCaptionValue(panel);
      await this.upsertRecord(currentPath, captionValue, toggle.checked, aliasInput.value, prefixToggle.checked, prefixTextInput.value, refresh);
      panel.dataset.lastCommittedCaption = captionValue;
      if (statusText) {
        setStatus(statusText);
      }
      return true;
    };

    const scheduleAutoSave = (statusText = "Saved") => {
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
      }

      const runId = ++autoSaveRunId;
      autoSaveTimer = window.setTimeout(async () => {
        autoSaveTimer = null;
        if (!panel.isConnected || runId !== autoSaveRunId) {
          return;
        }
        await saveCurrentPanelState(statusText);
      }, 300);
    };

    copyButton.addEventListener("click", async () => {
      const currentPath = panel.dataset.imagePath;
      if (!currentPath) {
        return;
      }
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      await saveCurrentPanelState();
      this.settings.defaultCopyAsTransclusion = copyModeToggle.checked;
      this.settings.defaultCopyIncludeAlias = copyAliasToggle.checked;
      this.settings.defaultCopyWrapAliasInParentheses = copyAliasParenthesesToggle.checked;
      this.settings.defaultCopyAsBold = copyBoldToggle.checked;
      await this.saveSettings();
      const sourcePath = this.lastMarkdownLeaf?.view?.file?.path || "";
      const linkText = this.buildPreferredImageWikilink(
        currentPath,
        sourcePath,
        {
          asTransclusion: copyModeToggle.checked,
          includeAlias: copyAliasToggle.checked,
          wrapAliasInParentheses: copyAliasParenthesesToggle.checked,
          asBold: copyBoldToggle.checked
        }
      );
      const copied = await this.copyText(linkText);
      const record = this.getRecord(currentPath);
      const effectiveIncludeAlias = copyAliasToggle.checked || copyAliasParenthesesToggle.checked;
      if (copied) {
        setStatus(effectiveIncludeAlias && !record.alias ? "No stored alias; wikilink copied" : "Wikilink copied");
      } else {
        setStatus("Copy failed");
      }
    });

    renameFileButton.addEventListener("click", async () => {
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      await saveCurrentPanelState("", false);
      await this.applyRenameHelper(panel, media, setStatus, { renameFile: true, renameAlias: false });
    });

    renameAliasButton.addEventListener("click", async () => {
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      await saveCurrentPanelState("", false);
      await this.applyRenameHelper(panel, media, setStatus, { renameFile: false, renameAlias: true });
    });

    const saveOnShortcut = async (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (autoSaveTimer) {
          window.clearTimeout(autoSaveTimer);
          autoSaveTimer = null;
        }
        await saveCurrentPanelState("Saved");
      }
    };

    panel.__imageCaptionsScheduleAutoSave = scheduleAutoSave;
    panel.__imageCaptionsCancelAutoSave = () => {
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
    };
    panel.__imageCaptionsSaveNow = saveCurrentPanelState;

    useAliasForPrefixButton.addEventListener("click", async () => {
      const aliasValue = String(aliasInput.value || "").trim();
      if (!aliasValue) {
        setStatus("No stored alias to use");
        return;
      }
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      prefixTextInput.value = aliasValue;
      prefixToggle.checked = true;
      prefixTextInput.focus();
      prefixTextInput.setSelectionRange(prefixTextInput.value.length, prefixTextInput.value.length);
      this.updateViewerPreviewFromPanel(media, panel, this.getPanelCaptionValue(panel));
      await saveCurrentPanelState("Prefix filled from alias", false);
    });

    aliasInput.addEventListener("keydown", saveOnShortcut);
    aliasInput.addEventListener("input", () => {
      scheduleAutoSave();
    });
    aliasInput.addEventListener("change", () => {
      scheduleAutoSave();
    });

    prefixTextInput.addEventListener("keydown", saveOnShortcut);
    prefixTextInput.addEventListener("input", () => {
      this.updateViewerPreviewFromPanel(media, panel, this.getPanelCaptionValue(panel));
      scheduleAutoSave();
    });
    prefixTextInput.addEventListener("change", () => {
      this.updateViewerPreviewFromPanel(media, panel, this.getPanelCaptionValue(panel));
      scheduleAutoSave();
    });

    toggle.addEventListener("change", () => {
      this.updateViewerPreviewFromPanel(media, panel, this.getPanelCaptionValue(panel));
      scheduleAutoSave();
    });

    copyModeToggle.addEventListener("change", async () => {
      this.settings.defaultCopyAsTransclusion = copyModeToggle.checked;
      this.updateCopiedLinkPreview(panel);
      await this.saveSettings();
    });

    copyAliasToggle.addEventListener("change", async () => {
      this.settings.defaultCopyIncludeAlias = copyAliasToggle.checked;
      this.updateCopiedLinkPreview(panel);
      await this.saveSettings();
    });

    copyAliasParenthesesToggle.addEventListener("change", async () => {
      this.settings.defaultCopyWrapAliasInParentheses = copyAliasParenthesesToggle.checked;
      this.updateCopiedLinkPreview(panel);
      await this.saveSettings();
    });

    copyBoldToggle.addEventListener("change", async () => {
      this.settings.defaultCopyAsBold = copyBoldToggle.checked;
      this.updateCopiedLinkPreview(panel);
      await this.saveSettings();
    });

    renameKindSelect.addEventListener("change", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    renameStartInput.addEventListener("input", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    renameEndInput.addEventListener("input", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    this.bindNumberInputWheel(renameStartInput, refreshRenameHelperPreview);
    this.bindNumberInputWheel(renameEndInput, refreshRenameHelperPreview);
    renameStartInput.addEventListener("change", () => {
      if (!this.normalizePositiveInteger(renameEndInput.value) && this.normalizePositiveInteger(renameStartInput.value)) {
        renameEndInput.value = this.normalizePositiveInteger(renameStartInput.value);
      }
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    renameEndInput.addEventListener("change", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    aliasLowercaseToggle.addEventListener("change", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    aliasAbbreviateToggle.addEventListener("change", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    aliasTrailingPeriodToggle.addEventListener("change", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    aliasParenthesesToggle.addEventListener("change", () => {
      this.stashRenameHelperPanelState(panel);
      refreshRenameHelperPreview();
    });
    prefixToggle.addEventListener("change", () => {
      this.updateViewerPreviewFromPanel(media, panel, this.getPanelCaptionValue(panel));
      scheduleAutoSave();
    });

    layout.appendChild(panel);
    return panel;
  }

  addFormatButton(toolbar, label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clickable-icon obsidian-image-captions-viewer-format-button";
    button.textContent = label;
    button.setAttribute("aria-label", title);
    button.setAttribute("title", title);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    toolbar.appendChild(button);
  }

  wrapSelection(textarea, prefix, suffix, placeholder) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const current = textarea.value || "";
    const selected = current.slice(start, end);
    const content = selected || placeholder;
    const replacement = `${prefix}${content}${suffix}`;

    textarea.value = current.slice(0, start) + replacement + current.slice(end);
    textarea.focus();

    if (selected) {
      const cursor = start + replacement.length;
      textarea.setSelectionRange(cursor, cursor);
    } else {
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + content.length);
    }
  }

  insertLink(textarea) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const current = textarea.value || "";
    const selected = current.slice(start, end) || "link text";
    const replacement = `[${selected}](url)`;

    textarea.value = current.slice(0, start) + replacement + current.slice(end);
    textarea.focus();

    const urlStart = start + replacement.indexOf("url");
    textarea.setSelectionRange(urlStart, urlStart + 3);
  }

  unwrapSimpleFormatting(textarea) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const current = textarea.value || "";
    const selected = current.slice(start, end);
    if (!selected) {
      return;
    }

    const unwrapped = selected
      .replace(/^\*\*(.*)\*\*$/s, "$1")
      .replace(/^\*(.*)\*$/s, "$1")
      .replace(/^`(.*)`$/s, "$1");

    textarea.value = current.slice(0, start) + unwrapped + current.slice(end);
    textarea.focus();
    textarea.setSelectionRange(start, start + unwrapped.length);
  }

  normalizePositiveInteger(value) {
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) {
      return "";
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return "";
    }
    return String(Math.trunc(numeric));
  }

  bindNumberInputWheel(input, onChange) {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    input.addEventListener("wheel", (event) => {
      if (document.activeElement !== input && !input.matches(":hover")) {
        return;
      }
      event.preventDefault();
      const current = Number(this.normalizePositiveInteger(input.value) || input.min || 1);
      const delta = event.deltaY < 0 ? 1 : -1;
      const next = Math.max(1, current + delta);
      input.value = String(next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (typeof onChange === "function") {
        onChange();
      }
    }, { passive: false });
  }

  getRenameKindLabel(kind, plural = false) {
    if (kind === "tableau") {
      return plural ? "Tableaux" : "Tableau";
    }
    return plural ? "Figures" : "Figure";
  }

  getRenameKindAbbreviation(kind) {
    return kind === "tableau" ? "Tab." : "Fig.";
  }

  normalizeRenameRange(startValue, endValue) {
    const start = this.normalizePositiveInteger(startValue);
    const endRaw = this.normalizePositiveInteger(endValue);
    if (!start) {
      return null;
    }
    const startNum = Number(start);
    const endNum = endRaw ? Number(endRaw) : startNum;
    const normalizedEnd = Math.max(startNum, endNum);
    return {
      start: String(startNum),
      end: String(normalizedEnd),
      isRange: normalizedEnd > startNum,
      count: normalizedEnd - startNum + 1
    };
  }

  buildRenameBaseLabel(kind, startValue, endValue) {
    const range = this.normalizeRenameRange(startValue, endValue);
    if (!range) {
      return this.getRenameKindLabel(kind);
    }

    if (!range.isRange) {
      return `${this.getRenameKindLabel(kind)} ${range.start}`;
    }

    const pluralLabel = this.getRenameKindLabel(kind, true);
    const joiner = range.count === 2 ? " et " : " à ";
    return `${pluralLabel} ${range.start}${joiner}${range.end}`;
  }

  buildRenameTargetPath(imagePath, kind, startValue, endValue) {
    const file = this.app.vault.getAbstractFileByPath(imagePath);
    const extension = file instanceof TFile ? file.extension : (imagePath.split(".").pop() || "png");
    const segments = imagePath.split("/");
    segments[segments.length - 1] = `${this.buildRenameBaseLabel(kind, startValue, endValue)}.${extension}`;
    return segments.join("/");
  }

  buildGeneratedAlias(kind, startValue, endValue, options = {}) {
    const range = this.normalizeRenameRange(startValue, endValue);
    if (!range) {
      return "";
    }

    const baseLabel = options.abbreviate
      ? this.getRenameKindAbbreviation(kind)
      : this.getRenameKindLabel(kind, range.isRange);
    const joiner = range.isRange ? (range.count === 2 ? " et " : " à ") : "";

    let alias = range.isRange
      ? `${baseLabel} ${range.start}${joiner}${range.end}`
      : `${baseLabel} ${range.start}`;

    if (options.addTrailingPeriod) {
      alias = alias.replace(/\.$/, "") + ".";
    }

    if (options.lowercase) {
      alias = alias.toLowerCase();
    }

    if (options.parentheses) {
      alias = `(${alias})`;
    }

    return alias;
  }

  buildStyledCaptionPrefixText(imagePath, alias = "") {
    const helperState = this.inferRenameHelperState(imagePath, alias);
    const range = this.normalizeRenameRange(helperState.start, helperState.end);
    if (!range) {
      return "";
    }

    const base = helperState.kind === "tableau" ? "Tab." : "Fig.";
    const joiner = range.isRange ? (range.count === 2 ? " et " : " à ") : "";
    const label = range.isRange
      ? `${base} ${range.start}${joiner}${range.end}`
      : `${base} ${range.start}`;

    return `${label} :`;
  }

  tokenizeLegacyFontTags(markdown) {
    const source = typeof markdown === "string" ? markdown : "";
    const tokens = [];
    const processed = source.replace(/<font\b[^>]*?\bcolor\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/font>/gi, (_match, c1, c2, c3, inner) => {
      const token = `@@OIC_FONT_${tokens.length}_${Date.now()}_${Math.random().toString(36).slice(2)}@@`;
      tokens.push({
        token,
        color: (c1 || c2 || c3 || "").trim(),
        text: String(inner || "")
      });
      return token;
    });

    return { markdown: processed, tokens };
  }

  replaceLegacyFontTokens(root, tokens) {
    if (!(root instanceof HTMLElement) || !Array.isArray(tokens) || tokens.length === 0) {
      return;
    }

    for (const tokenInfo of tokens) {
      const textNodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let current;
      while ((current = walker.nextNode())) {
        if (typeof current.nodeValue === "string" && current.nodeValue.includes(tokenInfo.token)) {
          textNodes.push(current);
        }
      }

      for (const textNode of textNodes) {
        const parent = textNode.parentNode;
        if (!parent) {
          continue;
        }

        const parts = String(textNode.nodeValue || "").split(tokenInfo.token);
        const fragment = document.createDocumentFragment();

        parts.forEach((part, index) => {
          if (part) {
            fragment.appendChild(document.createTextNode(part));
          }

          if (index < parts.length - 1) {
            const span = document.createElement("span");
            span.className = "obsidian-image-captions-inline-font";
            if (tokenInfo.color) {
              span.style.color = tokenInfo.color;
            }
            span.textContent = tokenInfo.text;
            fragment.appendChild(span);
          }
        });

        parent.replaceChild(fragment, textNode);
      }
    }
  }

  async renderCaptionMarkdownInto(target, markdown, sourcePath) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const processed = this.tokenizeLegacyFontTags(markdown);
    await Promise.resolve(
      MarkdownRenderer.render(this.app, processed.markdown, target, sourcePath, this)
    );
    this.replaceLegacyFontTokens(target, processed.tokens);
  }

  appendRenderedCaptionNodes(target, rendered) {
    if (!(rendered instanceof HTMLElement)) {
      return;
    }

    if (rendered.childElementCount === 1 && rendered.firstElementChild?.tagName === "P") {
      const paragraph = rendered.firstElementChild;
      while (paragraph.firstChild) {
        target.appendChild(paragraph.firstChild);
      }
      return;
    }

    while (rendered.firstChild) {
      target.appendChild(rendered.firstChild);
    }
  }

  async renderCaptionContent(target, imagePath, captionText, renderSourcePath, options = {}) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const prefixText = options.prefixEnabled
      ? String(options.prefixText || "").trim()
      : "";

    if (prefixText) {
      const prefixEl = document.createElement("span");
      prefixEl.className = "obsidian-image-captions-prefix";
      prefixEl.textContent = prefixText;
      target.appendChild(prefixEl);
    }

    if (!captionText) {
      return;
    }

    if (prefixText) {
      target.appendChild(document.createTextNode(" "));
    }

    const rendered = document.createElement("div");
    rendered.className = "obsidian-image-captions-render-target";

    try {
      await this.renderCaptionMarkdownInto(rendered, captionText, renderSourcePath || imagePath);
      this.appendRenderedCaptionNodes(target, rendered);
    } catch (_error) {
      target.appendChild(document.createTextNode(captionText));
    }
  }

  async buildRenderedCaptionElement(imagePath, captionText, renderSourcePath, options = {}) {
    const renderedCaption = document.createElement("div");
    renderedCaption.className = "obsidian-image-captions-render-buffer";
    await this.renderCaptionContent(renderedCaption, imagePath, captionText, renderSourcePath, options);
    return renderedCaption;
  }

  inferRenameHelperState(imagePath, alias = "") {
    const file = this.app.vault.getAbstractFileByPath(imagePath);
    const basename = file instanceof TFile
      ? file.basename
      : (imagePath.split("/").pop() || imagePath).replace(/\.[^.]+$/, "");

    let kind = "figure";
    let start = "";
    let end = "";

    const basenameMatch = basename.match(/^(Figure|Figures|Tableau|Tableaux)\s+(\d+)(?:\s*(à|et)\s*(\d+))?$/i);
    if (basenameMatch) {
      kind = basenameMatch[1].toLowerCase().startsWith("tabl") ? "tableau" : "figure";
      start = basenameMatch[2];
      end = basenameMatch[4] || basenameMatch[2];
    }

    let aliasText = String(alias || "").trim();
    let parentheses = false;
    if (aliasText.startsWith("(") && aliasText.endsWith(")") && aliasText.length > 2) {
      parentheses = true;
      aliasText = aliasText.slice(1, -1).trim();
    }

    const aliasHasTrailingPeriod = /\.$/.test(aliasText);
    const aliasTextWithoutTrailingPeriod = aliasHasTrailingPeriod
      ? aliasText.replace(/\.$/, "").trim()
      : aliasText;

    let abbreviate = false;
    if (/^fig\.\s*\d+(?:\s*(?:à|et)\s*\d+)?$/i.test(aliasTextWithoutTrailingPeriod)) {
      kind = "figure";
      abbreviate = true;
    } else if (/^tab\.\s*\d+(?:\s*(?:à|et)\s*\d+)?$/i.test(aliasTextWithoutTrailingPeriod)) {
      kind = "tableau";
      abbreviate = true;
    } else if (/^figure[s]?\s+\d+(?:\s*(?:à|et)\s*\d+)?$/i.test(aliasTextWithoutTrailingPeriod)) {
      kind = "figure";
    } else if (/^tableau[x]?\s+\d+(?:\s*(?:à|et)\s*\d+)?$/i.test(aliasTextWithoutTrailingPeriod)) {
      kind = "tableau";
    }

    if (!start) {
      const aliasRange = aliasTextWithoutTrailingPeriod.match(/(\d+)(?:\s*(?:à|et)\s*(\d+))?/i);
      if (aliasRange) {
        start = aliasRange[1];
        end = aliasRange[2] || aliasRange[1];
      }
    }

    const lowercase = !!aliasTextWithoutTrailingPeriod && aliasTextWithoutTrailingPeriod === aliasTextWithoutTrailingPeriod.toLowerCase();

    return {
      kind,
      start,
      end: end || start,
      lowercase,
      abbreviate,
      parentheses,
      addTrailingPeriod: aliasHasTrailingPeriod
    };
  }

  getRenameHelperPanelState(panel) {
    if (!(panel instanceof HTMLElement)) {
      return null;
    }

    const kindSelect = panel.querySelector(".obsidian-image-captions-rename-kind-select");
    const startInput = panel.querySelector(".obsidian-image-captions-rename-start-input");
    const endInput = panel.querySelector(".obsidian-image-captions-rename-end-input");
    const lowercaseToggle = panel.querySelector(".obsidian-image-captions-alias-lowercase-toggle");
    const abbreviateToggle = panel.querySelector(".obsidian-image-captions-alias-abbreviate-toggle");
    const trailingPeriodToggle = panel.querySelector(".obsidian-image-captions-alias-trailing-period-toggle");
    const parenthesesToggle = panel.querySelector(".obsidian-image-captions-alias-parentheses-toggle");

    if (!(kindSelect instanceof HTMLSelectElement) || !(startInput instanceof HTMLInputElement) || !(endInput instanceof HTMLInputElement) || !(lowercaseToggle instanceof HTMLInputElement) || !(abbreviateToggle instanceof HTMLInputElement) || !(trailingPeriodToggle instanceof HTMLInputElement) || !(parenthesesToggle instanceof HTMLInputElement)) {
      return null;
    }

    return {
      kind: kindSelect.value === "tableau" ? "tableau" : "figure",
      start: startInput.value,
      end: endInput.value,
      lowercase: lowercaseToggle.checked,
      abbreviate: abbreviateToggle.checked,
      addTrailingPeriod: trailingPeriodToggle.checked,
      parentheses: parenthesesToggle.checked
    };
  }

  stashRenameHelperPanelState(panel, forPath = "") {
    const state = this.getRenameHelperPanelState(panel);
    if (!state) {
      delete panel.dataset.renameHelperState;
      return null;
    }
    const scopedState = {
      ...state,
      __forPath: forPath || panel.dataset.imagePath || ""
    };
    panel.dataset.renameHelperState = JSON.stringify(scopedState);
    return scopedState;
  }

  consumeRenameHelperPanelState(panel, imagePath = "") {
    if (!(panel instanceof HTMLElement)) {
      return null;
    }

    const raw = panel.dataset.renameHelperState;
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        delete panel.dataset.renameHelperState;
        return null;
      }
      if (parsed.__forPath && imagePath && parsed.__forPath !== imagePath) {
        delete panel.dataset.renameHelperState;
        return null;
      }
      delete parsed.__forPath;
      return parsed;
    } catch (_error) {
      delete panel.dataset.renameHelperState;
      return null;
    }
  }

  updateRenameHelperPreview(panel) {

    if (!(panel instanceof HTMLElement)) {
      return;
    }

    const kindSelect = panel.querySelector(".obsidian-image-captions-rename-kind-select");
    const startInput = panel.querySelector(".obsidian-image-captions-rename-start-input");
    const endInput = panel.querySelector(".obsidian-image-captions-rename-end-input");
    const lowercaseToggle = panel.querySelector(".obsidian-image-captions-alias-lowercase-toggle");
    const abbreviateToggle = panel.querySelector(".obsidian-image-captions-alias-abbreviate-toggle");
    const trailingPeriodToggle = panel.querySelector(".obsidian-image-captions-alias-trailing-period-toggle");
    const parenthesesToggle = panel.querySelector(".obsidian-image-captions-alias-parentheses-toggle");
    const filenamePreview = panel.querySelector(".obsidian-image-captions-helper-filename-preview");
    const aliasPreview = panel.querySelector(".obsidian-image-captions-helper-alias-preview");
    const renameFileButton = panel.querySelector(".obsidian-image-captions-helper-rename-file-button");
    const renameAliasButton = panel.querySelector(".obsidian-image-captions-helper-rename-alias-button");

    if (!(kindSelect instanceof HTMLSelectElement) || !(startInput instanceof HTMLInputElement) || !(endInput instanceof HTMLInputElement) || !(lowercaseToggle instanceof HTMLInputElement) || !(abbreviateToggle instanceof HTMLInputElement) || !(trailingPeriodToggle instanceof HTMLInputElement) || !(parenthesesToggle instanceof HTMLInputElement) || !(filenamePreview instanceof HTMLElement) || !(aliasPreview instanceof HTMLElement) || !(renameFileButton instanceof HTMLButtonElement) || !(renameAliasButton instanceof HTMLButtonElement)) {
      return;
    }

    const kind = kindSelect.value === "tableau" ? "tableau" : "figure";
    const range = this.normalizeRenameRange(startInput.value, endInput.value);
    if (range && endInput.value !== range.end) {
      endInput.value = range.end;
    }
    const currentPath = panel.dataset.imagePath || "";
    const targetPath = range ? this.buildRenameTargetPath(currentPath, kind, range.start, range.end) : "";
    const filename = targetPath ? targetPath.split("/").pop() || targetPath : "—";
    const generatedAlias = range
      ? this.buildGeneratedAlias(kind, range.start, range.end, {
          lowercase: lowercaseToggle.checked,
          abbreviate: abbreviateToggle.checked,
          addTrailingPeriod: trailingPeriodToggle.checked,
          parentheses: parenthesesToggle.checked
        })
      : "—";

    filenamePreview.textContent = filename;
    aliasPreview.textContent = generatedAlias;
    renameFileButton.disabled = !range;
    renameAliasButton.disabled = !range;
    this.stashRenameHelperPanelState(panel);
  }

  async applyRenameHelper(panel, media, setStatus, options = {}) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    const imagePath = panel.dataset.imagePath;
    if (!imagePath) {
      new Notice("No image is currently selected.");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(imagePath);
    if (!(file instanceof TFile) || !this.isImageFile(file)) {
      new Notice("Unable to rename this image.");
      return;
    }

    const kindSelect = panel.querySelector(".obsidian-image-captions-rename-kind-select");
    const startInput = panel.querySelector(".obsidian-image-captions-rename-start-input");
    const endInput = panel.querySelector(".obsidian-image-captions-rename-end-input");
    const lowercaseToggle = panel.querySelector(".obsidian-image-captions-alias-lowercase-toggle");
    const abbreviateToggle = panel.querySelector(".obsidian-image-captions-alias-abbreviate-toggle");
    const trailingPeriodToggle = panel.querySelector(".obsidian-image-captions-alias-trailing-period-toggle");
    const parenthesesToggle = panel.querySelector(".obsidian-image-captions-alias-parentheses-toggle");

    if (!(kindSelect instanceof HTMLSelectElement) || !(startInput instanceof HTMLInputElement) || !(endInput instanceof HTMLInputElement) || !(lowercaseToggle instanceof HTMLInputElement) || !(abbreviateToggle instanceof HTMLInputElement) || !(trailingPeriodToggle instanceof HTMLInputElement) || !(parenthesesToggle instanceof HTMLInputElement)) {
      return;
    }

    const preservedHelperState = this.stashRenameHelperPanelState(panel);
    const range = this.normalizeRenameRange(startInput.value, endInput.value);
    if (!range) {
      new Notice("Choose a valid starting number before validating the rename helper.");
      return;
    }

    const kind = kindSelect.value === "tableau" ? "tableau" : "figure";
    const nextPath = this.buildRenameTargetPath(imagePath, kind, range.start, range.end);
    const shouldRenameFile = options.renameFile !== false;
    const shouldRenameAlias = options.renameAlias !== false;

    const nextAlias = this.buildGeneratedAlias(kind, range.start, range.end, {
      lowercase: lowercaseToggle.checked,
      abbreviate: abbreviateToggle.checked,
      parentheses: parenthesesToggle.checked,
      addTrailingPeriod: trailingPeriodToggle.checked
    });

    const currentRecord = this.getRecord(imagePath);
    let targetPath = imagePath;

    try {
      if (shouldRenameFile && nextPath !== imagePath) {
        await this.app.fileManager.renameFile(file, nextPath);
        targetPath = nextPath;
      }

      await this.upsertRecord(
        targetPath,
        currentRecord.caption,
        currentRecord.showInEmbeds,
        shouldRenameAlias ? nextAlias : currentRecord.alias,
        currentRecord.prefixEnabled,
        currentRecord.prefixText,
        false
      );
    } catch (error) {
      console.error("[image-viewer-captions] rename helper failed", error);
      new Notice("Unable to validate the requested rename change.");
      return;
    }

    panel.dataset.imagePath = targetPath;
    if (preservedHelperState) {
      this.stashRenameHelperPanelState(panel, targetPath);
    }
    this.populateImageViewerPanel(panel, targetPath, true);
    if (preservedHelperState) {
      this.stashRenameHelperPanelState(panel, targetPath);
    }

    if (media instanceof HTMLElement) {
      await this.updateViewerPreview(media, targetPath, currentRecord.caption, currentRecord.showInEmbeds, panel);
    }

    if (typeof setStatus === "function") {
      if (shouldRenameFile && shouldRenameAlias) {
        setStatus(nextPath !== imagePath ? "Renamed and alias updated" : "Alias updated");
      } else if (shouldRenameFile) {
        setStatus(nextPath !== imagePath ? "File renamed" : "File name unchanged");
      } else if (shouldRenameAlias) {
        setStatus("Alias updated");
      }
    }
  }

  populateImageViewerPanel(panel, imagePath, force = false) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    panel.dataset.imagePath = imagePath;

    const aliasInput = panel.querySelector(".obsidian-image-captions-viewer-alias-input");
    const toggle = panel.querySelector(".obsidian-image-captions-viewer-toggle");
    const copyModeToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-toggle");
    const copyAliasToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-alias-toggle");
    const copyAliasParenthesesToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-alias-parentheses-toggle");
    const copyBoldToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-bold-toggle");
    const renameKindSelect = panel.querySelector(".obsidian-image-captions-rename-kind-select");
    const renameStartInput = panel.querySelector(".obsidian-image-captions-rename-start-input");
    const renameEndInput = panel.querySelector(".obsidian-image-captions-rename-end-input");
    const aliasLowercaseToggle = panel.querySelector(".obsidian-image-captions-alias-lowercase-toggle");
    const aliasAbbreviateToggle = panel.querySelector(".obsidian-image-captions-alias-abbreviate-toggle");
    const aliasTrailingPeriodToggle = panel.querySelector(".obsidian-image-captions-alias-trailing-period-toggle");
    const aliasParenthesesToggle = panel.querySelector(".obsidian-image-captions-alias-parentheses-toggle");
    const prefixToggle = panel.querySelector(".obsidian-image-captions-prefix-toggle");
    const prefixTextInput = panel.querySelector(".obsidian-image-captions-prefix-text-input");
    const media = panel.parentElement?.querySelector(":scope > .obsidian-image-captions-viewer-media");

    if (!(aliasInput instanceof HTMLInputElement) || !(toggle instanceof HTMLInputElement) || !(copyModeToggle instanceof HTMLInputElement) || !(copyAliasToggle instanceof HTMLInputElement) || !(copyAliasParenthesesToggle instanceof HTMLInputElement) || !(copyBoldToggle instanceof HTMLInputElement) || !(renameKindSelect instanceof HTMLSelectElement) || !(renameStartInput instanceof HTMLInputElement) || !(renameEndInput instanceof HTMLInputElement) || !(aliasLowercaseToggle instanceof HTMLInputElement) || !(aliasAbbreviateToggle instanceof HTMLInputElement) || !(aliasTrailingPeriodToggle instanceof HTMLInputElement) || !(aliasParenthesesToggle instanceof HTMLInputElement) || !(prefixToggle instanceof HTMLInputElement) || !(prefixTextInput instanceof HTMLInputElement)) {
      return;
    }

    const preview = media instanceof HTMLElement
      ? media.querySelector(":scope > .obsidian-image-captions-viewer-preview-caption")
      : null;
    if (!force && (
      document.activeElement === aliasInput ||
      document.activeElement === toggle ||
      document.activeElement === copyModeToggle ||
      document.activeElement === copyAliasToggle ||
      document.activeElement === copyAliasParenthesesToggle ||
      document.activeElement === copyBoldToggle ||
      document.activeElement === renameKindSelect ||
      document.activeElement === renameStartInput ||
      document.activeElement === renameEndInput ||
      document.activeElement === aliasLowercaseToggle ||
      document.activeElement === aliasAbbreviateToggle ||
      document.activeElement === aliasTrailingPeriodToggle ||
      document.activeElement === aliasParenthesesToggle ||
      document.activeElement === prefixToggle ||
      document.activeElement === prefixTextInput ||
      (preview instanceof HTMLElement && preview.dataset.editing === "true")
    )) {
      return;
    }

    const record = this.getRecord(imagePath);
    aliasInput.value = record.alias;
    this.setPanelCaptionValue(panel, record.caption);
    panel.dataset.lastCommittedCaption = record.caption;
    toggle.checked = record.showInEmbeds;
    copyModeToggle.checked = this.settings.defaultCopyAsTransclusion;
    copyAliasToggle.checked = this.settings.defaultCopyIncludeAlias;
    copyAliasParenthesesToggle.checked = this.settings.defaultCopyWrapAliasInParentheses;
    copyBoldToggle.checked = this.settings.defaultCopyAsBold;

    const helperState = this.consumeRenameHelperPanelState(panel, imagePath) || this.inferRenameHelperState(imagePath, record.alias);
    renameKindSelect.value = helperState.kind;
    renameStartInput.value = helperState.start;
    renameEndInput.value = helperState.end;
    aliasLowercaseToggle.checked = helperState.lowercase;
    aliasAbbreviateToggle.checked = helperState.abbreviate;
    aliasTrailingPeriodToggle.checked = !!helperState.addTrailingPeriod;
    aliasParenthesesToggle.checked = helperState.parentheses;
    prefixToggle.checked = !!record.prefixEnabled;
    prefixTextInput.value = record.prefixText || "";
    this.updateRenameHelperPreview(panel);
    this.updateCopiedLinkPreview(panel);

    if (media instanceof HTMLElement) {
      void this.updateViewerPreview(media, imagePath, record.caption, record.showInEmbeds, panel);
    }
  }

  ensureViewerPreviewCaption(media) {
    if (!(media instanceof HTMLElement)) {
      return null;
    }

    let preview = media.querySelector(':scope > .obsidian-image-captions-viewer-preview-caption');
    if (preview instanceof HTMLElement) {
      return preview;
    }

    preview = document.createElement('figcaption');
    preview.className = 'obsidian-image-captions-viewer-preview-caption is-placeholder';
    preview.textContent = 'Cliquer ici pour ajouter un caption';
    media.appendChild(preview);
    return preview;
  }

  async updateViewerPreview(media, imagePath, captionText, _showInEmbeds, panel) {
    if (!(media instanceof HTMLElement)) {
      return;
    }

    const preview = this.ensureViewerPreviewCaption(media);
    if (!(preview instanceof HTMLElement)) {
      return;
    }

    if (preview.dataset.editing === 'true') {
      return;
    }

    if (panel instanceof HTMLElement) {
      this.bindViewerPreviewInteraction(preview, panel, media);
    }

    const prefixToggle = panel instanceof HTMLElement
      ? panel.querySelector('.obsidian-image-captions-prefix-toggle')
      : null;
    const aliasInput = panel instanceof HTMLElement
      ? panel.querySelector('.obsidian-image-captions-viewer-alias-input')
      : null;

    const record = this.getRecord(imagePath);
    const prefixTextInput = panel instanceof HTMLElement
      ? panel.querySelector('.obsidian-image-captions-prefix-text-input')
      : null;
    const prefixEnabled = prefixToggle instanceof HTMLInputElement
      ? prefixToggle.checked
      : !!record.prefixEnabled;
    const alias = aliasInput instanceof HTMLInputElement
      ? aliasInput.value
      : record.alias;
    const prefixText = prefixTextInput instanceof HTMLInputElement
      ? prefixTextInput.value
      : record.prefixText;

    const hasContent = !!String(captionText || '').trim() || (prefixEnabled && !!String(prefixText || '').trim());

    preview.dataset.imagePath = imagePath || '';
    const renderToken = `${Date.now()}-${Math.random()}`;
    preview.dataset.renderToken = renderToken;

    if (!hasContent) {
      preview.empty();
      preview.classList.add('is-placeholder');
      preview.setText('Cliquer ici pour ajouter un caption');
      return;
    }

    try {
      const renderedCaption = await this.buildRenderedCaptionElement(imagePath, captionText, imagePath, {
        alias,
        prefixEnabled,
        prefixText
      });

      if (preview.dataset.renderToken !== renderToken || preview.dataset.editing === 'true') {
        return;
      }

      preview.empty();
      preview.classList.remove('is-placeholder');
      while (renderedCaption.firstChild) {
        preview.appendChild(renderedCaption.firstChild);
      }
    } catch (_error) {
      if (preview.dataset.renderToken !== renderToken || preview.dataset.editing === 'true') {
        return;
      }
      preview.empty();
      preview.classList.remove('is-placeholder');
      preview.setText(String(captionText || ''));
    }
  }

  updateViewerPreviewFromPanel(media, panel, captionText) {
    if (!(media instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      return;
    }

    const imagePath = panel.dataset.imagePath;
    const toggle = panel.querySelector(".obsidian-image-captions-viewer-toggle");
    if (!imagePath || !(toggle instanceof HTMLInputElement)) {
      return;
    }

    this.setPanelCaptionValue(panel, captionText);
    void this.updateViewerPreview(media, imagePath, captionText, toggle.checked, panel);
  }

  getPanelCaptionValue(panel) {
    if (!(panel instanceof HTMLElement)) {
      return "";
    }
    return typeof panel.dataset.captionValue === "string" ? panel.dataset.captionValue : "";
  }

  setPanelCaptionValue(panel, value) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }
    panel.dataset.captionValue = typeof value === "string" ? value : "";
  }

  bindViewerPreviewInteraction(preview, panel, media) {
    if (!(preview instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      return;
    }

    if (preview.dataset.obsidianImageCaptionsBound === "true") {
      return;
    }

    preview.dataset.obsidianImageCaptionsBound = "true";
    preview.tabIndex = 0;

    const beginEdit = (event = null) => {
      if (preview.dataset.editing === "true") {
        return;
      }
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.enterViewerPreviewEditMode(preview, panel, media);
    };

    preview.addEventListener("mousedown", beginEdit);
    preview.addEventListener("click", (event) => {
      if (preview.dataset.editing === "true") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });

    preview.addEventListener("keydown", (event) => {
      if (preview.dataset.editing === "true") {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        beginEdit(event);
      }
    });
  }

  enterViewerPreviewEditMode(preview, panel, media) {
    if (!(preview instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      return;
    }

    preview.dataset.editing = "true";
    preview.classList.add("is-editing");
    preview.classList.remove("is-placeholder");
    preview.empty();

    const textarea = document.createElement("textarea");
    textarea.className = "obsidian-image-captions-viewer-preview-editor";
    textarea.value = this.getPanelCaptionValue(panel);
    textarea.setAttribute("aria-label", "Caption");
    preview.appendChild(textarea);

    const schedule = panel.__imageCaptionsScheduleAutoSave;
    const autoResize = () => this.autoResizePreviewEditor(textarea);

    textarea.addEventListener("input", () => {
      this.setPanelCaptionValue(panel, textarea.value);
      autoResize();
      if (typeof schedule === "function") {
        schedule();
      }
    });

    textarea.addEventListener("keydown", async (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        await this.exitViewerPreviewEditMode(preview, panel, media, { save: true, statusText: "Saved" });
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        await this.exitViewerPreviewEditMode(preview, panel, media, { save: true, statusText: "Saved" });
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        await this.exitViewerPreviewEditMode(preview, panel, media, { save: false, restore: true });
      }
    });

    textarea.addEventListener("blur", async () => {
      if (preview.dataset.editing !== "true") {
        return;
      }
      await this.exitViewerPreviewEditMode(preview, panel, media, { save: true, statusText: "Saved" });
    });

    window.requestAnimationFrame(() => {
      autoResize();
      textarea.focus();
      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;
    });
  }

  async exitViewerPreviewEditMode(preview, panel, media, options = {}) {
    if (!(preview instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      return;
    }

    const textarea = preview.querySelector(":scope > .obsidian-image-captions-viewer-preview-editor");
    const currentValue = textarea instanceof HTMLTextAreaElement ? textarea.value : this.getPanelCaptionValue(panel);

    preview.dataset.editing = "false";
    preview.classList.remove("is-editing");

    const shouldRestore = options.restore === true;
    const nextCaption = shouldRestore
      ? (typeof panel.dataset.lastCommittedCaption === "string" ? panel.dataset.lastCommittedCaption : "")
      : currentValue;

    this.setPanelCaptionValue(panel, nextCaption);

    if (options.save) {
      const cancelAutoSave = panel.__imageCaptionsCancelAutoSave;
      if (typeof cancelAutoSave === "function") {
        cancelAutoSave();
      }
      const saveNow = panel.__imageCaptionsSaveNow;
      if (typeof saveNow === "function") {
        await saveNow(options.statusText || "Saved");
      }
    }

    const toggle = panel.querySelector(".obsidian-image-captions-viewer-toggle");
    const isEnabled = toggle instanceof HTMLInputElement ? toggle.checked : true;
    await this.updateViewerPreview(media, panel.dataset.imagePath || "", nextCaption, isEnabled, panel);
  }


  buildCopyPreviewText(options = {}) {
    const asTransclusion = !!options.asTransclusion;
    const includeAlias = !!options.includeAlias || !!options.wrapAliasInParentheses;
    const wrapAliasInParentheses = !!options.wrapAliasInParentheses;
    const asBold = !!options.asBold;

    let alias = includeAlias ? "alias" : "";
    if (alias && wrapAliasInParentheses) {
      alias = `(${alias})`;
    }

    const aliasPart = alias ? `|${alias}` : "";
    let wikilink = `${asTransclusion ? "!" : ""}[[link${aliasPart}]]`;

    if (asBold) {
      wikilink = `**${wikilink}**`;
    }

    return wikilink;
  }

  updateCopiedLinkPreview(panel) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    const copyModeToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-toggle");
    const copyAliasToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-alias-toggle");
    const copyAliasParenthesesToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-alias-parentheses-toggle");
    const copyBoldToggle = panel.querySelector(".obsidian-image-captions-viewer-copy-bold-toggle");
    const previewValue = panel.querySelector(".obsidian-image-captions-copy-preview-value");

    if (!(copyModeToggle instanceof HTMLInputElement) || !(copyAliasToggle instanceof HTMLInputElement) || !(copyAliasParenthesesToggle instanceof HTMLInputElement) || !(copyBoldToggle instanceof HTMLInputElement) || !(previewValue instanceof HTMLElement)) {
      return;
    }

    previewValue.textContent = this.buildCopyPreviewText({
      asTransclusion: copyModeToggle.checked,
      includeAlias: copyAliasToggle.checked,
      wrapAliasInParentheses: copyAliasParenthesesToggle.checked,
      asBold: copyBoldToggle.checked
    });
  }

  autoResizePreviewEditor(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 48)}px`;
  }

  getCurrentImagePath() {
    const activeLeaf = this.app.workspace.getActiveLeaf();
    const activeFile = activeLeaf?.view?.file;
    if (this.isImageFile(activeFile)) {
      return activeFile.path;
    }

    const imageLeaf = this.app.workspace.getLeavesOfType("image").find((leaf) => this.isImageFile(leaf.view?.file));
    return imageLeaf?.view?.file?.path || null;
  }

  buildPreferredImageWikilink(imagePath, sourcePath = "", options = {}) {
    const normalizedOptions = typeof options === "object" && options !== null
      ? options
      : {
          asTransclusion: arguments[2],
          includeAlias: arguments[3],
          wrapAliasInParentheses: arguments[4],
          asBold: arguments[5]
        };

    const asTransclusion = normalizedOptions.asTransclusion !== false;
    const includeAlias = !!normalizedOptions.includeAlias;
    const wrapAliasInParentheses = !!normalizedOptions.wrapAliasInParentheses;
    const asBold = !!normalizedOptions.asBold;
    const effectiveIncludeAlias = includeAlias || wrapAliasInParentheses;

    const file = this.app.vault.getAbstractFileByPath(imagePath);
    const linkTarget = file instanceof TFile && typeof this.app.metadataCache.fileToLinktext === "function"
      ? this.app.metadataCache.fileToLinktext(file, sourcePath || "", true)
      : imagePath;
    const record = this.getRecord(imagePath);

    let alias = effectiveIncludeAlias && record.alias ? String(record.alias).trim() : "";
    if (alias && wrapAliasInParentheses && !(alias.startsWith("(") && alias.endsWith(")"))) {
      alias = `(${alias})`;
    }

    const aliasPart = alias ? `|${alias}` : "";
    let wikilink = `${asTransclusion ? "!" : ""}[[${linkTarget}${aliasPart}]]`;

    if (asBold) {
      wikilink = `**${wikilink}**`;
    }

    return wikilink;
  }

  async copyText(text) {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_error) {
      // fall through to execCommand fallback
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand("copy");
      textarea.remove();
      return !!success;
    } catch (_error) {
      return false;
    }
  }

  shouldIgnoreMutation(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (nodes.length === 0) {
      return false;
    }
    return nodes.every((node) => this.isPluginManagedNode(node));
  }

  isPluginManagedNode(node) {
    if (!node) {
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return this.isPluginManagedNode(node.parentElement);
    }

    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (
      node.classList.contains("obsidian-image-captions-caption") ||
      node.classList.contains("obsidian-image-captions-viewer-panel") ||
      node.classList.contains("obsidian-image-captions-viewer-layout") ||
      node.classList.contains("obsidian-image-captions-viewer-preview-caption")
    ) {
      return true;
    }

    return !!node.closest(
      ".obsidian-image-captions-caption, .obsidian-image-captions-viewer-panel, .obsidian-image-captions-viewer-layout, .obsidian-image-captions-viewer-preview-caption"
    );
  }

  getImageWikilinkContextAtCursor(editor, info) {
    if (!editor || typeof editor.getCursor !== "function" || typeof editor.getLine !== "function") {
      return null;
    }

    const cursor = editor.getCursor();
    if (!cursor || typeof cursor.line !== "number") {
      return null;
    }

    const lineText = editor.getLine(cursor.line) || "";
    const regex = /(!?)\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = regex.exec(lineText)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      if (cursor.ch < start || cursor.ch > end) {
        continue;
      }

      const sourcePath = info?.file?.path || this.lastMarkdownLeaf?.view?.file?.path || "";
      const rawInner = match[2];
      const imageFile = this.resolveImageLink(rawInner, sourcePath);
      if (!imageFile) {
        return null;
      }

      const lastPipeIndex = rawInner.lastIndexOf("|");
      const alias = lastPipeIndex >= 0 ? rawInner.slice(lastPipeIndex + 1).trim() : "";

      return {
        line: cursor.line,
        fromCh: start,
        toCh: end,
        fullMatch: match[0],
        rawInner,
        alias,
        hasBang: match[1] === "!",
        imagePath: imageFile.path,
        sourcePath
      };
    }

    return null;
  }

  async applyStoredAliasToImageWikilink(editor, context) {
    if (!editor || !context) {
      return;
    }

    const record = this.getRecord(context.imagePath);
    const trimmedAlias = (record.alias || "").trim();
    if (!trimmedAlias) {
      new Notice("No stored alias is defined for this image.");
      return;
    }

    const lastPipeIndex = context.rawInner.lastIndexOf("|");
    const nextInner = lastPipeIndex >= 0
      ? `${context.rawInner.slice(0, lastPipeIndex + 1)}${trimmedAlias}`
      : `${context.rawInner}|${trimmedAlias}`;
    const replacement = `${context.hasBang ? "!" : ""}[[${nextInner}]]`;

    editor.replaceRange(
      replacement,
      { line: context.line, ch: context.fromCh },
      { line: context.line, ch: context.toCh }
    );

    new Notice("Stored image alias applied to the wikilink.");
  }
};

class ImageViewerCaptionsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Image Viewer Captions" });

    new Setting(containerEl)
      .setName("Show captions in note embeds by default")
      .setDesc("For newly captioned images, decide whether the caption is displayed under transcluded images in notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultShowInEmbeds)
          .onChange(async (value) => {
            this.plugin.settings.defaultShowInEmbeds = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName("Show captions in Live Preview")
      .setDesc("Display the rendered caption under image embeds while editing in Live Preview.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showCaptionsInLivePreview)
          .onChange(async (value) => {
            this.plugin.settings.showCaptionsInLivePreview = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName("Copy as transclusion by default")
      .setDesc("Choose whether copied links from the image viewer use ![[...]] or [[...]] by default.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultCopyAsTransclusion)
          .onChange(async (value) => {
            this.plugin.settings.defaultCopyAsTransclusion = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include stored alias when copying by default")
      .setDesc("When enabled, copied image links append the stored alias as |alias when one exists.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultCopyIncludeAlias)
          .onChange(async (value) => {
            this.plugin.settings.defaultCopyIncludeAlias = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Copy wikilink as bold by default")
      .setDesc("Wrap copied image links in **...** by default.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultCopyAsBold)
          .onChange(async (value) => {
            this.plugin.settings.defaultCopyAsBold = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Wrap copied alias in parentheses by default")
      .setDesc("When copying a link with the stored alias, wrap the alias as |(alias) by default.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultCopyWrapAliasInParentheses)
          .onChange(async (value) => {
            this.plugin.settings.defaultCopyWrapAliasInParentheses = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image viewer panel position")
      .setDesc("Choose where the caption editor appears inside Obsidian's image viewer.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("right", "Right")
          .addOption("left", "Left")
          .addOption("top", "Top")
          .addOption("bottom", "Bottom")
          .setValue(this.plugin.settings.viewerPanelPosition)
          .onChange(async (value) => {
            this.plugin.settings.viewerPanelPosition = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    containerEl.createEl("p", {
      text: "Open any image in Obsidian's image view to edit its caption, store an alias, preview its rendering under the image in real time, choose whether the caption appears under transcluded images, copy either a transclusion or a normal wikilink with optional alias, bold wrapping, and alias parentheses, and prepare a validated rename + generated alias helper for Figure/Tableau naming. In the editor, right-click an image wikilink to apply the stored alias for that image."
    });
  }
}
