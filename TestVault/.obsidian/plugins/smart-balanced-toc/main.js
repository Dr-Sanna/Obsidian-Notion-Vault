const {
  Plugin,
  MarkdownRenderChild,
  PluginSettingTab,
  Setting,
  SettingGroup,
  MarkdownRenderer,
  htmlToMarkdown,
} = require('obsidian');

const CODEBLOCKS = ['smart-toc', 'balanced-toc'];

const DEFAULTS = {
  title: '',
  minLevel: 2,
  maxLevel: 0,
  include: null,
  exclude: null,
  includeLinks: true,
  hideWhenEmpty: false,
  columns: 1,
  breakAt: 'h3',
  repeatParents: false,
  columnGap: '1rem',
  debugInConsole: false,
};

const OPTION_DEFS = {
  title: { type: 'string', default: DEFAULTS.title, comment: 'Title displayed above the TOC (supports Markdown)' },
  minLevel: { type: 'number', default: DEFAULTS.minLevel, comment: 'Include headings from this level (0 = auto)' },
  maxLevel: { type: 'number', default: DEFAULTS.maxLevel, comment: 'Include headings up to this level (0 = no limit)' },
  include: { type: 'regexp', default: DEFAULTS.include, comment: 'Only include headings matching this regexp' },
  exclude: { type: 'regexp', default: DEFAULTS.exclude, comment: 'Exclude headings matching this regexp' },
  includeLinks: { type: 'boolean', default: DEFAULTS.includeLinks, comment: 'Make headings clickable' },
  hideWhenEmpty: { type: 'boolean', default: DEFAULTS.hideWhenEmpty, comment: 'Hide the block if no headings are found' },
  columns: { type: 'number', default: DEFAULTS.columns, comment: '1 or 2 columns' },
  breakAt: { type: 'value', default: DEFAULTS.breakAt, values: ['h2', 'h3', 'h4', 'h5', 'h6'], comment: 'Split between columns only before this heading level' },
  repeatParents: { type: 'boolean', default: DEFAULTS.repeatParents, comment: 'Repeat ancestor headings at the top of a continued chunk' },
  columnGap: { type: 'string', default: DEFAULTS.columnGap, comment: 'Gap between columns (CSS length)' },
  debugInConsole: { type: 'boolean', default: DEFAULTS.debugInConsole, comment: 'Print debug info in the developer console' },
};

function settingGroup(containerEl) {
  return typeof SettingGroup === 'function' ? new SettingGroup(containerEl) : null;
}

function getOptionsTemplate() {
  return Object.entries(OPTION_DEFS)
    .map(([key, def]) => `${key}: ${def.default === null ? '' : String(def.default)}${def.comment ? ` # ${def.comment}` : ''}`)
    .join('\n');
}

function parseCodeBlockOptions(sourceText = '', savedDefaults = null) {
  const options = { ...DEFAULTS, ...(savedDefaults || {}) };

  for (const rawLine of sourceText.split('\n')) {
    const parsed = parseOptionLine(rawLine);
    if (parsed) options[parsed.name] = parsed.value;
  }

  options.columns = options.columns === 2 ? 2 : 1;
  options.breakAt = normalizeBreakAt(options.breakAt);
  options.minLevel = normalizeInteger(options.minLevel, DEFAULTS.minLevel, 0);
  options.maxLevel = normalizeInteger(options.maxLevel, DEFAULTS.maxLevel, 0);
  options.repeatParents = Boolean(options.repeatParents);
  options.includeLinks = Boolean(options.includeLinks);
  options.hideWhenEmpty = Boolean(options.hideWhenEmpty);
  options.columnGap = String(options.columnGap || DEFAULTS.columnGap).trim() || DEFAULTS.columnGap;
  return options;
}

function parseOptionLine(line) {
  if (!line || /^\s*#/.test(line)) return null;
  const match = line.match(/([a-zA-Z0-9._ ]+):(.*)/);
  if (!match) return null;
  const name = match[1].trim();
  const def = OPTION_DEFS[name];
  if (!def) return null;

  let valueText = match[2].trim();
  if (!['string', 'regexp'].includes(def.type)) {
    valueText = valueText.replace(/#[^#]*$/, '').trim();
  }

  if (def.type === 'number') {
    const value = Number.parseInt(valueText, 10);
    if (Number.isNaN(value) || value < 0) throw new Error(`Invalid value for \`${name}\``);
    return { name, value };
  }

  if (def.type === 'boolean') {
    if (!['true', 'false'].includes(valueText)) throw new Error(`Invalid value for \`${name}\``);
    return { name, value: valueText === 'true' };
  }

  if (def.type === 'value') {
    if (!def.values.includes(valueText)) throw new Error(`Invalid value for \`${name}\``);
    return { name, value: valueText };
  }

  if (def.type === 'string') {
    if (valueText === 'null' || valueText === '""' || valueText === "''") return { name, value: '' };
    return { name, value: valueText };
  }

  if (def.type === 'regexp') {
    if (valueText === 'null' || valueText.length === 0) return { name, value: null };
    try {
      const regexMatch = /^\/(.*)\/([a-z]*)$/.exec(valueText);
      if (!regexMatch) throw new Error('Invalid regexp');
      return { name, value: new RegExp(regexMatch[1], regexMatch[2] || '') };
    } catch {
      throw new Error(`Invalid value for \`${name}\``);
    }
  }

  return null;
}

function normalizeInteger(value, fallback, min = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) || parsed < min ? fallback : parsed;
}

function normalizeBreakAt(value) {
  if (typeof value === 'number') {
    const level = Math.min(6, Math.max(2, value));
    return `h${level}`;
  }
  const normalized = String(value || '').trim().toLowerCase();
  return ['h2', 'h3', 'h4', 'h5', 'h6'].includes(normalized) ? normalized : DEFAULTS.breakAt;
}

function breakLevelNumber(options) {
  return Number.parseInt(options.breakAt.replace('h', ''), 10);
}

function shouldKeepHeading(headingText, options) {
  if (options.include instanceof RegExp) return options.include.test(headingText);
  if (options.exclude instanceof RegExp) return !options.exclude.test(headingText);
  return true;
}

function stripMarkdownFormatting(value) {
  return String(value)
    .replaceAll('*', '')
    .replace(/(\W|^)_+(\S)(.*?\S)?_+(\W|$)/g, '$1$2$3$4')
    .replaceAll('`', '')
    .replaceAll('==', '')
    .replaceAll('~~', '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function stripWikiLinks(value, forTarget = false) {
  return String(value)
    .replace(/\[\[([^\]]+)\|([^\]]+)\]\]/g, forTarget ? '$1 $2' : '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replaceAll('[[', '')
    .replaceAll('| ', forTarget ? ' ' : '- ')
    .replaceAll('|', forTarget ? ' ' : '-');
}

function stripHtml(value) {
  const markdown = typeof htmlToMarkdown === 'function' ? htmlToMarkdown(value) : value;
  return stripMarkdownFormatting(markdown).replace(/<[^>]+>/g, '');
}

function normalizeHeadingDisplay(heading) {
  return stripWikiLinks(stripHtml(heading), false).trim();
}

function normalizeHeadingTarget(heading) {
  return stripWikiLinks(String(heading), true).replaceAll('#', ' ').trim();
}

function filterHeadings(rawHeadings, options) {
  const headings = Array.isArray(rawHeadings) ? rawHeadings : [];
  if (!headings.length) return [];

  const autoMin = options.minLevel > 0 ? options.minLevel : Math.min(...headings.map((h) => h.level));
  const filtered = [];
  let skippedDepth = 0;

  for (const heading of headings) {
    if (skippedDepth > 0 && heading.level > skippedDepth) continue;
    if (skippedDepth > 0 && heading.level <= skippedDepth) skippedDepth = 0;

    if (!shouldKeepHeading(heading.heading, options)) {
      skippedDepth = heading.level;
      continue;
    }

    if (heading.level < autoMin) continue;
    if (options.maxLevel > 0 && heading.level > options.maxLevel) continue;
    if (!heading.heading || heading.heading.trim().length === 0) continue;

    filtered.push({
      level: heading.level,
      raw: heading.heading,
      text: normalizeHeadingDisplay(heading.heading),
      target: normalizeHeadingTarget(heading.heading),
    });
  }

  return filtered;
}

function buildTree(headings) {
  const root = { level: 0, raw: '', text: '', target: '', children: [], parent: null };
  const stack = [root];

  for (const heading of headings) {
    while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    const node = {
      ...heading,
      children: [],
      parent: stack[stack.length - 1],
    };

    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

function flattenTree(root) {
  const items = [];
  const visit = (node) => {
    if (node.level > 0) items.push(node);
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return items;
}

function collectChunks(root, breakLevel) {
  const chunks = [];

  function walk(node, ancestors) {
    if (node.level >= breakLevel) {
      chunks.push({ ancestors: [...ancestors], node });
      return;
    }

    if (!node.children.length) {
      chunks.push({ ancestors: [...ancestors], node });
      return;
    }

    for (const child of node.children) {
      walk(child, [...ancestors, node]);
    }
  }

  for (const child of root.children) {
    walk(child, []);
  }

  return chunks;
}

function flattenSubtree(node) {
  const items = [];
  const visit = (current) => {
    items.push(current);
    for (const child of current.children) visit(child);
  };
  visit(node);
  return items;
}

function commonAncestorPrefixLength(leftAncestors, rightAncestors) {
  const max = Math.min(leftAncestors.length, rightAncestors.length);
  let index = 0;
  while (index < max && leftAncestors[index] === rightAncestors[index]) {
    index += 1;
  }
  return index;
}

function buildChunkItemLists(chunks, options) {
  const chunkItems = [];
  let previousAncestors = [];

  for (const chunk of chunks) {
    const items = [];
    let ancestorsToEmit = chunk.ancestors;

    if (!options.repeatParents) {
      const sharedPrefix = commonAncestorPrefixLength(previousAncestors, chunk.ancestors);
      ancestorsToEmit = chunk.ancestors.slice(sharedPrefix);
    }

    for (const ancestor of ancestorsToEmit) {
      items.push({ ...ancestor, isContext: options.repeatParents });
    }

    for (const node of flattenSubtree(chunk.node)) {
      items.push({ ...node, isContext: false });
    }

    chunkItems.push(items);
    previousAncestors = chunk.ancestors;
  }

  return chunkItems;
}

function createInternalLinkEl(item, sourcePath, includeLinks) {
  if (!includeLinks) {
    const span = document.createElement('span');
    span.textContent = item.text;
    return span;
  }

  const link = document.createElement('a');
  const target = `#${item.target}`;
  link.className = 'internal-link';
  link.setAttribute('href', target);
  link.setAttribute('data-href', target);
  link.setAttribute('aria-label', item.text);
  link.setAttribute('data-tooltip-position', 'top');
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener nofollow');
  link.textContent = item.text;
  return link;
}

function createItemEl(item, sourcePath, includeLinks, baseLevel) {
  const el = document.createElement('div');
  el.className = 'smart-balanced-toc__item';
  el.dataset.level = String(item.level);
  el.style.setProperty('--smart-balanced-toc-relative-level', String(Math.max(0, item.level - baseLevel)));
  if (item.isContext) el.classList.add('is-context');
  el.appendChild(createInternalLinkEl(item, sourcePath, includeLinks));
  return el;
}

function renderItemsInto(container, items, sourcePath, options, baseLevel) {
  for (const item of items) {
    container.appendChild(createItemEl(item, sourcePath, options.includeLinks, baseLevel));
  }
}

function renderSingleColumn(container, root, sourcePath, options, baseLevel) {
  const items = flattenTree(root).map((node) => ({ ...node, isContext: false }));
  const columnsEl = container.createDiv({ cls: 'smart-balanced-toc__columns one-column' });
  columnsEl.style.setProperty('--smart-balanced-toc-gap', options.columnGap);
  const columnEl = columnsEl.createDiv({ cls: 'smart-balanced-toc__column' });
  renderItemsInto(columnEl, items, sourcePath, options, baseLevel);
}

function parseCssLengthToPixels(value, contextEl) {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return Number(normalized);

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.width = normalized;
  probe.style.height = '0';
  (contextEl || document.body).appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width || 0;
}

function createMeasurementColumn(referenceWidth) {
  const el = document.createElement('div');
  el.className = 'smart-balanced-toc__column smart-balanced-toc__measure-column';
  el.style.position = 'absolute';
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';
  el.style.left = '-99999px';
  el.style.top = '0';
  el.style.width = `${Math.max(1, referenceWidth)}px`;
  return el;
}

function measureChunkHeights(hostEl, chunkItems, sourcePath, options, baseLevel, columnWidth) {
  const measureRoot = document.createElement('div');
  measureRoot.className = 'smart-balanced-toc smart-balanced-toc--measure';
  measureRoot.style.position = 'absolute';
  measureRoot.style.visibility = 'hidden';
  measureRoot.style.pointerEvents = 'none';
  measureRoot.style.left = '-99999px';
  measureRoot.style.top = '0';
  measureRoot.style.width = `${Math.max(1, columnWidth)}px`;

  const columnEl = createMeasurementColumn(columnWidth);
  measureRoot.appendChild(columnEl);
  document.body.appendChild(measureRoot);

  const heights = chunkItems.map((items) => {
    columnEl.replaceChildren();
    renderItemsInto(columnEl, items, sourcePath, options, baseLevel);
    return columnEl.getBoundingClientRect().height;
  });

  measureRoot.remove();
  return heights;
}

function chooseBalancedSplit(heights) {
  if (heights.length <= 1) return heights.length;

  const total = heights.reduce((sum, value) => sum + value, 0);
  let running = 0;
  const candidates = [];

  for (let i = 0; i < heights.length - 1; i += 1) {
    running += heights[i];
    const left = running;
    const right = total - running;
    const diff = Math.abs(left - right);
    candidates.push({ index: i + 1, left, right, diff, leftHeavierOrEqual: left >= right });
  }

  const leftHeavyCandidates = candidates.filter((candidate) => candidate.leftHeavierOrEqual);
  const pool = leftHeavyCandidates.length > 0 ? leftHeavyCandidates : candidates;

  pool.sort((a, b) => {
    if (a.diff !== b.diff) return a.diff - b.diff;
    if (a.leftHeavierOrEqual !== b.leftHeavierOrEqual) return a.leftHeavierOrEqual ? -1 : 1;
    return a.index - b.index;
  });

  return pool[0]?.index ?? 1;
}

function renderTwoColumns(container, root, sourcePath, options, baseLevel) {
  const wrapper = container.createDiv({ cls: 'smart-balanced-toc__columns two-columns' });
  wrapper.style.setProperty('--smart-balanced-toc-gap', options.columnGap);
  const leftEl = wrapper.createDiv({ cls: 'smart-balanced-toc__column is-left' });
  const rightEl = wrapper.createDiv({ cls: 'smart-balanced-toc__column is-right' });

  const chunks = collectChunks(root, breakLevelNumber(options));
  if (chunks.length <= 1) {
    renderItemsInto(leftEl, flattenTree(root).map((node) => ({ ...node, isContext: false })), sourcePath, options, baseLevel);
    return;
  }

  const chunkItems = buildChunkItemLists(chunks, options);
  const hostWidth = Math.max(container.clientWidth || 0, container.parentElement?.clientWidth || 0, 700);
  const gapPx = parseCssLengthToPixels(options.columnGap, container);
  const columnWidth = Math.floor((hostWidth - gapPx) / 2);
  const heights = measureChunkHeights(container, chunkItems, sourcePath, options, baseLevel, columnWidth);
  const splitIndex = chooseBalancedSplit(heights);

  const leftItems = chunkItems.slice(0, splitIndex);
  const rightItems = chunkItems.slice(splitIndex);

  for (const items of leftItems) {
    renderItemsInto(leftEl, items, sourcePath, options, baseLevel);
  }

  for (const items of rightItems) {
    renderItemsInto(rightEl, items, sourcePath, options, baseLevel);
  }

  wrapper.dataset.splitIndex = String(splitIndex);
}

class SmartBalancedTocSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const headingWrapper = document.createElement('div');
    const headingTitle = document.createElement('div');
    headingTitle.className = 'setting-item-name';
    headingTitle.textContent = 'Default options';
    const headingDescription = document.createElement('div');
    headingDescription.className = 'setting-item-description';
    headingDescription.textContent = 'Configure defaults. Every option can still be overridden inside each code block.';
    headingWrapper.appendChild(headingTitle);
    headingWrapper.appendChild(headingDescription);

    const group = settingGroup(containerEl);
    if (group) {
      group.setHeading(headingWrapper);
    } else {
      containerEl.appendChild(headingWrapper);
    }

    new Setting(containerEl)
      .setName('Title')
      .setDesc('Title displayed above the TOC. Leave empty for none.')
      .addText((text) =>
        text.setPlaceholder('').setValue(this.plugin.settings.title).onChange(async (value) => {
          this.plugin.settings.title = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Minimum level')
      .setDesc('Include headings from this level (0 = auto).')
      .addText((text) =>
        text.setPlaceholder('2').setValue(String(this.plugin.settings.minLevel)).onChange(async (value) => {
          const parsed = normalizeInteger(value, this.plugin.settings.minLevel, 0);
          this.plugin.settings.minLevel = parsed;
          text.setValue(String(parsed));
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Maximum level')
      .setDesc('Include headings up to this level (0 = no limit).')
      .addText((text) =>
        text.setPlaceholder('0').setValue(String(this.plugin.settings.maxLevel)).onChange(async (value) => {
          const parsed = normalizeInteger(value, this.plugin.settings.maxLevel, 0);
          this.plugin.settings.maxLevel = parsed;
          text.setValue(String(parsed));
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Columns')
      .setDesc('Default number of columns.')
      .addDropdown((dropdown) =>
        dropdown.addOption('1', '1').addOption('2', '2').setValue(String(this.plugin.settings.columns)).onChange(async (value) => {
          this.plugin.settings.columns = value === '2' ? 2 : 1;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Break at')
      .setDesc('Only split between columns before headings of this level.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('h2', 'H2')
          .addOption('h3', 'H3')
          .addOption('h4', 'H4')
          .addOption('h5', 'H5')
          .addOption('h6', 'H6')
          .setValue(this.plugin.settings.breakAt)
          .onChange(async (value) => {
            this.plugin.settings.breakAt = normalizeBreakAt(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Repeat parent headings')
      .setDesc('When a section continues in the second column, repeat its ancestor headings for context.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.repeatParents).onChange(async (value) => {
          this.plugin.settings.repeatParents = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Column gap')
      .setDesc('Gap between columns (CSS length, for example 1rem or 20px).')
      .addText((text) =>
        text.setPlaceholder('1rem').setValue(this.plugin.settings.columnGap).onChange(async (value) => {
          this.plugin.settings.columnGap = String(value || '').trim() || DEFAULTS.columnGap;
          text.setValue(this.plugin.settings.columnGap);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Include links')
      .setDesc('Make headings clickable.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeLinks).onChange(async (value) => {
          this.plugin.settings.includeLinks = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Hide when empty')
      .setDesc('Hide the block when no headings are found.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideWhenEmpty).onChange(async (value) => {
          this.plugin.settings.hideWhenEmpty = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

class SmartBalancedTocChild extends MarkdownRenderChild {
  constructor(plugin, element, sourcePath, sourceText) {
    super(element);
    this.plugin = plugin;
    this.app = plugin.app;
    this.element = element;
    this.sourcePath = sourcePath;
    this.sourceText = sourceText;
    this.lastMeasuredWidth = 0;
    this.renderTimer = null;
    this.resizeObserver = null;
  }

  onload() {
    this.scheduleRender();

    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file.path === this.sourcePath) this.scheduleRender();
      })
    );

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        const width = Math.round(this.element.clientWidth || this.element.parentElement?.clientWidth || 0);
        if (width > 0 && Math.abs(width - this.lastMeasuredWidth) > 2) {
          this.lastMeasuredWidth = width;
          this.scheduleRender();
        }
      });
      this.resizeObserver.observe(this.element);
      this.register(() => this.resizeObserver?.disconnect());
    }
  }

  scheduleRender() {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.render(), 0);
  }

  async render() {
    try {
      const options = parseCodeBlockOptions(this.sourceText, this.plugin.settings);
      const cache = this.app.metadataCache.getCache(this.sourcePath);
      const headings = filterHeadings(cache?.headings || [], options);

      if (options.debugInConsole) {
        console.log('Smart Balanced TOC options', options);
        console.log('Smart Balanced TOC headings', headings);
      }

      this.element.empty();
      if (!headings.length) {
        if (options.hideWhenEmpty) return;
        const emptyEl = this.element.createDiv({ cls: 'smart-balanced-toc smart-balanced-toc--empty' });
        emptyEl.setText('Table of contents: no headings found');
        return;
      }

      const root = buildTree(headings);
      const baseLevel = options.minLevel > 0 ? options.minLevel : Math.min(...headings.map((heading) => heading.level));

      const wrapper = this.element.createDiv({ cls: 'smart-balanced-toc' });
      wrapper.dataset.columns = String(options.columns);
      wrapper.dataset.breakAt = options.breakAt;
      wrapper.dataset.repeatParents = String(options.repeatParents);
      wrapper.style.setProperty('--smart-balanced-toc-gap', options.columnGap);

      if (options.title) {
        const titleEl = wrapper.createDiv({ cls: 'smart-balanced-toc__title' });
        await MarkdownRenderer.renderMarkdown(options.title, titleEl, this.sourcePath, this);
      }

      if (options.columns === 2) {
        renderTwoColumns(wrapper, root, this.sourcePath, options, baseLevel);
      } else {
        renderSingleColumn(wrapper, root, this.sourcePath, options, baseLevel);
      }
    } catch (error) {
      console.error('Smart Balanced TOC error', error);
      this.element.empty();
      const errorEl = this.element.createDiv({ cls: 'smart-balanced-toc smart-balanced-toc--error' });
      errorEl.setText(`Could not render TOC (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

function insertBasicCodeBlock(editor) {
  editor.replaceRange('```smart-toc\n```', editor.getCursor());
}

function insertDocumentedCodeBlock(editor) {
  const contents = ['```smart-toc', getOptionsTemplate(), '```'].join('\n');
  editor.replaceRange(contents, editor.getCursor());
}

module.exports = class SmartBalancedTocPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    const processor = (source, el, ctx) => {
      ctx.addChild(new SmartBalancedTocChild(this, el, ctx.sourcePath, source));
    };

    for (const name of CODEBLOCKS) {
      this.registerMarkdownCodeBlockProcessor(name, processor);
    }

    this.addCommand({
      id: 'insert-smart-balanced-toc',
      name: 'Insert smart TOC',
      editorCallback: insertBasicCodeBlock,
    });

    this.addCommand({
      id: 'insert-smart-balanced-toc-with-options',
      name: 'Insert smart TOC (with available options)',
      editorCallback: insertDocumentedCodeBlock,
    });

    this.addSettingTab(new SmartBalancedTocSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.breakAt = normalizeBreakAt(this.settings.breakAt);
    this.settings.columns = this.settings.columns === 2 ? 2 : 1;
    this.settings.columnGap = String(this.settings.columnGap || DEFAULTS.columnGap).trim() || DEFAULTS.columnGap;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
