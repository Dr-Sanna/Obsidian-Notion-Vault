---
foldernote: true
cssclasses:
  - hide-frontmatter
  - notion-list
icon: 🧘‍♂️
---

```dataview
LIST
FROM ""
WHERE file.folder = this.file.folder
AND file.path != this.file.path
SORT file.name ASC
```