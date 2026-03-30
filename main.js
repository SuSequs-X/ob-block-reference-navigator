const {
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  Modal,
  MarkdownView,
  TFile,
  Notice,
  MarkdownRenderer,
} = require('obsidian');

const VIEW_TYPE = 'block-reference-current-page-view';

const DEFAULT_SETTINGS = {
  sortBy: 'occurrence',
  sortDirection: 'asc',
  showPreview: true,
  markerEnabled: true,
  markerText: '📌',
  markerOffsetX: -18,
  markerOffsetY: 0,
  ignoreFrontmatter: true,
  openPanelOnLoad: false,
};

module.exports = class BlockReferenceCurrentPagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.markerText = this.sanitizeMarkerText(this.settings.markerText);

    this.lastMarkdownView = null;
    this.refsCache = new Map();
    this.fileTextCache = new Map();
    this.frontmatterCache = new Map();
    this.refreshTimer = null;

    this.registerView(VIEW_TYPE, (leaf) => new BlockReferencePanelView(leaf, this));
    this.addSettingTab(new BlockReferenceSettingTab(this.app, this));

    this.addRibbonIcon('panel-right-open', '打开当前页块引用面板', () => {
      void this.activatePanel();
    });

    this.addRibbonIcon('settings', '打开块引用插件设置', () => {
      new BlockReferenceSettingsModal(this.app, this).open();
    });

    this.addCommand({
      id: 'open-block-reference-panel',
      name: '打开当前页块引用面板',
      callback: () => void this.activatePanel(),
    });

    this.addCommand({
      id: 'refresh-block-reference-panel',
      name: '刷新当前页块引用面板',
      callback: () => void this.refreshEverywhere(),
    });

    this.addCommand({
      id: 'open-block-reference-settings',
      name: '打开块引用插件设置',
      callback: () => new BlockReferenceSettingsModal(this.app, this).open(),
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      void this.decorateReadingSection(el, ctx);
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf && leaf.view instanceof MarkdownView) {
        this.lastMarkdownView = leaf.view;
      }
      this.scheduleRefresh();
    }));

    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.scheduleRefresh();
    }));

    this.registerEvent(this.app.workspace.on('editor-change', () => {
      this.clearActiveFileCaches();
      this.scheduleRefresh();
    }));

    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.scheduleRefresh();
    }));

    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      this.refsCache.clear();
      this.frontmatterCache.clear();
      this.scheduleRefresh();
    }));

    if (this.settings.openPanelOnLoad) {
      await this.activatePanel();
    } else {
      this.refreshPanelView();
    }
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  sanitizeMarkerText(value) {
    const text = String(value || '').trim();
    if (!text) return '📌';
    if (/^o/i.test(text)) return '📌';
    return text;
  }

  scheduleRefresh() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshEverywhere();
    }, 120);
  }

  async saveSettings() {
    this.settings.markerText = this.sanitizeMarkerText(this.settings.markerText);
    await this.saveData(this.settings);
    this.refsCache.clear();
    await this.refreshEverywhere();
  }

  async refreshEverywhere() {
    this.refreshPanelView();
    await this.rerenderMarkdownLeaves();
  }

  refreshPanelView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view && typeof view.render === 'function') {
        view.render();
      }
    }
  }

  async rerenderMarkdownLeaves() {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      try {
        const state = leaf.getViewState();
        await leaf.setViewState(state, { focus: false });
      } catch (_) {}
    }
  }

  async activatePanel() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    if (leaf.view && typeof leaf.view.render === 'function') {
      await leaf.view.render();
    }
  }

  getActiveMarkdownView() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      this.lastMarkdownView = active;
      return active;
    }

    if (this.lastMarkdownView && this.lastMarkdownView.file) {
      return this.lastMarkdownView;
    }

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (leaves.length && leaves[0].view instanceof MarkdownView) {
      this.lastMarkdownView = leaves[0].view;
      return leaves[0].view;
    }

    return null;
  }

  getPreferredMarkdownLeaf() {
    const view = this.getActiveMarkdownView();
    if (view && view.leaf) return view.leaf;

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (leaves.length) return leaves[0];

    return this.app.workspace.getLeaf(true);
  }

  clearActiveFileCaches() {
    const view = this.getActiveMarkdownView();
    const file = view && view.file;
    if (!file) return;

    this.refsCache.delete(file.path);
    this.fileTextCache.delete(file.path);
  }

  async getFileText(file) {
    if (!(file instanceof TFile)) return '';

    if (this.fileTextCache.has(file.path)) {
      return this.fileTextCache.get(file.path);
    }

    const text = await this.app.vault.cachedRead(file);
    this.fileTextCache.set(file.path, text);
    return text;
  }

  getFrontmatterRange(text) {
    const key = text.slice(0, 2048);
    if (this.frontmatterCache.has(key)) {
      return this.frontmatterCache.get(key);
    }

    const lines = String(text || '').split(/\r?\n/);
    let result = {
      exists: false,
      endLine: -1,
      bodyStartLine: 0,
      bodyStartOffset: 0,
    };

    if (lines.length && lines[0].trim() === '---') {
      let offset = lines[0].length + 1;
      for (let i = 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '---' || trimmed === '...') {
          result = {
            exists: true,
            endLine: i,
            bodyStartLine: i + 1,
            bodyStartOffset: offset + lines[i].length + 1,
          };
          break;
        }
        offset += lines[i].length + 1;
      }
    }

    this.frontmatterCache.set(key, result);
    return result;
  }

  escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  offsetToLine(text, offset) {
    if (offset <= 0) return 0;
    let line = 0;
    for (let i = 0; i < Math.min(offset, text.length); i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  normalizeCompareKey(value) {
    return String(value || '')
      .trim()
      .replace(/\.md(?=$|#)/i, '')
      .replace(/^\/+/, '');
  }

  parseTargetParts(targetRaw) {
    const raw = String(targetRaw || '').trim();
    const blockMatch = raw.match(/^(.*?)#\^(.+)$/);

    if (blockMatch) {
      return {
        targetRaw: raw,
        targetLink: String(blockMatch[1] || '').trim(),
        blockId: String(blockMatch[2] || '').trim(),
      };
    }

    return {
      targetRaw: raw,
      targetLink: raw,
      blockId: '',
    };
  }

  parseRefsFromText(text, sourcePath, options = {}) {
    const refs = [];
    const baseLine = Number(options.baseLine || 0);
    const regex = /!\[\[([^\]]+)\]\]/g;

    let match;
    while ((match = regex.exec(text)) !== null) {
      const full = match[0];
      const inner = String(match[1] || '').trim();
      if (!inner) continue;

      let targetRaw = inner;
      let alias = '';

      const pipeIndex = inner.indexOf('|');
      if (pipeIndex !== -1) {
        targetRaw = inner.slice(0, pipeIndex).trim();
        alias = inner.slice(pipeIndex + 1).trim();
      }

      if (!targetRaw) continue;

      const parsed = this.parseTargetParts(targetRaw);
      if (!parsed.targetLink && !parsed.blockId) continue;

      const isAliasRef = Boolean(alias && alias.startsWith('o-'));
      const isNativeBlockRef = Boolean(parsed.blockId) || /#\^[A-Za-z0-9_-]+$/.test(parsed.targetRaw);
      if (!isAliasRef && !isNativeBlockRef) continue;

      const localOffset = match.index;
      const absoluteLine = baseLine + this.offsetToLine(text, localOffset);

      refs.push({
        id: `${sourcePath}::${absoluteLine}::${localOffset}::${alias || parsed.blockId || 'ref'}`,
        sourcePath,
        line: absoluteLine,
        raw: full,
        alias,
        targetRaw: parsed.targetRaw,
        targetLink: parsed.targetLink,
        blockId: parsed.blockId,
        matchType: isNativeBlockRef ? 'block' : 'alias',
      });
    }

    return refs;
  }

  async getRefsForFile(file) {
    if (!(file instanceof TFile)) return [];

    if (this.refsCache.has(file.path)) {
      return this.refsCache.get(file.path);
    }

    const text = await this.getFileText(file);
    const fm = this.settings.ignoreFrontmatter
      ? this.getFrontmatterRange(text)
      : { exists: false, bodyStartLine: 0, bodyStartOffset: 0 };

    const scanText = fm.exists ? text.slice(fm.bodyStartOffset) : text;
    const baseLine = fm.exists ? fm.bodyStartLine : 0;
    const refs = this.parseRefsFromText(scanText, file.path, { baseLine });

    this.refsCache.set(file.path, refs);
    return refs;
  }

  isSectionInFrontmatter(fileText, lineStart, lineEnd) {
    if (!this.settings.ignoreFrontmatter) return false;

    const fm = this.getFrontmatterRange(fileText);
    if (!fm.exists) return false;

    return lineStart <= fm.endLine || lineEnd <= fm.endLine;
  }

  resolveTargetFile(ref) {
    return this.app.metadataCache.getFirstLinkpathDest(ref.targetLink, ref.sourcePath);
  }

  findAliasLine(lines, alias) {
    const needle = String(alias || '').trim();
    if (!needle) return null;

    const re = new RegExp(this.escapeRegExp(needle), 'i');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i;
    }
    return null;
  }

  cleanPreviewText(text) {
    let t = String(text || '');

    t = t.replace(/%%[\s\S]*?%%/g, '');
    t = t.replace(/(^|\s)\^([A-Za-z0-9_-]+)(?=\s*$)/gm, '$1');
    t = t.replace(/\bo-[A-Za-z0-9_-]+\b/g, '');

    t = t.replace(/^\s*[-*+]\s*$/gm, '');
    t = t.replace(/^\s*\d+[.)]\s*$/gm, '');
    t = t.replace(/[ \t]+\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');

    const lines = t
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (/^[-*+]$/.test(trimmed)) return false;
        if (/^\d+[.)]$/.test(trimmed)) return false;
        return true;
      });

    return lines.join('\n').trim();
  }

  isMeaningfulPreviewText(text) {
    const cleaned = this.cleanPreviewText(text);
    if (!cleaned) return false;

    const stripped = cleaned
      .replace(/`[^`]*`/g, '')
      .replace(/[*_~=#>[\]()!-]/g, '')
      .replace(/\s+/g, '')
      .trim();

    return Boolean(stripped);
  }

  findNearestMeaningfulLine(lines, centerLine, maxOffset = 4) {
    const candidates = [];

    for (let offset = 0; offset <= maxOffset; offset++) {
      if (offset === 0) {
        candidates.push(centerLine);
      } else {
        candidates.push(centerLine + offset, centerLine - offset);
      }
    }

    for (const idx of candidates) {
      if (idx < 0 || idx >= lines.length) continue;

      const raw = String(lines[idx] || '');
      const cleaned = this.cleanPreviewText(raw);
      if (this.isMeaningfulPreviewText(cleaned)) {
        return {
          line: idx,
          text: cleaned,
        };
      }
    }

    return {
      line: centerLine,
      text: '',
    };
  }

  buildPreviewAroundLine(lines, lineIndex, radius = 0) {
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
      return '';
    }

    const start = Math.max(0, lineIndex - radius);
    const end = Math.min(lines.length - 1, lineIndex + radius);
    const raw = lines.slice(start, end + 1).join('\n');

    return this.cleanPreviewText(raw);
  }

  async extractBlockInfo(ref) {
    const targetFile = this.resolveTargetFile(ref);
    if (!(targetFile instanceof TFile)) {
      return { targetFile: null, startLine: null, text: '' };
    }

    const fullText = await this.getFileText(targetFile);
    const lines = fullText.split(/\r?\n/);

    if (ref.blockId) {
      const cache = this.app.metadataCache.getFileCache(targetFile);
      const blocks = cache && cache.blocks ? cache.blocks : null;
      const block = blocks && blocks[ref.blockId] ? blocks[ref.blockId] : null;

      if (block && block.position && block.position.start && block.position.end) {
        const startLine = block.position.start.line;
        const endLine = block.position.end.line;
        const picked = lines.slice(startLine, endLine + 1).join('\n');
        const cleaned = this.cleanPreviewText(
          picked.replace(
            new RegExp(`\\s*\\^${this.escapeRegExp(ref.blockId)}\\s*$`),
            ''
          )
        );

        if (this.isMeaningfulPreviewText(cleaned)) {
          return {
            targetFile,
            startLine,
            text: cleaned,
          };
        }

        const fallback = this.findNearestMeaningfulLine(lines, startLine, 4);
        return {
          targetFile,
          startLine: fallback.line,
          text: fallback.text,
        };
      }

      const anchorRe = new RegExp(`\\^${this.escapeRegExp(ref.blockId)}(?:\\s*$|\\s+)`);
      for (let i = 0; i < lines.length; i++) {
        if (anchorRe.test(lines[i])) {
          const cleaned = this.cleanPreviewText(
            lines[i].replace(
              new RegExp(`\\s*\\^${this.escapeRegExp(ref.blockId)}\\s*$`),
              ''
            )
          );

          if (this.isMeaningfulPreviewText(cleaned)) {
            return {
              targetFile,
              startLine: i,
              text: cleaned,
            };
          }

          const fallback = this.findNearestMeaningfulLine(lines, i, 4);
          return {
            targetFile,
            startLine: fallback.line,
            text: fallback.text,
          };
        }
      }
    }

    const aliasLine = this.findAliasLine(lines, ref.alias);
    if (Number.isInteger(aliasLine)) {
      const cleaned = this.buildPreviewAroundLine(lines, aliasLine, 0);
      if (this.isMeaningfulPreviewText(cleaned)) {
        return {
          targetFile,
          startLine: aliasLine,
          text: cleaned,
        };
      }

      const fallback = this.findNearestMeaningfulLine(lines, aliasLine, 4);
      return {
        targetFile,
        startLine: fallback.line,
        text: fallback.text,
      };
    }

    return {
      targetFile,
      startLine: 0,
      text: '',
    };
  }

  async buildDisplayRefs(file) {
    const refs = await this.getRefsForFile(file);
    const rows = [];

    for (const ref of refs) {
      const blockInfo = await this.extractBlockInfo(ref);
      rows.push({
        ...ref,
        targetFile: blockInfo.targetFile,
        targetFileName: blockInfo.targetFile ? blockInfo.targetFile.basename : ref.targetLink,
        targetPath: blockInfo.targetFile ? blockInfo.targetFile.path : ref.targetLink,
        targetLine: blockInfo.startLine,
        preview: blockInfo.text,
      });
    }

    return this.sortRefs(rows);
  }

  sortRefs(rows) {
    const factor = this.settings.sortDirection === 'desc' ? -1 : 1;
    const sortBy = this.settings.sortBy;

    return [...rows].sort((a, b) => {
      let av;
      let bv;

      if (sortBy === 'target') {
        av = (a.targetFileName || '').toLowerCase();
        bv = (b.targetFileName || '').toLowerCase();
      } else if (sortBy === 'line') {
        av = a.line;
        bv = b.line;
      } else {
        av = a.line;
        bv = b.line;
      }

      if (av < bv) return -1 * factor;
      if (av > bv) return 1 * factor;
      return (a.line - b.line) * factor;
    });
  }

  async openOccurrence(ref) {
    const sourceFile = this.app.vault.getAbstractFileByPath(ref.sourcePath);
    if (!(sourceFile instanceof TFile)) return;

    const leaf = this.getPreferredMarkdownLeaf();
    await leaf.openFile(sourceFile);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    const mode = typeof view.getMode === 'function' ? view.getMode() : 'source';
    if (mode !== 'preview' && view.editor) {
      view.editor.setCursor({ line: ref.line, ch: 0 });
      view.editor.scrollIntoView(
        { from: { line: ref.line, ch: 0 }, to: { line: ref.line + 1, ch: 0 } },
        true
      );
      return;
    }

    try {
      view.setEphemeralState({ line: ref.line, focus: true });
    } catch (_) {}

    window.setTimeout(() => this.revealOccurrenceMarker(view, ref.id, ref.line), 80);
    window.setTimeout(() => this.revealOccurrenceMarker(view, ref.id, ref.line), 220);
  }

  async openOriginalBlock(ref) {
    const info = await this.extractBlockInfo(ref);
    if (!(info.targetFile instanceof TFile)) {
      new Notice('未能解析目标文件。');
      return;
    }

    const leaf = this.getPreferredMarkdownLeaf();
    await leaf.openFile(info.targetFile);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    const line = Number.isFinite(info.startLine) ? info.startLine : 0;
    const mode = typeof view.getMode === 'function' ? view.getMode() : 'source';

    if (mode !== 'preview' && view.editor) {
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView(
        { from: { line, ch: 0 }, to: { line: line + 1, ch: 0 } },
        true
      );
      return;
    }

    try {
      view.setEphemeralState({ line, focus: true });
    } catch (_) {}
  }

  revealOccurrenceMarker(view, occurrenceId, line) {
    const container = view.previewMode && view.previewMode.containerEl;
    if (!container) return;

    const marker = container.querySelector(
      `[data-obr-occurrence-id="${cssEscape(occurrenceId)}"]`
    );

    if (marker) {
      marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
      marker.classList.add('obr-flash');
      window.setTimeout(() => marker.classList.remove('obr-flash'), 700);
      return;
    }

    const nodes = container.querySelectorAll('[data-sourcepos]');
    const targetLine1 = line + 1;

    for (const node of nodes) {
      const pos = node.getAttribute('data-sourcepos') || '';
      const match = pos.match(/^(\d+):\d+-(\d+):\d+$/);
      if (!match) continue;

      const start = Number(match[1]);
      const end = Number(match[2]);
      if (targetLine1 >= start && targetLine1 <= end) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.add('obr-flash');
        window.setTimeout(() => node.classList.remove('obr-flash'), 700);
        return;
      }
    }
  }

  findMatchingEmbed(embeds, ref) {
    const refCandidates = new Set([
      this.normalizeCompareKey(ref.targetRaw),
      this.normalizeCompareKey(ref.targetLink),
      this.normalizeCompareKey(
        ref.blockId ? `${ref.targetLink}#^${ref.blockId}` : ref.targetLink
      ),
    ]);

    for (const embedEl of embeds) {
      if (!embedEl || embedEl.dataset.obrDecorated === 'true') continue;

      const src = embedEl.getAttribute('src')
        || embedEl.dataset.href
        || embedEl.dataset.src
        || '';

      const normalizedSrc = this.normalizeCompareKey(src);
      if (refCandidates.has(normalizedSrc)) {
        return embedEl;
      }
    }

    return null;
  }

  ensureEmbedDecorated(embedEl, ref) {
    if (!embedEl || embedEl.dataset.obrDecorated === 'true') return;

    embedEl.dataset.obrDecorated = 'true';
    embedEl.dataset.obrOccurrenceId = ref.id;
    embedEl.classList.add('obr-inline-host');

    embedEl.style.position = embedEl.style.position || 'relative';

    if (!this.settings.markerEnabled) return;

    let marker = embedEl.querySelector(':scope > .obr-inline-marker');
    if (!marker) {
      marker = document.createElement('span');
      marker.className = 'obr-inline-marker';
      marker.setAttribute('aria-hidden', 'true');
      embedEl.prepend(marker);
    }

    const x = Number(this.settings.markerOffsetX || 0);
    const y = Number(this.settings.markerOffsetY || 0);

    marker.textContent = this.sanitizeMarkerText(this.settings.markerText);
    marker.removeAttribute('title');
    marker.style.position = 'absolute';
    marker.style.left = '0';
    marker.style.top = '50%';
    marker.style.transform = `translate(${x}px, calc(-50% + ${y}px))`;
    marker.style.fontWeight = '700';
    marker.style.fontSize = '0.95em';
    marker.style.lineHeight = '1';
    marker.style.pointerEvents = 'none';
    marker.style.zIndex = '2';
    marker.style.userSelect = 'none';
  }

  async decorateReadingSection(el, ctx) {
    const sourcePath = ctx && ctx.sourcePath;
    if (!sourcePath) return;
    if (el.closest('.frontmatter')) return;

    const activeView = this.getActiveMarkdownView();
    const activeFile = activeView && activeView.file;
    if (!(activeFile instanceof TFile)) return;
    if (activeFile.path !== sourcePath) return;

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const section = typeof ctx.getSectionInfo === 'function'
      ? ctx.getSectionInfo(el)
      : null;
    if (!section || !section.text) return;

    const fullText = await this.getFileText(file);
    if (this.isSectionInFrontmatter(fullText, section.lineStart, section.lineEnd)) {
      return;
    }

    const refs = this.parseRefsFromText(section.text, file.path, {
      baseLine: section.lineStart,
    });
    if (!refs.length) return;

    const embeds = Array.from(el.querySelectorAll('.internal-embed'));
    if (!embeds.length) return;

    for (const ref of refs) {
      const embed = this.findMatchingEmbed(embeds, ref);
      if (embed) {
        this.ensureEmbedDecorated(embed, ref);
      }
    }
  }
};

class BlockReferencePanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '当前页块引用';
  }

  getIcon() {
    return 'panel-right-open';
  }

  async onOpen() {
    await this.render();
  }

  createHeader(contentEl, file, refsCount) {
    const header = contentEl.createDiv({ cls: 'obr-panel-header' });

    const top = header.createDiv({ cls: 'obr-panel-topline' });

    const titleWrap = top.createDiv({ cls: 'obr-panel-title-wrap' });
    titleWrap.createDiv({ cls: 'obr-panel-eyebrow', text: 'Block Reference' });
    titleWrap.createDiv({ cls: 'obr-panel-title', text: '当前页块引用' });
    titleWrap.createDiv({
      cls: 'obr-panel-subtitle',
      text: file instanceof TFile ? file.basename : '未找到当前文档',
    });

    const badgeWrap = top.createDiv({ cls: 'obr-panel-badges' });
    const countBadge = badgeWrap.createDiv({ cls: 'obr-badge obr-badge--count' });
    countBadge.setText(`${refsCount} 条`);

    const actions = header.createDiv({ cls: 'obr-panel-tools' });

    const sortSelect = actions.createEl('select', { cls: 'obr-panel-select' });
    [
      ['occurrence', '文内顺序'],
      ['target', '目标文档'],
      ['line', '行号'],
    ].forEach(([value, text]) => {
      const opt = sortSelect.createEl('option', { text, value });
      if (this.plugin.settings.sortBy === value) opt.selected = true;
    });

    sortSelect.addEventListener('change', async () => {
      this.plugin.settings.sortBy = sortSelect.value;
      await this.plugin.saveSettings();
    });

    const dirBtn = actions.createEl('button', {
      cls: 'obr-toolbar-btn',
      text: this.plugin.settings.sortDirection === 'asc' ? '升序' : '降序',
    });
    dirBtn.addEventListener('click', async () => {
      this.plugin.settings.sortDirection =
        this.plugin.settings.sortDirection === 'asc' ? 'desc' : 'asc';
      await this.plugin.saveSettings();
    });

    const refreshBtn = actions.createEl('button', {
      cls: 'obr-toolbar-btn',
      text: '刷新',
    });
    refreshBtn.addEventListener('click', async () => {
      await this.plugin.refreshEverywhere();
      new Notice('块引用面板已刷新');
    });

    const settingsBtn = actions.createEl('button', {
      cls: 'obr-toolbar-btn obr-toolbar-btn--primary',
      text: '设置',
    });
    settingsBtn.addEventListener('click', () => {
      new BlockReferenceSettingsModal(this.app, this.plugin).open();
    });

    return header;
  }

  createEmptyState(listEl) {
    const empty = listEl.createDiv({ cls: 'obr-empty' });
    empty.createDiv({ cls: 'obr-empty-title', text: '当前页没有匹配到块引用' });
    empty.createDiv({
      cls: 'obr-empty-desc',
      text: '识别 ![[文件名|o-xxx]] 与 ![[文件名#^blockid]] 两类嵌入。切换到含有该语法的页面后，侧边栏会自动刷新。',
    });
  }

  async renderPreviewMarkdown(container, markdown, sourcePath) {
    container.empty();
    container.addClass('markdown-rendered');
    container.addClass('obr-card-markdown');

    const text = String(markdown || '').trim();
    if (!text) {
      container.setText('未找到块内容');
      return;
    }

    try {
      if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === 'function') {
        await MarkdownRenderer.renderMarkdown(text, container, sourcePath || '', this);
        return;
      }

      if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
        await MarkdownRenderer.render(this.app, text, container, sourcePath || '', this);
        return;
      }
    } catch (_) {}

    container.setText(text);
  }

  async createCard(listEl, ref) {
    const card = listEl.createDiv({ cls: 'obr-card obr-card--preview-only' });
    card.addEventListener('click', () => void this.plugin.openOccurrence(ref));

    const previewText = (ref.preview || '').trim();
    const body = card.createDiv({ cls: 'obr-card-body obr-card-body--only' });

    if (this.plugin.settings.showPreview) {
      await this.renderPreviewMarkdown(body, previewText, ref.targetPath || ref.sourcePath || '');
    } else {
      body.setText('块内容预览已关闭');
    }

    const footer = card.createDiv({ cls: 'obr-card-footer' });
    footer.createDiv({
      cls: 'obr-card-footer-text',
      text: ref.targetFileName || ref.targetLink || '未知目标',
    });

    const actions = footer.createDiv({ cls: 'obr-card-actions' });

    const locateBtn = actions.createEl('button', {
      cls: 'obr-action-btn',
      text: '定位',
    });
    locateBtn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void this.plugin.openOccurrence(ref);
    });

    const sourceBtn = actions.createEl('button', {
      cls: 'obr-action-btn obr-action-btn--primary',
      text: '原文',
    });
    sourceBtn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void this.plugin.openOriginalBlock(ref);
    });
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('obr-panel');

    const view = this.plugin.getActiveMarkdownView();
    const file = view && view.file;

    if (!(file instanceof TFile)) {
      this.createHeader(contentEl, null, 0);
      const listEl = contentEl.createDiv({ cls: 'obr-panel-list' });
      listEl.createDiv({ cls: 'obr-empty', text: '当前没有激活的 Markdown 页面。' });
      return;
    }

    const refs = await this.plugin.buildDisplayRefs(file);
    this.createHeader(contentEl, file, refs.length);

    const listEl = contentEl.createDiv({ cls: 'obr-panel-list' });
    if (!refs.length) {
      this.createEmptyState(listEl);
      return;
    }

    for (const ref of refs) {
      await this.createCard(listEl, ref);
    }
  }
}

class BlockReferenceSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Block Reference Current Page' });
    buildSettingsUI(containerEl, this.plugin);
  }
}

class BlockReferenceSettingsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '块引用插件设置' });
    buildSettingsUI(contentEl, this.plugin);
  }

  onClose() {
    this.contentEl.empty();
  }
}

function buildSettingsUI(containerEl, plugin) {
  containerEl.createDiv({
    cls: 'obr-settings-intro',
    text: '本插件仅针对当前激活页面工作，并识别 ![[文件名|o-xxx]] 与 ![[文件名#^blockid]] 两类嵌入。',
  });

  new Setting(containerEl)
    .setName('侧边栏默认排序')
    .setDesc('控制右侧面板中引用内容的默认排列方式。')
    .addDropdown((d) => d
      .addOption('occurrence', '文内顺序')
      .addOption('target', '目标文档')
      .addOption('line', '行号')
      .setValue(plugin.settings.sortBy)
      .onChange(async (value) => {
        plugin.settings.sortBy = value;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('侧边栏默认方向')
    .setDesc('升序与降序会同时影响文内顺序与目标文档排序。')
    .addDropdown((d) => d
      .addOption('asc', '升序')
      .addOption('desc', '降序')
      .setValue(plugin.settings.sortDirection)
      .onChange(async (value) => {
        plugin.settings.sortDirection = value;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('显示块内容预览')
    .setDesc('关闭后，侧边栏仍保留引用项，但不额外强调内容层。')
    .addToggle((t) => t
      .setValue(plugin.settings.showPreview)
      .onChange(async (value) => {
        plugin.settings.showPreview = value;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('显示左侧提示标志')
    .setDesc('在阅读视图中，为匹配到的嵌入块添加左侧可视标记。')
    .addToggle((t) => t
      .setValue(plugin.settings.markerEnabled)
      .onChange(async (value) => {
        plugin.settings.markerEnabled = value;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('提示标志文字')
    .setDesc('不要以 o 开头；推荐使用 Windows 可正常显示的 emoji，例如 📌。')
    .addText((txt) => txt
      .setPlaceholder('📌')
      .setValue(plugin.settings.markerText)
      .onChange(async (value) => {
        plugin.settings.markerText = plugin.sanitizeMarkerText(value);
        await plugin.saveSettings();
      }));


  new Setting(containerEl)
    .setName('提示标志横向平移')
    .setDesc('负数向左，正数向右。适合不同主题微调位置。')
    .addText((txt) => txt
      .setPlaceholder('-18')
      .setValue(String(plugin.settings.markerOffsetX ?? -18))
      .onChange(async (value) => {
        const num = Number(value);
        plugin.settings.markerOffsetX = Number.isFinite(num) ? num : -18;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('提示标志纵向平移')
    .setDesc('负数向上，正数向下。')
    .addText((txt) => txt
      .setPlaceholder('0')
      .setValue(String(plugin.settings.markerOffsetY ?? 0))
      .onChange(async (value) => {
        const num = Number(value);
        plugin.settings.markerOffsetY = Number.isFinite(num) ? num : 0;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('排除 YAML / Frontmatter 区')
    .setDesc('开启后，顶部 YAML 区不会参与块引用扫描，也不会在阅读视图里被增强。')
    .addToggle((t) => t
      .setValue(plugin.settings.ignoreFrontmatter)
      .onChange(async (value) => {
        plugin.settings.ignoreFrontmatter = value;
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('启动时自动打开侧边面板')
    .setDesc('适合需要长期固定右侧导航栏的使用场景。')
    .addToggle((t) => t
      .setValue(plugin.settings.openPanelOnLoad)
      .onChange(async (value) => {
        plugin.settings.openPanelOnLoad = value;
        await plugin.saveSettings();
      }));
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return String(value).replace(/"/g, '\\"');
}
