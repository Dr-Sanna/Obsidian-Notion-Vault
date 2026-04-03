const {
  Plugin,
  Modal,
  Setting,
  Notice,
  parseYaml,
  stringifyYaml,
  PluginSettingTab,
} = require("obsidian");

const MANAGED_CLASSES = [
  "better-title",
  "fullwidth",
  "hide-frontmatter",
  "hide-icon-title",
  "notion-list",
];

const ALIAS_KEY = "alias";

const DEFAULT_SETTINGS = {
  managedParamsText: "foldernote|boolean|foldernote|false",
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCssClasses(value) {
  if (Array.isArray(value)) {
    return unique(value.flatMap((item) => normalizeCssClasses(item)));
  }

  if (typeof value === "string") {
    return unique(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    );
  }

  return [];
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "yes", "1", "on"].includes(normalized);
  }

  return false;
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function extractTopFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  return {
    full: match[0],
    yaml: match[1],
    start: 0,
    end: match[0].length,
  };
}

function safeParseYaml(yaml) {
  if (!yaml || !yaml.trim()) return {};

  try {
    const parsed = parseYaml(yaml);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (error) {
    console.error("[yaml-picker] YAML parse error", error);
  }

  return {};
}

function parseManagedParamDefinitions(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const parsed = [];
  const errors = [];
  const seenKeys = new Set();

  for (const [index, line] of lines.entries()) {
    const parts = line.split("|").map((part) => part.trim());
    const [keyRaw, typeRaw, labelRaw, defaultRaw = ""] = parts;
    const key = keyRaw || "";
    const type = (typeRaw || "boolean").toLowerCase();
    const lineNumber = index + 1;

    if (!key) {
      errors.push(`Ligne ${lineNumber} : clé manquante.`);
      continue;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      errors.push(
        `Ligne ${lineNumber} : clé invalide \"${key}\". Utilise uniquement lettres, chiffres, tirets et underscores.`
      );
      continue;
    }

    if (key === ALIAS_KEY) {
      errors.push(
        `Ligne ${lineNumber} : la clé \"${ALIAS_KEY}\" est réservée et gérée automatiquement.`
      );
      continue;
    }

    if (!["boolean", "string", "number"].includes(type)) {
      errors.push(`Ligne ${lineNumber} : type invalide \"${type}\".`);
      continue;
    }

    if (seenKeys.has(key)) {
      errors.push(`Ligne ${lineNumber} : clé dupliquée \"${key}\".`);
      continue;
    }

    seenKeys.add(key);

    let defaultValue;
    if (type === "boolean") {
      defaultValue = normalizeBoolean(defaultRaw);
    } else if (type === "number") {
      const trimmed = String(defaultRaw || "").trim();
      if (trimmed === "") {
        defaultValue = "";
      } else {
        const numberValue = Number(trimmed);
        if (Number.isFinite(numberValue)) {
          defaultValue = numberValue;
        } else {
          errors.push(`Ligne ${lineNumber} : valeur par défaut numérique invalide.`);
          continue;
        }
      }
    } else {
      defaultValue = defaultRaw;
    }

    parsed.push({
      key,
      type,
      label: labelRaw || key,
      defaultValue,
    });
  }

  return { parsed, errors };
}

function normalizeParamValue(value, definition) {
  if (definition.type === "boolean") {
    return normalizeBoolean(value);
  }

  if (definition.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const trimmed = String(value ?? "").trim();
    if (trimmed === "") return "";
    const numberValue = Number(trimmed);
    return Number.isFinite(numberValue) ? numberValue : definition.defaultValue;
  }

  return String(value ?? "");
}

function normalizeAliasValue(value) {
  return String(value ?? "").trim();
}

function buildUpdatedFrontmatter(currentData, selectedManagedClasses, paramValues, paramDefinitions) {
  const currentCssClasses = normalizeCssClasses(currentData.cssclasses);
  const selectedManaged = unique(selectedManagedClasses);
  const unmanagedClasses = currentCssClasses.filter(
    (cssClass) => !MANAGED_CLASSES.includes(cssClass)
  );

  const finalCssClasses = unique([
    ...unmanagedClasses,
    ...MANAGED_CLASSES.filter((cssClass) => selectedManaged.includes(cssClass)),
  ]);

  const rest = { ...currentData };
  delete rest.cssclasses;
  delete rest[ALIAS_KEY];

  for (const definition of paramDefinitions) {
    delete rest[definition.key];
  }

  const updated = {};

  if (finalCssClasses.length > 0) {
    updated.cssclasses = finalCssClasses;
  }

  const aliasValue = normalizeAliasValue(paramValues[ALIAS_KEY]);
  if (aliasValue) {
    updated[ALIAS_KEY] = aliasValue;
  }

  for (const definition of paramDefinitions) {
    const value = normalizeParamValue(paramValues[definition.key], definition);

    if (definition.type === "boolean") {
      updated[definition.key] = !!value;
      continue;
    }

    if (definition.type === "number") {
      if (value !== "" && Number.isFinite(value)) {
        updated[definition.key] = value;
      }
      continue;
    }

    if (typeof value === "string" && value.trim() !== "") {
      updated[definition.key] = value;
    }
  }

  return {
    ...updated,
    ...rest,
  };
}

function serializeFrontmatter(frontmatterObject, eol) {
  const yaml = stringifyYaml(frontmatterObject).trimEnd().replace(/\n/g, eol);
  return `---${eol}${yaml}${eol}---${eol}`;
}

function getFileTitle(file) {
  if (!file) return "";
  if (typeof file.basename === "string") return file.basename;
  return String(file.name || "").replace(/\.md$/i, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class YamlPickerModal extends Modal {
  constructor(app, file, initialState, paramDefinitions, onSubmit, onInsertAliasAsH1) {
    super(app);
    this.file = file;
    this.onSubmit = onSubmit;
    this.onInsertAliasAsH1 = onInsertAliasAsH1;
    this.paramDefinitions = paramDefinitions;
    this.aliasInputComponent = null;
    this.state = {
      selectedClasses: new Set(initialState.selectedClasses),
      paramValues: { ...initialState.paramValues },
    };
  }

  syncAliasInput() {
    if (!this.aliasInputComponent) return;
    this.aliasInputComponent.setValue(String(this.state.paramValues[ALIAS_KEY] ?? ""));
  }

  async copyTextToClipboard(text) {
    const value = String(text || "");

    if (!value) {
      new Notice("Aucun titre à copier.");
      return false;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (error) {
      console.error("[yaml-picker] Clipboard API error", error);
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "true");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const success = document.execCommand("copy");
      document.body.removeChild(textArea);
      return success;
    } catch (error) {
      console.error("[yaml-picker] execCommand copy error", error);
      document.body.removeChild(textArea);
      return false;
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("yaml-picker-modal");

    contentEl.createEl("h2", { text: "YAML Picker" });
    contentEl.createEl("p", {
      text: `Note active : ${this.file.path}`,
      cls: "yaml-picker-note-path",
    });

    const classesSection = contentEl.createDiv({
      cls: "yaml-picker-section",
    });
    classesSection.createEl("h3", { text: "cssclasses" });

    for (const cssClass of MANAGED_CLASSES) {
      new Setting(classesSection)
        .setName(cssClass)
        .addToggle((toggle) => {
          toggle.setValue(this.state.selectedClasses.has(cssClass));
          toggle.onChange((value) => {
            if (value) {
              this.state.selectedClasses.add(cssClass);
            } else {
              this.state.selectedClasses.delete(cssClass);
            }
          });
        });
    }

    const aliasSection = contentEl.createDiv({ cls: "yaml-picker-section" });
    aliasSection.createEl("h3", { text: "Alias" });

    new Setting(aliasSection)
      .setName("Alias")
      .setDesc("alias (string)")
      .addText((text) => {
        this.aliasInputComponent = text;
        text.setPlaceholder("Alias de la note");
        text.setValue(String(this.state.paramValues[ALIAS_KEY] ?? ""));
        text.onChange((value) => {
          this.state.paramValues[ALIAS_KEY] = value;
        });
      })
      .addButton((button) => {
        button.setButtonText("Copier le titre");
        button.onClick(async () => {
          const title = getFileTitle(this.file);
          this.state.paramValues[ALIAS_KEY] = title;
          this.syncAliasInput();

          const copied = await this.copyTextToClipboard(title);
          new Notice(copied ? "Titre copié dans le presse-papiers." : "Impossible de copier le titre.");
        });
      })
      .addButton((button) => {
        button.setButtonText("Alias → H1");
        button.setCta();
        button.onClick(async () => {
          const aliasValue = normalizeAliasValue(this.state.paramValues[ALIAS_KEY]);

          if (!aliasValue) {
            new Notice("Renseigne d'abord un alias.");
            return;
          }

          try {
            await this.onSubmit({
              selectedClasses: [...this.state.selectedClasses],
              paramValues: { ...this.state.paramValues, [ALIAS_KEY]: aliasValue },
            });
            await this.onInsertAliasAsH1(aliasValue);
          } catch (error) {
            console.error("[yaml-picker] Insert alias as H1 error", error);
            new Notice("Impossible d'ajouter l'alias en H1.");
          }
        });
      });

    const paramsByType = {
      boolean: this.paramDefinitions.filter((definition) => definition.type === "boolean"),
      string: this.paramDefinitions.filter((definition) => definition.type === "string"),
      number: this.paramDefinitions.filter((definition) => definition.type === "number"),
    };

    const renderParamSection = (title, definitions) => {
      const section = contentEl.createDiv({ cls: "yaml-picker-section" });
      section.createEl("h3", { text: title });

      if (definitions.length === 0) {
        section.createEl("p", {
          text: "Aucun paramètre dans cette section.",
          cls: "yaml-picker-empty-state",
        });
        return;
      }

      for (const definition of definitions) {
        const setting = new Setting(section)
          .setName(definition.label)
          .setDesc(`${definition.key} (${definition.type})`);

        if (definition.type === "boolean") {
          setting.addToggle((toggle) => {
            toggle.setValue(!!this.state.paramValues[definition.key]);
            toggle.onChange((value) => {
              this.state.paramValues[definition.key] = value;
            });
          });
          continue;
        }

        setting.addText((text) => {
          text.setPlaceholder(
            definition.type === "number" ? "Valeur numérique" : "Valeur texte"
          );
          text.setValue(String(this.state.paramValues[definition.key] ?? ""));
          text.onChange((value) => {
            this.state.paramValues[definition.key] = value;
          });
        });
      }
    };

    if (this.paramDefinitions.length === 0) {
      const emptySection = contentEl.createDiv({ cls: "yaml-picker-section" });
      emptySection.createEl("h3", { text: "Boolean" });
      emptySection.createEl("p", {
        text: "Aucun paramètre géré. Ajoute-en dans les options du plugin.",
        cls: "yaml-picker-empty-state",
      });
    } else {
      renderParamSection("Boolean", paramsByType.boolean);
      if (paramsByType.string.length > 0) renderParamSection("Texte", paramsByType.string);
      if (paramsByType.number.length > 0) renderParamSection("Nombre", paramsByType.number);
    }

    const footer = contentEl.createDiv({ cls: "yaml-picker-footer" });

    const cancelButton = footer.createEl("button", { text: "Annuler" });
    cancelButton.addEventListener("click", () => this.close());

    const applyButton = footer.createEl("button", {
      text: "Appliquer",
      cls: "mod-cta",
    });
    applyButton.addEventListener("click", async () => {
      await this.onSubmit({
        selectedClasses: [...this.state.selectedClasses],
        paramValues: { ...this.state.paramValues },
      });
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class YamlPickerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "YAML Picker" });

    containerEl.createEl("p", {
      text: "Définis ici les paramètres YAML gérés par le plugin et affichés dans le modal. La clé alias est déjà gérée automatiquement.",
    });

    let draftManagedParamsText = this.plugin.settings.managedParamsText;

    new Setting(containerEl)
      .setName("Paramètres YAML gérés")
      .setDesc(
        "Une ligne par paramètre au format : clé|type|label|valeur par défaut. Types autorisés : boolean, string, number. La clé alias est réservée."
      )
      .addTextArea((textArea) => {
        textArea
          .setPlaceholder(
            "foldernote|boolean|foldernote|false\ncover|string|cover|\npriority|number|priority|1"
          )
          .setValue(draftManagedParamsText);

        textArea.inputEl.addClass("yaml-picker-settings-textarea");

        textArea.onChange((value) => {
          draftManagedParamsText = value;
        });
      })
      .addButton((button) => {
        button.setButtonText("Enregistrer");
        button.setCta();
        button.onClick(async () => {
          this.plugin.settings.managedParamsText = draftManagedParamsText;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const { parsed, errors } = parseManagedParamDefinitions(draftManagedParamsText);

    const preview = containerEl.createDiv({
      cls: "yaml-picker-settings-preview",
    });
    preview.createEl("h3", { text: "Aperçu" });

    preview.createEl("p", {
      text: 'Le champ réservé alias (string) est toujours affiché dans le modal.',
    });

    if (parsed.length === 0) {
      preview.createEl("p", {
        text: "Aucun paramètre valide configuré.",
        cls: "yaml-picker-empty-state",
      });
    } else {
      const list = preview.createEl("ul");
      for (const definition of parsed) {
        list.createEl("li", {
          text: `${definition.key} — ${definition.type} — ${definition.label} — défaut : ${definition.defaultValue}`,
        });
      }
    }

    if (errors.length > 0) {
      const errorBox = containerEl.createDiv({
        cls: "yaml-picker-settings-errors",
      });
      errorBox.createEl("h3", { text: "Erreurs" });
      const list = errorBox.createEl("ul");
      for (const error of errors) {
        list.createEl("li", { text: error });
      }
    }

    new Setting(containerEl)
      .setName("Réinitialiser les paramètres gérés")
      .setDesc("Remet uniquement la configuration par défaut du plugin.")
      .addButton((button) => {
        button.setButtonText("Réinitialiser");
        button.onClick(async () => {
          this.plugin.settings.managedParamsText = DEFAULT_SETTINGS.managedParamsText;
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }
}

module.exports = class YamlPickerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addSettingTab(new YamlPickerSettingTab(this.app, this));

    this.addCommand({
      id: "open-yaml-picker",
      name: "Ouvrir YAML Picker",
      callback: async () => {
        await this.openPicker();
      },
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getManagedParamDefinitions() {
    return parseManagedParamDefinitions(this.settings.managedParamsText);
  }

  async openPicker() {
    const file = this.app.workspace.getActiveFile();

    if (!file) {
      new Notice("Aucune note active.");
      return;
    }

    if (file.extension !== "md") {
      new Notice("Le fichier actif n'est pas une note Markdown.");
      return;
    }

    try {
      const paramDefinitions = this.getManagedParamDefinitions();
      const initialState = await this.readInitialState(file, paramDefinitions.parsed);
      new YamlPickerModal(
        this.app,
        file,
        initialState,
        paramDefinitions.parsed,
        async (result) => {
          try {
            await this.saveState(
              file,
              result.selectedClasses,
              result.paramValues,
              paramDefinitions.parsed
            );
            new Notice("YAML mis à jour.");
          } catch (error) {
            console.error("[yaml-picker] Save error", error);
            new Notice("Impossible de mettre à jour le YAML.");
            throw error;
          }
        },
        async (aliasValue) => {
          await this.insertAliasAsH1(file, aliasValue);
        }
      ).open();
    } catch (error) {
      console.error("[yaml-picker] Open error", error);
      new Notice("Impossible de lire le YAML de la note.");
    }
  }

  async readInitialState(file, paramDefinitions) {
    const text = await this.app.vault.cachedRead(file);
    const frontmatterMatch = extractTopFrontmatter(
      text.startsWith("\uFEFF") ? text.slice(1) : text
    );
    const frontmatter = frontmatterMatch ? safeParseYaml(frontmatterMatch.yaml) : {};
    const currentClasses = normalizeCssClasses(frontmatter.cssclasses);
    const paramValues = {
      [ALIAS_KEY]: normalizeAliasValue(frontmatter[ALIAS_KEY]),
    };

    for (const definition of paramDefinitions) {
      if (Object.prototype.hasOwnProperty.call(frontmatter, definition.key)) {
        paramValues[definition.key] = normalizeParamValue(
          frontmatter[definition.key],
          definition
        );
      } else {
        paramValues[definition.key] = definition.defaultValue;
      }
    }

    return {
      selectedClasses: MANAGED_CLASSES.filter((cssClass) =>
        currentClasses.includes(cssClass)
      ),
      paramValues,
    };
  }

  async saveState(file, selectedManagedClasses, paramValues, paramDefinitions) {
    await this.app.vault.process(file, (text) => {
      const eol = detectEol(text);
      const hasBom = text.startsWith("\uFEFF");
      const bom = hasBom ? "\uFEFF" : "";
      const rawText = hasBom ? text.slice(1) : text;

      const existingFrontmatter = extractTopFrontmatter(rawText);
      const currentFrontmatter = existingFrontmatter
        ? safeParseYaml(existingFrontmatter.yaml)
        : {};

      const updatedFrontmatter = buildUpdatedFrontmatter(
        currentFrontmatter,
        selectedManagedClasses,
        paramValues,
        paramDefinitions
      );

      const serializedFrontmatter = serializeFrontmatter(updatedFrontmatter, eol);

      if (existingFrontmatter) {
        const remainingBody = rawText.slice(existingFrontmatter.end);
        return `${bom}${serializedFrontmatter}${remainingBody}`;
      }

      return `${bom}${serializedFrontmatter}${rawText}`;
    });
  }

  async insertAliasAsH1(file, aliasValue) {
    const normalizedAlias = normalizeAliasValue(aliasValue);

    if (!normalizedAlias) {
      new Notice("Aucun alias à insérer.");
      return;
    }

    await this.app.vault.process(file, (text) => {
      const eol = detectEol(text);
      const hasBom = text.startsWith("\uFEFF");
      const bom = hasBom ? "\uFEFF" : "";
      const rawText = hasBom ? text.slice(1) : text;
      const frontmatterMatch = extractTopFrontmatter(rawText);

      const frontmatterPart = frontmatterMatch ? rawText.slice(0, frontmatterMatch.end) : "";
      let bodyPart = frontmatterMatch ? rawText.slice(frontmatterMatch.end) : rawText;

      const trimmedBodyStart = bodyPart.replace(/^\s*/, "");
      const headingPattern = new RegExp(`^#\\s+${escapeRegExp(normalizedAlias)}(?:\\r?\\n|$)`);

      if (headingPattern.test(trimmedBodyStart)) {
        return text;
      }

      bodyPart = bodyPart.replace(/^\s*/, "");
      const headingBlock = `# ${normalizedAlias}${eol}${eol}`;
      const rebuiltBody = bodyPart.length > 0 ? `${headingBlock}${bodyPart}` : `# ${normalizedAlias}${eol}`;

      if (frontmatterPart) {
        return `${bom}${frontmatterPart}${rebuiltBody}`;
      }

      return `${bom}${rebuiltBody}`;
    });

    new Notice("Alias ajouté en H1 en tête de note.");
  }
};
