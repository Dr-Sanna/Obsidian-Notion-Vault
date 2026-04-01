const current = dv.current();
const folder = current.file.folder ?? "";
const folderBase = folder.split("/").filter(Boolean).pop() ?? "";

const className = input?.className ?? "pagination-nav";
const prevLabel = input?.prevLabel ?? "Précédent";
const nextLabel = input?.nextLabel ?? "Suivant";

const folderNoteNames = Array.isArray(input?.folderNoteNames)
  ? input.folderNoteNames
  : ["{folder}", "index", "README"];

dv.container.className += ` ${className}`;

const sameFolderPages = dv.pages()
  .where(p => p.file.folder === folder)
  .array();

const resolveFolderNoteName = (pattern) =>
  String(pattern ?? "")
    .replaceAll("{folder}", folderBase)
    .trim();

const candidatePaths = folderNoteNames
  .map(resolveFolderNoteName)
  .filter(name => name.length > 0)
  .map(name => (folder ? `${folder}/${name}.md` : `${name}.md`));

const folderNote =
  candidatePaths
    .map(path => sameFolderPages.find(p => p.file.path === path))
    .find(Boolean) ?? null;

const getOrder = (page) => {
  const raw = page.order ?? page["nav-order"];
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

const regularPages = sameFolderPages
  .filter(p => !folderNote || p.file.path !== folderNote.file.path)
  .sort((a, b) => {
    const ao = getOrder(a);
    const bo = getOrder(b);

    if (ao !== bo) return ao - bo;

    return a.file.name.localeCompare(b.file.name, undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });

const isCurrentFolderNote =
  !!folderNote && current.file.path === folderNote.file.path;

let prev = null;
let next = null;

if (isCurrentFolderNote) {
  next = regularPages[0] ?? null;
} else {
  const i = regularPages.findIndex(p => p.file.path === current.file.path);

  if (i !== -1) {
    prev = i > 0 ? regularPages[i - 1] : folderNote;
    next = i < regularPages.length - 1 ? regularPages[i + 1] : null;
  } else {
    prev = folderNote;
    next = regularPages[0] ?? null;
  }
}

const wrapper = dv.container.createDiv({ cls: "pagination-nav-grid" });

function openPage(path, evt) {
  const newLeaf = !!(evt?.metaKey || evt?.ctrlKey);
  app.workspace.openLinkText(path, current.file.path, newLeaf);
}

function normalizeAliases(value) {
  if (Array.isArray(value)) {
    return value
      .map(v => String(v ?? "").trim())
      .filter(Boolean);
  }

  const single = String(value ?? "").trim();
  return single ? [single] : [];
}

function getDisplayTitle(page) {
  const aliasCandidates = [
    ...normalizeAliases(page.alias),
    ...normalizeAliases(page.aliases),
    ...normalizeAliases(page.file?.aliases)
  ];

  return aliasCandidates[0] ?? page.file.name;
}

function makeCard(label, page, align = "left") {
  const btn = wrapper.createEl("button", {
    cls: `pagination-card pagination-card-${align}`,
    type: "button"
  });

  btn.addEventListener("click", (evt) => openPage(page.file.path, evt));

  btn.addEventListener("auxclick", (evt) => {
    if (evt.button === 1) {
      evt.preventDefault();
      openPage(page.file.path, evt);
    }
  });

  const meta = btn.createDiv({ cls: "pagination-card-meta" });
  meta.setText(label);

  const title = btn.createDiv({ cls: "pagination-card-title" });
  title.setText(getDisplayTitle(page));

  return btn;
}

if (prev) makeCard(`← ${prevLabel}`, prev, "left");
else wrapper.createDiv({ cls: "pagination-card-placeholder" });

if (next) makeCard(`${nextLabel} →`, next, "right");
else wrapper.createDiv({ cls: "pagination-card-placeholder" });
