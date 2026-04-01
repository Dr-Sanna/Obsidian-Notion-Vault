---
tags: MonthlyNote
cssclasses:
  - hide-frontmatter
  - hide-icon-title
startPosition: "{{date:gggg-[W]ww}}"
weekStart: "{{monday:YYYY-MM-DD}}"
weekEnd: "{{sunday:YYYY-MM-DD}}"
---
# <%*
const d = moment(tp.file.title, "YYYY-[M]MM", true).locale("fr");
const s = d.isValid() ? d.format("MMMM YYYY") : tp.file.title;
tR += s.charAt(0).toUpperCase() + s.slice(1);
%>


```dataviewjs
await dv.view("MonthlyTasksCalendar");
```

## Habit Tracker
```dataview
TABLE WITHOUT ID
  file.link as "Date",
  log_wakeup AS "⏰",
  log_stretching AS "🧘",
  log_workout_am AS "🏃‍♂️ AM",
  log_writing AS "🖊️",
  log_reading AS "🌄",
  log_workout_pm AS "🏋️ PM",
  log_mood AS "👾",
  log_discipline AS "🧱",
  log_summary AS "Résumé"
FROM "Notes/DailyNotes"
WHERE file.day >= this.weekStart AND file.day <= this.weekEnd
SORT file.day ASC

```

## Weekly review