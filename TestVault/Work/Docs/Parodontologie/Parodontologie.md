---
cssclasses:
  - notion-list
  - hide-frontmatter
foldernote: true
icon: 🍖
---
```dataview
LIST
FROM ""
WHERE file.folder = this.file.folder
AND file.path != this.file.path
SORT file.name ASC
```