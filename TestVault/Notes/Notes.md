---
icon: ✏️
cssclasses:
  - notion-list
  - hide-frontmatter
---

```dataviewjs
const currentFolder = dv.current().file.folder;
const currentDepth = currentFolder.split("/").length;
const vaultName = encodeURIComponent(app.vault.getName());

// Même logique que ton dataview initial
const pages = dv.pages('""')
  .where(p =>
    p.foldernote === true &&
    p.file.folder.startsWith(currentFolder + "/") &&
    p.file.folder.split("/").length === currentDepth + 1
  )
  .sort(p => p.file.folder, "asc");

// Conteneur principal
const wrapper = dv.container.createEl("div", { cls: "foldernotes-actions-list" });

// Liste <ul> style Dataview
const ul = wrapper.createEl("ul", { cls: "dataview list-view-ul" });

for (const p of pages) {
  const li = ul.createEl("li");

  // Ligne = lien natif + bouton éventuel
  const row = li.createEl("div", { cls: "foldernotes-row" });

  // 1) Lien normal vers la note (style natif Obsidian)
  const linkWrap = row.createEl("span", { cls: "foldernotes-main-link" });
  dv.el("span", p.file.link, { container: linkWrap });

  // 2) Lecture du champ YAML action
  let action = p.action ?? "";
  if (Array.isArray(action)) action = action[0] ?? "";
  action = String(action).trim();

  // Tolérance si parenthèses dans YAML
  if (action.startsWith("(") && action.endsWith(")")) {
    action = action.slice(1, -1).trim();
  }

  // Placeholder optionnel
  action = action.replaceAll("{{vault}}", vaultName);

  let actionUri = null;
  const actionKey = action.toLowerCase();

  // URI directe
  if (action.startsWith("obsidian://")) {
    actionUri = action;
  }
  // Mots-clés
  else if (actionKey === "daily") {
    actionUri = `obsidian://adv-uri?vault=${vaultName}&daily=true`;
  }
  else if (actionKey === "today") {
    actionUri = `obsidian://daily-notes?new=true`;
  }

  // 3) Bouton action (uniquement si action valide)
  if (actionUri) {
    const btn = row.createEl("button", {
      cls: "foldernotes-action-btn",
      text: "↗"
    });

    btn.setAttr("type", "button");
    btn.setAttr("aria-label", "Lancer l’action");
    btn.setAttr("title", action);

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      window.location.href = actionUri;
    });
  }
}
```
