// MonthlyTasksCalendar/view.js
// Rendu TasksCalendar calé sur le mois du nom de fichier "YYYY-Mmm".
// Ne dépend PAS du frontmatter, donc marche immédiatement après création.

const pad2 = (n) => String(n).padStart(2, "0");

const cur = dv.current?.();
if (!cur || !cur.file || !cur.file.name) {
  dv.paragraph("Calendrier: chargement…");
  return;
}

const fileName = String(cur.file.name).trim();
const m = fileName.match(/^(\d{4})-M(\d{1,2})$/i);

if (!m) {
  dv.paragraph("Calendrier: nom de fichier attendu : YYYY-Mmm (ex: 2026-M03).");
  return;
}

const year = m[1];
const month = +m[2];

if (month < 1 || month > 12) {
  dv.paragraph("Calendrier: mois invalide dans le nom de fichier.");
  return;
}

// TasksCalendar (month view) attend "YYYY-MM"
const startPosition = `${year}-${pad2(month)}`;

try {
  await dv.view("tasksCalendar", {
    pages: "",
    view: "month",
    firstDayOfWeek: "1",
    startPosition,
    options: "style1 lineClamp1 noIcons",
    css: `
.tasksCalendar[view="month"]{
  max-width: 100% !important;
  overflow-x: hidden !important;
  box-sizing: border-box !important;
}
.tasksCalendar[view="month"] *{
  box-sizing: border-box !important;
}
`,
  });
} catch (e) {
  dv.paragraph("Calendrier: chargement…");
  console.error("TasksCalendar error (hidden):", e);
}