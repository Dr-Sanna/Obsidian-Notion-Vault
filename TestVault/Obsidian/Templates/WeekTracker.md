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
WHERE file.day.weekyear = date(now).weekyear
  AND file.day.weeknumber = date(now).weeknumber
SORT file.day ASC
```
