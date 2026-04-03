const { Plugin, PluginSettingTab, Setting, Notice, Modal, getIcon, getIconIds, setIcon, MenuItem } = require('obsidian');

const DEFAULT_SETTINGS = {
  hiddenItemsText: '',
  moveRulesText: '',
  iconRulesText: '',
  caseSensitive: false,
  collapseWhitespace: true,
  detectedEntries: [],
  menuProfiles: {
    normal: [],
    heading: [],
    selection: [],
    other: []
  },
  activeProfileKey: 'normal',
  detectTargetProfileKey: 'normal',
  collapsedPaths: []
};

const MENU_PROFILE_DEFS = [
  { key: 'normal', label: 'Menu normal' },
  { key: 'heading', label: 'Menu entête' },
  { key: 'selection', label: 'Texte sélectionné' },
  { key: 'other', label: 'Autres' }
];
const MENU_PROFILE_KEYS = MENU_PROFILE_DEFS.map((def) => def.key);

const PATH_SEPARATOR = ' > ';
const ROOT_LABEL = '@root';
const HIDE_PREFIX = 'path:';
const TITLE_PREFIX = 'title:';
const SEP_PREFIX = 'sep:';
const TITLE_HIDE_CLASS = 'cmm-hide-item-title';
const PATH_HIDE_CLASS = 'cmm-hide-item-path';
const ANY_HIDE_CLASS = 'cmm-hide-item';


function createEmptyMenuProfiles() {
  return {
    normal: [],
    heading: [],
    selection: [],
    other: []
  };
}

function cloneMenuProfiles(profiles) {
  const out = createEmptyMenuProfiles();
  const src = profiles && typeof profiles === 'object' ? profiles : {};
  for (const key of MENU_PROFILE_KEYS) {
    out[key] = Array.isArray(src[key]) ? src[key].map((entry) => cloneEntryForStorage(entry)) : [];
  }
  return out;
}

function normalizeMenuProfileKey(value) {
  const key = String(value || '').trim();
  return MENU_PROFILE_KEYS.includes(key) ? key : 'normal';
}

function getMenuProfileLabel(key) {
  return MENU_PROFILE_DEFS.find((def) => def.key === key)?.label || key;
}

function getProfileEntriesFromSettings(settings, profileKey) {
  const key = normalizeMenuProfileKey(profileKey);
  const profiles = settings?.menuProfiles && typeof settings.menuProfiles === 'object'
    ? settings.menuProfiles
    : createEmptyMenuProfiles();
  return Array.isArray(profiles[key]) ? profiles[key] : [];
}

function setProfileEntriesOnSettings(settings, profileKey, entries) {
  if (!settings.menuProfiles || typeof settings.menuProfiles !== 'object') settings.menuProfiles = createEmptyMenuProfiles();
  const key = normalizeMenuProfileKey(profileKey);
  settings.menuProfiles[key] = Array.isArray(entries) ? entries.map((entry) => cloneEntryForStorage(entry)) : [];
}

function flattenMenuProfiles(settings) {
  const out = [];
  for (const def of MENU_PROFILE_DEFS) {
    out.push(...getProfileEntriesFromSettings(settings, def.key));
  }
  return out;
}

function getTotalProfileEntryCount(settings) {
  return flattenMenuProfiles(settings).length;
}

function hasDocumentTextSelection(doc) {
  try {
    const sel = doc?.getSelection?.() || window.getSelection?.();
    return !!String(sel?.toString?.() || '').trim();
  } catch (_) {
    return false;
  }
}

function isHeadingEventTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('h1, h2, h3, h4, h5, h6, .cm-header, .HyperMD-header, .markdown-preview-view .heading, .heading-collapse-indicator');
}

function inferMenuProfileFromEvent(evt) {
  const target = evt?.target;
  const doc = target?.ownerDocument || document;
  if (hasDocumentTextSelection(doc)) return 'selection';
  if (isHeadingEventTarget(target)) return 'heading';
  return 'normal';
}

function inferMenuProfileFromSnapshot(showRequest, snapshot) {
  const hinted = normalizeMenuProfileKey(showRequest?.profileKey || '');
  const titles = Array.isArray(snapshot) ? snapshot.filter((e) => e.kind === 'item').map((e) => String(e.title || '')) : [];
  if (titles.some((title) => /rechercher/i.test(title))) return 'selection';
  if (hinted === 'heading' || hinted === 'selection') return hinted;
  if (hinted && hinted !== 'normal') return hinted;
  return 'normal';
}

function normalizeText(value, settings) {
  let out = String(value ?? '').trim();
  if (settings.collapseWhitespace) out = out.replace(/\s+/g, ' ');
  if (!settings.caseSensitive) out = out.toLocaleLowerCase();
  return out;
}

function normalizePathInput(value) {
  return String(value ?? '')
    .replace(/\s*[›→]\s*/g, PATH_SEPARATOR)
    .replace(/\s*>\s*/g, PATH_SEPARATOR)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSelectorValue(mode, value, settings) {
  if (mode === 'title') return normalizeText(value, settings);
  if (mode === 'sep') {
    const m = /^(.+?)#(\d+)$/.exec(String(value ?? '').trim());
    if (!m) return normalizeText(value, settings);
    const parent = normalizePathInput(m[1] === ROOT_LABEL ? ROOT_LABEL : m[1]);
    const index = Number(m[2]);
    const parentNorm = normalizeText(parent, settings);
    return `${SEP_PREFIX}${parentNorm}#${Number.isFinite(index) ? index : 0}`;
  }
  return normalizeText(normalizePathInput(value), settings);
}

function parseExactSelector(selectorText, settings) {
  const raw = String(selectorText ?? '').trim();
  const lower = raw.toLocaleLowerCase();
  let mode = 'path';
  let value = raw;
  if (lower.startsWith(TITLE_PREFIX)) {
    mode = 'title';
    value = raw.slice(TITLE_PREFIX.length).trim();
  } else if (lower.startsWith(HIDE_PREFIX)) {
    mode = 'path';
    value = raw.slice(HIDE_PREFIX.length).trim();
  } else if (lower.startsWith(SEP_PREFIX)) {
    mode = 'sep';
    value = raw.slice(SEP_PREFIX.length).trim();
  }
  return {
    raw,
    mode,
    value,
    norm: normalizeSelectorValue(mode, value, settings)
  };
}

function parseHiddenSelectors(text, settings) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => parseExactSelector(line, settings));
}

function parseMoveRules(text, settings) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const m = /^(.*?)\s*=>\s*(before|after)\s+(.*?)$/i.exec(line);
      if (!m) return null;
      const source = parseExactSelector(m[1].trim(), settings);
      const relation = m[2].toLowerCase();
      const target = parseExactSelector(m[3].trim(), settings);
      return { raw: line, source, relation, target };
    })
    .filter(Boolean);
}

function parseIconRules(text, settings) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const m = /^(.*?)\s*=>\s*(.*?)$/i.exec(line);
      if (!m) return null;
      const selector = parseExactSelector(m[1].trim(), settings);
      const icon = String(m[2] ?? '').trim();
      if (!icon) return null;
      return { raw: line, selector, icon };
    })
    .filter(Boolean);
}

function buildPathSelector(path) {
  return `${HIDE_PREFIX}${String(path ?? '').trim()}`;
}

function buildTitleSelector(title) {
  return `${TITLE_PREFIX}${String(title ?? '').trim()}`;
}

function buildSeparatorSelector(parentPath, index) {
  return `${SEP_PREFIX}${parentPath && String(parentPath).trim() ? String(parentPath).trim() : ROOT_LABEL}#${index}`;
}

function isElementVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisibleMenuEls() {
  return Array.from(document.querySelectorAll('.menu'))
    .filter((el) => el instanceof HTMLElement)
    .filter((el) => isElementVisible(el));
}

function getMenuScrollEl(menuEl) {
  if (!(menuEl instanceof HTMLElement)) return null;
  return menuEl.querySelector(':scope > .menu-scroll') || menuEl;
}

function getMenuChildNodes(scrollEl) {
  if (!(scrollEl instanceof HTMLElement)) return [];
  return Array.from(scrollEl.children || []).filter((child) => (
    child instanceof HTMLElement && (child.matches('.menu-group') || child.matches('.menu-separator'))
  ));
}

function getItemTitle(itemEl) {
  if (!(itemEl instanceof HTMLElement)) return '(sans titre)';
  const titleEl = itemEl.querySelector(':scope > .menu-item-title');
  const text = titleEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
  return text || '(sans titre)';
}

function getItemIconData(itemEl) {
  if (!(itemEl instanceof HTMLElement)) return { icon: '', iconSvgHtml: '' };
  const iconContainer = itemEl.querySelector(':scope > .menu-item-icon:not(.mod-submenu)');
  if (!(iconContainer instanceof HTMLElement)) return { icon: '', iconSvgHtml: '' };

  const svg = iconContainer.querySelector('svg');
  if (!(svg instanceof SVGElement)) return { icon: '', iconSvgHtml: '' };

  const classes = Array.from(svg.classList || []);
  const lucide = classes.find((cls) => cls.startsWith('lucide-')) || '';
  if (lucide) return { icon: lucide, iconSvgHtml: '' };

  const wrapper = document.createElement('div');
  wrapper.appendChild(svg.cloneNode(true));
  return { icon: '', iconSvgHtml: wrapper.innerHTML };
}

function parseMenuEntries(menuEl) {
  const scrollEl = getMenuScrollEl(menuEl);
  if (!scrollEl) return [];

  const out = [];
  const childNodes = getMenuChildNodes(scrollEl);
  let order = 0;

  for (const child of childNodes) {
    if (child.matches('.menu-separator')) {
      out.push({
        kind: 'separator',
        title: '—',
        el: child,
        groupEl: null,
        order: order++
      });
      continue;
    }

    const groupEl = child;
    const items = Array.from(groupEl.children || []).filter((node) => node instanceof HTMLElement && node.matches('.menu-item'));
    for (const itemEl of items) {
      out.push({
        kind: 'item',
        title: getItemTitle(itemEl),
        el: itemEl,
        groupEl,
        order: order++,
        hasSubmenu: itemEl.classList.contains('has-submenu'),
        selected: itemEl.classList.contains('selected'),
        disabled: itemEl.classList.contains('is-disabled'),
        section: itemEl.getAttribute('data-section') || '',
        ...getItemIconData(itemEl),
        isLabel: itemEl.classList.contains('is-label')
      });
    }
  }

  return out;
}

function scoreMenuParent(childMenu, parentMenu, parentEntry) {
  if (!childMenu || !parentMenu || !parentEntry) return Number.POSITIVE_INFINITY;
  const menuRect = childMenu.rect;
  const itemRect = parentEntry.el.getBoundingClientRect();

  const opensRight = menuRect.left >= itemRect.right - 8;
  const opensLeft = menuRect.right <= itemRect.left + 8;
  const horizontalGap = opensRight
    ? Math.abs(menuRect.left - itemRect.right)
    : opensLeft
      ? Math.abs(itemRect.left - menuRect.right)
      : Math.min(Math.abs(menuRect.left - itemRect.right), Math.abs(itemRect.left - menuRect.right)) + 400;

  const verticalDistance = Math.abs(menuRect.top - itemRect.top);
  const overlap = Math.max(0, Math.min(menuRect.bottom, itemRect.bottom) - Math.max(menuRect.top, itemRect.top));
  const overlapBonus = overlap > 0 ? Math.min(80, overlap) : 0;
  return horizontalGap * 4 + verticalDistance - overlapBonus;
}

function buildDomSnapshot() {
  const menuEls = getVisibleMenuEls();
  if (menuEls.length === 0) return [];

  const menus = menuEls.map((menuEl, index) => ({
    index,
    menuEl,
    scrollEl: getMenuScrollEl(menuEl),
    rect: menuEl.getBoundingClientRect(),
    entries: parseMenuEntries(menuEl),
    parentMenuIndex: null,
    parentEntryIndex: null,
    childMenus: []
  }));

  menus.sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top || a.index - b.index);
  menus.forEach((menu, index) => { menu.index = index; });

  function findBestParentForChildMenu(childMenu, candidateMenuIndexes) {
    let best = null;
    for (const menuIndex of candidateMenuIndexes) {
      const parentMenu = menus[menuIndex];
      if (!parentMenu) continue;

      const submenuEntries = parentMenu.entries
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(({ entry }) => entry.kind === 'item' && entry.hasSubmenu);
      if (submenuEntries.length === 0) continue;

      const selectedEntries = submenuEntries.filter(({ entry }) => entry.selected);
      const preferredEntries = selectedEntries.length > 0 ? selectedEntries : submenuEntries;

      for (const { entry, entryIndex } of preferredEntries) {
        let score = scoreMenuParent(childMenu, parentMenu, entry);
        if (entry.selected) score -= 320;
        if (!best || score < best.score) {
          best = { parentMenuIndex: menuIndex, parentEntryIndex: entryIndex, score };
        }
      }
    }
    return best;
  }

  for (let i = 1; i < menus.length; i += 1) {
    const childMenu = menus[i];

    const menusToLeft = [];
    for (let j = 0; j < i; j += 1) {
      if (menus[j].rect.left <= childMenu.rect.left - 4) menusToLeft.push(j);
    }

    let best = null;
    if (menusToLeft.length > 0) {
      const nearestLeft = Math.max(...menusToLeft.map((idx) => menus[idx].rect.left));
      const nearestLeftMenus = menusToLeft.filter((idx) => Math.abs(menus[idx].rect.left - nearestLeft) <= 24);
      best = findBestParentForChildMenu(childMenu, nearestLeftMenus);
    }

    if (!best) {
      const allPreviousMenus = Array.from({ length: i }, (_, idx) => idx);
      best = findBestParentForChildMenu(childMenu, allPreviousMenus);
    }

    if (best && best.score < 900) {
      childMenu.parentMenuIndex = best.parentMenuIndex;
      childMenu.parentEntryIndex = best.parentEntryIndex;
      menus[best.parentMenuIndex].childMenus.push(i);
    }
  }

  const out = [];
  const visitedMenus = new Set();
  let globalOrder = 0;

  const walkMenu = (menuIndex, ancestors) => {
    if (visitedMenus.has(menuIndex)) return;
    visitedMenus.add(menuIndex);

    const menu = menus[menuIndex];
    let separatorCount = 0;

    for (let entryIndex = 0; entryIndex < menu.entries.length; entryIndex += 1) {
      const entry = menu.entries[entryIndex];
      const parentPath = ancestors.join(PATH_SEPARATOR);

      if (entry.kind === 'separator') {
        separatorCount += 1;
        const selector = buildSeparatorSelector(parentPath, separatorCount);
        out.push({
          kind: 'separator',
          title: '—',
          path: `${parentPath}${parentPath ? PATH_SEPARATOR : ''}—`,
          selector,
          parentPath,
          depth: ancestors.length,
          order: globalOrder++,
          menuIndex,
          entryIndex,
          el: entry.el,
          groupEl: entry.groupEl || null
        });
        continue;
      }

      const title = entry.title || '(sans titre)';
      const path = [...ancestors, title].join(PATH_SEPARATOR);
      const selector = buildPathSelector(path);
      const childMenuIndex = menus.findIndex((candidate) => (
        candidate.parentMenuIndex === menuIndex && candidate.parentEntryIndex === entryIndex
      ));
      const hasSubmenu = childMenuIndex >= 0;

      if (entry.el instanceof HTMLElement) entry.el.dataset.cmmRuntimePath = path;
      out.push({
        kind: 'item',
        title,
        path,
        selector,
        parentPath,
        depth: ancestors.length,
        order: globalOrder++,
        hasSubmenu,
        disabled: !!entry.disabled,
        icon: entry.icon || '',
        iconSvgHtml: entry.iconSvgHtml || '',
        section: entry.section || '',
        isLabel: !!entry.isLabel,
        selected: !!entry.selected,
        menuIndex,
        entryIndex,
        el: entry.el,
        groupEl: entry.groupEl || null
      });

      if (childMenuIndex >= 0) walkMenu(childMenuIndex, [...ancestors, title]);
    }
  };

  const rootMenus = menus
    .filter((menu) => menu.parentMenuIndex == null)
    .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top || a.index - b.index);

  rootMenus.forEach((menu) => walkMenu(menu.index, []));
  return out;
}

function resetMenuClasses(menuEls) {
  for (const menuEl of menuEls) {
    menuEl.querySelectorAll(`.${ANY_HIDE_CLASS}`).forEach((el) => {
      el.classList.remove(ANY_HIDE_CLASS, TITLE_HIDE_CLASS, PATH_HIDE_CLASS);
    });
    menuEl.querySelectorAll('.menu-item').forEach((itemEl) => {
      if (itemEl instanceof HTMLElement) {
        resetItemIconOverride(itemEl);
        delete itemEl.dataset.cmmRuntimePath;
      }
    });
    const scrollEl = getMenuScrollEl(menuEl);
    if (!scrollEl) continue;
    const directChildren = getMenuChildNodes(scrollEl);
    for (const child of directChildren) {
      child.classList.remove('cmm-empty-group', 'cmm-hide-separator');
    }
  }
}

function cleanupVisibleMenus(menuEls) {
  for (const menuEl of menuEls) {
    const scrollEl = getMenuScrollEl(menuEl);
    if (!scrollEl) continue;

    const directChildren = getMenuChildNodes(scrollEl);

    for (const child of directChildren) {
      if (child.matches('.menu-group')) {
        const items = Array.from(child.children || []).filter((node) => node instanceof HTMLElement && node.matches('.menu-item'));
        const hasVisibleItems = items.some((item) => !item.classList.contains(ANY_HIDE_CLASS));
        child.classList.toggle('cmm-empty-group', !hasVisibleItems);
      }
    }

    let previousWasSeparator = true;
    const visibleDirectChildren = directChildren.filter((child) => !child.classList.contains('cmm-empty-group') && !child.classList.contains('cmm-hide-separator'));
    for (const child of visibleDirectChildren) {
      if (child.matches('.menu-separator')) {
        child.classList.toggle('cmm-hide-separator', previousWasSeparator);
        previousWasSeparator = true;
      } else {
        child.classList.remove('cmm-hide-separator');
        previousWasSeparator = false;
      }
    }

    let seenVisibleItemBlock = false;
    for (let i = visibleDirectChildren.length - 1; i >= 0; i -= 1) {
      const child = visibleDirectChildren[i];
      if (child.classList.contains('cmm-hide-separator')) continue;
      if (!child.matches('.menu-separator')) {
        seenVisibleItemBlock = true;
        break;
      }
      if (!seenVisibleItemBlock) child.classList.add('cmm-hide-separator');
    }
  }
}

function cloneEntryForStorage(entry) {
  const clone = Object.assign({}, entry);
  delete clone.el;
  delete clone.groupEl;
  return clone;
}

function getStoredEntryMergeKey(entry) {
  if (!entry) return '';
  const kind = entry.kind || 'item';
  const selector = String(entry.selector || '').trim();
  if (selector) return `${kind}::${selector}`;
  const path = String(entry.path || entry.title || '').trim();
  const parentPath = String(entry.parentPath || '').trim();
  return `${kind}::${parentPath}::${path}`;
}

function findNearestSharedKeyBefore(list, startIndex, sharedKeySet) {
  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const key = getStoredEntryMergeKey(list[i]);
    if (sharedKeySet.has(key)) return key;
  }
  return null;
}

function findNearestSharedKeyAfter(list, startIndex, sharedKeySet) {
  for (let i = startIndex + 1; i < list.length; i += 1) {
    const key = getStoredEntryMergeKey(list[i]);
    if (sharedKeySet.has(key)) return key;
  }
  return null;
}

function mergeGroupEntries(existingGroup, incomingGroup) {
  const existing = existingGroup.map((entry) => cloneEntryForStorage(entry));
  const incoming = incomingGroup.map((entry) => cloneEntryForStorage(entry));

  const existingByKey = new Map();
  for (const entry of existing) {
    const key = getStoredEntryMergeKey(entry);
    if (key && !existingByKey.has(key)) existingByKey.set(key, entry);
  }

  const incomingByKey = new Map();
  for (const entry of incoming) {
    const key = getStoredEntryMergeKey(entry);
    if (key && !incomingByKey.has(key)) incomingByKey.set(key, entry);
  }

  const sharedKeys = new Set([...incomingByKey.keys()].filter((key) => existingByKey.has(key)));
  const merged = existing.map((entry) => {
    const key = getStoredEntryMergeKey(entry);
    if (!key || !incomingByKey.has(key)) return entry;
    const incomingEntry = incomingByKey.get(key) || {};
    return {
      ...entry,
      ...incomingEntry,
      hasSubmenu: !!(entry?.hasSubmenu || incomingEntry?.hasSubmenu)
    };
  });

  const mergedIndexByKey = new Map();
  const rebuildIndex = () => {
    mergedIndexByKey.clear();
    merged.forEach((entry, index) => {
      const key = getStoredEntryMergeKey(entry);
      if (key) mergedIndexByKey.set(key, index);
    });
  };
  rebuildIndex();

  for (let i = 0; i < incoming.length; i += 1) {
    const entry = incoming[i];
    const key = getStoredEntryMergeKey(entry);
    if (!key || sharedKeys.has(key) || mergedIndexByKey.has(key)) continue;

    const prevSharedKey = findNearestSharedKeyBefore(incoming, i, sharedKeys);
    const nextSharedKey = findNearestSharedKeyAfter(incoming, i, sharedKeys);

    let insertIndex = merged.length;
    if (prevSharedKey && mergedIndexByKey.has(prevSharedKey)) {
      insertIndex = mergedIndexByKey.get(prevSharedKey) + 1;
    }
    if (nextSharedKey && mergedIndexByKey.has(nextSharedKey)) {
      const nextIndex = mergedIndexByKey.get(nextSharedKey);
      insertIndex = prevSharedKey ? Math.min(insertIndex, nextIndex) : nextIndex;
    }

    merged.splice(insertIndex, 0, entry);
    rebuildIndex();
  }

  const incomingOrderIndex = new Map();
  incoming.forEach((entry, index) => {
    const key = getStoredEntryMergeKey(entry);
    if (key && !incomingOrderIndex.has(key)) incomingOrderIndex.set(key, index);
  });

  let tailOrder = incoming.length;
  return merged.map((entry) => {
    const key = getStoredEntryMergeKey(entry);
    const order = incomingOrderIndex.has(key) ? incomingOrderIndex.get(key) : tailOrder++;
    return {
      ...entry,
      order
    };
  });
}

function mergeStoredDetectedEntries(existingEntries, incomingEntries) {
  const existing = Array.isArray(existingEntries) ? existingEntries.map((entry) => cloneEntryForStorage(entry)) : [];
  const incoming = Array.isArray(incomingEntries) ? incomingEntries.map((entry) => cloneEntryForStorage(entry)) : [];

  const groups = new Map();
  const touchGroup = (parentPath) => {
    const key = String(parentPath || '');
    if (!groups.has(key)) groups.set(key, { existing: [], incoming: [] });
    return groups.get(key);
  };

  for (const entry of existing) touchGroup(entry.parentPath).existing.push(entry);
  for (const entry of incoming) touchGroup(entry.parentPath).incoming.push(entry);

  for (const group of groups.values()) {
    group.existing.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    group.incoming.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  const parentPaths = Array.from(groups.keys());
  const depthForParent = (parentPath) => {
    if (!parentPath) return 0;
    return String(parentPath).split(PATH_SEPARATOR).length;
  };
  parentPaths.sort((a, b) => depthForParent(a) - depthForParent(b) || a.localeCompare(b));

  const mergedOut = [];
  for (const parentPath of parentPaths) {
    const group = groups.get(parentPath);
    const mergedGroup = mergeGroupEntries(group.existing, group.incoming);
    mergedOut.push(...mergedGroup);
  }

  const parentPathSet = new Set(
    mergedOut
      .map((entry) => String(entry?.parentPath || '').trim())
      .filter(Boolean)
  );

  return mergedOut.map((entry, index) => ({
    ...entry,
    hasSubmenu: entry.kind === 'item' ? !!(entry.hasSubmenu || parentPathSet.has(String(entry.path || '').trim())) : entry.hasSubmenu,
    order: entry.order ?? index
  }));
}

function getPrimaryIconContainer(itemEl, createIfMissing = false) {
  if (!(itemEl instanceof HTMLElement)) return null;
  let container = itemEl.querySelector(':scope > .menu-item-icon:not(.mod-submenu)');
  if (container instanceof HTMLElement) return container;
  if (!createIfMissing) return null;

  container = document.createElement('div');
  container.className = 'menu-item-icon cmm-primary-icon';

  const titleEl = itemEl.querySelector(':scope > .menu-item-title');
  if (titleEl instanceof HTMLElement) itemEl.insertBefore(container, titleEl);
  else itemEl.prepend(container);
  return container;
}

function resetItemIconOverride(itemEl) {
  const container = getPrimaryIconContainer(itemEl, false);
  if (!(container instanceof HTMLElement)) return;

  if (container.dataset.cmmOriginalHtml != null) {
    container.innerHTML = container.dataset.cmmOriginalHtml;
  }
  if (container.dataset.cmmOriginalStyle != null) {
    container.setAttribute('style', container.dataset.cmmOriginalStyle);
  } else {
    container.removeAttribute('style');
  }
  delete container.dataset.cmmOriginalHtml;
  delete container.dataset.cmmOriginalStyle;
  delete container.dataset.cmmIconOverride;
  container.classList.remove('cmm-icon-overridden');
}

function applyIconOverrideToItemEl(itemEl, iconValue) {
  if (!(itemEl instanceof HTMLElement)) return false;
  const icon = String(iconValue ?? '').trim();
  if (!icon) return false;

  const container = getPrimaryIconContainer(itemEl, true);
  if (!(container instanceof HTMLElement)) return false;

  if (container.dataset.cmmOriginalHtml == null) {
    container.dataset.cmmOriginalHtml = container.innerHTML;
  }
  if (container.dataset.cmmOriginalStyle == null) {
    container.dataset.cmmOriginalStyle = container.getAttribute('style') || '';
  }

  container.style.display = 'inline-flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  container.style.visibility = 'visible';
  container.style.opacity = '1';

  const normalizedIcon = icon.replace(/^lucide-/, '');
  if (/^(none|hide|empty)$/i.test(normalizedIcon)) {
    container.innerHTML = '';
    container.dataset.cmmIconOverride = 'none';
    container.classList.add('cmm-icon-overridden');
    return true;
  }

  let svg = null;
  try {
    svg = typeof getIcon === 'function' ? getIcon(normalizedIcon) : null;
  } catch (_) {
    svg = null;
  }
  if (!svg) return false;

  svg.addClass('cmm-menu-icon-override');
  container.replaceChildren(svg);
  container.dataset.cmmIconOverride = normalizedIcon;
  container.classList.add('cmm-icon-overridden');
  return true;
}

function getIconRuleMatchInfo(entry, rules, settings) {
  const titleNorm = normalizeText(entry.title, settings);
  const pathNorm = normalizeSelectorValue('path', entry.path, settings);
  let matchedPathRule = null;
  let matchedTitleRule = null;

  for (const rule of rules) {
    if (rule.selector.mode === 'path' && rule.selector.norm === pathNorm) matchedPathRule = rule;
    if (rule.selector.mode === 'title' && rule.selector.norm === titleNorm) matchedTitleRule = rule;
  }

  return {
    matchedPathRule,
    matchedTitleRule,
    matchedRule: matchedPathRule || matchedTitleRule || null
  };
}

function getRuleMatchInfo(entry, rules, settings) {
  const titleNorm = normalizeText(entry.title, settings);
  const pathNorm = normalizeSelectorValue('path', entry.path, settings);
  let matchedPathRule = null;
  let matchedTitleRule = null;

  for (const rule of rules) {
    if (rule.mode === 'path' && rule.norm === pathNorm) matchedPathRule = rule;
    if (rule.mode === 'title' && rule.norm === titleNorm) matchedTitleRule = rule;
  }

  return {
    matchedPathRule,
    matchedTitleRule,
    isHidden: !!(matchedPathRule || matchedTitleRule)
  };
}

function rebuildMenuFromTokens(menuEl, orderedEntries) {
  const scrollEl = getMenuScrollEl(menuEl);
  if (!(scrollEl instanceof HTMLElement)) return false;

  const newChildren = [];
  let currentGroup = null;
  let changed = false;

  const ensureGroup = () => {
    if (!currentGroup) {
      currentGroup = document.createElement('div');
      currentGroup.className = 'menu-group';
      newChildren.push(currentGroup);
    }
    return currentGroup;
  };

  for (const entry of orderedEntries) {
    if (!(entry?.el instanceof HTMLElement)) continue;
    if (entry.kind === 'separator') {
      currentGroup = null;
      newChildren.push(entry.el);
      continue;
    }
    ensureGroup().appendChild(entry.el);
  }

  const oldChildren = getMenuChildNodes(scrollEl);
  if (oldChildren.length !== newChildren.length) {
    changed = true;
  } else {
    for (let i = 0; i < oldChildren.length; i += 1) {
      if (oldChildren[i] !== newChildren[i]) {
        changed = true;
        break;
      }
    }
  }

  if (!changed) return false;

  scrollEl.replaceChildren(...newChildren);
  return true;
}

function moveArrayEntry(arr, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= arr.length || toIndex >= arr.length) return false;
  const [item] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, item);
  return true;
}

function getEntrySelector(entry) {
  if (!entry) return '';
  if (entry.selector) return entry.selector;
  if (entry.kind === 'separator') return buildSeparatorSelector(entry.parentPath || '', 1);
  return buildPathSelector(entry.path || entry.title || '');
}

function applyMoveRulesToStoredEntries(entries, rules, settings) {
  const cloned = (Array.isArray(entries) ? entries : []).map((entry, index) => ({ ...entry, _sourceIndex: index }));
  if (cloned.length === 0 || !Array.isArray(rules) || rules.length === 0) return cloned;

  const groups = new Map();
  for (const entry of cloned) {
    const key = `${entry.parentPath || ''}@@${entry.depth || 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const arr of groups.values()) arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const findEntryIndex = (entriesInGroup, selector) => entriesInGroup.findIndex((entry) => {
    if (entry.kind === 'item' && selector.mode === 'path') {
      return normalizeSelectorValue('path', entry.path, settings) === selector.norm;
    }
    if (entry.kind === 'item' && selector.mode === 'title') {
      return normalizeText(entry.title, settings) === selector.norm;
    }
    if (entry.kind === 'separator' && selector.mode === 'sep') {
      const entryNorm = normalizeSelectorValue('sep', String(entry.selector || '').slice(SEP_PREFIX.length), settings);
      return entryNorm === selector.norm;
    }
    return false;
  });

  for (const entriesInGroup of groups.values()) {
    for (const rule of rules) {
      const sourceIndex = findEntryIndex(entriesInGroup, rule.source);
      const targetIndex = findEntryIndex(entriesInGroup, rule.target);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) continue;

      const targetEntry = entriesInGroup[targetIndex];
      const [sourceEntry] = entriesInGroup.splice(sourceIndex, 1);
      let nextTargetIndex = entriesInGroup.findIndex((entry) => entry === targetEntry);
      if (nextTargetIndex < 0) {
        entriesInGroup.push(sourceEntry);
        continue;
      }
      if (rule.relation === 'after') nextTargetIndex += 1;
      entriesInGroup.splice(nextTargetIndex, 0, sourceEntry);
    }
  }

  const out = [];
  const seen = new Set();
  const visitGroup = (parentPath, depth) => {
    const key = `${parentPath || ''}@@${depth || 0}`;
    const group = groups.get(key) || [];
    for (const entry of group) {
      const id = `${entry._sourceIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
      const childKey = `${entry.path || ''}@@${(entry.depth || 0) + 1}`;
      if (entry.kind === 'item' && groups.has(childKey)) visitGroup(entry.path || '', (entry.depth || 0) + 1);
    }
  };

  visitGroup('', 0);
  for (const entry of cloned) {
    const id = `${entry._sourceIndex}`;
    if (!seen.has(id)) out.push(entry);
  }
  return out.map((entry) => {
    const clone = { ...entry };
    delete clone._sourceIndex;
    return clone;
  });
}

module.exports = class ContextMenuManagerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.detectedEntries)) this.settings.detectedEntries = [];
    if (!Array.isArray(this.settings.collapsedPaths)) this.settings.collapsedPaths = [];
    if (!this.settings.menuProfiles || typeof this.settings.menuProfiles !== 'object') {
      this.settings.menuProfiles = createEmptyMenuProfiles();
    }
    this.settings.menuProfiles = cloneMenuProfiles(this.settings.menuProfiles);
    if (this.settings.detectedEntries.length && getTotalProfileEntryCount(this.settings) === 0) {
      this.settings.menuProfiles.normal = this.settings.detectedEntries.map((entry) => cloneEntryForStorage(entry));
    }
    this.settings.activeProfileKey = normalizeMenuProfileKey(this.settings.activeProfileKey || 'normal');
    this.settings.detectTargetProfileKey = normalizeMenuProfileKey(this.settings.detectTargetProfileKey || this.settings.activeProfileKey || 'normal');
    this.settings.detectedEntries = flattenMenuProfiles(this.settings);

    this.isDetecting = false;
    this.detectedEntriesLiveByProfile = cloneMenuProfiles(this.settings.menuProfiles);
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    this.installMenuPatches();
    this.addCommands();
    this.addSettingTab(new ContextMenuManagerSettingTab(this.app, this));
  }

  onunload() {
    this.uninstallMenuPatches();
  }

  getProfileEntries(profileKey) {
    return getProfileEntriesFromSettings(this.settings, profileKey);
  }

  setProfileEntries(profileKey, entries) {
    setProfileEntriesOnSettings(this.settings, profileKey, entries);
    this.settings.detectedEntries = flattenMenuProfiles(this.settings);
  }

  getAvailableProfileDefs() {
    const defs = [];
    for (const def of MENU_PROFILE_DEFS) {
      const count = this.getProfileEntries(def.key).length;
      if (count > 0 || def.key === this.settings.activeProfileKey) defs.push({ ...def, count });
    }
    if (defs.length === 0) return MENU_PROFILE_DEFS.map((def) => ({ ...def, count: 0 }));
    return defs;
  }

  getDetectTargetProfileKey() {
    return normalizeMenuProfileKey(this.settings.detectTargetProfileKey || 'normal');
  }

  async setDetectTargetProfileKey(profileKey, refresh = true) {
    this.settings.detectTargetProfileKey = normalizeMenuProfileKey(profileKey);
    await this.saveSettings();
    this.updateStatusBar();
    if (refresh) this.refreshSettingTab();
  }

  addCommands() {
    this.addCommand({
      id: 'start-menu-detection',
      name: 'Lancer la détection du menu contextuel',
      callback: () => this.startDetection()
    });

    for (const def of MENU_PROFILE_DEFS) {
      this.addCommand({
        id: `set-detect-target-${def.key}`,
        name: `Définir la cible de détection : ${def.label}`,
        callback: async () => {
          await this.setDetectTargetProfileKey(def.key);
          new Notice(`Cible de détection : ${def.label}`);
        }
      });
    }

    this.addCommand({
      id: 'stop-menu-detection',
      name: 'Arrêter la détection du menu contextuel',
      callback: () => this.stopDetection(true)
    });

    this.addCommand({
      id: 'clear-detected-entries',
      name: 'Effacer les entrées de menu détectées',
      callback: async () => {
        this.detectedEntriesLiveByProfile = createEmptyMenuProfiles();
        this.settings.menuProfiles = createEmptyMenuProfiles();
        this.settings.detectedEntries = [];
        await this.saveSettings();
        this.refreshSettingTab();
        new Notice('Entrées détectées effacées.');
      }
    });
  }

  installMenuPatches() {
    const obsidian = require('obsidian');
    const { Menu } = obsidian;

    this._orig = {
      showAtMouseEvent: Menu.prototype.showAtMouseEvent,
      showAtPosition: Menu.prototype.showAtPosition,
      setTitle: MenuItem?.prototype?.setTitle
    };

    const plugin = this;

    if (MenuItem?.prototype?.setTitle) {
      MenuItem.prototype.setTitle = function(title) {
        const result = plugin._orig.setTitle.call(this, title);
        try {
          const dom = this?.dom;
          if (dom instanceof HTMLElement) {
            dom.dataset.cmmTitle = String(title ?? '');
            plugin.applyTitleRuleToItemEl(dom, String(title ?? ''));
          }
        } catch (_) {}
        return result;
      };
    }

    Menu.prototype.showAtMouseEvent = function(evt) {
      const beforeMenus = new Set(getVisibleMenuEls());
      const result = plugin._orig.showAtMouseEvent.call(this, evt);
      plugin.processVisibleMenusNow({
        showRequest: {
          kind: 'mouse',
          x: evt?.clientX ?? 0,
          y: evt?.clientY ?? 0,
          beforeMenus,
          shouldRepositionRoot: beforeMenus.size === 0
        }
      });
      return result;
    };

    Menu.prototype.showAtPosition = function(position, doc) {
      const beforeMenus = new Set(getVisibleMenuEls());
      const result = plugin._orig.showAtPosition.call(this, position, doc);
      plugin.processVisibleMenusNow({
        showRequest: {
          kind: 'position',
          x: Number(position?.x ?? position?.left ?? 0),
          y: Number(position?.y ?? position?.top ?? 0),
          beforeMenus,
          shouldRepositionRoot: beforeMenus.size === 0
        }
      });
      return result;
    };
  }

  uninstallMenuPatches() {
    const obsidian = require('obsidian');
    const { Menu } = obsidian;
    if (!this._orig) return;

    Menu.prototype.showAtMouseEvent = this._orig.showAtMouseEvent;
    Menu.prototype.showAtPosition = this._orig.showAtPosition;
    if (this._orig.setTitle && MenuItem?.prototype) {
      MenuItem.prototype.setTitle = this._orig.setTitle;
    }
  }

  applyTitleRuleToItemEl(itemEl, explicitTitle = '') {
    if (!(itemEl instanceof HTMLElement)) return false;
    const title = explicitTitle || getItemTitle(itemEl);
    const rules = parseHiddenSelectors(this.settings.hiddenItemsText, this.settings).filter((rule) => rule.mode === 'title');
    const titleNorm = normalizeText(title, this.settings);
    const shouldHide = rules.some((rule) => rule.norm === titleNorm);
    itemEl.classList.toggle(TITLE_HIDE_CLASS, shouldHide);
    itemEl.classList.toggle(ANY_HIDE_CLASS, shouldHide || itemEl.classList.contains(PATH_HIDE_CLASS));
    return shouldHide;
  }

  applyTitleIconRuleToItemEl(itemEl, explicitTitle = '') {
    if (!(itemEl instanceof HTMLElement)) return false;
    const title = explicitTitle || getItemTitle(itemEl);
    const rules = parseIconRules(this.settings.iconRulesText, this.settings).filter((rule) => rule.selector.mode === 'title');
    const titleNorm = normalizeText(title, this.settings);
    const matchedRule = rules.find((rule) => rule.selector.norm === titleNorm);
    if (!matchedRule) return false;
    return applyIconOverrideToItemEl(itemEl, matchedRule.icon);
  }

  processVisibleMenusNow(context = {}) {
    const menuEls = getVisibleMenuEls();
    if (menuEls.length === 0) return;

    resetMenuClasses(menuEls);

    for (const menuEl of menuEls) {
      menuEl.querySelectorAll('.menu-item').forEach((itemEl) => {
        if (itemEl instanceof HTMLElement) {
          this.applyTitleRuleToItemEl(itemEl);
          this.applyTitleIconRuleToItemEl(itemEl);
        }
      });
    }

    const detectionSnapshot = buildDomSnapshot();
    const detectedProfileKey = this.getDetectTargetProfileKey();

    if (this.isDetecting) {
      const currentProfileEntries = Array.isArray(this.detectedEntriesLiveByProfile?.[detectedProfileKey])
        ? this.detectedEntriesLiveByProfile[detectedProfileKey]
        : [];
      this.detectedEntriesLiveByProfile[detectedProfileKey] = mergeStoredDetectedEntries(currentProfileEntries, detectionSnapshot);
      this.updateStatusBar();
      this.refreshSettingTab();
      this.applyPathRulesToSnapshot(detectionSnapshot);
      this.applyIconRulesToSnapshot(detectionSnapshot);
      cleanupVisibleMenus(getVisibleMenuEls());
      this.repositionRootMenuIfNeeded(context.showRequest);
      return;
    }

    this.applyPathRulesToSnapshot(detectionSnapshot);
    this.applyIconRulesToSnapshot(detectionSnapshot);
    this.applyMoveRulesToSnapshot(detectionSnapshot);
    cleanupVisibleMenus(getVisibleMenuEls());
    this.repositionRootMenuIfNeeded(context.showRequest);
  }

  repositionRootMenuIfNeeded(showRequest) {
    if (!showRequest?.shouldRepositionRoot) return;
    const menuEls = getVisibleMenuEls();
    const newMenus = menuEls.filter((menuEl) => !showRequest.beforeMenus?.has(menuEl));
    const rootMenu = newMenus[0];
    if (!(rootMenu instanceof HTMLElement)) return;

    const rect = rootMenu.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || rect.width;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight || rect.height;

    const left = Math.max(0, Math.min(Math.round(showRequest.x || 0), Math.max(0, viewportWidth - rect.width)));
    const top = Math.max(0, Math.min(Math.round(showRequest.y || 0), Math.max(0, viewportHeight - rect.height)));

    rootMenu.style.left = `${left}px`;
    rootMenu.style.top = `${top}px`;
  }

  applyHiddenRulesToVisibleMenus() {
    this.processVisibleMenusNow();
  }

  applyPathRulesToSnapshot(snapshot) {
    const rules = parseHiddenSelectors(this.settings.hiddenItemsText, this.settings);

    for (const entry of snapshot) {
      if (entry.kind !== 'item' || !(entry.el instanceof HTMLElement)) continue;
      const runtimePathHint = entry.el?.dataset?.cmmRuntimePath || '';
      const hintedEntry = runtimePathHint ? { ...entry, path: runtimePathHint } : entry;
      const match = getRuleMatchInfo(hintedEntry, rules, this.settings);
      entry.el.classList.toggle(PATH_HIDE_CLASS, !!match.matchedPathRule);
      entry.el.classList.toggle(TITLE_HIDE_CLASS, !!match.matchedTitleRule);
      entry.el.classList.toggle(ANY_HIDE_CLASS, match.isHidden);
    }
  }

  applyIconRulesToSnapshot(snapshot) {
    const rules = parseIconRules(this.settings.iconRulesText, this.settings);
    if (rules.length === 0) return;

    for (const entry of snapshot) {
      if (entry.kind !== 'item' || !(entry.el instanceof HTMLElement)) continue;
      const match = getIconRuleMatchInfo(entry, rules, this.settings);
      if (match.matchedRule) applyIconOverrideToItemEl(entry.el, match.matchedRule.icon);
    }
  }

  applyMoveRulesToSnapshot(snapshot) {
    const rules = parseMoveRules(this.settings.moveRulesText, this.settings);
    if (rules.length === 0 || snapshot.length === 0) return false;

    const entriesByMenu = new Map();
    for (const entry of snapshot) {
      if (!entriesByMenu.has(entry.menuIndex)) entriesByMenu.set(entry.menuIndex, []);
      entriesByMenu.get(entry.menuIndex).push(entry);
    }
    for (const entries of entriesByMenu.values()) entries.sort((a, b) => a.order - b.order);

    let changed = false;

    const findEntryIndex = (entries, selector) => {
      return entries.findIndex((entry) => {
        if (entry.kind === 'item' && selector.mode === 'path') {
          return normalizeSelectorValue('path', entry.path, this.settings) === selector.norm;
        }
        if (entry.kind === 'item' && selector.mode === 'title') {
          return normalizeText(entry.title, this.settings) === selector.norm;
        }
        if (entry.kind === 'separator' && selector.mode === 'sep') {
          const entryNorm = normalizeSelectorValue('sep', String(entry.selector || '').slice(SEP_PREFIX.length), this.settings);
          return entryNorm === selector.norm;
        }
        return false;
      });
    };

    for (const [menuIndex, entries] of entriesByMenu.entries()) {
      const menuEntries = entries.slice();
      let menuChanged = false;

      for (const rule of rules) {
        const sourceIndex = findEntryIndex(menuEntries, rule.source);
        const targetIndex = findEntryIndex(menuEntries, rule.target);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) continue;

        const sourceEntry = menuEntries[sourceIndex];
        const targetEntry = menuEntries[targetIndex];
        if ((sourceEntry.parentPath || '') !== (targetEntry.parentPath || '')) continue;

        const [sourceCurrent] = menuEntries.splice(sourceIndex, 1);
        let nextTargetIndex = menuEntries.findIndex((entry) => entry === targetEntry);
        if (nextTargetIndex < 0) continue;
        if (rule.relation === 'after') nextTargetIndex += 1;
        menuEntries.splice(nextTargetIndex, 0, sourceCurrent);
        menuChanged = true;
      }

      if (!menuChanged) continue;
      const menuEl = menuEntries[0]?.el?.closest?.('.menu');
      if (!(menuEl instanceof HTMLElement)) continue;
      const rebuilt = rebuildMenuFromTokens(menuEl, menuEntries);
      if (rebuilt) changed = true;
    }

    return changed;
  }

  async startDetection() {
    if (this.isDetecting) {
      new Notice('La détection du menu est déjà active.');
      return;
    }

    this.detectedEntriesLiveByProfile = cloneMenuProfiles(this.settings.menuProfiles);
    this.isDetecting = true;
    this.updateStatusBar();
    this.refreshSettingTab();
    new Notice(`Détection activée pour : ${getMenuProfileLabel(this.getDetectTargetProfileKey())}.`);
  }

  async stopDetection(showNotice = true) {
    if (!this.isDetecting) return;
    this.isDetecting = false;
    this.settings.menuProfiles = cloneMenuProfiles(this.detectedEntriesLiveByProfile);
    this.settings.detectedEntries = flattenMenuProfiles(this.settings);
    await this.saveSettings();
    this.updateStatusBar();
    this.refreshSettingTab();
    if (showNotice) new Notice(`Détection arrêtée. ${getTotalProfileEntryCount(this.settings)} entrée(s) mémorisée(s) au total.`);
  }

  updateStatusBar() {
    if (!this.statusBarItem) return;
    if (this.isDetecting) {
      const total = Object.values(this.detectedEntriesLiveByProfile || {}).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
      this.statusBarItem.setText(`CMM: détection active · ${getMenuProfileLabel(this.getDetectTargetProfileKey())} (${total})`);
      this.statusBarItem.classList.add('cmm-status-active');
    } else {
      this.statusBarItem.setText('CMM: détection arrêtée');
      this.statusBarItem.classList.remove('cmm-status-active');
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  refreshSettingTab() {
    const leaves = this.app.setting?.pluginTabs;
    if (!leaves) return;
    for (const tab of leaves) {
      if (tab instanceof ContextMenuManagerSettingTab) tab.display();
    }
  }

  getHiddenRuleMatch(entry) {
    if (!entry || entry.kind !== 'item') return { matchedPathRule: null, matchedTitleRule: null, isHidden: false };
    const rules = parseHiddenSelectors(this.settings.hiddenItemsText, this.settings);
    return getRuleMatchInfo(entry, rules, this.settings);
  }

  isSelectorHidden(selector) {
    const targetNorm = normalizeText(selector, this.settings);
    return parseHiddenSelectors(this.settings.hiddenItemsText, this.settings)
      .some((rule) => normalizeText(rule.raw, this.settings) === targetNorm);
  }

  isMoveRulePresent(rawSourceSelector) {
    const sourceNorm = normalizeText(rawSourceSelector, this.settings);
    return parseMoveRules(this.settings.moveRulesText, this.settings)
      .some((rule) => normalizeText(rule.source.raw, this.settings) === sourceNorm);
  }

  getMoveRuleForSelector(rawSourceSelector) {
    const sourceNorm = normalizeText(rawSourceSelector, this.settings);
    return parseMoveRules(this.settings.moveRulesText, this.settings)
      .find((rule) => normalizeText(rule.source.raw, this.settings) === sourceNorm) || null;
  }

  getIconRuleForEntry(entry) {
    if (!entry || entry.kind !== 'item') return null;
    const rules = parseIconRules(this.settings.iconRulesText, this.settings);
    const match = getIconRuleMatchInfo(entry, rules, this.settings);
    return match.matchedRule;
  }

  async setIconRule(selector, iconName) {
    const currentRules = parseIconRules(this.settings.iconRulesText, this.settings);
    const sourceNorm = normalizeText(selector, this.settings);
    const kept = currentRules.filter((rule) => normalizeText(rule.selector.raw, this.settings) !== sourceNorm);
    const icon = String(iconName || '').trim();
    if (icon) kept.push({ raw: `${selector} => ${icon}` });
    this.settings.iconRulesText = kept.map((rule) => rule.raw).join('\n');
    await this.saveSettings();
    this.refreshSettingTab();
    this.applyHiddenRulesToVisibleMenus();
  }

  async clearIconRule(selector) {
    await this.setIconRule(selector, '');
  }

  async toggleHiddenSelector(selector) {
    const lines = parseHiddenSelectors(this.settings.hiddenItemsText, this.settings).map((rule) => rule.raw);
    const targetNorm = normalizeText(selector, this.settings);
    const filtered = lines.filter((line) => normalizeText(line, this.settings) !== targetNorm);
    if (filtered.length === lines.length) filtered.push(selector);
    this.settings.hiddenItemsText = filtered.join('\n');
    await this.saveSettings();
    this.refreshSettingTab();
    this.applyHiddenRulesToVisibleMenus();
  }

  async setMoveRule(sourceSelector, relation, targetSelector) {
    const currentRules = parseMoveRules(this.settings.moveRulesText, this.settings);
    const sourceNorm = normalizeText(sourceSelector, this.settings);
    const kept = currentRules.filter((rule) => normalizeText(rule.source.raw, this.settings) !== sourceNorm);
    kept.push({ raw: `${sourceSelector} => ${relation} ${targetSelector}` });
    this.settings.moveRulesText = kept.map((rule) => rule.raw).join('\n');
    await this.saveSettings();
    this.refreshSettingTab();
    this.applyHiddenRulesToVisibleMenus();
  }

  async clearMoveRule(sourceSelector) {
    const currentRules = parseMoveRules(this.settings.moveRulesText, this.settings);
    const sourceNorm = normalizeText(sourceSelector, this.settings);
    const kept = currentRules.filter((rule) => normalizeText(rule.source.raw, this.settings) !== sourceNorm);
    this.settings.moveRulesText = kept.map((rule) => rule.raw).join('\n');
    await this.saveSettings();
    this.refreshSettingTab();
    this.applyHiddenRulesToVisibleMenus();
  }
  isPathCollapsed(path) {
    const target = normalizeText(normalizePathInput(path || ''), this.settings);
    if (!target) return false;
    return (Array.isArray(this.settings.collapsedPaths) ? this.settings.collapsedPaths : [])
      .some((value) => normalizeText(normalizePathInput(value || ''), this.settings) === target);
  }

  async toggleCollapsedPath(path) {
    const clean = String(path || '').trim();
    if (!clean) return;
    const current = Array.isArray(this.settings.collapsedPaths) ? this.settings.collapsedPaths.slice() : [];
    const target = normalizeText(normalizePathInput(clean), this.settings);
    const kept = current.filter((value) => normalizeText(normalizePathInput(value || ''), this.settings) !== target);
    if (kept.length === current.length) kept.push(clean);
    this.settings.collapsedPaths = kept;
    await this.saveSettings();
    this.refreshSettingTab();
  }

  isEntryHiddenByCollapsedAncestor(entry) {
    if (!entry || !entry.path) return false;
    const pathNorm = normalizeText(normalizePathInput(entry.path), this.settings);
    const collapsed = Array.isArray(this.settings.collapsedPaths) ? this.settings.collapsedPaths : [];
    return collapsed.some((value) => {
      const base = normalizeText(normalizePathInput(value || ''), this.settings);
      return !!base && pathNorm.startsWith(base + ' > ');
    });
  }
};

class LucideIconPickerModal extends Modal {
  constructor(app, options) {
    super(app);
    this.selector = options?.selector || '';
    this.currentIcon = String(options?.currentIcon || '').replace(/^lucide-/, '').trim();
    this.onSubmit = typeof options?.onSubmit === 'function' ? options.onSubmit : async () => {};
    this.onClear = typeof options?.onClear === 'function' ? options.onClear : async () => {};
    this.iconIds = Array.from(new Set((typeof getIconIds === 'function' ? getIconIds() : []).filter(Boolean)));
    this.searchValue = '';
    this.filteredIconIds = this.iconIds.slice();
  }

  getFilteredIcons(query) {
    const q = String(query || '').trim().toLocaleLowerCase();
    if (!q) return this.iconIds.slice();
    return this.iconIds.filter((iconId) => String(iconId).toLocaleLowerCase().includes(q));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('npis-picker-modal');
    this.modalEl.addClass('npis-picker-modal-shell');

    contentEl.createEl('h3', { text: 'Choisir une icône Lucide', cls: 'npis-picker-title' });

    const body = contentEl.createDiv({ cls: 'npis-picker-body' });
    const iconPane = body.createDiv({ cls: 'npis-picker-pane npis-picker-pane-icons is-active' });

    const searchRow = iconPane.createDiv({ cls: 'npis-icon-search-row npis-icon-search-row-with-clear' });
    const search = searchRow.createEl('input', {
      type: 'search',
      cls: 'npis-picker-search npis-picker-search-with-clear',
      placeholder: 'Rechercher une icône'
    });
    this.searchEl = search;

    const clearBtn = searchRow.createEl('button', { cls: 'npis-icon-search-clear-btn' });
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label', 'Effacer la recherche');
    clearBtn.title = 'Effacer';
    clearBtn.setText('×');

    const resultsMeta = iconPane.createDiv({ cls: 'npis-results-meta' });
    const scroll = iconPane.createDiv({ cls: 'npis-picker-scroll npis-icon-scroll' });
    const grid = scroll.createDiv({ cls: 'npis-icon-grid npis-icon-grid-compact' });

    const render = () => {
      this.filteredIconIds = this.getFilteredIcons(this.searchValue);
      grid.empty();
      resultsMeta.setText(`${this.filteredIconIds.length} icône(s)`);
      clearBtn.classList.toggle('is-visible', !!this.searchValue);

      for (const iconId of this.filteredIconIds) {
        const btn = grid.createEl('button', { cls: 'npis-icon-btn-compact' });
        btn.type = 'button';
        btn.setAttr('aria-label', iconId);
        btn.setAttr('title', iconId);
        if (iconId === this.currentIcon) btn.addClass('is-current');

        const preview = btn.createDiv({ cls: 'npis-icon-btn-preview' });
        try {
          if (typeof setIcon === 'function') setIcon(preview, iconId);
          else {
            const svg = typeof getIcon === 'function' ? getIcon(iconId) : null;
            if (svg) preview.appendChild(svg);
          }
        } catch (_) {}

        btn.addEventListener('click', async () => {
          await this.onSubmit(iconId);
          this.close();
        });
      }
    };

    search.addEventListener('input', () => {
      this.searchValue = search.value || '';
      render();
    });

    clearBtn.addEventListener('click', () => {
      this.searchValue = '';
      search.value = '';
      render();
      search.focus();
    });

    const footer = contentEl.createDiv({ cls: 'npis-picker-actions' });
    const removeBtn = footer.createEl('button', { text: 'Retirer' });
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', async () => {
      await this.onClear();
      this.close();
    });

    const cancelBtn = footer.createEl('button', { text: 'Annuler' });
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => this.close());

    render();
    window.setTimeout(() => this.searchEl?.focus(), 0);
  }

  onClose() {
    this.modalEl.removeClass('npis-picker-modal-shell');
    this.contentEl.empty();
  }
}

class ContextMenuManagerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getScrollHost() {
    return this.containerEl.closest('.vertical-tab-content-container') || this.containerEl.parentElement || this.containerEl;
  }

  autoScrollDuringDrag(clientY) {
    const host = this.getScrollHost();
    if (!(host instanceof HTMLElement)) return;
    const rect = host.getBoundingClientRect();
    const threshold = Math.min(72, Math.max(36, rect.height * 0.12));
    const maxStep = 22;
    if (clientY < rect.top + threshold) {
      const ratio = Math.max(0, (rect.top + threshold - clientY) / threshold);
      host.scrollTop -= Math.ceil(maxStep * ratio);
    } else if (clientY > rect.bottom - threshold) {
      const ratio = Math.max(0, (clientY - (rect.bottom - threshold)) / threshold);
      host.scrollTop += Math.ceil(maxStep * ratio);
    }
  }

  createLucideIcon(iconClass, options = {}) {
    if (!iconClass) return null;
    const iconName = String(iconClass).replace(/^lucide-/, '');
    if (!iconName) return null;
    try {
      const svg = typeof getIcon === 'function' ? getIcon(iconName) : null;
      if (!svg) return null;
      svg.addClass('cmm-lucide-icon');
      if (options.placeholder) svg.addClass('is-placeholder');
      if (options.overridden) svg.addClass('is-overridden');
      return svg;
    } catch (_) {
      return null;
    }
  }

  createCustomSvgPreview(svgHtml, options = {}) {
    if (!svgHtml) return null;
    const wrap = document.createElement('span');
    wrap.className = 'cmm-custom-icon';
    wrap.innerHTML = String(svgHtml || '').trim();
    const svg = wrap.querySelector('svg');
    if (!(svg instanceof SVGElement)) return null;
    svg.classList.add('cmm-custom-icon-svg');
    if (options.placeholder) svg.classList.add('is-placeholder');
    if (options.overridden) svg.classList.add('is-overridden');
    return wrap;
  }

  createIconButton(containerEl, options = {}) {
    const btn = containerEl.createEl('button', { cls: 'cmm-icon-button' });
    btn.setAttr('type', 'button');
    btn.setAttr('aria-label', options.label || 'Modifier l’icône');
    btn.setAttr('title', options.label || 'Modifier l’icône');

    let preview = null;
    if (options.iconClass) {
      preview = this.createLucideIcon(options.iconClass, {
        placeholder: !!options.placeholder,
        overridden: !!options.overridden
      });
    } else if (options.iconSvgHtml) {
      preview = this.createCustomSvgPreview(options.iconSvgHtml, {
        placeholder: !!options.placeholder,
        overridden: !!options.overridden
      });
    }
    if (!preview) {
      preview = this.createLucideIcon('plus', {
        placeholder: true,
        overridden: !!options.overridden
      });
      btn.addClass('is-empty');
    }

    if (preview) btn.appendChild(preview);
    if (options.overridden) btn.addClass('is-overridden');
    return btn;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Context Menu Manager' });


    new Setting(containerEl)
      .setName('État de la détection')
      .setDesc(this.plugin.isDetecting ? 'Détection active.' : 'Détection arrêtée.')
      .addButton((btn) => btn
        .setButtonText('Lancer')
        .setDisabled(this.plugin.isDetecting)
        .onClick(() => this.plugin.startDetection()))
      .addButton((btn) => btn
        .setButtonText('Arrêter')
        .setDisabled(!this.plugin.isDetecting)
        .onClick(() => this.plugin.stopDetection(true)));

    new Setting(containerEl)
      .setName('Cible de détection')
      .setDesc('Choisis manuellement dans quel onglet enregistrer la prochaine capture.')
      .addDropdown((dd) => {
        for (const def of MENU_PROFILE_DEFS) dd.addOption(def.key, def.label);
        dd.setValue(this.plugin.getDetectTargetProfileKey());
        dd.onChange(async (value) => {
          await this.plugin.setDetectTargetProfileKey(value);
        });
      });

    new Setting(containerEl)
      .setName('Masquer des éléments')
      .setDesc('Une ligne par règle. Exemples : path:2 Columns   ou   title:2 Columns')
      .addTextArea((ta) => {
        ta.setPlaceholder('path:2 Columns\npath:Colonnes > 2 Columns\ntitle:2 Columns');
        ta.setValue(this.plugin.settings.hiddenItemsText || '');
        ta.inputEl.addClass('cmm-textarea');
        ta.onChange(async (value) => {
          this.plugin.settings.hiddenItemsText = value;
          await this.plugin.saveSettings();
          this.plugin.applyHiddenRulesToVisibleMenus();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Déplacer des éléments')
      .setDesc('Une ligne par règle. Exemples : path:Custom Layout... => before path:Callout   ou   sep:@root#4 => after path:Colonnes')
      .addTextArea((ta) => {
        ta.setPlaceholder('path:Custom Layout... => before path:Callout\nsep:@root#4 => after path:Colonnes');
        ta.setValue(this.plugin.settings.moveRulesText || '');
        ta.inputEl.addClass('cmm-textarea');
        ta.onChange(async (value) => {
          this.plugin.settings.moveRulesText = value;
          await this.plugin.saveSettings();
          this.plugin.applyHiddenRulesToVisibleMenus();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Icônes des éléments')
      .setDesc('Une ligne par règle. Exemples : path:Copilot => bot   ou   title:Highlight => highlighter. Utilise “none” pour vider l’icône principale.')
      .addTextArea((ta) => {
        ta.setPlaceholder('path:Copilot => bot\npath:Colonnes > 2 Columns => columns-2\ntitle:Highlight => highlighter\npath:Copilot => none');
        ta.setValue(this.plugin.settings.iconRulesText || '');
        ta.inputEl.addClass('cmm-textarea');
        ta.onChange(async (value) => {
          this.plugin.settings.iconRulesText = value;
          await this.plugin.saveSettings();
          this.plugin.applyHiddenRulesToVisibleMenus();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Sensibilité à la casse')
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.caseSensitive)
        .onChange(async (value) => {
          this.plugin.settings.caseSensitive = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Compacter les espaces')
      .setDesc('Considère plusieurs espaces comme un seul lors des comparaisons.')
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.collapseWhitespace)
        .onChange(async (value) => {
          this.plugin.settings.collapseWhitespace = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    const activeProfileKey = normalizeMenuProfileKey(this.plugin.settings.activeProfileKey || 'normal');
    const activeProfileLabel = getMenuProfileLabel(activeProfileKey);
    const totalEntries = getTotalProfileEntryCount(this.plugin.settings);

    new Setting(containerEl)
      .setName('Entrées détectées')
      .setDesc(`${totalEntries} entrée(s) mémorisée(s) au total. Onglet actuel : ${activeProfileLabel}.`)
      .addButton((btn) => btn
        .setButtonText('Effacer cet onglet')
        .onClick(async () => {
          this.plugin.setProfileEntries(activeProfileKey, []);
          this.plugin.detectedEntriesLiveByProfile = cloneMenuProfiles(this.plugin.settings.menuProfiles);
          await this.plugin.saveSettings();
          this.display();
        }))
      .addButton((btn) => btn
        .setButtonText('Effacer tout')
        .onClick(async () => {
          this.plugin.detectedEntriesLiveByProfile = createEmptyMenuProfiles();
          this.plugin.settings.menuProfiles = createEmptyMenuProfiles();
          this.plugin.settings.detectedEntries = [];
          await this.plugin.saveSettings();
          this.display();
        }));

    const profileTabs = containerEl.createDiv({ cls: 'cmm-profile-tabs' });
    for (const def of this.plugin.getAvailableProfileDefs()) {
      const tabBtn = profileTabs.createEl('button', { cls: 'cmm-profile-tab', text: `${def.label} (${def.count})` });
      if (def.key === activeProfileKey) tabBtn.addClass('is-active');
      tabBtn.addEventListener('click', async () => {
        this.plugin.settings.activeProfileKey = def.key;
        await this.plugin.saveSettings();
        this.display();
      });
    }

    const tree = containerEl.createDiv({ cls: 'cmm-tree' });
    const rawEntries = this.plugin.getProfileEntries(activeProfileKey);
    const entries = applyMoveRulesToStoredEntries(
      rawEntries,
      parseMoveRules(this.plugin.settings.moveRulesText, this.plugin.settings),
      this.plugin.settings
    );

    if (entries.length === 0) {
      tree.createDiv({ cls: 'cmm-empty', text: 'Aucune entrée détectée pour le moment.' });
      return;
    }

    tree.addEventListener('dragover', (evt) => {
      if (!this._dragState) return;
      this.autoScrollDuringDrag(evt.clientY);
    });

    const childrenByParent = new Map();
    for (const entry of entries) {
      const key = String(entry.parentPath || '');
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(entry);
    }

    const renderEntry = (entry) => {
      if (this.plugin.isEntryHiddenByCollapsedAncestor(entry)) return;
      const match = this.plugin.getHiddenRuleMatch(entry);
      const rowClasses = ['cmm-row'];
      if (entry.kind === 'separator') rowClasses.push('is-separator');
      if ((entry.depth ?? 0) > 0) rowClasses.push('is-submenu');
      else rowClasses.push('is-rootmenu');
      if (match.isHidden) rowClasses.push('is-hidden');
      if (match.matchedPathRule) rowClasses.push('is-hidden-exact');
      if (match.matchedTitleRule) rowClasses.push('is-hidden-by-title');

      const row = tree.createDiv({ cls: rowClasses });
      row.style.setProperty('--cmm-depth', String(entry.depth ?? 0));

      const textWrap = row.createDiv({ cls: 'cmm-row-text' });
      const titleLine = textWrap.createDiv({ cls: 'cmm-row-title' });

      const childEntries = childrenByParent.get(String(entry.path || '')) || [];
      const hasStoredChildren = entry.kind === 'item' && childEntries.length > 0;
      const hasCollapseToggle = entry.kind === 'item' && (entry.hasSubmenu || hasStoredChildren);
      const iconRule = this.plugin.getIconRuleForEntry(entry);
      const overrideIcon = iconRule?.icon ? String(iconRule.icon).trim() : '';
      const hasOverrideIcon = !!(overrideIcon && overrideIcon.toLowerCase() !== 'none');
      const effectiveIconClass = entry.kind === 'item'
        ? (hasOverrideIcon ? `lucide-${overrideIcon.replace(/^lucide-/, '')}` : (entry.icon || ''))
        : '';
      const effectiveIconSvgHtml = entry.kind === 'item' && !hasOverrideIcon ? (entry.iconSvgHtml || '') : '';
      const shouldShowPlaceholderIcon = entry.kind === 'item' && !effectiveIconClass && !effectiveIconSvgHtml;

      if (entry.kind === 'item') {
        const iconBtn = this.createIconButton(titleLine, {
          iconClass: effectiveIconClass,
          iconSvgHtml: effectiveIconSvgHtml,
          placeholder: shouldShowPlaceholderIcon,
          overridden: hasOverrideIcon,
          label: shouldShowPlaceholderIcon ? 'Choisir une icône' : 'Modifier l’icône'
        });
        const selector = entry.selector || buildPathSelector(entry.path || entry.title || '');
        iconBtn.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          new LucideIconPickerModal(this.app, {
            selector,
            currentIcon: overrideIcon,
            onSubmit: async (value) => {
              await this.plugin.setIconRule(selector, value);
            },
            onClear: async () => {
              await this.plugin.clearIconRule(selector);
            }
          }).open();
        });
      }

      titleLine.createSpan({ text: entry.title || '(sans titre)' });
      titleLine.createSpan({ cls: 'cmm-pill', text: entry.kind === 'separator' ? 'Séparateur' : ((entry.depth ?? 0) > 0 ? 'Sous-menu' : 'Menu') });

      if (match.matchedPathRule) titleLine.createSpan({ cls: 'cmm-pill cmm-pill-hidden', text: 'Masqué exact' });
      else if (match.matchedTitleRule) titleLine.createSpan({ cls: 'cmm-pill cmm-pill-hidden-title', text: 'Masqué par nom' });
      else titleLine.createSpan({ cls: 'cmm-pill cmm-pill-shown', text: 'Affiché' });

      if (hasCollapseToggle) titleLine.createSpan({ cls: 'cmm-pill is-muted', text: this.plugin.isPathCollapsed(entry.path || '') ? 'Sous-menu replié' : 'A un sous-menu' });
      if (entry.disabled) titleLine.createSpan({ cls: 'cmm-pill is-muted', text: 'Désactivé' });
      if (entry.isLabel) titleLine.createSpan({ cls: 'cmm-pill is-muted', text: 'Label' });
      if (entry.selected) titleLine.createSpan({ cls: 'cmm-pill is-muted', text: 'Sélectionné' });
      if (entry.section) titleLine.createSpan({ cls: 'cmm-pill is-muted', text: `section:${entry.section}` });

      const actions = row.createDiv({ cls: 'cmm-row-actions' });
      const selector = entry.selector || (entry.kind === 'separator'
        ? buildSeparatorSelector(entry.parentPath || '', 1)
        : buildPathSelector(entry.path || entry.title || ''));
      const moveRule = this.plugin.getMoveRuleForSelector(selector);

      row.draggable = true;
      row.dataset.cmmSelector = selector;
      row.dataset.cmmParentPath = entry.parentPath || '';
      row.dataset.cmmKind = entry.kind || 'item';
      row.dataset.cmmTitle = entry.title || '';

      if (entry.kind === 'item') {
        const hideBtn = actions.createEl('button', { text: this.plugin.isSelectorHidden(selector) ? 'Afficher' : 'Masquer' });
        hideBtn.addClass('mod-cta');
        hideBtn.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          await this.plugin.toggleHiddenSelector(selector);
        });

        if (hasCollapseToggle) {
          const collapsed = this.plugin.isPathCollapsed(entry.path || '');
          const toggleBtn = actions.createEl('button', { cls: 'cmm-collapse-toggle', text: collapsed ? '▸' : '▾' });
          toggleBtn.setAttr('aria-label', collapsed ? 'Déplier le sous-menu' : 'Replier le sous-menu');
          toggleBtn.setAttr('title', collapsed ? 'Déplier le sous-menu' : 'Replier le sous-menu');
          toggleBtn.addEventListener('click', async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            await this.plugin.toggleCollapsedPath(entry.path || '');
          });
        }
      }

      if (moveRule) {
        const clearMoveBtn = actions.createEl('button', { text: 'Annuler déplacement' });
        clearMoveBtn.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          await this.plugin.clearMoveRule(selector);
        });
      }

      row.addEventListener('dragstart', (evt) => {
        const dragState = {
          selector,
          parentPath: entry.parentPath || '',
          kind: entry.kind || 'item',
          title: entry.title || ''
        };
        this._dragState = dragState;
        row.classList.add('is-dragging');
        if (evt.dataTransfer) {
          evt.dataTransfer.effectAllowed = 'move';
          evt.dataTransfer.setData('text/plain', JSON.stringify(dragState));
        }
      });

      row.addEventListener('dragend', () => {
        this._dragState = null;
        tree.querySelectorAll('.cmm-row').forEach((el) => el.classList.remove('is-dragging', 'cmm-drop-before', 'cmm-drop-after', 'cmm-drop-invalid'));
      });

      row.addEventListener('dragover', (evt) => {
        const dragState = this._dragState;
        if (!dragState) return;
        if (dragState.selector === selector) return;

        const sameParent = (dragState.parentPath || '') === (entry.parentPath || '');
        tree.querySelectorAll('.cmm-row').forEach((el) => el.classList.remove('cmm-drop-before', 'cmm-drop-after', 'cmm-drop-invalid'));

        if (!sameParent) {
          row.addClass('cmm-drop-invalid');
          return;
        }

        evt.preventDefault();
        if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const relation = (evt.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after';
        row.dataset.cmmDropRelation = relation;
        row.addClass(relation === 'before' ? 'cmm-drop-before' : 'cmm-drop-after');
      });

      row.addEventListener('dragleave', (evt) => {
        if (evt.currentTarget !== row) return;
        const related = evt.relatedTarget;
        if (related instanceof Node && row.contains(related)) return;
        row.classList.remove('cmm-drop-before', 'cmm-drop-after', 'cmm-drop-invalid');
      });

      row.addEventListener('drop', async (evt) => {
        const dragState = this._dragState;
        row.classList.remove('cmm-drop-before', 'cmm-drop-after', 'cmm-drop-invalid');
        if (!dragState) return;
        if (dragState.selector === selector) return;
        const sameParent = (dragState.parentPath || '') === (entry.parentPath || '');
        if (!sameParent) {
          evt.preventDefault();
          new Notice('Le glisser-déposer ne fonctionne qu’à l’intérieur du même menu ou sous-menu.');
          return;
        }
        evt.preventDefault();
        const rect = row.getBoundingClientRect();
        const relation = (evt.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after';
        await this.plugin.setMoveRule(dragState.selector, relation, selector);
      });
    };

    const renderBranch = (parentPath = '') => {
      const children = childrenByParent.get(String(parentPath || '')) || [];
      for (const entry of children) {
        renderEntry(entry);
        if (entry.kind === 'item') renderBranch(entry.path || '');
      }
    };

    renderBranch('');
  }
}
