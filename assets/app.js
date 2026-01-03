const STORAGE_KEYS = {
  markdown: "mdr:markdown:v1",
  mode: "mdr:mode:v1",
  theme: "mdr:theme:v1",
};

const DEFAULTS = {
  mode: "edit",
  features: {
    tables: true,
    strikethrough: true,
    inlineHtml: false,
    math: true,
    highlight: true,
    theme: "light",
  },
  export: {
    maxWidthPx: 900,
    paddingPx: 16,
    scale: null,
  },
};

const state = {
  mode: DEFAULTS.mode,
  theme: DEFAULTS.features.theme,
  markdownText: "",
  dirty: true,
  exporting: false,
};

const dom = /** @type {const} */ ({
  btnEdit: document.getElementById("btnEdit"),
  btnPreview: document.getElementById("btnPreview"),
  btnExport: document.getElementById("btnExport"),
  btnSettings: document.getElementById("btnSettings"),
  editor: document.getElementById("editor"),
  preview: document.getElementById("preview"),
  previewPane: document.getElementById("previewPane"),
  fileInput: document.getElementById("fileInput"),
  dropOverlay: document.getElementById("dropOverlay"),
  toast: document.getElementById("toast"),
  settingsDialog: document.getElementById("settingsDialog"),
  hljsTheme: document.getElementById("hljsTheme"),
  themeColor: document.getElementById("themeColor"),
  themeLight: document.getElementById("themeLight"),
  themeDark: document.getElementById("themeDark"),
});

let markdownIt = null;
let renderTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
let toastTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
let isComposing = false;
let dragCounter = 0;

init();

function init() {
  markdownIt = createMarkdownIt();

  const restoredTheme = restoreThemeFromStorage();
  state.theme = restoredTheme ?? getSystemTheme();
  applyTheme(state.theme, { save: restoredTheme !== null });

  const restored = restoreFromStorage();
  if (restored) {
    state.markdownText = restored.markdownText;
    state.mode = restored.mode;
    state.dirty = true;
  } else {
    state.markdownText = demoMarkdown();
    state.mode = DEFAULTS.mode;
  }

  dom.editor.value = state.markdownText;
  setMode(state.mode, { save: false });
  syncThemeControls();

  wireEvents();
  renderIfNeeded({ force: true });
}

function wireEvents() {
  dom.btnEdit.addEventListener("click", () => setMode("edit"));
  dom.btnPreview.addEventListener("click", () => setMode("preview"));
  dom.btnExport.addEventListener("click", () => exportPng());
  dom.btnSettings.addEventListener("click", () => openSettings());

  if (dom.themeLight) {
    dom.themeLight.addEventListener("change", () => {
      if (dom.themeLight.checked) applyTheme("light");
    });
  }
  if (dom.themeDark) {
    dom.themeDark.addEventListener("change", () => {
      if (dom.themeDark.checked) applyTheme("dark");
    });
  }

  dom.editor.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  dom.editor.addEventListener("compositionend", () => {
    isComposing = false;
    onEditorInput();
  });
  dom.editor.addEventListener("input", () => onEditorInput());

  dom.fileInput.addEventListener("change", async (e) => {
    const input = /** @type {HTMLInputElement} */ (e.currentTarget);
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    await importMarkdownFile(file);
  });

  window.addEventListener("dragenter", (e) => onDragEnter(e));
  window.addEventListener("dragover", (e) => onDragOver(e));
  window.addEventListener("dragleave", (e) => onDragLeave(e));
  window.addEventListener("drop", (e) => onDrop(e));
}

function onEditorInput() {
  if (isComposing) return;
  state.markdownText = dom.editor.value;
  state.dirty = true;
  saveToStorageDebounced();
  if (state.mode !== "edit") scheduleRender();
}

function setMode(mode, { save = true } = {}) {
  if (mode !== "edit" && mode !== "preview" && mode !== "split") return;
  state.mode = mode;
  document.documentElement.dataset.mode = mode;

  dom.btnEdit.classList.toggle("is-active", mode === "edit");
  dom.btnPreview.classList.toggle("is-active", mode === "preview" || mode === "split");

  if (save) {
    try {
      localStorage.setItem(STORAGE_KEYS.mode, mode);
    } catch {}
  }

  if (mode !== "edit") renderIfNeeded({ force: false });
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderIfNeeded({ force: false });
  }, 400);
}

function renderIfNeeded({ force }) {
  if (!markdownIt) return;
  if (!force && !state.dirty) return;

  const t0 = performance.now();
  const html = renderMarkdownToHtml(state.markdownText);
  dom.preview.innerHTML = html;
  if (DEFAULTS.features.highlight) applyHighlight(dom.preview);
  state.dirty = false;

  const ms = Math.round(performance.now() - t0);
  if (ms > 80) showToast(`已渲染（${ms}ms）`, { durationMs: 900 });
}

function renderMarkdownToHtml(markdownText) {
  const { text, segments } = DEFAULTS.features.math
    ? extractMathSegments(markdownText)
    : { text: markdownText, segments: [] };

  const rawHtml = markdownIt.render(text);
  const safeHtml = sanitizeHtml(rawHtml);
  if (!DEFAULTS.features.math) return safeHtml;
  return applyMathSegments(safeHtml, segments);
}

function createMarkdownIt() {
  const md = window.markdownit({
    html: false,
    linkify: true,
    breaks: false,
    typographer: true,
  });

  md.validateLink = (url) => isSafeUrl(url);

  return md;
}

function sanitizeHtml(html) {
  if (!window.DOMPurify) return html;
  return window.DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

function isSafeUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("/")) return true;
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return true;

  try {
    const parsed = new URL(trimmed, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function applyHighlight(container) {
  if (!window.hljs) return;
  const blocks = container.querySelectorAll("pre code");
  for (const block of blocks) {
    try {
      window.hljs.highlightElement(block);
    } catch {}
  }
}

function extractMathSegments(markdown) {
  const segments = [];
  const prefix = "@@MDRENDER_MATH_";
  let out = "";
  let i = 0;

  let inlineCodeTicks = 0;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  while (i < markdown.length) {
    if (isLineStart(markdown, i)) {
      const fence = scanFenceMarker(markdown, i);
      if (fence && !inFence) {
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.len;
      } else if (fence && inFence && fence.char === fenceChar && fence.len >= fenceLen) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
    }

    if (inFence) {
      out += markdown[i];
      i += 1;
      continue;
    }

    if (markdown[i] === "`") {
      const ticks = countRun(markdown, i, "`");
      if (inlineCodeTicks === 0) {
        inlineCodeTicks = ticks;
      } else if (ticks === inlineCodeTicks) {
        inlineCodeTicks = 0;
      }
      out += markdown.slice(i, i + ticks);
      i += ticks;
      continue;
    }

    if (inlineCodeTicks === 0) {
      const blockStart = markdown.startsWith("$$", i);
      if (blockStart) {
        const end = markdown.indexOf("$$", i + 2);
        if (end !== -1) {
          const content = markdown.slice(i + 2, end);
          const placeholder = `${prefix}${segments.length}@@`;
          segments.push({ placeholder, content, displayMode: true });
          out += placeholder;
          i = end + 2;
          continue;
        }
      }

      if (startsWithUnescaped(markdown, i, "\\[")) {
        const end = findUnescaped(markdown, i + 2, "\\]");
        if (end !== -1) {
          const content = markdown.slice(i + 2, end);
          const placeholder = `${prefix}${segments.length}@@`;
          segments.push({ placeholder, content, displayMode: true });
          out += placeholder;
          i = end + 2;
          continue;
        }
      }

      if (startsWithUnescaped(markdown, i, "\\(")) {
        const end = findUnescaped(markdown, i + 2, "\\)");
        if (end !== -1) {
          const content = markdown.slice(i + 2, end);
          const placeholder = `${prefix}${segments.length}@@`;
          segments.push({ placeholder, content, displayMode: false });
          out += placeholder;
          i = end + 2;
          continue;
        }
      }
    }

    out += markdown[i];
    i += 1;
  }

  return { text: out, segments };
}

function applyMathSegments(html, segments) {
  if (!window.katex) return html;
  let out = html;

  for (const seg of segments) {
    const rendered = renderKatex(seg.content, seg.displayMode);
    if (seg.displayMode) {
      const re = new RegExp(`<p>\\s*${escapeRegExp(seg.placeholder)}\\s*<\\/p>`, "g");
      out = out.replace(re, rendered);
    }
    out = out.split(seg.placeholder).join(rendered);
  }

  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderKatex(content, displayMode) {
  try {
    return window.katex.renderToString(content, {
      displayMode,
      throwOnError: false,
      strict: "warn",
      trust: false,
    });
  } catch (e) {
    const escaped = escapeHtml(String(content));
    return displayMode ? `<pre>${escaped}</pre>` : `<code>${escaped}</code>`;
  }
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isLineStart(src, i) {
  return i === 0 || src[i - 1] === "\n";
}

function scanFenceMarker(src, i) {
  let j = i;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j += 1;
  const c = src[j];
  if (c !== "`" && c !== "~") return null;
  const len = countRun(src, j, c);
  if (len < 3) return null;
  return { char: c, len };
}

function countRun(src, i, ch) {
  let j = i;
  while (j < src.length && src[j] === ch) j += 1;
  return j - i;
}

function startsWithUnescaped(src, i, needle) {
  if (!src.startsWith(needle, i)) return false;
  const prev = i > 0 ? src[i - 1] : "";
  return prev !== "\\";
}

function findUnescaped(src, from, needle) {
  let idx = from;
  while (idx !== -1) {
    idx = src.indexOf(needle, idx);
    if (idx === -1) return -1;
    const prev = idx > 0 ? src[idx - 1] : "";
    if (prev !== "\\") return idx;
    idx += needle.length;
  }
  return -1;
}

async function importMarkdownFile(file) {
  if (!file.name.toLowerCase().endsWith(".md") && !file.type.includes("markdown")) {
    showToast("请选择 .md 文件", { durationMs: 1600 });
  }
  const text = await file.text();
  state.markdownText = text;
  state.dirty = true;
  dom.editor.value = text;
  saveToStorageDebounced(true);
  showToast(`已导入：${file.name}`, { durationMs: 1400 });
  if (state.mode !== "edit") renderIfNeeded({ force: true });
}

function onDragEnter(e) {
  if (!isFileDragEvent(e)) return;
  e.preventDefault();
  dragCounter += 1;
  dom.dropOverlay.hidden = false;
}

function onDragOver(e) {
  if (!isFileDragEvent(e)) return;
  e.preventDefault();
  try {
    /** @type {DragEvent} */ (e).dataTransfer.dropEffect = "copy";
  } catch {}
}

function onDragLeave(e) {
  if (!isFileDragEvent(e)) return;
  e.preventDefault();
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dom.dropOverlay.hidden = true;
}

function onDrop(e) {
  if (!isFileDragEvent(e)) return;
  e.preventDefault();
  dragCounter = 0;
  dom.dropOverlay.hidden = true;
  const dt = /** @type {DragEvent} */ (e).dataTransfer;
  if (!dt) return;
  const file = dt.files && dt.files[0];
  if (!file) return;
  importMarkdownFile(file);
}

function isFileDragEvent(e) {
  const dt = /** @type {DragEvent} */ (e).dataTransfer;
  if (!dt) return false;
  return Array.from(dt.types || []).includes("Files");
}

async function exportPng() {
  if (state.exporting) return;
  state.exporting = true;
  setBusy(true);

  try {
    if (state.mode === "edit") setMode("preview");
    renderIfNeeded({ force: false });

    showToast("正在生成 PNG…", { durationMs: 1800 });
    const canvas = await renderPreviewToCanvas();
    const blob = await canvasToBlob(canvas, "image/png");
    const name = `markdown_${timestamp()}.png`;
    await downloadBlob(blob, name);
    showToast(`已导出：${name}`, { durationMs: 1600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`导出失败：${msg}`, { durationMs: 2600 });
    console.error(err);
  } finally {
    state.exporting = false;
    setBusy(false);
  }
}

async function renderPreviewToCanvas() {
  if (!window.html2canvas) throw new Error("html2canvas 未加载");

  const exportWidth = Math.min(DEFAULTS.export.maxWidthPx, dom.previewPane.clientWidth || 720);
  const root = document.createElement("div");
  root.className = "export-root";
  root.style.width = `${exportWidth}px`;
  root.style.padding = `${DEFAULTS.export.paddingPx}px`;

  const clone = dom.preview.cloneNode(true);
  root.appendChild(clone);
  document.body.appendChild(root);

  try {
    await waitForFonts();
    await waitForImages(root);

    const width = root.scrollWidth;
    const height = root.scrollHeight;
    const scale =
      DEFAULTS.export.scale ??
      Math.max(1, Math.min(2, Math.round((window.devicePixelRatio || 1) * 10) / 10));

    const scaledWidth = Math.floor(width * scale);
    const scaledHeight = Math.floor(height * scale);
    const MAX_DIM = 32767;
    const MAX_AREA = 50_000_000;

    if (scaledWidth > MAX_DIM || scaledHeight > MAX_DIM) {
      throw new Error("内容过长/过宽，超出浏览器画布限制；请缩短内容或降低导出宽度/倍率");
    }
    if (scaledWidth * scaledHeight > MAX_AREA) {
      throw new Error("图片像素过大，可能导致内存不足；请降低导出宽度/倍率或缩短内容");
    }

    const full = document.createElement("canvas");
    full.width = scaledWidth;
    full.height = scaledHeight;
    const ctx = full.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");

    const maxTileScaledH = 4096;
    const tileCssH = Math.max(256, Math.floor(maxTileScaledH / scale));
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#ffffff";
    let y = 0;
    let destY = 0;

    while (y < height) {
      const h = Math.min(tileCssH, height - y);
      const tileCanvas = await window.html2canvas(root, {
        backgroundColor: bg,
        scale,
        useCORS: true,
        allowTaint: false,
        width,
        height: h,
        x: 0,
        y,
        windowWidth: width,
        windowHeight: h,
      });

      ctx.drawImage(tileCanvas, 0, destY);
      destY += tileCanvas.height;
      y += h;
    }

    return full;
  } finally {
    root.remove();
  }
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("无法生成图片数据"))), type);
  });
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

function openSettings() {
  if (!dom.settingsDialog) return;
  syncThemeControls();
  if (typeof dom.settingsDialog.showModal === "function") {
    dom.settingsDialog.showModal();
    return;
  }
  showToast("当前浏览器不支持设置面板", { durationMs: 1800 });
}

function setBusy(busy) {
  dom.btnExport.disabled = busy;
  dom.btnEdit.disabled = busy;
  dom.btnPreview.disabled = busy;
  dom.btnSettings.disabled = busy;
  dom.fileInput.disabled = busy;
}

function showToast(message, { durationMs = 1400 } = {}) {
  if (toastTimer) clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, durationMs);
}

function getSystemTheme() {
  try {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme, { save = true } = {}) {
  if (theme !== "light" && theme !== "dark") return;
  state.theme = theme;
  document.documentElement.dataset.theme = theme;

  if (dom.hljsTheme && "href" in dom.hljsTheme) {
    const href =
      theme === "dark"
        ? "https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css"
        : "https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css";
    if (dom.hljsTheme.href !== href) dom.hljsTheme.href = href;
  }

  if (dom.themeColor && "content" in dom.themeColor) {
    dom.themeColor.content = theme === "dark" ? "#0b0f19" : "#ffffff";
  }

  syncThemeControls();

  if (!save) return;
  try {
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  } catch {}
}

function syncThemeControls() {
  if (dom.themeLight) dom.themeLight.checked = state.theme === "light";
  if (dom.themeDark) dom.themeDark.checked = state.theme === "dark";
}

let saveTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
function saveToStorageDebounced(immediate = false) {
  if (saveTimer) clearTimeout(saveTimer);
  const delay = immediate ? 0 : 700;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEYS.markdown, state.markdownText);
    } catch {}
  }, delay);
}

function restoreThemeFromStorage() {
  try {
    const theme = localStorage.getItem(STORAGE_KEYS.theme);
    return theme === "dark" || theme === "light" ? theme : null;
  } catch {
    return null;
  }
}

function restoreFromStorage() {
  try {
    const markdownText = localStorage.getItem(STORAGE_KEYS.markdown);
    const mode = localStorage.getItem(STORAGE_KEYS.mode);
    if (!markdownText) return null;
    return {
      markdownText,
      mode: mode === "preview" || mode === "edit" || mode === "split" ? mode : DEFAULTS.mode,
    };
  } catch {
    return null;
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function waitForFonts() {
  if (!document.fonts || typeof document.fonts.ready?.then !== "function") return;
  try {
    await document.fonts.ready;
  } catch {}
}

async function waitForImages(root) {
  const imgs = Array.from(root.querySelectorAll("img"));
  const pending = imgs
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }),
    );
  if (pending.length) await Promise.race([Promise.all(pending), timeout(4000)]);
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function demoMarkdown() {
  return [
    "# Markdown Render",
    "",
    "- 拖拽 `.md` 文件到页面（桌面端）",
    "- 或在编辑区粘贴/输入 Markdown",
    "- 点击「预览」查看渲染效果",
    "- 点击「导出 PNG」生成长图",
    "",
    "## 表格 / 删除线",
    "",
    "| Name | Value |",
    "| --- | ---: |",
    "| foo | 123 |",
    "| ~~bar~~ | 456 |",
    "",
    "## 数学公式（\\( ... \\) / $$ ... $$）",
    "",
    "行内：\\(a^2 + b^2 = c^2\\)",
    "",
    "块级：",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
    "",
    "## 代码高亮",
    "",
    "```js",
    "function hello(name) {",
    "  return `Hello, ${name}`;",
    "}",
    "```",
  ].join("\n");
}
