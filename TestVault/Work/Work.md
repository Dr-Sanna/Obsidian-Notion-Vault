---
foldernote: true
cssclasses:
  - hide-frontmatter
  - notion-list
icon: 🦷
---
```dataview
LIST WITHOUT ID link(file.path, choice(length(file.aliases) > 0, file.aliases[0], file.name))
FROM ""
WHERE foldernote = true
AND startswith(file.folder, this.file.folder + "/")
AND length(split(file.folder, "/")) = length(split(this.file.folder, "/")) + 1
SORT file.folder ASC
```
^menu




