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
  sortBy: 'line',
  sortDirection: 'asc',
  showPreview: true,
  markerEnabled: true,
  markerText: '📌',
  markerOffsetX: -18,
  markerOffsetY: 0,
  ignoreFrontmatter: true,
  openPanelOnLoad: false,
  sourceDisplayMode: 'basename',
  previewMode: 'summary',
  previewChars: 140,
  filterMode: 'smart',
  hideDuplicateRefs: true,
  exportContentMode: 'full',
  exportSourceDisplayMode: 'path',
  exportOpenAfterCreate: true,
};
module.exports = class BlockReferenceCurrentPagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Number.isFinite(Number(this.settings.previewChars)) && Number.isFinite(Number(this.settings.previewLines))) {
      this.settings.previewChars = Math.max(40, Math.min(1000, Math.round(Number(this.settings.previewLines) * 45)));
    }
    this.settings.sortBy = 'line';
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
    this.addCommand({
      id: 'export-current-page-block-references',
      name: '导出当前页块引用',
      callback: () => void this.exportCurrentPageBlockReferences(),
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
  formatRefTargetLabel(ref) {
    const mode = this.settings.sourceDisplayMode === 'path' ? 'path' : 'basename';
    const base = mode === 'path'
      ? (ref.targetPath || ref.targetFileName || ref.targetLink || '未知目标')
      : (ref.targetFileName || ref.targetLink || ref.targetPath || '未知目标');
    if (ref.headingPath) return `${base} › ${ref.headingPath}`;
    return base;
  }
  getPreviewChars() {
    const raw = Number(this.settings.previewChars);
    if (!Number.isFinite(raw)) return 140;
    return Math.max(20, Math.min(1000, Math.round(raw)));
  }
  buildSummaryText(text, maxChars) {
    const compact = this.cleanPreviewText(text).replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    if (compact.length <= maxChars) return compact;
    return compact.slice(0, Math.max(1, maxChars)).replace(/[\s,.，。；;:：、!?！？]+$/g, '') + '…';
  }
  getFilterMode() {
    return this.settings.filterMode === 'all' ? 'all' : 'smart';
  }
  makeTextSnapshot(text, maxLen = 100) {
    const cleaned = this.cleanPreviewText(text)
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    return cleaned.slice(0, maxLen);
  }
  isLowSignalText(text) {
    const cleaned = this.cleanPreviewText(text);
    if (!cleaned) return true;
    const compact = cleaned.replace(/\s+/g, ' ').trim();
    if (compact.length < 6) return true;
    if (/^[#>*\-+\d.\s`~_=:[\]()]+$/.test(compact)) return true;
    return false;
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
    const blockMatch = raw.match(/^(.*?)#\^([^#|]+)$/);
    if (blockMatch) {
      return {
        targetRaw: raw,
        targetLink: String(blockMatch[1] || '').trim(),
        blockId: String(blockMatch[2] || '').trim(),
        headingPath: '',
      };
    }
    const headingMatch = raw.match(/^(.*?)#(?!\^)(.+)$/);
    if (headingMatch) {
      return {
        targetRaw: raw,
        targetLink: String(headingMatch[1] || '').trim(),
        blockId: '',
        headingPath: String(headingMatch[2] || '').trim(),
      };
    }
    return {
      targetRaw: raw,
      targetLink: raw,
      blockId: '',
      headingPath: '',
    };
  }
  parseRefsFromText(text, sourcePath, options = {}) {
    const refs = [];
    const baseLine = Number(options.baseLine || 0);
    const regex = /(!)?\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const full = match[0];
      const isEmbed = Boolean(match[1]);
      const inner = String(match[2] || '').trim();
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
      if (!parsed.targetLink && !parsed.blockId && !parsed.headingPath) continue;
      const isAliasRef = Boolean(alias && alias.startsWith('o-'));
      const isNativeBlockRef = Boolean(parsed.blockId) || /#\^[A-Za-z0-9_-]+$/.test(parsed.targetRaw);
      const isHeadingRef = Boolean(parsed.headingPath);
      if (!isAliasRef && !isNativeBlockRef && !isHeadingRef) continue;
      const localOffset = match.index;
      const absoluteLine = baseLine + this.offsetToLine(text, localOffset);
      const renderKind = isEmbed ? 'embed' : 'link';
      refs.push({
        id: `${sourcePath}::${absoluteLine}::${localOffset}::${alias || parsed.blockId || parsed.headingPath || 'ref'}`,
        sourcePath,
        line: absoluteLine,
        raw: full,
        alias,
        targetRaw: parsed.targetRaw,
        targetLink: parsed.targetLink,
        blockId: parsed.blockId,
        headingPath: parsed.headingPath,
        matchType: isNativeBlockRef ? 'block' : (isHeadingRef ? 'heading' : 'alias'),
        renderKind,
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
    const candidates = [];
    const raw = String(ref && ref.targetLink || '').trim();
    if (raw) {
      candidates.push(raw);
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded && decoded !== raw) candidates.push(decoded);
      } catch (_) {}
      if (/\.md$/i.test(raw)) candidates.push(raw.replace(/\.md$/i, ''));
    }
    for (const candidate of candidates) {
      const found = this.app.metadataCache.getFirstLinkpathDest(candidate, ref.sourcePath);
      if (found instanceof TFile) return found;
    }
    return null;
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
  normalizeHeadingKey(value) {
    return String(value || '')
      .trim()
      .replace(/^#+\s*/, '')
      .replace(/\\/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }
  findHeadingSection(lines, headings, headingPath) {
    const needle = this.normalizeHeadingKey(headingPath);
    if (!needle) return null;
    const list = Array.isArray(headings) ? headings : [];
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const title = this.normalizeHeadingKey(h && h.heading);
      if (title !== needle) continue;
      const startLine = h.position && h.position.start ? h.position.start.line : null;
      if (!Number.isInteger(startLine)) continue;
      let endLine = lines.length - 1;
      const level = Number(h.level || 0) || 0;
      for (let j = i + 1; j < list.length; j++) {
        const nxt = list[j];
        const nextLine = nxt && nxt.position && nxt.position.start ? nxt.position.start.line : null;
        if (!Number.isInteger(nextLine)) continue;
        if ((Number(nxt.level || 0) || 0) <= level) {
          endLine = Math.max(startLine, nextLine - 1);
          break;
        }
      }
      return { startLine, endLine, heading: String(h.heading || '').trim() };
    }
    const escaped = this.escapeRegExp(String(headingPath || '').trim());
    const headingRe = new RegExp(`^\s*#{1,6}\s*${escaped}\s*$`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (!headingRe.test(lines[i])) continue;
      let endLine = lines.length - 1;
      const currentLevel = ((lines[i].match(/^\s*(#{1,6})\s*/) || [])[1] || '').length || 6;
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^\s*(#{1,6})\s+/);
        if (!m) continue;
        if (m[1].length <= currentLevel) {
          endLine = Math.max(i, j - 1);
          break;
        }
      }
      return { startLine: i, endLine, heading: String(headingPath || '').trim() };
    }
    return null;
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
    if (ref.headingPath) {
      const cache = this.app.metadataCache.getFileCache(targetFile);
      const headingSection = this.findHeadingSection(lines, cache && cache.headings, ref.headingPath);
      if (headingSection) {
        const rawSection = lines.slice(headingSection.startLine, headingSection.endLine + 1).join('\n');
        const cleaned = this.cleanPreviewText(rawSection);
        if (this.isMeaningfulPreviewText(cleaned)) {
          return {
            targetFile,
            startLine: headingSection.startLine,
            endLine: headingSection.endLine,
            text: cleaned,
            snapshot: this.makeTextSnapshot(cleaned || rawSection),
          };
        }
        const fallback = this.findNearestMeaningfulLine(lines, Math.min(lines.length - 1, headingSection.startLine + 1), 6);
        return {
          targetFile,
          startLine: fallback.line,
          endLine: headingSection.endLine,
          text: fallback.text,
          snapshot: this.makeTextSnapshot(fallback.text || rawSection),
        };
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
        targetEndLine: blockInfo.endLine,
        preview: blockInfo.text,
        previewSnapshot: blockInfo.snapshot || this.makeTextSnapshot(blockInfo.text),
      });
    }
    return this.sortRefs(this.filterDisplayRefs(rows));
  }
  filterDisplayRefs(rows) {
    const filterMode = this.getFilterMode();
    const hideDup = this.settings.hideDuplicateRefs !== false;
    const seen = new Set();
    const kept = [];
    for (const row of rows) {
      const preview = this.cleanPreviewText(row.preview || '');
      const targetKey = `${row.targetPath || row.targetLink || ''}::${row.blockId || row.headingPath || row.alias || ''}`;
      const dupKey = `${targetKey}::${this.makeTextSnapshot(preview || row.previewSnapshot || '')}`;
      if (filterMode === 'smart') {
        if (this.isLowSignalText(preview)) continue;
      }
      if (hideDup) {
        if (seen.has(dupKey)) continue;
        seen.add(dupKey);
      }
      kept.push({ ...row, preview });
    }
    return kept;
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
  async locateTargetPosition(targetFile, ref) {
    if (!(targetFile instanceof TFile)) return { line: 0, matchedBy: 'fallback' };
    const fullText = await this.getFileText(targetFile);
    const lines = fullText.split(/\r?\n/);
    if (ref.blockId) {
      const cache = this.app.metadataCache.getFileCache(targetFile);
      const blocks = cache && cache.blocks ? cache.blocks : null;
      const block = blocks && blocks[ref.blockId] ? blocks[ref.blockId] : null;
      if (block && block.position && block.position.start) {
        return { line: block.position.start.line, matchedBy: 'block-id' };
      }
      const anchorRe = new RegExp(`\^${this.escapeRegExp(ref.blockId)}(?:\s*$|\s+)`);
      for (let i = 0; i < lines.length; i++) {
        if (anchorRe.test(lines[i])) return { line: i, matchedBy: 'anchor-line' };
      }
    }
    if (ref.headingPath) {
      const cache = this.app.metadataCache.getFileCache(targetFile);
      const headingSection = this.findHeadingSection(lines, cache && cache.headings, ref.headingPath);
      if (headingSection) return { line: headingSection.startLine, matchedBy: 'heading' };
    }
    const snapshot = this.makeTextSnapshot(ref.preview || ref.previewSnapshot || '');
    if (snapshot) {
      const idx = lines.findIndex((line) => this.makeTextSnapshot(line).includes(snapshot));
      if (idx !== -1) return { line: idx, matchedBy: 'snapshot' };
      const near = lines.findIndex((line) => snapshot.includes(this.makeTextSnapshot(line)) && this.makeTextSnapshot(line).length >= 12);
      if (near !== -1) return { line: near, matchedBy: 'snapshot-partial' };
    }
    const aliasLine = this.findAliasLine(lines, ref.alias);
    if (Number.isInteger(aliasLine)) return { line: aliasLine, matchedBy: 'alias' };
    const targetLine = Number.isFinite(ref.targetLine) ? ref.targetLine : 0;
    return { line: targetLine, matchedBy: 'cached-line' };
  }
  async getUniqueExportPath(baseDir, baseName) {
    const safeName = String(baseName || '块引用导出').replace(/[\\/:*?"<>|]/g, '-').trim() || '块引用导出';
    let attempt = `${baseDir ? baseDir + '/' : ''}${safeName}.md`;
    let idx = 2;
    while (this.app.vault.getAbstractFileByPath(attempt)) {
      attempt = `${baseDir ? baseDir + '/' : ''}${safeName}-${idx}.md`;
      idx += 1;
    }
    return attempt;
  }
  splitMarkdownBlocks(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];
    const lines = normalized.split('\n');
    const blocks = [];
    let current = [];
    let inFence = false;
    let fenceMarker = '';
    const pushCurrent = () => {
      if (!current.length) return;
      blocks.push(current.join('\n').trimEnd());
      current = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      const fenceMatch = trimmed.match(/^(```+|~~~+)/);
      if (inFence) {
        current.push(line);
        if (fenceMatch && fenceMatch[1] === fenceMarker) {
          inFence = false;
          fenceMarker = '';
        }
        continue;
      }
      if (!trimmed) {
        pushCurrent();
        continue;
      }
      current.push(line);
      if (fenceMatch) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      }
    }
    pushCurrent();
    return blocks.filter(Boolean);
  }
  truncateMarkdownBlock(block, maxChars) {
    const raw = String(block || '').trim();
    if (!raw) return '';
    if (raw.length <= maxChars) return raw;
    const lines = raw.split('\n');
    const kept = [];
    let used = 0;
    for (const line of lines) {
      const addition = kept.length ? `\n${line}` : line;
      if (used + addition.length > maxChars) break;
      kept.push(line);
      used += addition.length;
    }
    if (!kept.length) {
      const slice = raw.slice(0, Math.max(1, maxChars - 1)).replace(/[\s]+$/g, '');
      if (/^(```+|~~~+)/.test(lines[0].trim())) {
        const fence = lines[0].trim().match(/^(```+|~~~+)/)[1];
        return `${slice}\n${fence}\n…`;
      }
      return `${slice}…`;
    }
    let fragment = kept.join('\n').replace(/[\s]+$/g, '');
    const firstFence = lines[0].trim().match(/^(```+|~~~+)/);
    const lastFence = kept[kept.length - 1].trim().match(/^(```+|~~~+)/);
    if (firstFence && (!lastFence || lastFence[1] !== firstFence[1])) {
      fragment += `\n${firstFence[1]}`;
    }
    return `${fragment}\n…`;
  }
  buildSummaryMarkdown(text, maxChars) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const limit = Math.max(24, Number(maxChars) || 140);
    if (raw.length <= limit) return raw;
    const blocks = this.splitMarkdownBlocks(raw);
    if (!blocks.length) {
      return `${raw.slice(0, Math.max(1, limit - 1)).replace(/[\s]+$/g, '')}…`;
    }
    const kept = [];
    let used = 0;
    let truncated = false;
    for (const block of blocks) {
      const addition = kept.length ? `\n\n${block}` : block;
      if (used + addition.length <= limit) {
        kept.push(block);
        used += addition.length;
        continue;
      }
      const remaining = limit - used - (kept.length ? 2 : 0);
      if (remaining >= 24) {
        const fragment = this.truncateMarkdownBlock(block, remaining);
        if (fragment) kept.push(fragment);
      }
      truncated = true;
      break;
    }
    let result = kept.join('\n\n').trim();
    if (!result) result = this.truncateMarkdownBlock(raw, limit);
    if (truncated && !/…\s*$/.test(result)) result = `${result}\n\n…`;
    return result;
  }
  formatRefTargetLabelForMode(ref, mode) {
    const normalizedMode = mode === 'path' ? 'path' : 'basename';
    const base = normalizedMode === 'path'
      ? (ref.targetPath || ref.targetFileName || ref.targetLink || '未知目标')
      : (ref.targetFileName || ref.targetLink || ref.targetPath || '未知目标');
    if (ref.headingPath) return `${base} › ${ref.headingPath}`;
    return base;
  }
  buildExportMarkdown(file, refs) {
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const contentMode = this.settings.exportContentMode === 'summary' ? 'summary' : 'full';
    const sourceMode = this.settings.exportSourceDisplayMode === 'basename' ? 'basename' : 'path';
    const maxChars = this.getPreviewChars();
    const lines = [];
    lines.push(`# ${file.basename} - 块引用导出`);
    lines.push('');
    lines.push(`- 导出时间：${timestamp}`);
    lines.push(`- 当前文档：${file.path}`);
    lines.push(`- 块引用数量：${refs.length}`);
    lines.push(`- 导出内容模式：${contentMode === 'summary' ? '摘要' : '完整 Markdown'}`);
    lines.push(`- 导出来源显示：${sourceMode === 'path' ? '绝对路径' : '笔记名'}`);
    lines.push('');
    refs.forEach((ref, idx) => {
      const target = this.formatRefTargetLabelForMode(ref, sourceMode);
      const rawMarkdown = String(ref.preview || '').trim();
      const exportContent = contentMode === 'summary'
        ? this.buildSummaryMarkdown(rawMarkdown, maxChars)
        : rawMarkdown;
      lines.push(`## ${idx + 1}. ${target || '未命名目标'}`);
      lines.push('');
      lines.push(`- 当前页行号：${Number(ref.line) + 1}`);
      if (ref.targetPath) lines.push(`- 目标路径：${ref.targetPath}`);
      if (Number.isFinite(ref.targetLine)) lines.push(`- 目标行号：${Number(ref.targetLine) + 1}`);
      if (ref.blockId) lines.push(`- 块 ID：^${ref.blockId}`);
      else if (ref.headingPath) lines.push(`- 标题：#${ref.headingPath}`);
      else if (ref.alias) lines.push(`- 别名：${ref.alias}`);
      lines.push('');
      lines.push(exportContent || '未找到块内容');
      lines.push('');
    });
    return lines.join('\n');
  }
  async exportCurrentPageBlockReferences() {
    const view = this.getActiveMarkdownView();
    const file = view && view.file;
    if (!(file instanceof TFile)) {
      new Notice('当前没有可导出的 Markdown 页面。');
      return;
    }
    const refs = await this.buildDisplayRefs(file);
    const content = this.buildExportMarkdown(file, refs);
    const baseDir = file.parent ? file.parent.path : '';
    const exportPath = await this.getUniqueExportPath(baseDir, `${file.basename}-块引用导出`);
    await this.app.vault.create(exportPath, content);
    const created = this.app.vault.getAbstractFileByPath(exportPath);
    new Notice(`块引用已导出：${exportPath}`);
    if (created instanceof TFile && this.settings.exportOpenAfterCreate !== false) {
      const leaf = this.getPreferredMarkdownLeaf();
      await leaf.openFile(created);
    }
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
    const located = await this.locateTargetPosition(info.targetFile, { ...ref, ...info });
    const leaf = this.getPreferredMarkdownLeaf();
    await leaf.openFile(info.targetFile);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const line = Number.isFinite(located.line) ? located.line : 0;
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
  findMatchingHost(hosts, ref) {
    const refCandidates = new Set([
      this.normalizeCompareKey(ref.targetRaw),
      this.normalizeCompareKey(ref.targetLink),
      this.normalizeCompareKey(
        ref.blockId ? `${ref.targetLink}#^${ref.blockId}` : (ref.headingPath ? `${ref.targetLink}#${ref.headingPath}` : ref.targetLink)
      ),
    ]);
    for (const hostEl of hosts) {
      if (!hostEl || hostEl.dataset.obrDecorated === 'true') continue;
      const src = hostEl.getAttribute('src')
        || hostEl.getAttribute('href')
        || hostEl.dataset.href
        || hostEl.dataset.src
        || '';
      const normalizedSrc = this.normalizeCompareKey(src);
      if (refCandidates.has(normalizedSrc)) {
        return hostEl;
      }
    }
    return null;
  }
  ensureHostDecorated(hostEl, ref) {
    if (!hostEl) return;
    hostEl.dataset.obrDecorated = 'true';
    hostEl.dataset.obrOccurrenceId = ref.id;
    hostEl.classList.add('obr-inline-host');
    const isLinkHost = ref.renderKind === 'link';
    hostEl.classList.toggle('obr-inline-link-host', isLinkHost);
    hostEl.classList.toggle('obr-inline-embed-host', !isLinkHost);
    if (!hostEl.style.position || hostEl.style.position === 'static') {
      hostEl.style.position = 'relative';
    }
    if (isLinkHost) {
      if (!hostEl.style.display) hostEl.style.display = 'inline-flex';
      if (!hostEl.style.alignItems) hostEl.style.alignItems = 'center';
      hostEl.style.verticalAlign = hostEl.style.verticalAlign || 'baseline';
    }
    if (!this.settings.markerEnabled) return;
    let marker = hostEl.querySelector(':scope > .obr-inline-marker');
    if (!marker) {
      marker = document.createElement('span');
      marker.className = 'obr-inline-marker';
      marker.setAttribute('aria-hidden', 'true');
      hostEl.prepend(marker);
    }
    const x = Number(this.settings.markerOffsetX || 0);
    const y = Number(this.settings.markerOffsetY || 0);
    const baseX = isLinkHost ? x - 2 : x;
    const top = isLinkHost ? '0.62em' : '50%';
    const transform = isLinkHost
      ? `translate(${baseX}px, calc(-50% + ${y}px))`
      : `translate(${baseX}px, calc(-50% + ${y}px))`;
    marker.textContent = this.sanitizeMarkerText(this.settings.markerText);
    marker.removeAttribute('title');
    marker.style.position = 'absolute';
    marker.style.left = '0';
    marker.style.top = top;
    marker.style.transform = transform;
    marker.style.fontWeight = '700';
    marker.style.fontSize = isLinkHost ? '0.88em' : '0.95em';
    marker.style.lineHeight = '1';
    marker.style.pointerEvents = 'none';
    marker.style.zIndex = '2';
    marker.style.userSelect = 'none';
    marker.style.opacity = isLinkHost ? '0.92' : '1';
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
    const hosts = Array.from(el.querySelectorAll('.internal-embed, a.internal-link'));
    if (!hosts.length) return;
    for (const ref of refs) {
      const host = this.findMatchingHost(hosts, ref);
      if (host) {
        this.ensureHostDecorated(host, ref);
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
    const sortLabel = actions.createDiv({
      cls: 'obr-inline-note',
      text: '默认按行号',
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
    const exportBtn = actions.createEl('button', {
      cls: 'obr-toolbar-btn',
      text: '导出',
    });
    exportBtn.addEventListener('click', async () => {
      await this.plugin.exportCurrentPageBlockReferences();
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
      text: '切换到包含块引用的页面后，侧边栏会自动刷新。',
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
  async createCard(listEl, ref, index) {
    const card = listEl.createDiv({ cls: 'obr-card obr-card--preview-only' });
    card.addEventListener('click', () => void this.plugin.openOccurrence(ref));
    const meta = card.createDiv({ cls: 'obr-card-meta' });
    meta.createDiv({ cls: 'obr-card-index', text: String(index) });
    meta.createDiv({
      cls: 'obr-card-target',
      text: this.plugin.formatRefTargetLabel(ref),
    });
    const previewText = (ref.preview || '').trim();
    const body = card.createDiv({ cls: 'obr-card-body obr-card-body--only' });
    if (this.plugin.settings.showPreview) {
      const mode = this.plugin.settings.previewMode === 'full' ? 'full' : 'summary';
      body.toggleClass('is-summary', mode === 'summary');
      if (mode === 'summary') {
        const rawMarkdown = String(previewText || '').trim();
        const maxChars = this.plugin.getPreviewChars();
        const summaryMarkdown = this.plugin.buildSummaryMarkdown(rawMarkdown, maxChars);
        await this.renderPreviewMarkdown(body, summaryMarkdown || '未找到块内容', ref.targetPath || ref.sourcePath || '');
        if (rawMarkdown && rawMarkdown.length > maxChars) {
          const expand = card.createEl('button', {
            cls: 'obr-expand-btn',
            text: '展开',
            attr: { type: 'button' },
          });
          let expanded = false;
          expand.addEventListener('click', async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            expanded = !expanded;
            body.empty();
            if (expanded) {
              body.removeClass('is-summary');
              await this.renderPreviewMarkdown(body, rawMarkdown, ref.targetPath || ref.sourcePath || '');
              expand.setText('收起');
            } else {
              body.addClass('is-summary');
              await this.renderPreviewMarkdown(body, summaryMarkdown || '未找到块内容', ref.targetPath || ref.sourcePath || '');
              expand.setText('展开');
            }
          });
        }
      } else {
        await this.renderPreviewMarkdown(body, previewText, ref.targetPath || ref.sourcePath || '');
      }
    } else {
      body.setText('块内容预览已关闭');
    }
    const footer = card.createDiv({ cls: 'obr-card-footer' });
    footer.createDiv({
      cls: 'obr-card-footer-text',
      text: `当前页第 ${Number(ref.line) + 1} 行`,
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
    for (let i = 0; i < refs.length; i++) {
      await this.createCard(listEl, refs[i], i + 1);
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
    buildSettingsUI(contentEl, this.plugin);
  }
  onClose() {
    this.contentEl.empty();
  }
}
function buildSettingsUI(containerEl, plugin) {
  containerEl.empty();
  const root = containerEl.createDiv({ cls: 'obr-settings-shell' });
  const layout = root.createDiv({ cls: 'obr-settings-layout' });
  const nav = layout.createDiv({ cls: 'obr-settings-nav' });
  const body = layout.createDiv({ cls: 'obr-settings-body' });
  const tabs = [
    { id: 'general', label: '通用' },
    { id: 'preview', label: '预览' },
    { id: 'export', label: '导出' },
    { id: 'marker', label: '标志' },
    { id: 'behavior', label: '行为' },
  ];
  let activeTab = 'general';
  const renderGeneral = (mount) => {
    const section = createSettingsSection(mount, '通用设置');
    new Setting(section)
      .setName('侧边栏默认方向')
      .addDropdown((d) => d
        .addOption('asc', '升序')
        .addOption('desc', '降序')
        .setValue(plugin.settings.sortDirection)
        .onChange(async (value) => {
          plugin.settings.sortDirection = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('侧边栏引用来源显示')
      .addDropdown((d) => d
        .addOption('basename', '笔记名')
        .addOption('path', '绝对路径')
        .setValue(plugin.settings.sourceDisplayMode || 'basename')
        .onChange(async (value) => {
          plugin.settings.sourceDisplayMode = value;
          await plugin.saveSettings();
        }));
  };
  const renderPreview = (mount) => {
    const section = createSettingsSection(mount, '预览与过滤');
    new Setting(section)
      .setName('显示块内容预览')
      .addToggle((t) => t
        .setValue(plugin.settings.showPreview)
        .onChange(async (value) => {
          plugin.settings.showPreview = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('预览模式')
      .addDropdown((d) => d
        .addOption('summary', '摘要')
        .addOption('full', '全文')
        .setValue(plugin.settings.previewMode || 'summary')
        .onChange(async (value) => {
          plugin.settings.previewMode = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('摘要目标字符数')
      .addText((txt) => txt
        .setPlaceholder('140')
        .setValue(String(plugin.getPreviewChars()))
        .onChange(async (value) => {
          const num = Number(value);
          plugin.settings.previewChars = Number.isFinite(num) ? Math.max(20, Math.min(1000, Math.round(num))) : 140;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('索引过滤')
      .addDropdown((d) => d
        .addOption('smart', '智能过滤')
        .addOption('all', '显示全部')
        .setValue(plugin.getFilterMode())
        .onChange(async (value) => {
          plugin.settings.filterMode = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('隐藏重复块引用')
      .addToggle((t) => t
        .setValue(plugin.settings.hideDuplicateRefs !== false)
        .onChange(async (value) => {
          plugin.settings.hideDuplicateRefs = value;
          await plugin.saveSettings();
        }));
  };
  const renderExport = (mount) => {
    const section = createSettingsSection(mount, '导出设置');
    new Setting(section)
      .setName('导出内容模式')
      .addDropdown((d) => d
        .addOption('full', '完整 Markdown')
        .addOption('summary', '摘要')
        .setValue(plugin.settings.exportContentMode || 'full')
        .onChange(async (value) => {
          plugin.settings.exportContentMode = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('导出来源显示')
      .addDropdown((d) => d
        .addOption('path', '绝对路径')
        .addOption('basename', '笔记名')
        .setValue(plugin.settings.exportSourceDisplayMode || 'path')
        .onChange(async (value) => {
          plugin.settings.exportSourceDisplayMode = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('导出后自动打开文件')
      .addToggle((t) => t
        .setValue(plugin.settings.exportOpenAfterCreate !== false)
        .onChange(async (value) => {
          plugin.settings.exportOpenAfterCreate = value;
          await plugin.saveSettings();
        }));
  };
  const renderMarker = (mount) => {
    const section = createSettingsSection(mount, '左侧标志');
    new Setting(section)
      .setName('显示左侧提示标志')
      .addToggle((t) => t
        .setValue(plugin.settings.markerEnabled)
        .onChange(async (value) => {
          plugin.settings.markerEnabled = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('提示标志文字')
      .addText((txt) => txt
        .setPlaceholder('📌')
        .setValue(plugin.settings.markerText)
        .onChange(async (value) => {
          plugin.settings.markerText = plugin.sanitizeMarkerText(value);
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('提示标志横向平移')
      .addText((txt) => txt
        .setPlaceholder('-18')
        .setValue(String(plugin.settings.markerOffsetX ?? -18))
        .onChange(async (value) => {
          const num = Number(value);
          plugin.settings.markerOffsetX = Number.isFinite(num) ? num : -18;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('提示标志纵向平移')
      .addText((txt) => txt
        .setPlaceholder('0')
        .setValue(String(plugin.settings.markerOffsetY ?? 0))
        .onChange(async (value) => {
          const num = Number(value);
          plugin.settings.markerOffsetY = Number.isFinite(num) ? num : 0;
          await plugin.saveSettings();
        }));
  };
  const renderBehavior = (mount) => {
    const section = createSettingsSection(mount, '行为设置');
    new Setting(section)
      .setName('排除 YAML / Frontmatter 区')
      .addToggle((t) => t
        .setValue(plugin.settings.ignoreFrontmatter)
        .onChange(async (value) => {
          plugin.settings.ignoreFrontmatter = value;
          await plugin.saveSettings();
        }));
    new Setting(section)
      .setName('启动时自动打开侧边面板')
      .addToggle((t) => t
        .setValue(plugin.settings.openPanelOnLoad)
        .onChange(async (value) => {
          plugin.settings.openPanelOnLoad = value;
          await plugin.saveSettings();
        }));
  };
  const renderTab = () => {
    body.empty();
    const pane = body.createDiv({ cls: 'obr-settings-pane' });
    if (activeTab === 'general') renderGeneral(pane);
    if (activeTab === 'preview') renderPreview(pane);
    if (activeTab === 'export') renderExport(pane);
    if (activeTab === 'marker') renderMarker(pane);
    if (activeTab === 'behavior') renderBehavior(pane);
  };
  tabs.forEach((tab) => {
    const btn = nav.createEl('button', {
      cls: `obr-settings-tab${activeTab === tab.id ? ' is-active' : ''}`,
      attr: { type: 'button' },
      text: tab.label,
    });
    btn.addEventListener('click', () => {
      activeTab = tab.id;
      [...nav.querySelectorAll('.obr-settings-tab')].forEach((el) => el.removeClass('is-active'));
      btn.addClass('is-active');
      renderTab();
    });
  });
  renderTab();
}
function createSettingsSection(containerEl, title) {
  const card = containerEl.createDiv({ cls: 'obr-settings-card' });
  if (title) {
    const head = card.createDiv({ cls: 'obr-settings-card-head' });
    head.createDiv({ cls: 'obr-settings-card-title', text: title });
  }
  return card.createDiv({ cls: 'obr-settings-card-body' });
}
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return String(value).replace(/"/g, '\\"');
}