---
foldernote: true
cssclasses:
  - hide-frontmatter
  - notion-list
icon: 🎯
---
```dataview
LIST
FROM ""
WHERE foldernote = true
AND startswith(file.folder, this.file.folder + "/")
AND length(split(file.folder, "/")) = length(split(this.file.folder, "/")) + 1
SORT file.folder ASC
```