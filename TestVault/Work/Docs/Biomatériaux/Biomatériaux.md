---
cssclasses:
  - notion-list
  - hide-frontmatter
foldernote: true
icon: 🧪
---
```dataview
LIST WITHOUT ID link(file.path, file.aliases[0])
FROM ""
WHERE file.folder = this.file.folder
AND file.path != this.file.path
SORT file.name ASC
```