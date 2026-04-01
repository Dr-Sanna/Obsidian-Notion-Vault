---
cssclasses:
  - notion-list
  - hide-frontmatter
foldernote: true
icon: 📖
---

```dataviewjs
const currentPath = dv.current().file.path;
const currentFolder = dv.current().file.folder;

const allFiles = app.vault.getFiles();

// 1) Fichiers du dossier courant
const directFiles = allFiles.filter(f =>
  f.parent?.path === currentFolder &&
  f.path !== currentPath
);

// 2) Folder notes des sous-dossiers immédiats
const folder = app.vault.getAbstractFileByPath(currentFolder);
let childFolderNotes = [];

if (folder && folder.children) {
  const childFolders = folder.children.filter(x => x.children); // TFolder sans importer les classes

  childFolderNotes = childFolders
    .map(subfolder => {
      const expectedPath = `${subfolder.path}/${subfolder.name}.md`;
      return app.vault.getAbstractFileByPath(expectedPath);
    })
    .filter(f => f && f.path !== currentPath);
}

// 3) Fusion sans doublons
const byPath = new Map();

for (const f of [...directFiles, ...childFolderNotes]) {
  byPath.set(f.path, f);
}

const result = [...byPath.values()].sort((a, b) =>
  a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" })
);

dv.list(result.map(f => dv.fileLink(f.path)));
```