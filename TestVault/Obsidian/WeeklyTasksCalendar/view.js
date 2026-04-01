// WeeklyTasksCalendar/view.js
// Rendu TasksCalendar calé sur la semaine ISO du nom de fichier "YYYY-Www".
// Ne dépend PAS du frontmatter, donc marche immédiatement après création.

const pad2 = (n) => String(n).padStart(2, "0");

const cur = dv.current?.();
if (!cur || !cur.file || !cur.file.name) {
  dv.paragraph("Calendrier: chargement…");
  return;
}

const fileName = String(cur.file.name);
const m = fileName.match(/^(\d{4})-W(\d{1,2})$/i);

if (!m) {
  dv.paragraph("Calendrier: nom de fichier attendu: YYYY-Www (ex: 2026-W02).");
  return;
}

// TasksCalendar (week view) attend "YYYY-ww"
const startPosition = `${m[1]}-${pad2(+m[2])}`;

try {
  await dv.view("tasksCalendar", {
    pages: "",
    view: "week",
    firstDayOfWeek: "1",
    startPosition,
    options: "style4 lineClamp1 noIcons",
    css: `
.tasksCalendar.style4[view="week"] .grid{ height: 277px !important; }
.tasksCalendar{ max-width: 100% !important; overflow-x: hidden !important; box-sizing: border-box !important; }
.tasksCalendar *{ box-sizing: border-box !important; }
`,
  });
} catch (e) {
  dv.paragraph("Calendrier: chargement…");
  console.error("TasksCalendar error (hidden):", e);
}
