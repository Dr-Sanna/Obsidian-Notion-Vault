---
creation date: <% tp.file.creation_date() %>
modification date: <%+ tp.file.last_modified_date("dddd Do MMMM YYYY HH:mm:ss") %>
tags: DailyNote
cssclasses:
  - hide-frontmatter
  - hide-icon-title
week: <% tp.date.now("YYYY-[W]WW") %>
log_summary:
log_mood:
log_discipline:
log_wakeup:
log_workout_pm:
log_stretching:
log_affirmation:
log_visualisation:
log_writing:
log_reading:
log_workout_am:
log_ecrire:
notetoolbar: DailyNotesToolbar
---
#  <%* 
const d = moment(tp.file.title, "YYYY-MM-DD", true).locale("fr");
const s = d.isValid() ? d.format("dddd D MMMM YYYY") : tp.file.title;
tR += s.charAt(0).toUpperCase() + s.slice(1);
%>

Weekly Log: [[<% tp.date.now("YYYY-[W]WW", 0, tp.file.title, "YYYY-MM-DD") %>]]

## Objectifs

```tqa
mode: objectifs
preview: objectifs
```

## Daily Log
- **📝 Résumé** : `INPUT[text:log_summary]`  
- **⏰ Réveil** : `INPUT[time:log_wakeup]`
- **🧱 Discipline** : `INPUT[inlineSelect(option(✅), option(❌)):log_discipline]`
- **👾 Mood** : `INPUT[inlineSelect(option(😄), option(🙂), option(😐), option(😕), option(😫)):log_mood]`
- **🏋️ Workout (PM)** : `INPUT[text:log_workout_pm]`

### Miracle Routine
- **🧘 Stretching** : `INPUT[text:log_stretching]`
- **🧠 Affirmation** : `INPUT[text:log_affirmation]`
- **🖼️ Visualisation** : `INPUT[text:log_visualisation]`
- **🖊️ Writing** : `INPUT[text:log_writing]`
- **🌄 Reading** : `INPUT[text:log_reading]` 
- **🏃‍♂️ Workout (AM)** : `INPUT[text:log_workout_am]`

## Tasks
```tqa
mode: tasks
preview: tasks
```
