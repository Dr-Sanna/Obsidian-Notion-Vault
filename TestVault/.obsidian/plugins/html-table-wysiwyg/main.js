const { Plugin, Modal, Notice, Setting, PluginSettingTab, setIcon } = require("obsidian");

const DEFAULT_SETTINGS = {
  classPresets: "bg-bloc,bg-bloc-centered,text-center,font-bold",
  defaultTableClass: "def-table"
};

function uniq(arr) {
  return Array.from(new Set(arr));
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/** Clear any text selection (avoid lingering highlight when leaving contenteditable) */
function clearTextSelection() {
  const sel = window.getSelection?.();
  if (sel && typeof sel.removeAllRanges === "function") sel.removeAllRanges();
}

/** Find table block under cursor by scanning for nearest <table ...> and </table> */
function findTableRange(text, cursorOffset) {
  const before = text.slice(0, cursorOffset);
  const openIdx = before.lastIndexOf("<table");
  if (openIdx === -1) return null;

  const after = text.slice(openIdx);
  const closeRel = after.indexOf("</table>");
  if (closeRel === -1) return null;

  const closeIdx = openIdx + closeRel + "</table>".length;
  return { start: openIdx, end: closeIdx, html: text.slice(openIdx, closeIdx) };
}

function extractAttrs(el) {
  const attrs = {};
  for (const a of Array.from(el.attributes)) {
    if (a.name === "class") continue;
    attrs[a.name] = a.value;
  }
  const cls = (el.getAttribute("class") || "").trim();
  if (cls) attrs["class"] = cls;
  return attrs;
}

function escapeAttr(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function attrsToString(attrs) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === "") continue;
    parts.push(`${k}="${escapeAttr(v)}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function splitClassNames(value) {
  return String(value || "")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function joinClassNames(list) {
  return uniq((list || []).map((x) => String(x || "").trim()).filter(Boolean)).join(" ");
}

function ensureClassOnAttrs(attrs, className) {
  const next = { ...(attrs || {}) };
  next.class = joinClassNames([...splitClassNames(next.class), className]);
  return next;
}

function parsePercentWidth(value) {
  const m = String(value || "").match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getExplicitColumnWidths(table) {
  const cols = Array.from(table.querySelectorAll(":scope > colgroup > col"));
  const raw = cols
    .map((col) => {
      const styleWidth = parsePercentWidth(col.getAttribute("style") || "");
      const attrWidth = parsePercentWidth(col.getAttribute("width") || "");
      return styleWidth ?? attrWidth;
    })
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!raw.length) return null;
  const sum = raw.reduce((acc, n) => acc + n, 0) || 100;
  return raw.map((n) => (n / sum) * 100);
}

function extractColumnWidths(table, fallbackCols = 1) {
  const explicit = getExplicitColumnWidths(table);
  if (explicit && explicit.length) return explicit;
  const count = Math.max(1, parseInt(fallbackCols, 10) || 1);
  return Array.from({ length: count }, () => 100 / count);
}

function normalizeColWidths(model) {
  const cols = Math.max(1, parseInt(model.cols, 10) || 1);
  const incoming = Array.isArray(model.colWidths) ? model.colWidths.map((n) => parseFloat(n)).filter((n) => Number.isFinite(n) && n > 0) : [];

  let widths = incoming.slice(0, cols);
  if (!widths.length) {
    widths = Array.from({ length: cols }, () => 100 / cols);
  } else if (widths.length < cols) {
    const remaining = cols - widths.length;
    const fill = remaining > 0 ? ((100 - widths.reduce((acc, n) => acc + n, 0)) / remaining) : 0;
    while (widths.length < cols) widths.push(fill > 0 ? fill : 100 / cols);
  }

  const sum = widths.reduce((acc, n) => acc + n, 0) || 100;
  model.colWidths = widths.map((n) => (n / sum) * 100);
}

function insertColumnWidth(model, index) {
  normalizeColWidths(model);
  index = clamp(index, 0, model.colWidths.length);

  if (!model.colWidths.length) {
    model.colWidths = [100];
    return;
  }

  const sourceIndex = Math.min(index, model.colWidths.length - 1);
  const sourceWidth = model.colWidths[sourceIndex] || (100 / Math.max(1, model.cols || 1));
  const newWidth = sourceWidth / 2;
  model.colWidths[sourceIndex] = sourceWidth - newWidth;
  model.colWidths.splice(index, 0, newWidth);
  normalizeColWidths(model);
}

function deleteColumnWidth(model, index) {
  normalizeColWidths(model);
  if (model.colWidths.length <= 1) {
    model.colWidths = [100];
    return;
  }

  index = clamp(index, 0, model.colWidths.length - 1);
  const removed = model.colWidths.splice(index, 1)[0] || 0;
  const target = clamp(index - 1 >= 0 ? index - 1 : 0, 0, model.colWidths.length - 1);
  model.colWidths[target] += removed;
  normalizeColWidths(model);
}

function isWhitespaceOnlyTextNode(node) {
  return node && node.nodeType === Node.TEXT_NODE && !String(node.textContent || "").replace(/\u200B/g, "").trim();
}

function createFragmentRoot(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="htw-root">${html || ""}</div>`, "text/html");
  return { doc, root: doc.getElementById("htw-root") };
}

function removeCommentNodes(root) {
  if (!root || !root.ownerDocument) return;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const toRemove = [];
  let current = walker.nextNode();
  while (current) {
    toRemove.push(current);
    current = walker.nextNode();
  }
  toRemove.forEach((node) => node.parentNode?.removeChild(node));
}

function unwrapElement(el) {
  if (!el || !el.parentNode) return;
  const parent = el.parentNode;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function stripZeroWidthSpaces(root) {
  if (!root || !root.ownerDocument) return;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  let current = walker.nextNode();
  while (current) {
    texts.push(current);
    current = walker.nextNode();
  }
  texts.forEach((node) => {
    node.textContent = String(node.textContent || "").replace(/​/g, "");
  });
}

function sanitizeInlineMarkup(root) {
  if (!root || !root.ownerDocument) return;
  removeCommentNodes(root);

  root.querySelectorAll("style,script,meta,link").forEach((el) => el.remove());

  Array.from(root.querySelectorAll("b")).forEach((el) => {
    const strong = root.ownerDocument.createElement("strong");
    while (el.firstChild) strong.appendChild(el.firstChild);
    el.replaceWith(strong);
  });

  Array.from(root.querySelectorAll("i")).forEach((el) => {
    const em = root.ownerDocument.createElement("em");
    while (el.firstChild) em.appendChild(el.firstChild);
    el.replaceWith(em);
  });

  const allowed = new Set(["P", "BR", "STRONG", "EM"]);
  Array.from(root.querySelectorAll("*")).forEach((el) => {
    if (!allowed.has(el.tagName)) {
      unwrapElement(el);
      return;
    }
    Array.from(el.attributes).forEach((attr) => el.removeAttribute(attr.name));
  });

  stripZeroWidthSpaces(root);
}

function nodeIsParagraph(node) {
  return node && node.nodeType === Node.ELEMENT_NODE && node.tagName === "P";
}

function paragraphIsEmpty(p) {
  if (!p || p.tagName !== "P") return true;
  const html = String(p.innerHTML || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "")
    .replace(/&nbsp;|&#160;/gi, "")
    .replace(/\u200B/g, "")
    .trim();
  const text = String(p.textContent || "").replace(/\u200B/g, "").trim();
  const hasNonTextContent = !!p.querySelector("img,svg,video,audio,iframe,table,ul,ol,blockquote,pre,code");
  return !hasNonTextContent && !html && !text;
}

function ensureParagraphHasPlaceholder(p) {
  if (!p) return;
  if (paragraphIsEmpty(p)) p.innerHTML = "<br>";
}

function normalizeEditableRoot(root) {
  if (!root) return;
  sanitizeInlineMarkup(root);
  const doc = root.ownerDocument;
  const frag = doc.createDocumentFragment();
  let currentP = null;

  const flush = () => {
    if (!currentP) return;
    ensureParagraphHasPlaceholder(currentP);
    frag.appendChild(currentP);
    currentP = null;
  };

  Array.from(root.childNodes).forEach((node) => {
    if (nodeIsParagraph(node)) {
      flush();
      ensureParagraphHasPlaceholder(node);
      frag.appendChild(node);
      return;
    }

    if (isWhitespaceOnlyTextNode(node) && !currentP) {
      return;
    }

    if (!currentP) currentP = doc.createElement("p");
    currentP.appendChild(node);
  });

  flush();
  root.replaceChildren(frag);
  stripZeroWidthSpaces(root);

  if (!root.children.length) {
    const p = doc.createElement("p");
    p.innerHTML = "<br>";
    root.appendChild(p);
  }

  Array.from(root.childNodes).forEach((node) => {
    if (isWhitespaceOnlyTextNode(node)) root.removeChild(node);
  });

  Array.from(root.children).forEach((child) => {
    if (child.tagName !== "P") {
      const p = doc.createElement("p");
      while (child.firstChild) p.appendChild(child.firstChild);
      child.replaceWith(p);
      ensureParagraphHasPlaceholder(p);
      if (!paragraphIsEmpty(p)) trimTrailingBreakArtifacts(p, false);
      return;
    }
    Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
    ensureParagraphHasPlaceholder(child);
    if (!paragraphIsEmpty(child)) trimTrailingBreakArtifacts(child, false);
    ensureParagraphHasPlaceholder(child);
  });

  sanitizeInlineMarkup(root);
}

function normalizeStoredCellHtml(html) {
  const { root } = createFragmentRoot(html || "");
  normalizeEditableRoot(root);
  const paragraphs = Array.from(root.children).filter((el) => el.tagName === "P");
  const allEmpty = paragraphs.every((p) => paragraphIsEmpty(p));
  if (!paragraphs.length || allEmpty) return "";
  return paragraphs
    .map((p) => {
      if (paragraphIsEmpty(p)) return "<p><br></p>";
      return p.outerHTML;
    })
    .join("");
}

function htmlToEditableCellHtml(html) {
  const normalized = normalizeStoredCellHtml(html || "");
  return normalized || "<p><br></p>";
}

function extractEditableCellHtml(editorEl) {
  const clone = editorEl.cloneNode(true);
  clone.removeAttribute("contenteditable");
  normalizeEditableRoot(clone);

  const paragraphs = Array.from(clone.children).filter((el) => el.tagName === "P");
  while (paragraphs.length && paragraphIsEmpty(paragraphs[0])) {
    paragraphs[0].remove();
    paragraphs.shift();
  }
  while (paragraphs.length && paragraphIsEmpty(paragraphs[paragraphs.length - 1])) {
    paragraphs[paragraphs.length - 1].remove();
    paragraphs.pop();
  }

  if (!paragraphs.length) return "";

  return Array.from(clone.children)
    .filter((el) => el.tagName === "P")
    .map((p) => {
      if (paragraphIsEmpty(p)) return "<p><br></p>";
      return p.outerHTML;
    })
    .join("");
}

function findClosestWithin(node, selector, root) {
  let current = node instanceof Node ? node : null;
  while (current && current !== root) {
    if (current.nodeType === Node.ELEMENT_NODE && current.matches(selector)) return current;
    current = current.parentNode;
  }
  return current === root && root.matches && root.matches(selector) ? root : null;
}

function ensureEditorHasParagraph(root) {
  normalizeEditableRoot(root);
  return root.querySelector(":scope > p") || root.querySelector("p");
}

function selectionIsInside(root) {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  return root.contains(range.startContainer) && root.contains(range.endContainer);
}

function isCaretAtEndOfElement(range, element) {
  const test = range.cloneRange();
  test.selectNodeContents(element);
  test.setStart(range.endContainer, range.endOffset);
  return test.toString() === "";
}

function lastMeaningfulChild(element) {
  const nodes = Array.from(element.childNodes).filter((node) => !isWhitespaceOnlyTextNode(node));
  return nodes.length ? nodes[nodes.length - 1] : null;
}

function paragraphEndsWithSoftBreak(p) {
  let current = p ? p.lastChild : null;
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const raw = String(current.textContent || "");
      const cleaned = raw.replace(/​/g, "");
      if (!cleaned.trim()) {
        current = current.previousSibling;
        continue;
      }
      return false;
    }
    if (current.nodeType === Node.ELEMENT_NODE && current.tagName === "BR") return true;
    if (current.nodeType === Node.ELEMENT_NODE) return false;
    current = current.previousSibling;
  }
  return false;
}

function trimTrailingBreakArtifacts(p, keepPlaceholder = false) {
  let current = p ? p.lastChild : null;
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const raw = String(current.textContent || "");
      const cleaned = raw.replace(/​/g, "");
      if (!cleaned.trim()) {
        const prev = current.previousSibling;
        current.remove();
        current = prev;
        continue;
      }
      break;
    }

    if (current.nodeType === Node.ELEMENT_NODE && current.tagName === "BR") {
      const prev = current.previousSibling;
      current.remove();
      current = prev;
      continue;
    }

    break;
  }

  if (!p) return;
  if (!p.childNodes.length && keepPlaceholder) {
    p.innerHTML = "<br>";
  }
}

function removeTrailingSoftBreak(p) {
  trimTrailingBreakArtifacts(p, false);
  if (!p.childNodes.length) {
    p.innerHTML = "";
  }
}

function placeCaretAtStart(el) {
  const sel = window.getSelection?.();
  if (!sel) return;
  const range = document.createRange();
  if (el.firstChild && el.firstChild.nodeType === Node.ELEMENT_NODE && el.firstChild.tagName === "BR") {
    range.setStartBefore(el.firstChild);
  } else {
    range.selectNodeContents(el);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAfterNode(node) {
  const sel = window.getSelection?.();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretInTextNode(node, offset = null) {
  const sel = window.getSelection?.();
  if (!sel || !node) return;
  const range = document.createRange();
  const safeOffset = offset == null ? String(node.textContent || "").length : offset;
  range.setStart(node, safeOffset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function plainTextToEditorHtml(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const paragraphs = raw.split(/\n{2,}/);
  const html = paragraphs
    .map((block) => escapeHtml(block).replace(/\n/g, "<br>"))
    .map((block) => `<p>${block || "<br>"}</p>`)
    .join("");
  return html || "<p><br></p>";
}

function insertSoftBreakAtSelection(forceVisibleLine = false) {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement("br");
  range.insertNode(br);

  if (forceVisibleLine) {
    const tail = document.createTextNode("​");
    if (br.nextSibling) br.parentNode.insertBefore(tail, br.nextSibling);
    else br.parentNode.appendChild(tail);
    placeCaretInTextNode(tail, 1);
    return;
  }

  placeCaretAfterNode(br);
}

function insertParagraphAfter(p) {
  const doc = p.ownerDocument;
  const next = doc.createElement("p");
  next.innerHTML = "<br>";
  if (p.nextSibling) p.parentNode.insertBefore(next, p.nextSibling);
  else p.parentNode.appendChild(next);
  placeCaretAtStart(next);
  return next;
}

function handleParagraphEditorKeydown(editorEl, event) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return;
  }
  if (!selectionIsInside(editorEl)) return;

  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const p = findClosestWithin(range.startContainer, "p", editorEl) || ensureEditorHasParagraph(editorEl);
  if (!p) return;

  const caretAtEnd = range.collapsed && isCaretAtEndOfElement(range, p);

  event.preventDefault();

  if (caretAtEnd && paragraphEndsWithSoftBreak(p)) {
    removeTrailingSoftBreak(p);
    insertParagraphAfter(p);
    return;
  }

  insertSoftBreakAtSelection(caretAtEnd);
}

function mergeCellHtmlBlocks(htmlList) {
  return htmlList
    .map((html) => normalizeStoredCellHtml(html || ""))
    .filter(Boolean)
    .join("");
}

function nextId(model) {
  let maxId = 0;
  for (const c of model.cells) {
    const n = parseInt(c.id, 10);
    if (!isNaN(n)) maxId = Math.max(maxId, n);
  }
  return String(maxId + 1);
}

function buildOcc(model) {
  const occ = Array.from({ length: model.rows }, () => Array(model.cols).fill(null));
  for (const cell of model.cells) {
    for (let rr = cell.row; rr < cell.row + cell.rowspan; rr++) {
      for (let cc = cell.col; cc < cell.col + cell.colspan; cc++) {
        if (rr >= 0 && rr < model.rows && cc >= 0 && cc < model.cols) {
          occ[rr][cc] = cell.id;
        }
      }
    }
  }
  return occ;
}

/** Fill holes so the grid is always rectangular */
function normalizeGrid(model) {
  const occ = buildOcc(model);
  for (let r = 0; r < model.rows; r++) {
    for (let c = 0; c < model.cols; c++) {
      if (occ[r][c] != null) continue;
      const tag = model.rowSections[r] === "thead" ? "th" : "td";
      model.cells.push({
        id: nextId(model),
        row: r,
        col: c,
        rowspan: 1,
        colspan: 1,
        html: "",
        classes: [],
        tag
      });
      occ[r][c] = model.cells[model.cells.length - 1].id;
    }
  }
}

function deleteRow(model, rDel) {
  if (model.rows <= 1) return;
  rDel = clamp(rDel, 0, model.rows - 1);

  const nextCells = [];
  for (const cell of model.cells) {
    const r0 = cell.row;
    const r1 = cell.row + cell.rowspan - 1;

    if (rDel < r0) {
      cell.row -= 1;
      nextCells.push(cell);
    } else if (rDel > r1) {
      nextCells.push(cell);
    } else {
      if (cell.rowspan > 1) {
        cell.rowspan -= 1;
        nextCells.push(cell);
      }
    }
  }

  model.cells = nextCells;
  model.rowSections.splice(rDel, 1);
  model.rows -= 1;
  normalizeGrid(model);
}

function deleteCol(model, cDel) {
  if (model.cols <= 1) return;
  cDel = clamp(cDel, 0, model.cols - 1);
  deleteColumnWidth(model, cDel);

  const nextCells = [];
  for (const cell of model.cells) {
    const c0 = cell.col;
    const c1 = cell.col + cell.colspan - 1;

    if (cDel < c0) {
      cell.col -= 1;
      nextCells.push(cell);
    } else if (cDel > c1) {
      nextCells.push(cell);
    } else {
      if (cell.colspan > 1) {
        cell.colspan -= 1;
        nextCells.push(cell);
      }
    }
  }

  model.cells = nextCells;
  model.cols -= 1;
  normalizeGrid(model);
}

/**
 * Cleanup:
 * - remove empty rows
 * - remove empty cols + cols without anchor (covered only by colspans)
 */
function cleanupTable(model) {
  normalizeGrid(model);

  let changed = true;
  while (changed) {
    changed = false;
    const occ = buildOcc(model);

    for (let r = 0; r < model.rows; r++) {
      const hasAny = occ[r] && occ[r].some((id) => id != null);
      if (!hasAny) {
        deleteRow(model, r);
        normalizeGrid(model);
        changed = true;
        break;
      }
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    const occ = buildOcc(model);

    const hasAnchorInCol = (c) => model.cells.some((cell) => cell.col === c);

    for (let c = 0; c < model.cols; c++) {
      let hasAnyOcc = false;
      for (let r = 0; r < model.rows; r++) {
        if (occ[r] && occ[r][c] != null) {
          hasAnyOcc = true;
          break;
        }
      }

      const noAnchor = !hasAnchorInCol(c);

      if (!hasAnyOcc || noAnchor) {
        deleteCol(model, c);
        normalizeGrid(model);
        changed = true;
        break;
      }
    }
  }
}

/** Parse HTML table into model */
function parseHtmlTable(tableHtml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(tableHtml, "text/html");
  const table = doc.querySelector("table");
  if (!table) throw new Error("No <table> found");

  const rowEntries = [];
  const sections = ["thead", "tbody", "tfoot"];
  let anySection = false;

  sections.forEach((sec) => {
    const el = table.querySelector(sec);
    if (!el) return;
    anySection = true;
    el.querySelectorAll("tr").forEach((tr) => rowEntries.push({ section: sec, tr }));
  });

  if (!anySection) {
    table.querySelectorAll("tr").forEach((tr) => rowEntries.push({ section: "tbody", tr }));
  }

  const model = {
    tableAttrs: extractAttrs(table),
    rows: rowEntries.length,
    cols: 0,
    rowSections: rowEntries.map((r) => r.section),
    cells: [],
    colWidths: [],
    hasCustomColWidths: false
  };

  const occ = [];
  let cellId = 1;

  function ensureOccRow(r) {
    while (occ.length <= r) occ.push([]);
  }
  function isOccupied(r, c) {
    return occ[r] && occ[r][c] != null;
  }
  function markOccupied(r, c, rowspan, colspan, id) {
    for (let rr = r; rr < r + rowspan; rr++) {
      ensureOccRow(rr);
      for (let cc = c; cc < c + colspan; cc++) {
        occ[rr][cc] = id;
      }
    }
  }
  function nextFreeCol(r, start) {
    let c = start;
    while (isOccupied(r, c)) c++;
    return c;
  }

  for (let r = 0; r < rowEntries.length; r++) {
    ensureOccRow(r);
    const tr = rowEntries[r].tr;
    const children = Array.from(tr.children).filter((x) => x.tagName === "TD" || x.tagName === "TH");
    let c = 0;

    for (const cellEl of children) {
      c = nextFreeCol(r, c);

      const rowspan = parseInt(cellEl.getAttribute("rowspan") || "1", 10);
      const colspan = parseInt(cellEl.getAttribute("colspan") || "1", 10);
      const classes = (cellEl.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
      const tag = cellEl.tagName.toLowerCase();

      model.cells.push({
        id: String(cellId++),
        row: r,
        col: c,
        rowspan: Math.max(1, rowspan),
        colspan: Math.max(1, colspan),
        html: normalizeStoredCellHtml(cellEl.innerHTML),
        classes,
        tag
      });

      markOccupied(r, c, Math.max(1, rowspan), Math.max(1, colspan), model.cells[model.cells.length - 1].id);
      c += Math.max(1, colspan);
    }
  }

  model.cols = Math.max(1, ...model.cells.map((c) => (c.col || 0) + (c.colspan || 1)));
  const explicitWidths = getExplicitColumnWidths(table);
  model.hasCustomColWidths = !!(explicitWidths && explicitWidths.length);
  model.colWidths = explicitWidths && explicitWidths.length ? explicitWidths : extractColumnWidths(table, model.cols);
  normalizeColWidths(model);
  normalizeGrid(model);
  cleanupTable(model);
  normalizeGrid(model);
  return model;
}

/** Render model back to HTML */
function renderHtmlTable(model) {
  const defaultTableClass = model.defaultTableClass || DEFAULT_SETTINGS.defaultTableClass;
  model.tableAttrs = ensureClassOnAttrs(model.tableAttrs, defaultTableClass);
  normalizeColWidths(model);
  normalizeGrid(model);
  cleanupTable(model);
  normalizeGrid(model);

  const occ = buildOcc(model);
  const cellById = new Map(model.cells.map((c) => [c.id, c]));

  function renderRow(r) {
    let html = "<tr>";
    for (let c = 0; c < model.cols; c++) {
      const id = occ[r][c];
      if (!id) continue;
      const cell = cellById.get(id);
      if (!cell) continue;
      if (cell.row !== r || cell.col !== c) continue;

      const tag = cell.tag || "td";
      const cls = cell.classes && cell.classes.length ? ` class="${escapeAttr(cell.classes.join(" "))}"` : "";
      const rs = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
      const cs = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
      html += `<${tag}${cls}${rs}${cs}>${normalizeStoredCellHtml(cell.html || "")}</${tag}>`;
    }
    html += "</tr>";
    return html;
  }

  const groups = [];
  for (let r = 0; r < model.rows; r++) {
    const sec = model.rowSections[r] || "tbody";
    const prev = groups.length ? groups[groups.length - 1] : null;
    if (!prev || prev.section !== sec) groups.push({ section: sec, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }

  let out = `<table${attrsToString(model.tableAttrs)}>`;
  if (model.hasCustomColWidths && Array.isArray(model.colWidths) && model.colWidths.length) {
    out += `<colgroup>`;
    model.colWidths.forEach((width) => {
      out += `<col style="width: ${Number(width.toFixed(4))}%">`;
    });
    out += `</colgroup>`;
  }
  for (const g of groups) {
    out += `<${g.section}>`;
    for (const r of g.rows) out += renderRow(r);
    out += `</${g.section}>`;
  }
  out += "</table>";
  return out;
}

/** Add row with section, and extend crossing cells */
function addRowAt(model, index, section) {
  index = clamp(index, 0, model.rows);
  model.rows += 1;
  model.rowSections.splice(index, 0, section || "tbody");

  for (const cell of model.cells) {
    if (cell.row >= index) {
      cell.row += 1;
      continue;
    }
    if (cell.row < index && cell.row + cell.rowspan > index) {
      cell.rowspan += 1;
    }
  }
  normalizeGrid(model);
}

/** Add col and extend crossing cells */
function addColAt(model, index) {
  index = clamp(index, 0, model.cols);
  model.cols += 1;
  insertColumnWidth(model, index);

  for (const cell of model.cells) {
    if (cell.col >= index) {
      cell.col += 1;
      continue;
    }
    if (cell.col < index && cell.col + cell.colspan > index) {
      cell.colspan += 1;
    }
  }
  normalizeGrid(model);
}

/**
 * Insert row for split inside SAME SECTION and extend touching cells in that section
 */
function insertRowForSplit(model, insertAt, section) {
  insertAt = clamp(insertAt, 0, model.rows);
  model.rows += 1;
  model.rowSections.splice(insertAt, 0, section);

  for (const cell of model.cells) {
    if (cell.row >= insertAt) {
      cell.row += 1;
      continue;
    }

    const cellSection = model.rowSections[cell.row] || "tbody";

    if (cellSection === section && cell.row + cell.rowspan === insertAt) {
      cell.rowspan += 1;
    }
    if (cell.row < insertAt && cell.row + cell.rowspan > insertAt) {
      cell.rowspan += 1;
    }
  }

  normalizeGrid(model);
}

function splitCellHorizontal(model, cellId) {
  normalizeGrid(model);
  const cell = model.cells.find((c) => c.id === cellId);
  if (!cell) return { ok: false, reason: "Cellule introuvable." };

  const section = model.rowSections[cell.row] || "tbody";

  if (cell.rowspan > 1) {
    const total = cell.rowspan;
    const top = Math.floor(total / 2);
    const bottom = total - top;

    cell.rowspan = top;

    model.cells.push({
      id: nextId(model),
      row: cell.row + top,
      col: cell.col,
      rowspan: bottom,
      colspan: cell.colspan,
      html: "",
      classes: Array.isArray(cell.classes) ? [...cell.classes] : [],
      tag: cell.tag || "td"
    });

    normalizeGrid(model);
    cleanupTable(model);
    normalizeGrid(model);
    return { ok: true };
  }

  const insertAt = cell.row + 1;
  insertRowForSplit(model, insertAt, section);

  const below = model.cells.find((c) => c.row === insertAt && c.col === cell.col && c.rowspan === 1 && c.colspan === 1);
  if (below) {
    below.tag = cell.tag || below.tag;
    below.classes = Array.isArray(cell.classes) ? [...cell.classes] : [];
    below.html = "";
  }

  cleanupTable(model);
  normalizeGrid(model);
  return { ok: true };
}

function splitCellVertical(model, cellId) {
  normalizeGrid(model);
  const cell = model.cells.find((c) => c.id === cellId);
  if (!cell) return { ok: false, reason: "Cellule introuvable." };

  if (cell.colspan > 1) {
    const total = cell.colspan;
    const left = Math.floor(total / 2);
    const right = total - left;

    cell.colspan = left;

    model.cells.push({
      id: nextId(model),
      row: cell.row,
      col: cell.col + left,
      rowspan: cell.rowspan,
      colspan: right,
      html: "",
      classes: Array.isArray(cell.classes) ? [...cell.classes] : [],
      tag: cell.tag || "td"
    });

    normalizeGrid(model);
    cleanupTable(model);
    normalizeGrid(model);
    return { ok: true };
  }

  const insertAt = cell.col + 1;
  const spanRowStart = cell.row;
  const spanRowEnd = cell.row + cell.rowspan - 1;

  addColAt(model, insertAt);
  normalizeGrid(model);

  let occ = buildOcc(model);
  let byId = new Map(model.cells.map((c) => [c.id, c]));
  const toRemove = new Set();

  function getPlaceholderIdAtRow(r) {
    const id = occ[r]?.[insertAt];
    if (!id) return null;
    const c = byId.get(id);
    if (!c) return null;

    const isAnchor = c.row === r && c.col === insertAt;
    const is1x1 = c.rowspan === 1 && c.colspan === 1;
    const isEmpty = (c.html || "") === "";
    const noClass = !c.classes || c.classes.length === 0;

    return isAnchor && is1x1 && isEmpty && noClass ? id : null;
  }

  for (let r = 0; r < model.rows; r++) {
    const covered = r >= spanRowStart && r <= spanRowEnd;
    const placeholderId = getPlaceholderIdAtRow(r);

    if (covered) {
      if (placeholderId) toRemove.add(placeholderId);
      continue;
    }

    const leftId = occ[r]?.[insertAt - 1];
    if (!leftId) continue;

    const leftCell = byId.get(leftId);
    if (!leftCell) continue;

    const end = leftCell.col + leftCell.colspan;
    if (end === insertAt) {
      leftCell.colspan += 1;
      if (placeholderId) toRemove.add(placeholderId);
    }
  }

  if (toRemove.size) {
    model.cells = model.cells.filter((c) => !toRemove.has(c.id));
  }

  model.cells.push({
    id: nextId(model),
    row: cell.row,
    col: insertAt,
    rowspan: cell.rowspan,
    colspan: 1,
    html: "",
    classes: Array.isArray(cell.classes) ? [...cell.classes] : [],
    tag: cell.tag || "td"
  });

  normalizeGrid(model);
  cleanupTable(model);
  normalizeGrid(model);
  return { ok: true };
}

function mergeSelection(model, sel) {
  normalizeGrid(model);

  const r0 = Math.min(sel.r0, sel.r1);
  const r1 = Math.max(sel.r0, sel.r1);
  const c0 = Math.min(sel.c0, sel.c1);
  const c1 = Math.max(sel.c0, sel.c1);

  const occ = buildOcc(model);
  const ids = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const id = occ[r]?.[c];
      if (!id) return { ok: false, reason: "Sélection contient un trou." };
      ids.push(id);
    }
  }
  const uniqueIds = uniq(ids);

  const cellById = new Map(model.cells.map((c) => [c.id, c]));
  for (const id of uniqueIds) {
    const cell = cellById.get(id);
    if (!cell) continue;
    const rr0 = cell.row;
    const rr1 = cell.row + cell.rowspan - 1;
    const cc0 = cell.col;
    const cc1 = cell.col + cell.colspan - 1;
    if (rr0 < r0 || rr1 > r1 || cc0 < c0 || cc1 > c1) {
      return { ok: false, reason: "Sélection coupe une cellule fusionnée." };
    }
  }

  const mergedHtml = mergeCellHtmlBlocks(uniqueIds.map((id) => cellById.get(id)?.html || ""));

  const mergedClasses = uniq(uniqueIds.flatMap((id) => (cellById.get(id)?.classes || [])));
  const keepTag = cellById.get(uniqueIds[0])?.tag || "td";

  model.cells = model.cells.filter((c) => !uniqueIds.includes(c.id));

  model.cells.push({
    id: nextId(model),
    row: r0,
    col: c0,
    rowspan: r1 - r0 + 1,
    colspan: c1 - c0 + 1,
    html: mergedHtml,
    classes: mergedClasses,
    tag: keepTag
  });

  normalizeGrid(model);
  cleanupTable(model);
  normalizeGrid(model);
  return { ok: true };
}

function toggleClassOnCell(model, cellId, className) {
  const cell = model.cells.find((c) => c.id === cellId);
  if (!cell) return;
  const cls = (className || "").trim();
  if (!cls) return;

  const list = cell.classes || [];
  if (list.includes(cls)) cell.classes = list.filter((x) => x !== cls);
  else cell.classes = uniq([...list, cls]);
}

function removeClassFromCell(model, cellId, className) {
  const cell = model.cells.find((c) => c.id === cellId);
  if (!cell) return;
  const cls = (className || "").trim();
  if (!cls) return;
  cell.classes = (cell.classes || []).filter((x) => x !== cls);
}

function applyClassToRow(model, row, className) {
  normalizeGrid(model);
  const occ = buildOcc(model);
  const ids = uniq((occ[row] || []).filter(Boolean));
  const cls = (className || "").trim();
  if (!cls) return;

  ids.forEach((id) => toggleClassOnCell(model, id, cls));
}

function applyClassToCol(model, col, className) {
  normalizeGrid(model);
  const occ = buildOcc(model);
  const ids = uniq(occ.map((r) => r[col]).filter(Boolean));
  const cls = (className || "").trim();
  if (!cls) return;

  ids.forEach((id) => toggleClassOnCell(model, id, cls));
}

function setClassOnCell(model, cellId, className, enabled) {
  const cell = model.cells.find((c) => c.id === cellId);
  if (!cell) return;
  const cls = (className || "").trim();
  if (!cls) return;

  const list = cell.classes || [];
  if (enabled) {
    cell.classes = list.includes(cls) ? list.slice() : uniq([...list, cls]);
  } else {
    cell.classes = list.filter((x) => x !== cls);
  }
}

function toggleClassOnCells(model, cellIds, className) {
  const ids = uniq((cellIds || []).filter(Boolean));
  const cls = (className || "").trim();
  if (!ids.length || !cls) return;

  const everyHasClass = ids.every((id) => {
    const cell = model.cells.find((c) => c.id === id);
    return !!cell && (cell.classes || []).includes(cls);
  });

  ids.forEach((id) => setClassOnCell(model, id, cls, !everyHasClass));
}

function removeClassFromCells(model, cellIds, className) {
  uniq((cellIds || []).filter(Boolean)).forEach((id) => removeClassFromCell(model, id, className));
}

function setExclusivePresetClassOnCells(model, cellIds, className, presetClasses) {
  const ids = uniq((cellIds || []).filter(Boolean));
  const cls = (className || "").trim();
  const presetSet = new Set((presetClasses || []).map((x) => (x || "").trim()).filter(Boolean));
  if (!ids.length || !presetSet.size) return;

  ids.forEach((id) => {
    const cell = model.cells.find((c) => c.id === id);
    if (!cell) return;
    const current = Array.isArray(cell.classes) ? cell.classes : [];
    const kept = current.filter((item) => !presetSet.has(item));
    cell.classes = cls ? uniq([...kept, cls]) : kept;
  });
}

function detectUniformPresetClass(cells, presetClasses) {
  const presetSet = new Set((presetClasses || []).map((x) => (x || "").trim()).filter(Boolean));
  if (!cells?.length || !presetSet.size) return "";

  let uniform = null;
  let sawNone = false;
  for (const cell of cells) {
    const matches = uniq((cell?.classes || []).filter((cls) => presetSet.has(cls)));
    if (matches.length > 1) return "";
    if (!matches.length) {
      sawNone = true;
      if (uniform != null) return "";
      continue;
    }
    if (sawNone) return "";
    if (uniform == null) uniform = matches[0];
    else if (uniform !== matches[0]) return "";
  }
  if (uniform) return uniform;
  return sawNone ? "__none__" : "";
}

/** Create a minimal empty HTML table */
function makeEmptyHtmlTable({ cols = 3, headRows = 1, bodyRows = 2, footRows = 0, tableClass = DEFAULT_SETTINGS.defaultTableClass } = {}) {
  cols = Math.max(1, parseInt(cols, 10) || 1);
  headRows = Math.max(0, parseInt(headRows, 10) || 0);
  bodyRows = Math.max(0, parseInt(bodyRows, 10) || 0);
  footRows = Math.max(0, parseInt(footRows, 10) || 0);

  const mkRow = (tag) => `<tr>${Array.from({ length: cols }, () => `<${tag}></${tag}>`).join("")}</tr>`;

  const classAttr = joinClassNames(splitClassNames(tableClass).length ? splitClassNames(tableClass) : [DEFAULT_SETTINGS.defaultTableClass]);

  let out = `<table class="${escapeAttr(classAttr)}">`;
  if (headRows > 0) out += `<thead>${Array.from({ length: headRows }, () => mkRow("th")).join("")}</thead>`;
  if (bodyRows > 0) out += `<tbody>${Array.from({ length: bodyRows }, () => mkRow("td")).join("")}</tbody>`;
  if (footRows > 0) out += `<tfoot>${Array.from({ length: footRows }, () => mkRow("td")).join("")}</tfoot>`;
  out += `</table>`;
  return out;
}

/** Find all <table>...</table> blocks in a string, return [{start,end,html}] */
function findAllTablesInText(text) {
  const re = /<table[\s\S]*?<\/table>/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const html = m[0];
    const start = m.index;
    const end = start + html.length;
    out.push({ start, end, html });
  }
  return out;
}

/** Find the table closest to an approximate document offset */
function findTableRangeAtApproxOffset(text, approxOffset) {
  const safeOffset = clamp(parseInt(approxOffset, 10) || 0, 0, Math.max(0, text.length));
  const tables = findAllTablesInText(text);
  if (!tables.length) return null;

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const table of tables) {
    let distance = 0;
    if (safeOffset < table.start) distance = table.start - safeOffset;
    else if (safeOffset > table.end) distance = safeOffset - table.end;
    else distance = 0;

    if (
      distance < bestDistance ||
      (distance === bestDistance && best && Math.abs(table.start - safeOffset) < Math.abs(best.start - safeOffset))
    ) {
      best = table;
      bestDistance = distance;
    }
  }

  return best;
}

/** CM6 editor adapter: expose only the operations the modal needs */
function makeCmEditorAdapter(cmView) {
  return {
    getValue() {
      return cmView.state.doc.toString();
    },
    replaceRangeByOffsets(start, end, insert) {
      const scrollDOM = cmView.scrollDOM || null;
      const scrollTop = scrollDOM ? scrollDOM.scrollTop : null;
      const scrollLeft = scrollDOM ? scrollDOM.scrollLeft : null;
      const anchor = Math.max(0, start + String(insert || "").length);

      cmView.dispatch({
        changes: { from: start, to: end, insert },
        selection: { anchor }
      });

      if (scrollDOM && scrollTop != null) {
        requestAnimationFrame(() => {
          scrollDOM.scrollTop = scrollTop;
          scrollDOM.scrollLeft = scrollLeft || 0;
        });
      }
    },
    setValue(val) {
      const docLen = cmView.state.doc.length;
      cmView.dispatch({
        changes: { from: 0, to: docLen, insert: val },
        selection: { anchor: Math.min(docLen, String(val || "").length) }
      });
    }
  };
}

function makeFileEditorAdapter(app, file, initialText = "") {
  let text = String(initialText || "");
  return {
    file,
    getValue() {
      return text;
    },
    async replaceRangeByOffsets(start, end, insert) {
      text = text.slice(0, start) + String(insert || "") + text.slice(end);
      await app.vault.modify(file, text);
    },
    async setValue(val) {
      text = String(val || "");
      await app.vault.modify(file, text);
    }
  };
}

async function replaceEditorRange(editor, start, end, insert) {
  if (editor && typeof editor.replaceRangeByOffsets === "function") {
    return await editor.replaceRangeByOffsets(start, end, insert);
  }

  if (editor && typeof editor.replaceRange === "function" && typeof editor.offsetToPos === "function") {
    const from = editor.offsetToPos(start);
    const to = editor.offsetToPos(end);
    editor.replaceRange(insert, from, to);

    if (typeof editor.setCursor === "function") {
      const cursorPos = editor.offsetToPos(start + String(insert || "").length);
      editor.setCursor(cursorPos);
    }
    return;
  }

  const fullText = editor.getValue();
  return await editor.setValue(fullText.slice(0, start) + insert + fullText.slice(end));
}

/** Try to load CM6 modules (Obsidian bundles them, but require can fail in some builds) */
function tryLoadCm6() {
  try {
    const view = require("@codemirror/view");
    const state = require("@codemirror/state");
    return { ...view, ...state };
  } catch (e) {
    return null;
  }
}

class HtmlTableWysiwygSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "HTML Table WYSIWYG" });

    new Setting(containerEl)
      .setName("Classe de table par défaut")
      .setDesc("Ajoutée automatiquement sur les tables HTML créées ou réenregistrées.")
      .addText((text) => {
        text
          .setPlaceholder("def-table")
          .setValue(this.plugin.settings.defaultTableClass)
          .onChange(async (value) => {
            this.plugin.settings.defaultTableClass = value.trim() || DEFAULT_SETTINGS.defaultTableClass;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Class presets")
      .setDesc("Liste de classes (séparées par des virgules) proposées dans l’éditeur.")
      .addText((text) => {
        text
          .setPlaceholder("bg-bloc,bg-bloc-centered,text-center,font-bold")
          .setValue(this.plugin.settings.classPresets)
          .onChange(async (value) => {
            this.plugin.settings.classPresets = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

class NewTableModal extends Modal {
  constructor(app, plugin, editor) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;

    this.cols = 3;
    this.headRows = 1;
    this.bodyRows = 2;
    this.footRows = 0;

    this._previewTimer = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("htw-modal", "htw-modal-new");

    contentEl.createEl("h2", { text: "Créer une table HTML" });

    const schedulePreview = () => {
      if (this._previewTimer) window.clearTimeout(this._previewTimer);
      this._previewTimer = window.setTimeout(() => this.renderPreview(), 60);
    };

    const parseIntSafe = (v, fallback) => {
      const n = parseInt(String(v ?? "").trim(), 10);
      return Number.isFinite(n) ? n : fallback;
    };

    new Setting(contentEl)
      .setName("Colonnes")
      .addText((t) =>
        t.setValue(String(this.cols)).onChange((v) => {
          this.cols = parseIntSafe(v, this.cols);
          schedulePreview();
        })
      );

    new Setting(contentEl)
      .setName("Lignes (thead)")
      .setDesc("0 = pas de header")
      .addText((t) =>
        t.setValue(String(this.headRows)).onChange((v) => {
          this.headRows = parseIntSafe(v, this.headRows);
          schedulePreview();
        })
      );

    new Setting(contentEl)
      .setName("Lignes (tbody)")
      .addText((t) =>
        t.setValue(String(this.bodyRows)).onChange((v) => {
          this.bodyRows = parseIntSafe(v, this.bodyRows);
          schedulePreview();
        })
      );

    new Setting(contentEl)
      .setName("Lignes (tfoot)")
      .setDesc("optionnel")
      .addText((t) =>
        t.setValue(String(this.footRows)).onChange((v) => {
          this.footRows = parseIntSafe(v, this.footRows);
          schedulePreview();
        })
      );

    // Preview visuel (pas de preview code)
    this.previewWrap = contentEl.createDiv({ cls: "htw-new-preview" });
    this.previewWrap.createEl("h3", { text: "Aperçu" });
    this.previewTableHost = this.previewWrap.createDiv();

    const btnRow = contentEl.createDiv({ cls: "htw-toolbar" });
    btnRow.createEl("button", { text: "Créer et éditer" }).onclick = () => this.createAndOpenEditor();

    this.renderPreview();
  }

  renderPreview() {
    if (!this.previewTableHost) return;

    const html = makeEmptyHtmlTable({
      cols: this.cols,
      headRows: this.headRows,
      bodyRows: this.bodyRows,
      footRows: this.footRows,
      tableClass: this.plugin.settings.defaultTableClass
    });

    this.previewTableHost.empty();
    this.previewTableHost.innerHTML = html;

    // Appliquer le style THEAD dans l’aperçu (classe htw-head-row)
    const thead = this.previewTableHost.querySelector("thead");
    if (thead) {
      thead.querySelectorAll("tr").forEach((tr) => tr.classList.add("htw-head-row"));
    }
  }

  createAndOpenEditor() {
    const html = makeEmptyHtmlTable({
      cols: this.cols,
      headRows: this.headRows,
      bodyRows: this.bodyRows,
      footRows: this.footRows,
      tableClass: this.plugin.settings.defaultTableClass
    });

    const cursor = this.editor.getCursor();
    const insertOffset = this.editor.posToOffset(cursor);

    const toInsert = `\n${html}\n`;
    this.editor.replaceRange(toInsert, cursor);

    // Range exacte du tableau inséré
    const tableStart = insertOffset + toInsert.indexOf("<table");
    const tableEnd = tableStart + html.length;

    const fullText = this.editor.getValue();
    const slice = fullText.slice(tableStart, tableEnd);

    const range =
      slice.startsWith("<table") && slice.endsWith("</table>")
        ? { start: tableStart, end: tableEnd, html: slice }
        : findTableRange(fullText, tableStart + 1);

    if (!range) {
      new Notice("Table insérée, mais impossible de la détecter pour l’ouvrir.");
      this.close();
      return;
    }

    const modal = new TableEditorModal(this.app, this.plugin, this.editor, range);
    this.close();
    modal.open();
  }

  onClose() {
    if (this._previewTimer) window.clearTimeout(this._previewTimer);
    this._previewTimer = null;
    this.contentEl.empty();
  }
}

class TableEditorModal extends Modal {
  constructor(app, plugin, editor, tableRange) {
    super(app);
    this.plugin = plugin;
    this.editor = editor; // can be Obsidian editor OR CM adapter
    this.tableRange = tableRange;

    this.model = parseHtmlTable(tableRange.html);
    this.model.defaultTableClass = this.plugin.settings.defaultTableClass || DEFAULT_SETTINGS.defaultTableClass;
    this.model.tableAttrs = ensureClassOnAttrs(this.model.tableAttrs, this.model.defaultTableClass);

    this.selected = null;
    this.selectedCellIds = null;
    this.activeCellId = null;
    this.cellElById = new Map();

    this.isDragging = false;
    this.dragAnchor = null;

    this._mouseUpHandler = null;

    // UI
    this.classSelectEl = null;
    this.classPresetList = [];
    this.activeEditorEl = null;
    this.currentGridTable = null;
    this.currentResizeOverlay = null;
    this._colResizeState = null;
    this._colResizeMoveHandler = null;
    this._colResizeUpHandler = null;
    this._allowClose = false;
    this._modalCloseButtonEl = null;
    this._modalCloseButtonHandler = null;
  }

  bindCloseButtonAsCancel() {
    const closeBtn = this.modalEl?.querySelector?.(".modal-close-button");
    if (!closeBtn || this._modalCloseButtonEl === closeBtn) return;

    if (this._modalCloseButtonEl && this._modalCloseButtonHandler) {
      this._modalCloseButtonEl.removeEventListener("click", this._modalCloseButtonHandler, true);
    }

    this._modalCloseButtonEl = closeBtn;
    this._modalCloseButtonHandler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.requestClose();
    };
    closeBtn.addEventListener("click", this._modalCloseButtonHandler, true);
  }

  requestClose() {
    clearTextSelection();
    this._allowClose = true;
    return super.close();
  }

  close() {
    if (!this._allowClose) return;
    return super.close();
  }

  clearExplicitSelectionIds() {
    this.selectedCellIds = null;
  }

  getSelectedCellIds() {
    const explicit = uniq((this.selectedCellIds || []).filter((id) => this.model.cells.some((cell) => cell.id === id)));
    if (explicit.length) return explicit;
    if (!this.selected) return this.activeCellId ? [this.activeCellId] : [];

    normalizeGrid(this.model);
    const occ = buildOcc(this.model);
    const r0 = Math.min(this.selected.r0, this.selected.r1);
    const r1 = Math.max(this.selected.r0, this.selected.r1);
    const c0 = Math.min(this.selected.c0, this.selected.c1);
    const c1 = Math.max(this.selected.c0, this.selected.c1);
    const ids = [];
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const id = occ[r]?.[c];
        if (id) ids.push(id);
      }
    }
    return uniq(ids);
  }

  selectCellsByIds(cellIds, rect = null, activeCellId = null) {
    const ids = uniq((cellIds || []).filter(Boolean));
    this.selectedCellIds = ids.length ? ids : null;
    this.selected = rect || null;
    if (activeCellId && ids.includes(activeCellId)) this.activeCellId = activeCellId;
    else if (ids.length) this.activeCellId = ids[0];
    else this.activeCellId = null;
    this.updateHighlights();
    this.syncClassSelectState();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("htw-modal", "htw-modal-editor");
    this.bindCloseButtonAsCancel();

    const toolbar = contentEl.createDiv({ cls: "htw-toolbar" });
    const bodyEl = contentEl.createDiv({ cls: "htw-modal-body" });
    const makeGroup = (title = "", extraCls = "") => {
      const group = toolbar.createDiv({ cls: ["htw-toolbar-group", extraCls].filter(Boolean).join(" ") });
      if (title) group.createDiv({ cls: "htw-toolbar-group-title", text: title });
      const body = group.createDiv({ cls: "htw-toolbar-group-body" });
      return { group, body };
    };
    const addButtonIcon = (btn, iconName) => {
      if (!iconName) return null;
      const iconWrap = btn.createSpan({ cls: "htw-toolbar-icon" });
      try {
        setIcon(iconWrap, iconName);
      } catch (_) {
        iconWrap.empty();
      }
      return iconWrap;
    };
    const makeToolbarButton = (parent, text, onClick, opts = {}) => {
      const btn = parent.createEl("button", {
        cls: [
          "htw-toolbar-btn",
          opts.compact ? "htw-toolbar-btn-compact" : "",
          opts.iconOnly ? "htw-toolbar-btn-icon-only" : "",
          opts.cls || ""
        ].filter(Boolean).join(" ")
      });
      if (opts.title) btn.setAttr("title", opts.title);
      if (opts.ariaLabel) btn.setAttr("aria-label", opts.ariaLabel);
      if (opts.keepSelection) {
        btn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
        });
      }
      addButtonIcon(btn, opts.icon);
      if (text) btn.createSpan({ cls: "htw-toolbar-btn-label", text });
      btn.onclick = onClick;
      return btn;
    };

    const formatGroup = makeGroup("Texte", "htw-toolbar-group-format");
    makeToolbarButton(formatGroup.body, "Gras", () => this.applyInlineFormat("bold"), {
      keepSelection: true,
      icon: "bold",
      compact: true,
      cls: "htw-format-btn htw-format-btn-bold",
      title: "Mettre la sélection en gras",
      ariaLabel: "Mettre la sélection en gras"
    });

    makeToolbarButton(formatGroup.body, "Italique", () => this.applyInlineFormat("italic"), {
      keepSelection: true,
      icon: "italic",
      compact: true,
      cls: "htw-format-btn htw-format-btn-italic",
      title: "Mettre la sélection en italique",
      ariaLabel: "Mettre la sélection en italique"
    });

    const rowsGroup = makeGroup("Lignes", "htw-toolbar-group-rows");
    const colsGroup = makeGroup("Cols", "htw-toolbar-group-cols");
    const structureGroup = makeGroup("Cellules", "htw-toolbar-group-structure");

    const getReferenceRowStart = () => {
      if (this.selected) return clamp(Math.min(this.selected.r0, this.selected.r1), 0, this.model.rows - 1);
      const activeCell = this.model.cells.find((c) => c.id === this.activeCellId);
      return activeCell ? clamp(activeCell.row, 0, this.model.rows - 1) : null;
    };

    const getReferenceRowEnd = () => {
      if (this.selected) return clamp(Math.max(this.selected.r0, this.selected.r1), 0, this.model.rows - 1);
      const activeCell = this.model.cells.find((c) => c.id === this.activeCellId);
      return activeCell ? clamp(activeCell.row + Math.max(1, activeCell.rowspan || 1) - 1, 0, this.model.rows - 1) : null;
    };

    const getReferenceColStart = () => {
      if (this.selected) return clamp(Math.min(this.selected.c0, this.selected.c1), 0, this.model.cols - 1);
      const activeCell = this.model.cells.find((c) => c.id === this.activeCellId);
      return activeCell ? clamp(activeCell.col, 0, this.model.cols - 1) : null;
    };

    const getReferenceColEnd = () => {
      if (this.selected) return clamp(Math.max(this.selected.c0, this.selected.c1), 0, this.model.cols - 1);
      const activeCell = this.model.cells.find((c) => c.id === this.activeCellId);
      return activeCell ? clamp(activeCell.col + Math.max(1, activeCell.colspan || 1) - 1, 0, this.model.cols - 1) : null;
    };

    const getRowSectionForInsert = (index) => {
      if (!this.model.rows) return "tbody";
      const prevSection = index > 0 ? this.model.rowSections[index - 1] : null;
      const nextSection = index < this.model.rowSections.length ? this.model.rowSections[index] : null;
      return prevSection || nextSection || "tbody";
    };

    makeToolbarButton(rowsGroup.body, "Haut", () => {
      normalizeGrid(this.model);
      const refRow = getReferenceRowStart();
      const idx = refRow == null ? this.model.rows : refRow;
      addRowAt(this.model, idx, getRowSectionForInsert(idx));
      this.renderGrid();
    }, { compact: true, icon: "arrow-up", title: "Ajouter une ligne au-dessus" });

    makeToolbarButton(rowsGroup.body, "Bas", () => {
      normalizeGrid(this.model);
      const refRow = getReferenceRowEnd();
      const idx = refRow == null ? this.model.rows : refRow + 1;
      addRowAt(this.model, idx, getRowSectionForInsert(idx));
      this.renderGrid();
    }, { compact: true, icon: "arrow-down", title: "Ajouter une ligne en dessous" });

    makeToolbarButton(rowsGroup.body, "Suppr.", () => {
      const refRow = getReferenceRowStart();
      const r = refRow == null ? this.model.rows - 1 : refRow;
      deleteRow(this.model, r);
      this.selected = null;
      this.clearExplicitSelectionIds();
      this.activeCellId = null;
      this.renderGrid();
    }, { compact: true, icon: "minus", title: "Supprimer la ligne sélectionnée" });

    makeToolbarButton(colsGroup.body, "Gauche", () => {
      normalizeGrid(this.model);
      const refCol = getReferenceColStart();
      const idx = refCol == null ? this.model.cols : refCol;
      addColAt(this.model, idx);
      this.renderGrid();
    }, { compact: true, icon: "arrow-left", title: "Ajouter une colonne à gauche" });

    makeToolbarButton(colsGroup.body, "Droite", () => {
      normalizeGrid(this.model);
      const refCol = getReferenceColEnd();
      const idx = refCol == null ? this.model.cols : refCol + 1;
      addColAt(this.model, idx);
      this.renderGrid();
    }, { compact: true, icon: "arrow-right", title: "Ajouter une colonne à droite" });

    makeToolbarButton(colsGroup.body, "Suppr.", () => {
      const refCol = getReferenceColStart();
      const c = refCol == null ? this.model.cols - 1 : refCol;
      deleteCol(this.model, c);
      this.selected = null;
      this.clearExplicitSelectionIds();
      this.activeCellId = null;
      this.renderGrid();
    }, { compact: true, icon: "minus", title: "Supprimer la colonne sélectionnée" });

    makeToolbarButton(structureGroup.body, "Fusion", () => {
      if (!this.selected) return new Notice("Sélectionne une zone (clic-glissé) puis fusionner.");
      const res = mergeSelection(this.model, this.selected);
      if (!res.ok) new Notice(res.reason || "Fusion impossible.");
      this.renderGrid();
    }, { compact: true, icon: "combine", title: "Fusionner la sélection" });

    const btnSplitV = makeToolbarButton(structureGroup.body, "Scind. H", () => {
      if (!this.activeCellId) return new Notice("Clique dans une cellule d’abord.");
      const res = splitCellVertical(this.model, this.activeCellId);
      if (!res.ok) new Notice(res.reason);
      this.renderGrid();
    }, { compact: true, icon: "split-square-vertical", title: "Divise en deux cellules gauche/droite" });
    const btnSplitH = makeToolbarButton(structureGroup.body, "Scind. V", () => {
      if (!this.activeCellId) return new Notice("Clique dans une cellule d’abord.");
      const res = splitCellHorizontal(this.model, this.activeCellId);
      if (!res.ok) new Notice(res.reason);
      this.renderGrid();
    }, { compact: true, icon: "split-square-horizontal", title: "Divise en deux cellules haut/bas" });

    const selectionGroup = makeGroup("Sélection", "htw-toolbar-group-selection");
    makeToolbarButton(selectionGroup.body, "Ligne", () => {
      const activeCell = this.activeCellId ? this.model.cells.find((c) => c.id === this.activeCellId) : null;
      if (!activeCell) return new Notice("Clique dans une cellule d’abord.");
      normalizeGrid(this.model);
      const occ = buildOcc(this.model);
      const rowStart = clamp(activeCell.row, 0, this.model.rows - 1);
      const rowEnd = clamp(activeCell.row + Math.max(1, activeCell.rowspan || 1) - 1, 0, this.model.rows - 1);
      const ids = [];
      for (let r = rowStart; r <= rowEnd; r += 1) {
        ids.push(...((occ[r] || []).filter(Boolean)));
      }
      this.selectCellsByIds(ids, { r0: rowStart, c0: 0, r1: rowEnd, c1: Math.max(0, this.model.cols - 1) }, activeCell.id);
    }, { compact: true, icon: "rows-3", title: "Sélectionner la ligne courante" });

    makeToolbarButton(selectionGroup.body, "Colonne", () => {
      const activeCell = this.activeCellId ? this.model.cells.find((c) => c.id === this.activeCellId) : null;
      if (!activeCell) return new Notice("Clique dans une cellule d’abord.");
      normalizeGrid(this.model);
      const occ = buildOcc(this.model);
      const colStart = clamp(activeCell.col, 0, this.model.cols - 1);
      const colEnd = clamp(activeCell.col + Math.max(1, activeCell.colspan || 1) - 1, 0, this.model.cols - 1);
      const ids = [];
      for (const row of occ) {
        for (let c = colStart; c <= colEnd; c += 1) {
          const id = row?.[c];
          if (id) ids.push(id);
        }
      }
      this.selectCellsByIds(ids, { r0: 0, c0: colStart, r1: Math.max(0, this.model.rows - 1), c1: colEnd }, activeCell.id);
    }, { compact: true, icon: "columns-3", title: "Sélectionner la colonne courante" });

    const classesGroup = makeGroup("Classes", "htw-toolbar-group-classes");
    const presets = (this.plugin.settings.classPresets || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.classPresetList = presets.slice();

    const classSelect = classesGroup.body.createEl("select", { cls: "htw-toolbar-select htw-toolbar-select-boxed" });
    this.classSelectEl = classSelect;
    const blankOpt = classSelect.createEl("option");
    blankOpt.value = "";
    blankOpt.text = "";
    blankOpt.hidden = true;
    presets.forEach((p) => {
      const opt = classSelect.createEl("option", { text: p });
      opt.value = p;
    });
    if (presets.length) {
      const separator = classSelect.createEl("option", { text: "────────" });
      separator.value = "__sep__";
      separator.disabled = true;
    }
    classSelect.createEl("option", { text: "Aucune" }).value = "__none__";
    classSelect.addEventListener("change", () => {
      const value = classSelect.value;
      if (!value || value === "__sep__") return;
      const ids = this.getSelectedCellIds();
      if (!ids.length) {
        classSelect.value = "";
        return new Notice("Clique une cellule d’abord.");
      }
      const cls = value === "__none__" ? "" : value;
      setExclusivePresetClassOnCells(this.model, ids, cls, this.classPresetList);
      this.renderGrid();
    });

    const actionsGroup = makeGroup("", "htw-toolbar-group-actions");
    makeToolbarButton(actionsGroup.body, "Appliquer", () => this.applyChanges(), { cls: "mod-cta htw-apply-btn", icon: "check", compact: true });

    this.gridWrap = bodyEl.createDiv({ cls: "htw-grid-wrap" });
    this.renderGrid();
  }

  getActiveEditable() {
    const sel = window.getSelection?.();
    if (sel && sel.rangeCount) {
      const candidate = findClosestWithin(sel.getRangeAt(0).startContainer, ".htw-cell", this.contentEl);
      if (candidate) return candidate;
    }

    if (this.activeEditorEl && this.contentEl.contains(this.activeEditorEl)) return this.activeEditorEl;

    const ae = document.activeElement;
    if (ae instanceof HTMLElement) {
      const candidate = ae.closest(".htw-cell");
      if (candidate && this.contentEl.contains(candidate)) return candidate;
    }

    return null;
  }

  syncCellHtmlFromEditable(editable) {
    if (!editable) return;
    const cellId = editable.dataset.cellId || this.activeCellId;
    if (!cellId) return;
    const cell = this.model.cells.find((c) => c.id === cellId);
    if (!cell) return;
    cell.html = extractEditableCellHtml(editable);
  }

  applyInlineFormat(command) {
    const editable = this.getActiveEditable();
    if (!editable) return new Notice("Clique dans une cellule puis sélectionne du texte.");

    editable.focus();

    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !selectionIsInside(editable)) {
      return new Notice("Sélectionne du texte dans une cellule.");
    }

    try {
      document.execCommand(command, false, null);
      normalizeEditableRoot(editable);
      this.syncCellHtmlFromEditable(editable);
    } catch (e) {
      console.error(e);
      new Notice("Impossible d’appliquer la mise en forme.");
    }
  }

  scheduleResizeOverlayRefresh() {
    if (this._overlayRefreshRaf) cancelAnimationFrame(this._overlayRefreshRaf);
    this._overlayRefreshRaf = requestAnimationFrame(() => {
      this._overlayRefreshRaf = null;
      this.positionColumnResizeOverlay();
    });
  }

  getRenderedColumnWidths() {
    const table = this.currentGridTable;
    if (!table || !this.model?.cols) return Array.isArray(this.model?.colWidths) ? this.model.colWidths.slice() : [];

    const tableRect = table.getBoundingClientRect();
    const boundaries = Array(this.model.cols - 1).fill(null);

    for (const cell of this.model.cells) {
      const cellEl = this.cellElById.get(cell.id);
      if (!cellEl || !cellEl.isConnected) continue;
      const boundaryIndex = cell.col + cell.colspan - 1;
      if (boundaryIndex < 0 || boundaryIndex >= boundaries.length) continue;
      const rect = cellEl.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      boundaries[boundaryIndex] = rect.right - tableRect.left;
    }

    const widths = [];
    let lastPx = 0;
    const total = tableRect.width || table.offsetWidth || 1;
    for (let i = 0; i < this.model.cols; i++) {
      const boundaryPx = i < boundaries.length && Number.isFinite(boundaries[i]) ? boundaries[i] : ((i + 1) / this.model.cols) * total;
      const segment = Math.max(0, boundaryPx - lastPx);
      widths.push(segment);
      lastPx = boundaryPx;
    }

    const sum = widths.reduce((acc, n) => acc + n, 0) || total || 1;
    return widths.map((n) => (n / sum) * 100);
  }

  syncRenderedColumnWidths() {
    normalizeColWidths(this.model);
    const table = this.currentGridTable;
    if (!table) return;

    let colgroup = table.querySelector(":scope > colgroup");
    if (!this.model.hasCustomColWidths) {
      if (colgroup) colgroup.remove();
      this.positionColumnResizeOverlay();
      return;
    }

    if (!colgroup) {
      colgroup = table.createEl("colgroup");
      table.prepend(colgroup);
    }

    while (colgroup.children.length < this.model.colWidths.length) colgroup.createEl("col");
    while (colgroup.children.length > this.model.colWidths.length) colgroup.lastElementChild?.remove();

    const cols = Array.from(colgroup.querySelectorAll(":scope > col"));
    this.model.colWidths.forEach((width, index) => {
      if (cols[index]) cols[index].style.width = `${Number(width.toFixed(4))}%`;
    });
    this.positionColumnResizeOverlay();
  }

  getColumnResizeSegments(table) {
    const tableRect = table.getBoundingClientRect();
    const segmentsByBoundary = Array.from({ length: Math.max(0, (this.model?.cols || 0) - 1) }, () => []);

    for (const cell of this.model?.cells || []) {
      const cellEl = this.cellElById.get(cell.id);
      if (!cellEl || !cellEl.isConnected) continue;
      const boundaryIndex = cell.col + cell.colspan - 1;
      if (boundaryIndex < 0 || boundaryIndex >= segmentsByBoundary.length) continue;

      const rect = cellEl.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;

      segmentsByBoundary[boundaryIndex].push({
        top: rect.top - tableRect.top,
        bottom: rect.bottom - tableRect.top,
        x: rect.right - tableRect.left,
      });
    }

    return segmentsByBoundary.map((segments) => {
      if (!segments.length) return [];
      segments.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
      const merged = [];
      for (const segment of segments) {
        const prev = merged[merged.length - 1];
        if (!prev || segment.top > prev.bottom + 0.5) {
          merged.push({ ...segment });
          continue;
        }
        prev.bottom = Math.max(prev.bottom, segment.bottom);
        prev.x = Number.isFinite(prev.x) ? prev.x : segment.x;
      }
      return merged;
    });
  }

  positionColumnResizeOverlay() {
    const overlay = this.currentResizeOverlay;
    const table = this.currentGridTable;
    if (!overlay || !table) return;

    overlay.empty();
    overlay.style.left = `${table.offsetLeft}px`;
    overlay.style.top = `${table.offsetTop}px`;
    overlay.style.width = `${table.offsetWidth}px`;
    overlay.style.height = `${table.offsetHeight}px`;

    const widths = this.model.hasCustomColWidths ? (this.model.colWidths || []).slice() : this.getRenderedColumnWidths();
    if (!widths.length) return;

    const segmentsByBoundary = this.getColumnResizeSegments(table);
    let acc = 0;
    for (let index = 0; index < widths.length - 1; index++) {
      acc += widths[index];
      const segments = segmentsByBoundary[index] || [];
      const fallbackLeft = `${acc}%`;

      if (!segments.length) {
        const handle = overlay.createDiv({ cls: "htw-col-resize-handle" });
        handle.style.left = fallbackLeft;
        handle.setAttr("title", `Redimensionner entre colonnes ${index + 1} et ${index + 2}`);
        handle.addEventListener("mousedown", (event) => this.startColumnResize(index, event));
        continue;
      }

      for (const segment of segments) {
        const handle = overlay.createDiv({ cls: "htw-col-resize-handle" });
        handle.style.left = Number.isFinite(segment.x) ? `${segment.x}px` : fallbackLeft;
        handle.style.top = `${Math.max(0, segment.top)}px`;
        handle.style.height = `${Math.max(0, segment.bottom - segment.top)}px`;
        handle.style.bottom = "auto";
        handle.setAttr("title", `Redimensionner entre colonnes ${index + 1} et ${index + 2}`);
        handle.addEventListener("mousedown", (event) => this.startColumnResize(index, event));
      }
    }
  }

  startColumnResize(index, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const active = this.getActiveEditable();
    if (active) {
      this.syncCellHtmlFromEditable(active);
      active.blur();
    }

    const table = this.currentGridTable;
    if (!table) return;

    const baseWidths = this.model.hasCustomColWidths ? (this.model.colWidths || []).slice() : this.getRenderedColumnWidths();
    if (!baseWidths[index + 1]) return;

    this.model.colWidths = baseWidths;
    this.model.hasCustomColWidths = true;
    this.syncRenderedColumnWidths();
    normalizeColWidths(this.model);

    const tableWidth = table.getBoundingClientRect().width || table.offsetWidth || 1;
    this._colResizeState = {
      index,
      startX: event.clientX,
      tableWidth,
      leftStart: this.model.colWidths[index],
      pairTotal: this.model.colWidths[index] + this.model.colWidths[index + 1]
    };

    if (!this._colResizeMoveHandler) {
      this._colResizeMoveHandler = (moveEvent) => {
        if (!this._colResizeState) return;
        const state = this._colResizeState;
        const deltaPct = ((moveEvent.clientX - state.startX) / state.tableWidth) * 100;
        const minPct = Math.max(2, Math.min(8, state.pairTotal * 0.05));
        const left = clamp(state.leftStart + deltaPct, minPct, state.pairTotal - minPct);
        const right = state.pairTotal - left;
        this.model.colWidths[state.index] = left;
        this.model.colWidths[state.index + 1] = right;
        this.syncRenderedColumnWidths();
      };
      document.addEventListener("mousemove", this._colResizeMoveHandler, true);
    }

    if (!this._colResizeUpHandler) {
      this._colResizeUpHandler = () => {
        if (!this._colResizeState) return;
        this._colResizeState = null;
        normalizeColWidths(this.model);
        this.syncRenderedColumnWidths();
        this.scheduleResizeOverlayRefresh();
      };
      document.addEventListener("mouseup", this._colResizeUpHandler, true);
    }
  }

  destroyColumnResizeListeners() {
    if (this._colResizeMoveHandler) {
      document.removeEventListener("mousemove", this._colResizeMoveHandler, true);
      this._colResizeMoveHandler = null;
    }
    if (this._colResizeUpHandler) {
      document.removeEventListener("mouseup", this._colResizeUpHandler, true);
      this._colResizeUpHandler = null;
    }
    this._colResizeState = null;
  }

  syncClassSelectState() {
    if (!this.classSelectEl) return;

    const ids = this.getSelectedCellIds();
    const cells = ids
      .map((id) => this.model.cells.find((c) => c.id === id))
      .filter(Boolean);

    const uniformPresetClass = detectUniformPresetClass(cells, this.classPresetList);
    this.classSelectEl.value = uniformPresetClass || "";
  }

  renderGrid() {
    normalizeGrid(this.model);
    cleanupTable(this.model);
    normalizeGrid(this.model);

    const occ = buildOcc(this.model);
    const cellById = new Map(this.model.cells.map((c) => [c.id, c]));

    this.cellElById.clear();
    this.gridWrap.empty();

    if (this._mouseUpHandler) {
      document.removeEventListener("mouseup", this._mouseUpHandler, true);
      this._mouseUpHandler = null;
    }

    normalizeColWidths(this.model);
    const tableClasses = joinClassNames(["htw-grid", ...splitClassNames(this.model.tableAttrs?.class)]);
    const table = this.gridWrap.createEl("table", { cls: tableClasses || "htw-grid" });
    this.currentGridTable = table;

    if (this.model.hasCustomColWidths) {
      const colgroup = table.createEl("colgroup");
      this.model.colWidths.forEach((width) => {
        const col = colgroup.createEl("col");
        col.style.width = `${Number(width.toFixed(4))}%`;
      });
    }

    const stopDrag = () => {
      this.isDragging = false;
      this.dragAnchor = null;
    };

    this._mouseUpHandler = () => stopDrag();
    document.addEventListener("mouseup", this._mouseUpHandler, true);

    for (let r = 0; r < this.model.rows; r++) {
      const tr = table.createEl("tr");

      const section = this.model.rowSections[r] || "tbody";
      if (section === "thead") tr.addClass("htw-head-row");

      for (let c = 0; c < this.model.cols; c++) {
        const id = occ[r][c];
        if (!id) continue;

        const cell = cellById.get(id);
        if (!cell) continue;
        if (cell.row !== r || cell.col !== c) continue;

        const td = tr.createEl(cell.tag === "th" ? "th" : "td");
        if (cell.rowspan > 1) td.setAttribute("rowspan", String(cell.rowspan));
        if (cell.colspan > 1) td.setAttribute("colspan", String(cell.colspan));
        if (cell.classes && cell.classes.length) td.setAttribute("class", cell.classes.join(" "));

        if (section === "thead") td.addClass("htw-head-cell");

        this.cellElById.set(cell.id, td);

        const div = td.createDiv({ cls: "htw-cell" });
        div.setAttr("contenteditable", "true");
        div.dataset.cellId = cell.id;
        div.innerHTML = htmlToEditableCellHtml(cell.html || "");

        div.addEventListener("keydown", (event) => {
          handleParagraphEditorKeydown(div, event);
        });

        div.addEventListener("paste", (event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain") || "";
          const html = plainTextToEditorHtml(text);
          try {
            document.execCommand("insertHTML", false, html);
          } catch (e) {
            const sel = window.getSelection?.();
            if (sel && sel.rangeCount) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const temp = div.ownerDocument.createElement("div");
              temp.innerHTML = html;
              const frag = div.ownerDocument.createDocumentFragment();
              while (temp.firstChild) frag.appendChild(temp.firstChild);
              range.insertNode(frag);
            }
          }
          normalizeEditableRoot(div);
          cell.html = extractEditableCellHtml(div);
        });

        div.addEventListener("input", () => {
          this.activeEditorEl = div;
          cell.html = extractEditableCellHtml(div);
          this.scheduleResizeOverlayRefresh();
        });

        div.addEventListener("focusout", () => {
          td.removeClass("htw-focus");
          cell.html = extractEditableCellHtml(div);
          div.innerHTML = htmlToEditableCellHtml(cell.html);
          if (this.activeEditorEl === div) this.activeEditorEl = null;
          this.scheduleResizeOverlayRefresh();
          clearTextSelection();
        });

        div.addEventListener("focusin", () => {
          div.innerHTML = htmlToEditableCellHtml(cell.html || "");
          this.activeEditorEl = div;
          td.addClass("htw-focus");
          this.scheduleResizeOverlayRefresh();
          this.isDragging = false;
          this.dragAnchor = null;
          this.selected = { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
          this.clearExplicitSelectionIds();
          this.activeCellId = cell.id;
          this.updateHighlights();
          this.syncClassSelectState();
        });

        const startDragFromCell = (ev) => {
          if (ev.button !== 0) return;
          if (ev.target && ev.target.closest && ev.target.closest(".htw-cell")) return;

          clearTextSelection();
          const ae = document.activeElement;
          if (ae && ae instanceof HTMLElement && ae.closest && ae.closest(".htw-cell")) ae.blur();

          ev.preventDefault();
          this.isDragging = true;
          this.dragAnchor = { row: cell.row, col: cell.col };
          this.selected = { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
          this.clearExplicitSelectionIds();
          this.activeCellId = cell.id;
          this.updateHighlights();
          this.syncClassSelectState();
        };

        const updateDrag = () => {
          if (!this.isDragging || !this.dragAnchor) return;
          this.selected = { r0: this.dragAnchor.row, c0: this.dragAnchor.col, r1: cell.row, c1: cell.col };
          this.clearExplicitSelectionIds();
          this.activeCellId = cell.id;
          this.updateHighlights();
          this.syncClassSelectState();
        };

        td.addEventListener("mousedown", startDragFromCell);
        td.addEventListener("mouseenter", updateDrag);

        div.addEventListener("mousedown", (ev) => {
          ev.stopPropagation();
          this.isDragging = false;
          this.dragAnchor = null;
          this.selected = { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
          this.clearExplicitSelectionIds();
          this.activeCellId = cell.id;
          this.updateHighlights();
          this.syncClassSelectState();
        });
      }
    }

    this.currentResizeOverlay = this.gridWrap.createDiv({ cls: "htw-col-resize-overlay" });
    if (this._tableResizeObserver) {
      this._tableResizeObserver.disconnect();
      this._tableResizeObserver = null;
    }
    if (window.ResizeObserver && this.currentGridTable) {
      this._tableResizeObserver = new ResizeObserver(() => this.scheduleResizeOverlayRefresh());
      this._tableResizeObserver.observe(this.currentGridTable);
    }
    this.positionColumnResizeOverlay();

    this.updateHighlights();
    this.syncClassSelectState();
  }

  updateHighlights() {
    for (const el of this.cellElById.values()) {
      el.removeClass("htw-selected");
      el.removeClass("htw-selection-rect");
    }

    if (this.activeCellId && this.cellElById.has(this.activeCellId)) {
      this.cellElById.get(this.activeCellId).addClass("htw-selected");
    }

    const ids = this.getSelectedCellIds();
    ids.forEach((id) => {
      const el = this.cellElById.get(id);
      if (el) el.addClass("htw-selection-rect");
    });
  }

  async applyChanges() {
    try {
      const html = renderHtmlTable(this.model);
      await replaceEditorRange(this.editor, this.tableRange.start, this.tableRange.end, html);
      this.tableRange = {
        start: this.tableRange.start,
        end: this.tableRange.start + html.length,
        html
      };
      new Notice("Table appliquée.");
      this.requestClose();
    } catch (e) {
      console.error(e);
      new Notice("Erreur: impossible d’appliquer (voir console).");
    }
  }

  onClose() {
    if (this._mouseUpHandler) {
      document.removeEventListener("mouseup", this._mouseUpHandler, true);
      this._mouseUpHandler = null;
    }
    if (this._tableResizeObserver) {
      this._tableResizeObserver.disconnect();
      this._tableResizeObserver = null;
    }
    if (this._overlayRefreshRaf) {
      cancelAnimationFrame(this._overlayRefreshRaf);
      this._overlayRefreshRaf = null;
    }
    if (this._modalCloseButtonEl && this._modalCloseButtonHandler) {
      this._modalCloseButtonEl.removeEventListener("click", this._modalCloseButtonHandler, true);
    }
    this._modalCloseButtonEl = null;
    this._modalCloseButtonHandler = null;
    this.destroyColumnResizeListeners();
    clearTextSelection();
    this.activeEditorEl = null;
    this.contentEl.empty();
  }
}

function getRenderedTableHost(tableEl) {
  return tableEl?.closest?.(".markdown-embed-content, .markdown-preview-view, .markdown-rendered") || null;
}

function ensureRenderedTableButtonWrap(tableEl) {
  if (!(tableEl instanceof HTMLElement)) return null;
  const existing = tableEl.parentElement;
  if (existing?.classList?.contains("htw-rendered-table-wrap")) return existing;

  const wrap = document.createElement("div");
  wrap.className = "htw-rendered-table-wrap";
  tableEl.parentNode?.insertBefore(wrap, tableEl);
  wrap.appendChild(tableEl);
  return wrap;
}

module.exports = class HtmlTableWysiwygPlugin extends Plugin {
  resolveMarkdownFile(linktext, sourcePath = "") {
    const cleaned = String(linktext || "").split("|")[0].split("#")[0].trim();
    if (!cleaned) return null;
    const file = this.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath || "");
    return file || null;
  }

  resolveRenderedTableFile(tableEl, fallbackSourcePath = "") {
    const embed = tableEl?.closest?.(".internal-embed[src], .markdown-embed[src]");
    const src = embed?.getAttribute?.("src") || "";
    if (src) {
      const file = this.resolveMarkdownFile(src, fallbackSourcePath || "");
      if (file) return file;
    }
    if (fallbackSourcePath) {
      const file = this.app.vault.getAbstractFileByPath(fallbackSourcePath);
      if (file) return file;
    }
    return null;
  }

  getRenderedTableIndex(tableEl) {
    const host = getRenderedTableHost(tableEl);
    if (!(host instanceof HTMLElement)) return 0;
    const tables = Array.from(host.querySelectorAll("table"));
    const index = tables.indexOf(tableEl);
    return index >= 0 ? index : 0;
  }

  attachRenderedTableEditButton(tableEl, sourcePath = "") {
    if (!(tableEl instanceof HTMLElement)) return;
    const wrap = ensureRenderedTableButtonWrap(tableEl);
    if (!(wrap instanceof HTMLElement)) return;

    let button = wrap.querySelector(":scope > .htw-rendered-edit-btn");
    if (!(button instanceof HTMLButtonElement)) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "htw-rendered-edit-btn";
      button.title = "Modifier cette table";
      button.setAttribute("aria-label", "Modifier cette table");
      button.textContent = "✎";
      wrap.appendChild(button);
    }

    button.onmousedown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    button.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const file = this.resolveRenderedTableFile(tableEl, sourcePath || "");
        if (!file) {
          new Notice("Fichier source introuvable pour cette table.");
          return;
        }
        const text = await this.app.vault.cachedRead(file);
        const tables = findAllTablesInText(text);
        if (!tables.length) {
          new Notice("Aucune <table> trouvée dans le fichier source.");
          return;
        }
        const index = Math.min(this.getRenderedTableIndex(tableEl), tables.length - 1);
        const range = tables[index];
        const adapter = makeFileEditorAdapter(this.app, file, text);
        const modal = new TableEditorModal(this.app, this, adapter, range);
        modal.open();
      } catch (e) {
        console.error(e);
        new Notice("Table non supportée ou parsing impossible (voir console).");
      }
    };
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new HtmlTableWysiwygSettingTab(this.app, this));

    // ====== 1) Bouton d’édition unique sur chaque table HTML rendue en Live Preview ======
    this._cm6 = tryLoadCm6();
    if (this._cm6) {
      const { ViewPlugin } = this._cm6;
      const pluginRef = this;

      const resolveTableRangeFromEmbed = (view, embed) => {
        const docText = view.state.doc.toString();
        let approxOffset = null;

        try {
          approxOffset = view.posAtDOM(embed, 0);
        } catch (e) {}

        if (!Number.isFinite(approxOffset)) {
          const table = embed.querySelector("table");
          if (table) {
            try {
              approxOffset = view.posAtDOM(table, 0);
            } catch (e) {}
          }
        }

        if (!Number.isFinite(approxOffset)) return null;
        return findTableRangeAtApproxOffset(docText, approxOffset);
      };

      const createLiveEditButton = (view, embed) => {
        const wrap = document.createElement("span");
        wrap.className = "htw-live-edit-wrap";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "htw-live-edit-btn";
        btn.title = "Modifier cette table";
        btn.setAttribute("aria-label", "Modifier cette table");
        btn.textContent = "✎";

        btn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });

        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          try {
            const range = resolveTableRangeFromEmbed(view, embed);
            if (!range) {
              new Notice("Aucune <table> trouvée dans le texte.");
              return;
            }

            const editorAdapter = makeCmEditorAdapter(view);
            const modal = new TableEditorModal(pluginRef.app, pluginRef, editorAdapter, range);
            modal.open();
          } catch (e) {
            console.error(e);
            new Notice("Table non supportée ou parsing impossible (voir console).");
          }
        });

        wrap.appendChild(btn);
        return wrap;
      };

      const injectButtons = (view) => {
        const embeds = view.dom.querySelectorAll(".cm-html-embed.cm-embed-block");
        if (!embeds.length) return;

        embeds.forEach((embed) => {
          const table = embed.querySelector("table");
          const wraps = Array.from(embed.querySelectorAll(":scope > .htw-live-edit-wrap"));

          if (!table) {
            wraps.forEach((el) => el.remove());
            return;
          }

          const firstWrap = wraps[0] || createLiveEditButton(view, embed);
          wraps.slice(1).forEach((el) => el.remove());

          if (!firstWrap.isConnected) embed.prepend(firstWrap);
        });
      };

      const liveButtonPlugin = ViewPlugin.fromClass(
        class {
          constructor(view) {
            this.view = view;
            injectButtons(view);
            this.observer = new MutationObserver(() => injectButtons(view));
            this.observer.observe(view.dom, { childList: true, subtree: true });
          }

          update(update) {
            if (update.docChanged || update.viewportChanged) {
              injectButtons(update.view);
            }
          }

          destroy() {
            this.observer?.disconnect();
          }
        }
      );

      this.registerEditorExtension(liveButtonPlugin);
    } else {
      console.warn("[HTML Table WYSIWYG] CM6 modules not found; live-preview edit button disabled.");
    }

    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!(el instanceof HTMLElement)) return;
      const tables = el.querySelectorAll("table");
      tables.forEach((table) => this.attachRenderedTableEditButton(table, ctx.sourcePath || ""));
    });

    // ====== 2) Commands (keep existing behavior) ======
    this.addCommand({
      id: "insert-new-html-table",
      name: "Create new HTML table (WYSIWYG)",
      editorCallback: (editor) => {
        const modal = new NewTableModal(this.app, this, editor);
        modal.open();
      }
    });

    this.addCommand({
      id: "edit-html-table-under-cursor",
      name: "Edit HTML table (WYSIWYG) under cursor",
      editorCallback: (editor) => {
        const text = editor.getValue();
        const cursor = editor.getCursor();
        const cursorOffset = editor.posToOffset(cursor);

        const range = findTableRange(text, cursorOffset);
        if (!range) {
          new Notice("Aucun <table> trouvé autour du curseur.");
          return;
        }

        try {
          const modal = new TableEditorModal(this.app, this, editor, range);
          modal.open();
        } catch (e) {
          console.error(e);
          new Notice("Table non supportée ou parsing impossible (voir console).");
        }
      }
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
