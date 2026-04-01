---
title: GTO Paradise Lost
author: Tôru Fujisawa
read: false
started: 2026-01-12
finished:
tags:
  - manga
cover: "[[GTO Paradise Lost T01.jpg]]"
---

## Tomes (édition française — Pika)
```dataviewjs
const tomes = [
  { n: 1,  date: "2015-09-30", img: "https://www.bedetheque.com/media/Couvertures/Couv_256625.jpg" },
  { n: 2,  date: "2015-11-04", img: "https://www.bedetheque.com/media/Couvertures/Couv_259078.jpg" },
  { n: 3,  date: "2016-03-02", img: "https://www.bedetheque.com/media/Couvertures/Couv_274626.jpg" },
  { n: 4,  date: "2016-09-21", img: "https://www.bedetheque.com/media/Couvertures/Couv_288920.jpg" },
  { n: 5,  date: "2016-12-14", img: "https://www.bedetheque.com/media/Couvertures/Couv_294422.jpg" },
  { n: 6,  date: "2017-03-01", img: "https://www.bedetheque.com/media/Couvertures/Couv_300251.jpg" },
  { n: 7,  date: "2017-09-06", img: "https://www.bedetheque.com/media/Couvertures/Couv_310526.jpg" },
  { n: 8,  date: "2017-11-02", img: "https://www.bedetheque.com/media/Couvertures/Couv_314725.jpg" },
  { n: 9,  date: "2018-02-07", img: "https://www.bedetheque.com/media/Couvertures/Couv_322856.jpg" },
  { n: 10, date: "2018-05-23", img: "https://www.bedetheque.com/media/Couvertures/Couv_333983.jpg" },
  { n: 11, date: "2018-08-29", img: "https://www.bedetheque.com/media/Couvertures/Couv_342752.jpg" },
  { n: 12, date: "2020-07-01", img: "https://www.bedetheque.com/media/Couvertures/Couv_397969.jpg" },
  { n: 13, date: "2021-02-03", img: "https://www.bedetheque.com/media/Couvertures/Couv_415720.jpg" },
  { n: 14, date: "2021-07-07", img: "https://www.bedetheque.com/media/Couvertures/Couv_427433.jpg" },
  { n: 15, date: "2022-03-16", img: "https://www.bedetheque.com/media/Couvertures/Couv_444606.jpg" },
  { n: 16, date: "2022-06-01", img: "https://www.bedetheque.com/media/Couvertures/Couv_448400.jpg" },
  { n: 17, date: "2022-09-07", img: "https://www.bedetheque.com/media/Couvertures/Couv_453237.jpg" },
  { n: 18, date: "2023-03-01", img: "https://www.bedetheque.com/media/Couvertures/Couv_467737.jpg" },
  { n: 19, date: "2023-07-05", img: "https://www.bedetheque.com/media/Couvertures/Couv_475157.jpg" },
  { n: 20, date: "2023-11-02", img: "https://www.bedetheque.com/media/Couvertures/Couv_485770.jpg" },
];

// Nettoyage: enlève les entrées vides + trie
const data = tomes
  .filter(t => t && Number.isFinite(t.n) && t.img)
  .sort((a,b) => a.n - b.n);

const COLS = 6;
const IMG_W = 110;

// Important: on repart sur un conteneur propre (évite les "nœuds fantômes")
dv.container.innerHTML = "";

const grid = document.createElement("div");
grid.style.display = "grid";
grid.style.gridTemplateColumns = `repeat(${COLS}, minmax(0, 1fr))`;
grid.style.gap = "12px";

for (const t of data) {
  const card = document.createElement("div");
  card.className = "gto-card";

  const img = document.createElement("img");
  img.src = t.img;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.style.width = `${IMG_W}px`;
  img.style.maxWidth = "100%";
  img.style.height = "auto";
  img.style.borderRadius = "10px";

  const title = document.createElement("div");
  title.className = "gto-title";
  title.textContent = `Tome ${String(t.n).padStart(2, "0")}`;

  const date = document.createElement("div");
  date.className = "gto-date";
  date.textContent = t.date || "";

  card.appendChild(img);
  card.appendChild(title);
  card.appendChild(date);
  grid.appendChild(card);
}

dv.container.appendChild(grid);

```
