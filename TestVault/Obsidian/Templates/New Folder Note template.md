---
cssclasses:
  - notion-list
  - hide-frontmatter
foldernote: true
---
#### Folder notes des sous-dossiers directs uniquement
```dataview
LIST
FROM ""
WHERE foldernote = true
AND startswith(file.folder, this.file.folder + "/")
AND length(split(file.folder, "/")) = length(split(this.file.folder, "/")) + 1
SORT file.folder ASC
```
 
#### Fichiers du dossier courant uniquement (sans la note courante)
```dataview
LIST
FROM ""
WHERE file.folder = this.file.folder
AND file.path != this.file.path
SORT file.name ASC
```