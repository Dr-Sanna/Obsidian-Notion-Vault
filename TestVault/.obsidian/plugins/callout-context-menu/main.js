const { Plugin, Menu, MarkdownRenderer, Component } = require("obsidian");
const { StateEffect, StateField } = require("@codemirror/state");
const { Decoration, EditorView, WidgetType } = require("@codemirror/view");

// -------------------- Config --------------------

const ROOT_CALLOUT_MENU_TITLE = "Callout";
const ROOT_COLUMNS_MENU_TITLE = "Colonnes";
const DEQUOTE_MENU_TITLE = "Retirer blockquote/callout (déquote)";

const SPECIAL_MULTI_COLUMN_TYPE = "multi-column";
const SPECIAL_TWO_COLUMNS_TITLE = "2 Colonnes";
const SPECIAL_THREE_COLUMNS_TITLE = "3 Colonnes";
const SPECIAL_MULTI_COLUMN_CONTAINER_META = ["bordered"];
const SPECIAL_TWO_COLUMNS_WIDTHS = ["50", "50"];
const SPECIAL_THREE_COLUMNS_WIDTHS = ["33", "34", "33"];

const STANDARD_CALLOUTS = [
  { key: "note", title: "Note", defaultTitle: "Note" },
  { key: "info", title: "Info", defaultTitle: "Info" },
  { key: "tip", title: "Tip", defaultTitle: "Tip" },
  { key: "success", title: "Success", defaultTitle: "Success" },
  { key: "question", title: "Question", defaultTitle: "Question" },
  { key: "warning", title: "Warning", defaultTitle: "Warning" },
  { key: "failure", title: "Failure", defaultTitle: "Failure" },
  { key: "danger", title: "Danger", defaultTitle: "Danger" },
  { key: "bug", title: "Bug", defaultTitle: "Bug" },
  { key: "example", title: "Example", defaultTitle: "Example" },
  { key: "quote", title: "Quote", defaultTitle: "Quote" }
];

const TYPE_PREVIEW_METAS = [...STANDARD_CALLOUTS];
const TYPE_TITLE_TO_KEY = new Map(STANDARD_CALLOUTS.map((c) => [c.title, c.key]));

const COLOR_METAS = [
  { id: "slate", label: "Gris" },
  { id: "red", label: "Rouge" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Jaune" },
  { id: "green", label: "Vert" },
  { id: "cyan", label: "Cyan" },
  { id: "blue", label: "Bleu" },
  { id: "purple", label: "Violet" },
  { id: "pink", label: "Rose" }
];
const COLOR_META_IDS = new Set(COLOR_METAS.map((c) => c.id));
const COLOR_LABEL_TO_ID = new Map(COLOR_METAS.map((c) => [c.label, c.id]));

const SIMPLE_METADATA_METAS = [
  { id: "no-title", label: "No title" },
  { id: "no-icon", label: "No icon" }
];
const SIMPLE_METADATA_LABEL_TO_ID = new Map(SIMPLE_METADATA_METAS.map((m) => [m.label, m.id]));

const TYPE_KEY_TO_ICON = new Map([
  ["note", "pencil"],
  ["info", "info"],
  ["tip", "lightbulb"],
  ["success", "check-circle"],
  ["question", "help-circle"],
  ["warning", "alert-triangle"],
  ["failure", "x-circle"],
  ["danger", "zap"],
  ["bug", "bug"],
  ["example", "list"],
  ["quote", "quote"],
  [SPECIAL_MULTI_COLUMN_TYPE, "columns-2"]
]);

const IMAGE_WIKILINK_RE = /!\[\[[^\]]+\.(?:png|apng|jpe?g|gif|webp|svg|bmp|avif|tiff?)(?:\|[^\]]*)?\]\]/i;

function getDefaultTitleForType(type) {
  return STANDARD_CALLOUTS.find((c) => c.key === type)?.defaultTitle ?? "";
}

// -------------------- Markdown helpers --------------------

function parseCalloutHeader(line) {
  const m = /^>\s*\[!([^\]]+)\]([+-])?\s*(.*)$/.exec(line ?? "");
  if (!m) return null;

  const inside = (m[1] ?? "").trim();
  const fold = m[2] ?? "";
  const title = m[3] ?? "";

  const parts = inside.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  return { type: parts[0], metas: parts.slice(1), fold, title };
}

function buildCalloutHeader({ type, metas, fold, title }) {
  const inside = [type, ...(metas ?? [])].join("|");
  const foldStr = fold ? fold : "";
  const space = title && title.length > 0 ? " " : "";
  return `> [!${inside}]${foldStr}${space}${title ?? ""}`.trimEnd();
}

function uniqPreserveOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = (x ?? "").trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function normalizeNewlines(s) {
  return (s ?? "").replace(/\r\n/g, "\n");
}

function quotePreserve(lines) {
  return lines.map((l) => {
    if (l === "") return ">";
    if (l.startsWith(">")) return l;
    return `> ${l}`;
  });
}

function getQuoteLevel(line) {
  const m = /^(?:>\s*)+/.exec(line ?? "");
  if (!m) return 0;
  return (m[0].match(/>/g) ?? []).length;
}

function stripOneQuoteLevel(line) {
  if ((line ?? "").startsWith("> ")) return line.slice(2);
  if ((line ?? "").startsWith(">")) return line.slice(1);
  return line ?? "";
}

function stripNQuoteLevels(line, n) {
  let out = line ?? "";
  for (let i = 0; i < n; i++) out = stripOneQuoteLevel(out);
  return out;
}

function prefixWithQuoteLevel(lines, level) {
  const prefix = level > 0 ? `${Array(level).fill(">").join(" ")} ` : "";
  return lines.map((l) => (l === "" ? prefix.trimEnd() : `${prefix}${l}`));
}

function prefixWithCompactQuoteLevel(lines, level) {
  const prefix = level > 0 ? ">".repeat(level) : "";
  return lines.map((l) => {
    if (l === "") return prefix;
    if (!prefix) return l;
    if (l.startsWith(">")) return `${prefix}${l}`;
    return `${prefix} ${l}`;
  });
}

function containsImageWikilink(line) {
  return IMAGE_WIKILINK_RE.test(line ?? "");
}

function findEnclosingCalloutHeaderFromLine(editor, lineNumber) {
  let i = lineNumber;
  while (i >= 0) {
    const line = editor.getLine(i);
    if (!line.startsWith(">")) return null;
    const parsed = parseCalloutHeader(line);
    if (parsed) return { headerLine: i, parsed, quoteLevel: getQuoteLevel(line) };
    i--;
  }
  return null;
}

function findEnclosingCalloutHeader(editor) {
  const cur = editor.getCursor();
  return findEnclosingCalloutHeaderFromLine(editor, cur.line);
}

function stripSelectionForParentQuoteLevel(lines, parentQuoteLevel) {
  if (parentQuoteLevel <= 0) return lines;
  return lines.map((line) => stripNQuoteLevels(line, parentQuoteLevel));
}

function splitLinesForTwoColumns(lines) {
  const left = [];
  const right = [];

  for (const line of lines) {
    if (containsImageWikilink(line)) right.push(line);
    else left.push(line);
  }

  return { left, right };
}

function buildMultiColumnScaffold(targetLevel, widths, columnContents) {
  const childLevel = targetLevel + 1;
  const lines = [];

  lines.push(
    ...prefixWithCompactQuoteLevel([
      buildCalloutHeader({
        type: SPECIAL_MULTI_COLUMN_TYPE,
        metas: SPECIAL_MULTI_COLUMN_CONTAINER_META,
        fold: "",
        title: ""
      }).replace(/^>\s*/, "")
    ], targetLevel)
  );
  lines.push(...prefixWithCompactQuoteLevel([""], targetLevel));

  widths.forEach((width, index) => {
    const bodyLines = columnContents[index]?.length ? columnContents[index] : [""];

    lines.push(
      ...prefixWithCompactQuoteLevel([
        buildCalloutHeader({ type: "col", metas: [width], fold: "", title: "" }).replace(/^>\s*/, "")
      ], childLevel)
    );
    lines.push(...prefixWithCompactQuoteLevel(bodyLines, childLevel));

    if (index < widths.length - 1) {
      lines.push(...prefixWithCompactQuoteLevel([""], targetLevel));
    }
  });

  return lines.join("\n");
}

function buildTwoColumnsFromSelection(lines, parentQuoteLevel) {
  const normalizedLines = stripSelectionForParentQuoteLevel(lines, parentQuoteLevel);
  const { left, right } = splitLinesForTwoColumns(normalizedLines);
  const targetLevel = parentQuoteLevel > 0 ? parentQuoteLevel + 1 : 1;
  return buildMultiColumnScaffold(targetLevel, SPECIAL_TWO_COLUMNS_WIDTHS, [left, right]);
}

function buildThreeColumnsFromSelection(lines, parentQuoteLevel) {
  const normalizedLines = stripSelectionForParentQuoteLevel(lines, parentQuoteLevel);
  const targetLevel = parentQuoteLevel > 0 ? parentQuoteLevel + 1 : 1;
  return buildMultiColumnScaffold(targetLevel, SPECIAL_THREE_COLUMNS_WIDTHS, [normalizedLines, [""], [""]]);
}

function unwrapSelectionText(sel) {
  const lines = normalizeNewlines(sel).split("\n");
  const firstParsed = parseCalloutHeader(lines[0]);
  const bodyLines = firstParsed ? lines.slice(1) : lines;
  return bodyLines
    .map((l) => {
      if (l.startsWith("> ")) return l.slice(2);
      if (l.startsWith(">")) return l.slice(1);
      return l;
    })
    .join("\n");
}

function unwrapBlockLines(lines) {
  return unwrapSelectionText((lines ?? []).join("\n"));
}

function convertSelectionTextToCallout(editor, sel, type, fromPos) {
  const ctx = findEnclosingCalloutHeaderFromLine(editor, fromPos.line);
  if (!sel || sel.length === 0) {
    const targetLevel = ctx ? ctx.quoteLevel + 1 : 1;
    const header = buildCalloutHeader({ type, metas: [], fold: "", title: getDefaultTitleForType(type) }).replace(/^>\s*/, "");
    return [
      ...prefixWithQuoteLevel([header], targetLevel),
      ...prefixWithQuoteLevel([""], targetLevel)
    ].join("\n");
  }

  const lines = normalizeNewlines(sel).split("\n");
  const parsed = parseCalloutHeader(lines[0]);

  if (parsed) {
    const newHeader = buildCalloutHeader({
      type,
      metas: parsed.metas,
      fold: parsed.fold,
      title: parsed.title
    });
    return [newHeader, ...lines.slice(1)].join("\n");
  }

  if (ctx) {
    const parentLevel = ctx.quoteLevel;
    const targetLevel = parentLevel + 1;
    const strippedLines = lines.map((line) => stripNQuoteLevels(line, parentLevel));
    const header = buildCalloutHeader({ type, metas: [], fold: "", title: getDefaultTitleForType(type) }).replace(/^>\s*/, "");
    return [
      ...prefixWithQuoteLevel([header], targetLevel),
      ...prefixWithQuoteLevel(strippedLines, targetLevel)
    ].join("\n");
  }

  const header = buildCalloutHeader({ type, metas: [], fold: "", title: "" });
  return [header, ...quotePreserve(lines)].join("\n");
}

function convertSelectionTextToTwoColumns(editor, sel, fromPos) {
  const ctx = findEnclosingCalloutHeaderFromLine(editor, fromPos.line);
  if (!sel || sel.length === 0) {
    const targetLevel = ctx ? ctx.quoteLevel + 1 : 1;
    return buildMultiColumnScaffold(targetLevel, SPECIAL_TWO_COLUMNS_WIDTHS, [[""], [""]]);
  }
  return buildTwoColumnsFromSelection(normalizeNewlines(sel).split("\n"), ctx?.quoteLevel ?? 0);
}

function convertSelectionTextToThreeColumns(editor, sel, fromPos) {
  const ctx = findEnclosingCalloutHeaderFromLine(editor, fromPos.line);
  if (!sel || sel.length === 0) {
    const targetLevel = ctx ? ctx.quoteLevel + 1 : 1;
    return buildMultiColumnScaffold(targetLevel, SPECIAL_THREE_COLUMNS_WIDTHS, [[""], [""], [""]]);
  }
  return buildThreeColumnsFromSelection(normalizeNewlines(sel).split("\n"), ctx?.quoteLevel ?? 0);
}

function gatherCalloutBlock(editor, headerLine) {
  const header = editor.getLine(headerLine);
  const parsed = parseCalloutHeader(header);
  if (!parsed) return null;

  const quoteLevel = getQuoteLevel(header);
  const lines = [header];
  let endLine = headerLine;

  for (let i = headerLine + 1; i < editor.lineCount(); i++) {
    const line = editor.getLine(i);
    if (!line.startsWith(">")) break;
    if (getQuoteLevel(line) < quoteLevel) break;
    lines.push(line);
    endLine = i;
  }

  return { headerLine, endLine, quoteLevel, parsed, lines };
}

function replaceHeaderInBlock(block, nextParsed) {
  const lines = [...block.lines];
  lines[0] = buildCalloutHeader(nextParsed);
  return lines.join("\n");
}

function withTypeInBlock(block, type) {
  return replaceHeaderInBlock(block, { ...block.parsed, type });
}

function withColorInBlock(block, colorId) {
  let metas = (block.parsed.metas ?? []).filter((m) => !COLOR_META_IDS.has(m));
  if (colorId) metas.push(colorId);
  metas = uniqPreserveOrder(metas);
  return replaceHeaderInBlock(block, { ...block.parsed, metas });
}

function withToggledMetaInBlock(block, meta) {
  const metas = [...(block.parsed.metas ?? [])];
  const idx = metas.indexOf(meta);
  if (idx >= 0) metas.splice(idx, 1);
  else metas.push(meta);
  return replaceHeaderInBlock(block, { ...block.parsed, metas: uniqPreserveOrder(metas) });
}

function withClearedMetasInBlock(block) {
  return replaceHeaderInBlock(block, { ...block.parsed, metas: [] });
}

function withResetInBlock(block) {
  return replaceHeaderInBlock(block, { type: block.parsed.type, metas: [], fold: "", title: "" });
}

// -------------------- Actual editor actions --------------------

function convertSelectionToCallout(editor, type) {
  editor.replaceSelection(convertSelectionTextToCallout(editor, normalizeNewlines(editor.getSelection()), type, editor.getCursor("from")));
}

function convertSelectionToTwoColumns(editor) {
  editor.replaceSelection(convertSelectionTextToTwoColumns(editor, normalizeNewlines(editor.getSelection()), editor.getCursor("from")));
}

function convertSelectionToThreeColumns(editor) {
  editor.replaceSelection(convertSelectionTextToThreeColumns(editor, normalizeNewlines(editor.getSelection()), editor.getCursor("from")));
}

function unwrapSelectionBlockquote(editor) {
  const sel = normalizeNewlines(editor.getSelection());
  if (!sel || sel.length === 0) return;
  editor.replaceSelection(unwrapSelectionText(sel));
}

function unwrapCalloutBlock(editor, headerLine) {
  const block = gatherCalloutBlock(editor, headerLine);
  if (!block) return;

  const from = { line: block.headerLine, ch: 0 };
  const isLastLine = block.endLine >= editor.lineCount() - 1;
  const to = isLastLine
    ? { line: block.endLine, ch: (editor.getLine(block.endLine) ?? "").length }
    : { line: block.endLine + 1, ch: 0 };

  editor.replaceRange(unwrapBlockLines(block.lines), from, to);
}

function setHeader(editor, headerLine, newParsed) {
  editor.setLine(headerLine, buildCalloutHeader(newParsed));
}

function setCalloutType(editor, headerLine, newType) {
  const parsed = parseCalloutHeader(editor.getLine(headerLine));
  if (!parsed) return;
  setHeader(editor, headerLine, { ...parsed, type: newType });
}

function toggleMeta(editor, headerLine, meta) {
  const parsed = parseCalloutHeader(editor.getLine(headerLine));
  if (!parsed) return;
  const metas = [...(parsed.metas ?? [])];
  const idx = metas.indexOf(meta);
  if (idx >= 0) metas.splice(idx, 1);
  else metas.push(meta);
  setHeader(editor, headerLine, { ...parsed, metas: uniqPreserveOrder(metas) });
}

function clearAllMetas(editor, headerLine) {
  const parsed = parseCalloutHeader(editor.getLine(headerLine));
  if (!parsed) return;
  setHeader(editor, headerLine, { ...parsed, metas: [] });
}

function clearColorMeta(editor, headerLine) {
  const parsed = parseCalloutHeader(editor.getLine(headerLine));
  if (!parsed) return;
  const metas = (parsed.metas ?? []).filter((m) => !COLOR_META_IDS.has(m));
  setHeader(editor, headerLine, { ...parsed, metas: uniqPreserveOrder(metas) });
}

function setColorMeta(editor, headerLine, colorId) {
  const parsed = parseCalloutHeader(editor.getLine(headerLine));
  if (!parsed) return;
  let metas = (parsed.metas ?? []).filter((m) => !COLOR_META_IDS.has(m));
  metas.push(colorId);
  metas = uniqPreserveOrder(metas);
  setHeader(editor, headerLine, { ...parsed, metas });
}

function resetKeepType(editor, headerLine) {
  const parsed = parseCalloutHeader(editor.getLine(headerLine));
  if (!parsed) return;
  setHeader(editor, headerLine, { type: parsed.type, metas: [], fold: "", title: "" });
}

// -------------------- Menu builders --------------------

function trySetItemIcon(item, iconName) {
  try {
    if (typeof item?.setIcon === "function" && iconName) item.setIcon(iconName);
  } catch (_) {}
}

function addCalloutEditSubmenu(menu, editor, headerLine) {
  let root = null;
  menu.addItem((item) => {
    root = item;
    item.setTitle(ROOT_CALLOUT_MENU_TITLE);
  });

  if (!root || typeof root.setSubmenu !== "function") return;

  const sub = root.setSubmenu();

  for (const c of STANDARD_CALLOUTS) {
    sub.addItem((it) => {
      it.setTitle(c.title);
      it.onClick(() => setCalloutType(editor, headerLine, c.key));
    });
  }

  sub.addSeparator();
  sub.addItem((it) => {
    it.setTitle(DEQUOTE_MENU_TITLE);
    it.onClick(() => unwrapCalloutBlock(editor, headerLine));
  });
}

function addMetadataSubmenu(menu, editor, headerLine) {
  let metadataRoot = null;
  menu.addItem((item) => {
    metadataRoot = item;
    item.setTitle("Metadata");
  });
  if (!metadataRoot || typeof metadataRoot.setSubmenu !== "function") return;

  const sub = metadataRoot.setSubmenu();

  for (const meta of SIMPLE_METADATA_METAS) {
    sub.addItem((it) => {
      it.setTitle(meta.label);
      it.onClick(() => toggleMeta(editor, headerLine, meta.id));
    });
  }

  sub.addSeparator();
  sub.addItem((it) => {
    it.setTitle("Aucun");
    it.onClick(() => clearAllMetas(editor, headerLine));
  });
}

function addColorSubmenu(menu, editor, headerLine) {
  let colorRoot = null;
  menu.addItem((item) => {
    colorRoot = item;
    item.setTitle("Couleur");
  });
  if (!colorRoot || typeof colorRoot.setSubmenu !== "function") return;

  const sub = colorRoot.setSubmenu();
  sub.addItem((it) => {
    it.setTitle("Par défaut");
    it.onClick(() => clearColorMeta(editor, headerLine));
  });

  sub.addSeparator();
  for (const c of COLOR_METAS) {
    sub.addItem((it) => {
      it.setTitle(c.label);
      it.onClick(() => setColorMeta(editor, headerLine, c.id));
    });
  }
}

function addResetItem(menu, editor, headerLine) {
  menu.addItem((item) => {
    item.setTitle("Réinitialiser");
    item.onClick(() => resetKeepType(editor, headerLine));
  });
}

function addRootCalloutSubmenu(menu, editor) {
  let root = null;
  menu.addItem((item) => {
    root = item;
    item.setTitle(ROOT_CALLOUT_MENU_TITLE);
  });
  if (!root || typeof root.setSubmenu !== "function") return;

  const sub = root.setSubmenu();
  for (const c of STANDARD_CALLOUTS) {
    sub.addItem((it) => {
      it.setTitle(c.title);
      it.onClick(() => convertSelectionToCallout(editor, c.key));
    });
  }
}

function addRootColumnsSubmenu(menu, editor) {
  let root = null;
  menu.addItem((item) => {
    root = item;
    item.setTitle(ROOT_COLUMNS_MENU_TITLE);
  });
  if (!root || typeof root.setSubmenu !== "function") return;

  const sub = root.setSubmenu();

  sub.addItem((it) => {
    it.setTitle(SPECIAL_TWO_COLUMNS_TITLE);
    trySetItemIcon(it, "columns-2");
    it.onClick(() => convertSelectionToTwoColumns(editor));
  });

  sub.addItem((it) => {
    it.setTitle(SPECIAL_THREE_COLUMNS_TITLE);
    trySetItemIcon(it, "columns-3");
    it.onClick(() => convertSelectionToThreeColumns(editor));
  });
}

// -------------------- Live Preview context helpers --------------------

function getEditorFromCmCallout(calloutEl) {
  const widget = calloutEl?.cmView?.widget;
  const editor = widget?.editor?.editor;
  if (editor) return { widget, editor };
  return null;
}

function getHeaderLineFromCmCallout(editor, widget) {
  return editor.offsetToPos(widget.start).line;
}

// -------------------- Type preview (icon + color) computed from theme CSS --------------------

function computeTypePreviewVars() {
  const out = new Map();
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "-10000px";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  host.setAttribute("aria-hidden", "true");
  document.body.appendChild(host);

  for (const c of TYPE_PREVIEW_METAS) {
    const el = document.createElement("div");
    el.className = "callout";
    el.setAttribute("data-callout", c.key);
    host.appendChild(el);

    const cs = getComputedStyle(el);
    const iconRaw = (cs.getPropertyValue("--callout-icon") || "").trim();
    const colorRaw = (cs.getPropertyValue("--callout-color") || "").trim();

    out.set(c.key, { iconRaw, colorRaw });
    host.removeChild(el);
  }

  document.body.removeChild(host);
  return out;
}

function getMenuItemElFromTitleEl(titleEl) {
  return titleEl?.closest?.(".menu-item") ?? null;
}

function getMenuItemIconContainer(menuItemEl) {
  if (!menuItemEl) return null;
  return Array.from(menuItemEl.children).find((el) => el.classList?.contains("menu-item-icon")) ?? null;
}

function buildLucideIcon(iconName, color) {
  let svg = null;
  try {
    const obs = require("obsidian");
    if (typeof obs.getIcon === "function" && iconName) svg = obs.getIcon(iconName);
  } catch (_) {
    svg = null;
  }
  if (!svg) return null;
  if (color) svg.style.color = color;
  return svg;
}

function setMenuItemIcon(titleEl, iconName, color) {
  const menuItemEl = getMenuItemElFromTitleEl(titleEl);
  if (!menuItemEl) return;

  let iconContainer = getMenuItemIconContainer(menuItemEl);
  if (!iconContainer && iconName) {
    iconContainer = document.createElement("div");
    iconContainer.className = "menu-item-icon";
    menuItemEl.insertBefore(iconContainer, menuItemEl.firstChild);
  }
  if (!iconContainer) return;

  iconContainer.replaceChildren();

  if (!iconName) {
    iconContainer.style.display = "none";
    return;
  }

  iconContainer.style.display = "";
  const svg = buildLucideIcon(iconName, color);
  if (svg) iconContainer.appendChild(svg);
}

function collectMenuTitleEls(menuEl) {
  return Array.from(menuEl.querySelectorAll(".menu-item-title"));
}

function removeMenuItemsByTitle(menuEl, labels) {
  if (!menuEl) return;
  const wanted = new Set((labels ?? []).map((s) => (s ?? "").trim()).filter(Boolean));
  if (!wanted.size) return;

  Array.from(menuEl.querySelectorAll(":scope > .menu-item")).forEach((itemEl) => {
    const title = (itemEl.querySelector(".menu-item-title")?.textContent ?? "").trim();
    if (wanted.has(title)) itemEl.remove();
  });
}

function cleanupMenuSeparators(menuEl) {
  if (!menuEl) return;
  const children = Array.from(menuEl.children);
  let prevWasSep = true;

  for (const child of children) {
    const isSep = child.classList?.contains("menu-separator");
    if (!isSep) {
      prevWasSep = false;
      continue;
    }
    if (prevWasSep) {
      child.remove();
      continue;
    }
    prevWasSep = true;
  }

  const last = menuEl.lastElementChild;
  if (last?.classList?.contains("menu-separator")) last.remove();
}

function injectColorSwatchIfNeeded(titleEl) {
  const text = (titleEl.textContent ?? "").trim();
  const colorId = COLOR_LABEL_TO_ID.get(text);
  if (!colorId) return;
  if (titleEl.querySelector(".ccm-swatch")) return;

  const sw = document.createElement("span");
  sw.className = `ccm-swatch ccm-${colorId}`;
  titleEl.prepend(sw);
}

function decorateSpecialColumnMenuItems(titleEl) {
  const text = (titleEl.textContent ?? "").trim();

  if (text === ROOT_COLUMNS_MENU_TITLE || text === ROOT_CALLOUT_MENU_TITLE) return false;
  if (text === SPECIAL_TWO_COLUMNS_TITLE) {
    setMenuItemIcon(titleEl, "columns-2");
    return true;
  }
  if (text === SPECIAL_THREE_COLUMNS_TITLE) {
    setMenuItemIcon(titleEl, "columns-3");
    return true;
  }
  return false;
}

function injectTypeIconIfNeeded(titleEl, previewVars) {
  if (decorateSpecialColumnMenuItems(titleEl)) return;

  const text = (titleEl.textContent ?? "").trim();
  const key = TYPE_TITLE_TO_KEY.get(text);
  if (!key) return;

  const vars = previewVars.get(key);
  let iconName = (vars?.iconRaw || "").trim();
  if (iconName.startsWith("lucide-")) iconName = iconName.slice("lucide-".length);
  if (!iconName) iconName = TYPE_KEY_TO_ICON.get(key) || "";

  const color = (vars?.colorRaw || "").trim();
  setMenuItemIcon(titleEl, iconName, color ? `rgb(${color})` : "");
}

function ensurePreviewsInMenu(menuEl, previewVars) {
  if (!menuEl || !(menuEl instanceof HTMLElement)) return;

  removeMenuItemsByTitle(menuEl, ["Type de mise en avant", "Callout type"]);
  cleanupMenuSeparators(menuEl);

  const titles = collectMenuTitleEls(menuEl);
  titles.forEach((titleEl) => {
    injectColorSwatchIfNeeded(titleEl);
    injectTypeIconIfNeeded(titleEl, previewVars);
  });
}

// -------------------- Preview session helpers --------------------

const setPreviewEffect = StateEffect.define();
const clearPreviewEffect = StateEffect.define();

class CalloutPreviewWidget extends WidgetType {
  constructor(app, markdown, sourcePath) {
    super();
    this.app = app;
    this.markdown = markdown;
    this.sourcePath = sourcePath || "";
  }

  eq(other) {
    return other?.markdown === this.markdown && other?.sourcePath === this.sourcePath;
  }

  toDOM() {
    const host = document.createElement("div");
    host.className = "ccm-cm-preview-host cm-embed-block cm-callout";
    host.setAttribute("data-ccm-preview", "true");
    host.setAttribute("contenteditable", "false");
    host.setAttribute("tabindex", "-1");
    host.style.pointerEvents = "none";

    const rendered = document.createElement("div");
    rendered.className = "markdown-rendered show-indentation-guide";
    host.appendChild(rendered);

    const component = new Component();
    host._ccmComponent = component;

    MarkdownRenderer.render(this.app, this.markdown, rendered, this.sourcePath, component).catch(() => {
      if (!rendered.isConnected) return;
      rendered.textContent = this.markdown;
    });

    return host;
  }

  destroy(dom) {
    try { dom?._ccmComponent?.unload?.(); } catch (_) {}
  }

  ignoreEvent() {
    return true;
  }
}

function createPreviewExtension(app) {
  const previewField = StateField.define({
    create() {
      return Decoration.none;
    },

    update(deco, tr) {
      deco = deco.map(tr.changes);

      for (const effect of tr.effects) {
        if (effect.is(clearPreviewEffect)) return Decoration.none;

        if (effect.is(setPreviewEffect)) {
          const { from, to, markdown, sourcePath } = effect.value || {};
          if (typeof from !== "number" || typeof to !== "number" || !markdown) return Decoration.none;

          const widget = new CalloutPreviewWidget(app, markdown, sourcePath);

          if (from === to) {
            return Decoration.set([
              Decoration.widget({ widget, block: true, side: 1 }).range(from)
            ], true);
          }

          return Decoration.set([
            Decoration.replace({ widget, block: true }).range(from, to)
          ], true);
        }
      }

      if (tr.docChanged) return Decoration.none;
      return deco;
    },

    provide(field) {
      return EditorView.decorations.from(field);
    }
  });

  return [previewField];
}

function capturePreviewSession(editor, sourcePath, options = null) {
  const selection = normalizeNewlines(editor.getSelection());
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const forcedHeaderLine = typeof options === "number" ? options : options?.forcedHeaderLine;
  const renderedCalloutEl = options?.renderedCalloutEl ?? null;
  const headerCtx = typeof forcedHeaderLine === "number"
    ? findEnclosingCalloutHeaderFromLine(editor, forcedHeaderLine)
    : findEnclosingCalloutHeaderFromLine(editor, from.line);

  return {
    editor,
    selection,
    from,
    to,
    sourcePath: sourcePath || "",
    headerCtx,
    renderedCalloutEl
  };
}

function getSelectionOffsetRange(session) {
  if (!session?.editor) return null;
  return {
    from: session.editor.posToOffset(session.from),
    to: session.editor.posToOffset(session.to)
  };
}

function getLineEndOffset(editor, lineNumber) {
  const lineText = editor.getLine(lineNumber) ?? "";
  return editor.posToOffset({ line: lineNumber, ch: lineText.length });
}

function getSelectionVisualOffsetRange(session) {
  if (!session?.editor) return null;

  const editor = session.editor;
  let startLine = session.from.line;
  let endLine = session.to.line;

  if (session.from.line !== session.to.line && session.to.ch === 0) {
    endLine = Math.max(startLine, endLine - 1);
  }

  const from = editor.posToOffset({ line: startLine, ch: 0 });
  let to = getLineEndOffset(editor, endLine);

  if (endLine < editor.lineCount() - 1) {
    try { to = editor.posToOffset({ line: endLine + 1, ch: 0 }); } catch (_) {}
  }

  return { from, to };
}

function getBlockOffsetRange(editor, startLine, endLine) {
  const from = editor.posToOffset({ line: startLine, ch: 0 });
  let to = getLineEndOffset(editor, endLine);
  if (endLine < editor.lineCount() - 1) {
    try { to = editor.posToOffset({ line: endLine + 1, ch: 0 }); } catch (_) {}
  }
  return { from, to };
}

function buildPreviewPayloadFromLabel(session, label) {
  if (!session?.editor) return null;

  const editor = session.editor;
  const hasSelection = !!session.selection;
  const typeKey = TYPE_TITLE_TO_KEY.get(label);

  if (typeKey) {
    if (hasSelection) return { markdown: convertSelectionTextToCallout(editor, session.selection, typeKey, session.from), ...getSelectionOffsetRange(session) };
    if (session.headerCtx) {
      const block = gatherCalloutBlock(editor, session.headerCtx.headerLine);
      if (!block) return null;
      return { markdown: withTypeInBlock(block, typeKey), ...getBlockOffsetRange(editor, block.headerLine, block.endLine) };
    }
    return { markdown: convertSelectionTextToCallout(editor, session.selection, typeKey, session.from), ...getSelectionOffsetRange(session) };
  }

  if (label === SPECIAL_TWO_COLUMNS_TITLE) {
    const markdown = convertSelectionTextToTwoColumns(editor, session.selection, session.from);
    const range = session.selection ? getSelectionVisualOffsetRange(session) : getSelectionOffsetRange(session);
    return { markdown, ...range };
  }
  if (label === SPECIAL_THREE_COLUMNS_TITLE) {
    const markdown = convertSelectionTextToThreeColumns(editor, session.selection, session.from);
    const range = session.selection ? getSelectionVisualOffsetRange(session) : getSelectionOffsetRange(session);
    return { markdown, ...range };
  }
  if (label === DEQUOTE_MENU_TITLE) {
    if (hasSelection) return { markdown: unwrapSelectionText(session.selection), ...getSelectionOffsetRange(session) };
    if (session.headerCtx) {
      const block = gatherCalloutBlock(editor, session.headerCtx.headerLine);
      if (!block) return null;
      return { markdown: unwrapBlockLines(block.lines), ...getBlockOffsetRange(editor, block.headerLine, block.endLine) };
    }
  }

  if (!session.headerCtx) return null;
  const block = gatherCalloutBlock(editor, session.headerCtx.headerLine);
  if (!block) return null;
  const range = getBlockOffsetRange(editor, block.headerLine, block.endLine);

  if (label === "Par défaut") return { markdown: withColorInBlock(block, null), ...range };
  if (COLOR_LABEL_TO_ID.has(label)) return { markdown: withColorInBlock(block, COLOR_LABEL_TO_ID.get(label)), ...range };
  if (SIMPLE_METADATA_LABEL_TO_ID.has(label)) return { markdown: withToggledMetaInBlock(block, SIMPLE_METADATA_LABEL_TO_ID.get(label)), ...range };
  if (label === "Aucun") return { markdown: withClearedMetasInBlock(block), ...range };
  if (label === "Réinitialiser") return { markdown: withResetInBlock(block), ...range };

  return null;
}

function clearPreviewInView(view) {
  if (!view) return;
  try { view.dispatch({ effects: clearPreviewEffect.of(null) }); } catch (_) {}
}

function setPreviewActiveOnView(view, isActive) {
  const root = view?.dom;
  if (!root?.classList) return;
  root.classList.toggle("ccm-preview-active", !!isActive);
}


function hideElement(el) {
  if (!el) return null;
  const prev = el.getAttribute("style");
  el.style.display = "none";
  return prev;
}

function restoreElementStyle(el, prevStyle) {
  if (!el) return;
  if (prevStyle == null) el.removeAttribute("style");
  else el.setAttribute("style", prevStyle);
}
// -------------------- Plugin --------------------

module.exports = class CalloutContextMenuPlugin extends Plugin {
  onload() {
    this._previewVars = computeTypePreviewVars();
    this._previewSession = null;
    this._clearPreviewTimer = null;
    this._lastPreviewKey = "";
    this._previewView = null;
    this._renderedPreviewState = null;

    this.registerEditorExtension(createPreviewExtension(this.app));

    this._menuObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList.contains("menu")) ensurePreviewsInMenu(node, this._previewVars);
          node.querySelectorAll?.(".menu").forEach((el) => ensurePreviewsInMenu(el, this._previewVars));
        }
      }

      const hasOpenMenu = !!document.querySelector(".menu");
      if (!hasOpenMenu) this.clearPreviewNow();
    });
    this._menuObserver.observe(document.body, { childList: true, subtree: true });

    this.registerDomEvent(document, "mouseover", (evt) => this.handleGlobalMouseOver(evt), true);
    this.registerDomEvent(document, "mousedown", () => this.clearPreviewNow(), true);
    this.registerDomEvent(document, "scroll", () => this.clearPreviewNow(), true);
    this.registerDomEvent(window, "resize", () => this.clearPreviewNow(), true);

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        this._previewSession = capturePreviewSession(editor, this.app.workspace.getActiveFile()?.path || "");

        const ctx = findEnclosingCalloutHeader(editor);
        if (ctx) {
          addCalloutEditSubmenu(menu, editor, ctx.headerLine);
          addColorSubmenu(menu, editor, ctx.headerLine);
          addMetadataSubmenu(menu, editor, ctx.headerLine);
          addResetItem(menu, editor, ctx.headerLine);
          return;
        }

        addRootCalloutSubmenu(menu, editor);
        addRootColumnsSubmenu(menu, editor);
      })
    );

    const proto = Menu.prototype;
    this._origShowAtMouseEvent = proto.showAtMouseEvent;
    const plugin = this;

    proto.showAtMouseEvent = function (...args) {
      const e = args[0];
      const target = e?.target;

      try {
        if (target instanceof HTMLElement) {
          const cmCallout = target.closest(".cm-callout");
          if (cmCallout) {
            const ed = getEditorFromCmCallout(cmCallout);
            if (ed?.editor && ed?.widget) {
              const headerLine0 = getHeaderLineFromCmCallout(ed.editor, ed.widget);
              let hl = headerLine0;
              let parsed = parseCalloutHeader(ed.editor.getLine(hl));
              let guard = 0;

              while (!parsed && guard < 20) {
                hl++;
                parsed = parseCalloutHeader(ed.editor.getLine(hl));
                guard++;
              }
              if (!parsed) {
                hl = headerLine0;
                guard = 0;
                while (!parsed && hl > 0 && guard < 20) {
                  hl--;
                  const line = ed.editor.getLine(hl);
                  if (!line.startsWith(">")) break;
                  parsed = parseCalloutHeader(line);
                  guard++;
                }
              }

              if (parsed) {
                plugin._previewSession = capturePreviewSession(ed.editor, plugin.app.workspace.getActiveFile()?.path || "", { forcedHeaderLine: hl, renderedCalloutEl: cmCallout });
                addCalloutEditSubmenu(this, ed.editor, hl);
                addColorSubmenu(this, ed.editor, hl);
                addMetadataSubmenu(this, ed.editor, hl);
                addResetItem(this, ed.editor, hl);
              }
            }
          }
        }
      } catch (_) {}

      const out = plugin._origShowAtMouseEvent.apply(this, args);
      try {
        const candidates = Array.from(document.querySelectorAll(".menu"));
        for (const menuEl of candidates) ensurePreviewsInMenu(menuEl, plugin._previewVars);
      } catch (_) {}
      return out;
    };
  }

  handleGlobalMouseOver(evt) {
    const target = evt.target instanceof HTMLElement ? evt.target : null;
    if (!target) return;

    const menuItemEl = target.closest(".menu-item");
    if (!menuItemEl) {
      this.scheduleClearPreview();
      return;
    }

    const titleEl = menuItemEl.querySelector(".menu-item-title");
    const label = (titleEl?.textContent ?? "").trim();
    if (!label || !this._previewSession) {
      this.scheduleClearPreview();
      return;
    }

    const payload = buildPreviewPayloadFromLabel(this._previewSession, label);
    if (!payload?.markdown) {
      this.scheduleClearPreview();
      return;
    }

    this.showPreview(payload, label);
  }

  scheduleClearPreview() {
    if (this._clearPreviewTimer) window.clearTimeout(this._clearPreviewTimer);
    this._clearPreviewTimer = window.setTimeout(() => this.clearPreviewNow(), 50);
  }

  cancelClearPreview() {
    if (!this._clearPreviewTimer) return;
    window.clearTimeout(this._clearPreviewTimer);
    this._clearPreviewTimer = null;
  }

  showPreview(payload, label) {
    this.cancelClearPreview();
    const session = this._previewSession;
    if (!session?.editor) return;

    const targetKey = session.renderedCalloutEl ? `rendered::${session.headerCtx?.headerLine ?? -1}` : `editor::${payload.from ?? -1}::${payload.to ?? -1}`;
    const key = `${label}::${targetKey}::${payload.markdown}`;
    if (key === this._lastPreviewKey) return;

    if (session.renderedCalloutEl) {
      if (this._previewView) {
        setPreviewActiveOnView(this._previewView, false);
        clearPreviewInView(this._previewView);
        this._previewView = null;
      }
      this.showRenderedCalloutPreview(session.renderedCalloutEl, payload.markdown, session.sourcePath || "");
      this._lastPreviewKey = key;
      return;
    }

    const view = session.editor.cm;
    if (!view) return;

    if (this._renderedPreviewState) this.clearRenderedCalloutPreview();

    if (this._previewView && this._previewView !== view) {
      clearPreviewInView(this._previewView);
      setPreviewActiveOnView(this._previewView, false);
    }

    this._lastPreviewKey = key;
    this._previewView = view;
    setPreviewActiveOnView(view, true);

    try {
      view.dispatch({
        effects: setPreviewEffect.of({
          from: payload.from,
          to: payload.to,
          markdown: payload.markdown,
          sourcePath: session.sourcePath || ""
        })
      });
    } catch (_) {}
  }

  showRenderedCalloutPreview(calloutEl, markdown, sourcePath) {
    if (!(calloutEl instanceof HTMLElement)) return;

    const existing = this._renderedPreviewState;
    if (existing && existing.calloutEl !== calloutEl) this.clearRenderedCalloutPreview();

    const renderedEl = calloutEl.querySelector(":scope > .markdown-rendered") || calloutEl.querySelector(".markdown-rendered");
    if (!renderedEl) return;

    let state = this._renderedPreviewState;
    if (!state || state.calloutEl !== calloutEl) {
      const previewEl = document.createElement("div");
      previewEl.className = "markdown-rendered show-indentation-guide ccm-rendered-callout-preview";
      previewEl.setAttribute("data-ccm-preview", "true");
      previewEl.setAttribute("contenteditable", "false");
      previewEl.style.pointerEvents = "none";

      const buttonEl = calloutEl.querySelector(":scope > .edit-block-button") || calloutEl.querySelector(".edit-block-button");
      if (buttonEl?.parentElement === calloutEl) calloutEl.insertBefore(previewEl, buttonEl);
      else calloutEl.appendChild(previewEl);

      state = {
        calloutEl,
        renderedEl,
        renderedStyle: hideElement(renderedEl),
        buttonEl: buttonEl || null,
        buttonStyle: hideElement(buttonEl),
        previewEl,
        component: null
      };
      this._renderedPreviewState = state;
    }

    try { state.component?.unload?.(); } catch (_) {}
    state.previewEl.replaceChildren();

    const component = new Component();
    state.component = component;
    MarkdownRenderer.render(this.app, markdown, state.previewEl, sourcePath || "", component).catch(() => {
      if (!state.previewEl.isConnected) return;
      state.previewEl.textContent = markdown;
    });
  }

  clearRenderedCalloutPreview() {
    const state = this._renderedPreviewState;
    if (!state) return;

    try { state.component?.unload?.(); } catch (_) {}
    try { state.previewEl?.remove?.(); } catch (_) {}
    restoreElementStyle(state.renderedEl, state.renderedStyle);
    restoreElementStyle(state.buttonEl, state.buttonStyle);
    this._renderedPreviewState = null;
  }

  clearPreviewNow() {
    this.cancelClearPreview();
    this._lastPreviewKey = "";
    this.clearRenderedCalloutPreview();
    setPreviewActiveOnView(this._previewView, false);
    clearPreviewInView(this._previewView);
    this._previewView = null;

    if (!document.querySelector(".menu")) {
      this._previewSession = null;
    }
  }

  onunload() {
    this.clearPreviewNow();
    if (this._origShowAtMouseEvent) Menu.prototype.showAtMouseEvent = this._origShowAtMouseEvent;
    if (this._menuObserver) this._menuObserver.disconnect();
  }
};
