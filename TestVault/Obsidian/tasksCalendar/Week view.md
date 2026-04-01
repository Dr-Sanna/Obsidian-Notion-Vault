---
icon: 📅
cssclasses:
  - fullwidth
  - hide-icon-title
  - hide-frontmatter
---
```dataviewjs
dv.container.replaceChildren();
await dv.view("tasksCalendar", {pages: "", view: "week", firstDayOfWeek: "1", options: "style4",   css: `
/* Empêcher le micro overflow horizontal + contenir la hauteur */
.tasksCalendar{
  height: 100% !important;
  max-height: 100% !important;
  max-width: 100% !important;
  overflow-x: hidden !important;
  box-sizing: border-box !important;
  padding-top: 10px;
  padding-right: 10px;
}
`})
```
