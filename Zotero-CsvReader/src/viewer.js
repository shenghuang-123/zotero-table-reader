/*
 * viewer.js —— 自定义元素 zotero-csvreader-view。
 * 只读表格：固定表头 + 虚拟滚动，单元格一律用 textContent 写入。
 *
 * 两条数据通路：
 *   text     —— 字节 → 编码探测 → 解码 → RFC 4180 分词
 *   workbook —— 字节 → SheetJS 解析 → 选中工作表 → sheet_to_json(header:1)
 * 两条通路最终都归一到 rows: string[][]，交给同一套渲染逻辑。
 *
 * 主窗口是 XUL 文档，因此宿主元素用 createXULElement 创建，内部 HTML 节点用 XHTML 命名空间。
 */

var CsvReaderViewer = {
  ELEMENT_NAME: "zotero-csvreader-view",
  XHTML_NS: "http://www.w3.org/1999/xhtml",

  ROW_HEIGHT: 26,
  OVERSCAN: 10,
  ROWNUM_WIDTH: 52,
  MIN_COL_WIDTH: 60,
  MAX_COL_WIDTH: 1200,
  CHAR_WIDTH: 7.2,
  CELL_PADDING: 18,
  MAX_MEASURE: 168,

  ENCODINGS: [
    ["utf-8", "UTF-8"],
    ["gb18030", "GB18030 / GBK"],
    ["big5", "Big5"],
    ["shift_jis", "Shift_JIS"],
    ["windows-1252", "Windows-1252"],
    ["utf-16le", "UTF-16 LE"],
    ["utf-16be", "UTF-16 BE"],
  ],

  DELIMITERS: [
    ["auto", "自动识别"],
    [",", "逗号 ,"],
    [";", "分号 ;"],
    ["\t", "制表符"],
    ["|", "竖线 |"],
  ],

  ALIGNMENTS: [
    ["left", "靠左"],
    ["center", "居中"],
    ["right", "靠右"],
  ],

  ALIGN_PREF: "csvreader.tableAlign",
  FREEZE_ROWS_PREF: "csvreader.freezeRows",
  FREEZE_COLS_PREF: "csvreader.freezeCols",

  // 拖拽框选：靠近边缘时自动滚动
  AUTOSCROLL_EDGE: 28,
  AUTOSCROLL_STEP: 18,

  defineElement(win) {
    if (win.customElements.get(this.ELEMENT_NAME)) return;
    const XHTML_NS = this.XHTML_NS;

    class CsvReaderView extends win.MozXULElement {
      constructor() {
        super();
        this._built = false;
        this._bytes = null;
        this._text = "";
        this._rows = [];
        this._header = [];
        this._bodyRows = [];
        this._columns = 0;
        this._kind = CsvReaderFormats.KIND_TEXT;
        this._workbook = null;
        this._sheetNames = [];
        this._sheetName = null;
        this._merges = [];
        this._encoding = "utf-8";
        this._delimiter = ",";
        this._align = "left";
        this._alignSelect = null;
        this._frozenRows = 0;
        this._frozenCols = 0;
        this._freezeRowsInput = null;
        this._freezeColsInput = null;
        this._colLeft = [CsvReaderViewer.ROWNUM_WIDTH];
        this._headHeight = CsvReaderViewer.ROW_HEIGHT;
        this._rowPitch = CsvReaderViewer.ROW_HEIGHT;
        this._sel = null;
        this._selDrag = null;
        this._selEl = null;
        this._onSelMoveBound = null;
        this._onSelUpBound = null;
        this._onKeyBound = null;
        this._hbarEl = null;
        this._hbarTrack = null;
        this._hbarThumb = null;
        this._hbarDrag = null;
        this._tableTotalWidth = 0;
        this._diagDone = false;
        this._renderPending = false;
        this._resizeObserver = null;
        this._messages = {
          loading: "正在读取…",
          empty: "该文件没有可显示的表格数据",
          loadError: "无法读取该文件：",
          libMissing: "表格解析库未加载，请重启 Zotero 后重试。",
        };
      }

      connectedCallback() {
        if (this._built) return;
        this._built = true;
        this.classList.add("zcr-root");
        this.setAttribute("flex", "1");
        this._build();

        this._localize()
          .catch((e) => Zotero.logError(e))
          .then(() => {
            if (this.getAttribute("path")) this._load();
          });
      }

      disconnectedCallback() {
        if (this._resizeObserver) {
          this._resizeObserver.disconnect();
          this._resizeObserver = null;
        }
        this._endHbarDrag();
        this._clearSelection();
        this._bytes = null;
        this._text = "";
        this._rows = [];
        this._header = [];
        this._bodyRows = [];
        this._workbook = null;
        this._sheetNames = [];
        this._sheetName = null;
        this._merges = [];
      }

      // ---------- DOM 构建 ----------

      _create(tag, className, text) {
        const el = this.ownerDocument.createElementNS(XHTML_NS, tag);
        if (className) el.setAttribute("class", className);
        if (text !== undefined) el.textContent = text;
        return el;
      }

      _build() {
        this._frozenRows = this._readInt(CsvReaderViewer.FREEZE_ROWS_PREF, 0);
        this._frozenCols = this._readInt(CsvReaderViewer.FREEZE_COLS_PREF, 0);

        const toolbar = this._create("div", "zcr-toolbar");

        this._titleEl = this._create("div", "zcr-title", this.getAttribute("title") || "");
        this._titleEl.setAttribute("title", this.getAttribute("title") || "");
        toolbar.appendChild(this._titleEl);

        this._statsEl = this._create("div", "zcr-stats", "");
        toolbar.appendChild(this._statsEl);
        toolbar.appendChild(this._create("div", "zcr-toolbar-spacer"));

        this._sheetField = this._buildSheetField(toolbar);

        const freezeRows = this._buildNumberField(
          toolbar,
          "csvreader-toolbar-freeze-rows",
          "冻结行",
          this._frozenRows,
          (value) => this._setFrozenRows(value),
        );
        this._freezeRowsField = freezeRows.field;
        this._freezeRowsInput = freezeRows.input;

        const freezeCols = this._buildNumberField(
          toolbar,
          "csvreader-toolbar-freeze-cols",
          "冻结列",
          this._frozenCols,
          (value) => this._setFrozenCols(value),
        );
        this._freezeColsField = freezeCols.field;
        this._freezeColsInput = freezeCols.input;

        const encoding = this._buildSelect(
          toolbar,
          "csvreader-toolbar-encoding",
          "编码",
          CsvReaderViewer.ENCODINGS,
          (value) => {
            if (this._kind !== CsvReaderFormats.KIND_TEXT) return;
            this._encoding = value;
            this._redecode();
          },
        );
        this._encodingField = encoding.field;
        this._encodingSelect = encoding.select;

        const delimiter = this._buildSelect(
          toolbar,
          "csvreader-toolbar-delimiter",
          "分隔符",
          CsvReaderViewer.DELIMITERS,
          (value) => {
            if (this._kind !== CsvReaderFormats.KIND_TEXT) return;
            this._delimiter =
              value === "auto" ? CsvReaderCsv.sniffDelimiter(this._text) : value;
            this._applyRows(CsvReaderCsv.parse(this._text, this._delimiter));
          },
        );
        this._delimiterField = delimiter.field;
        this._delimiterSelect = delimiter.select;

        const align = this._buildSelect(
          toolbar,
          "csvreader-toolbar-align",
          "对齐",
          CsvReaderViewer.ALIGNMENTS,
          (value) => this._setAlign(value),
        );
        this._alignSelect = align.select;

        this.appendChild(toolbar);

        const body = this._create("div", "zcr-body");
        this._scrollEl = this._create("div", "zcr-scroll");
        this._tableEl = this._create("table", "zcr-table");
        this._colgroupEl = this._create("colgroup");
        this._theadEl = this._create("thead");
        this._tbodyEl = this._create("tbody");
        this._tableEl.appendChild(this._colgroupEl);
        this._tableEl.appendChild(this._theadEl);
        this._tableEl.appendChild(this._tbodyEl);
        this._scrollEl.appendChild(this._tableEl);

        // 选中框是 .zcr-scroll 的绝对定位子节点：位于滚动内容坐标系，随表格一起滚动
        this._selEl = this._create("div", "zcr-selection");
        this._selEl.setAttribute("hidden", "hidden");
        this._scrollEl.appendChild(this._selEl);

        body.appendChild(this._scrollEl);

        this._messageEl = this._create("div", "zcr-message");
        this._messageEl.setAttribute("hidden", "hidden");
        body.appendChild(this._messageEl);
        this.appendChild(body);

        this._setAlign(this._readAlign(), false);
        this._buildHScrollBar();

        this._scrollEl.addEventListener("scroll", () => this._scheduleRender());
        // 拖拽框选：按下落在单元格上就开始选区，落在空白处则清除选区
        this._scrollEl.addEventListener("pointerdown", (e) => this._onPointerDown(e));
        // 原生横向条已隐藏，触控板横滑 / Shift+滚轮 需自行映射到 scrollLeft
        this._scrollEl.addEventListener("wheel", (e) => this._onWheel(e), {
          passive: false,
        });

        const win = this.ownerDocument.defaultView;
        if (win && win.ResizeObserver) {
          this._resizeObserver = new win.ResizeObserver(() => this._scheduleRender());
          // 宿主与滚动区都要观察：标签页宽度变化时只有宿主会变，滚动区不变
          this._resizeObserver.observe(this);
          this._resizeObserver.observe(this._scrollEl);
        }
      }

      _buildSheetField(parent) {
        const field = this._create("label", "zcr-field");
        const label = this._create("span", "zcr-field-label", "工作表");
        label.setAttribute("data-l10n-id", "csvreader-toolbar-sheet");
        field.appendChild(label);

        const select = this._create("select", "zcr-select");
        select.addEventListener("change", () => this._selectSheet(select.value));
        field.appendChild(select);

        field.setAttribute("hidden", "hidden");
        parent.appendChild(field);
        this._sheetSelect = select;
        return field;
      }

      _buildSelect(parent, l10nId, labelText, options, onChange) {
        const field = this._create("label", "zcr-field");
        const label = this._create("span", "zcr-field-label", labelText);
        label.setAttribute("data-l10n-id", l10nId);
        field.appendChild(label);

        const select = this._create("select", "zcr-select");
        for (const [value, text] of options) {
          const option = this._create("option", null, text);
          option.setAttribute("value", value);
          select.appendChild(option);
        }
        select.addEventListener("change", () => onChange(select.value));
        field.appendChild(select);
        parent.appendChild(field);
        return { field, select };
      }

      _buildNumberField(parent, l10nId, labelText, initial, onChange) {
        const field = this._create("label", "zcr-field");
        const label = this._create("span", "zcr-field-label", labelText);
        label.setAttribute("data-l10n-id", l10nId);
        field.appendChild(label);

        const input = this._create("input", "zcr-number");
        input.setAttribute("type", "number");
        input.setAttribute("min", "0");
        input.setAttribute("step", "1");
        input.setAttribute("value", String(initial || 0));
        input.addEventListener("change", () => onChange(input.value));
        field.appendChild(input);
        parent.appendChild(field);
        return { field, input };
      }

      // ---------- 整数偏好 ----------

      _readInt(pref, fallback) {
        try {
          const value = Zotero.Prefs.get(pref, true);
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n >= 0) return n;
        } catch (e) {
          // 读不到偏好时回退默认值
        }
        return fallback;
      }

      _saveInt(pref, value) {
        try {
          Zotero.Prefs.set(pref, value, true);
        } catch (e) {
          // 偏好写入失败不影响本次会话
        }
      }

      // ---------- 表格对齐 ----------

      _readAlign() {
        try {
          const value = Zotero.Prefs.get(CsvReaderViewer.ALIGN_PREF, true);
          if (CsvReaderViewer.ALIGNMENTS.some(([v]) => v === value)) return value;
        } catch (e) {
          // 读不到偏好时回退默认值
        }
        return "left";
      }

      _setAlign(value, persist = true) {
        if (!CsvReaderViewer.ALIGNMENTS.some(([v]) => v === value)) value = "left";
        this._align = value;
        if (this._alignSelect) this._alignSelect.value = value;
        this._applyAlign();
        if (persist) this._saveAlign(value);
      }

      _applyAlign() {
        const cls = this._tableEl.classList;
        cls.remove("zcr-align-left", "zcr-align-center", "zcr-align-right");
        cls.add("zcr-align-" + this._align);
      }

      _saveAlign(value) {
        try {
          Zotero.Prefs.set(CsvReaderViewer.ALIGN_PREF, value, true);
        } catch (e) {
          // 偏好写入失败不影响本次会话
        }
      }

      // ---------- 冻结行 / 冻结列 ----------

      // 把用户输入收敛到当前数据的合法范围，并回写输入框
      _clampFrozen() {
        const rows = Math.max(0, Math.min(this._frozenRows, this._bodyRows.length));
        const cols = Math.max(0, Math.min(this._frozenCols, this._columns));
        this._frozenRows = rows;
        this._frozenCols = cols;
        if (this._freezeRowsInput) this._freezeRowsInput.value = String(rows);
        if (this._freezeColsInput) this._freezeColsInput.value = String(cols);
      }

      _setFrozenRows(raw) {
        let n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0) n = 0;
        this._frozenRows = Math.min(n, this._bodyRows.length);
        this._refreshFrozen();
        this._saveInt(CsvReaderViewer.FREEZE_ROWS_PREF, this._frozenRows);
      }

      _setFrozenCols(raw) {
        let n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0) n = 0;
        this._frozenCols = Math.min(n, this._columns);
        this._refreshFrozen();
        this._saveInt(CsvReaderViewer.FREEZE_COLS_PREF, this._frozenCols);
      }

      // 冻结变化只影响 sticky 定位与虚拟窗口，不需要重算列宽，也不重置滚动位置
      _refreshFrozen() {
        this._clampFrozen();
        this._renderHead();
        this._scheduleRender();
      }

      // 冻结行距顶部的像素偏移：表头高度 + 已冻结行数 × 行高
      _frozenRowTop(index) {
        return this._headHeight + index * this._rowPitch;
      }

      // ---------- 横向滚动条 ----------

      _buildHScrollBar() {
        const bar = this._create("div", "zcr-hbar");
        bar.setAttribute("hidden", "hidden");
        const track = this._create("div", "zcr-hbar-track");
        const thumb = this._create("div", "zcr-hbar-thumb");
        track.appendChild(thumb);
        bar.appendChild(track);
        this.appendChild(bar);

        this._hbarEl = bar;
        this._hbarTrack = track;
        this._hbarThumb = thumb;

        this._onThumbMoveBound = (e) => this._onThumbMove(e);
        this._onThumbUpBound = (e) => this._onThumbUp(e);

        thumb.addEventListener("pointerdown", (e) => this._onThumbDown(e));
        track.addEventListener("pointerdown", (e) => this._onTrackDown(e));
      }

      _hMaxScroll() {
        return Math.max(0, this._scrollEl.scrollWidth - this._scrollEl.clientWidth);
      }

      /*
       * 横向溢出量。同时看两条来源：
       *   scrollWidth —— 实际可滚动宽度（正常情况下最准）
       *   _tableTotalWidth —— 我们自己算出的表格像素宽（不依赖 Gecko 对 overflow-x:hidden 的取值）
       * 取两者较大值，避免任一来源在某些布局下返回 0 导致横条被误判为「不需要」。
       */
      _overflowWidth() {
        const view = this._scrollEl.clientWidth || 0;
        const byScroll = (this._scrollEl.scrollWidth || 0) - view;
        const byTable = (this._tableTotalWidth || 0) - view;
        return Math.max(0, byScroll, byTable);
      }

      /*
       * 窗口可视内容宽度。必须用它作为外部基准：
       * .tab-content 是按内容撑开的（实测 1754 > 窗口 1536），
       * 拿父容器宽度当基准会形成「表格撑宽父容器 → 父容器又决定表格」的死循环。
       * 优先 innerWidth（窗口无纵向滚动条时即内容宽），取不到再退回 documentElement。
       */
      _viewportWidth() {
        const win = this.ownerDocument.defaultView;
        let w = win && win.innerWidth ? win.innerWidth : 0;
        if (w <= 0) {
          try {
            const el = this.ownerDocument.documentElement;
            if (el) w = el.clientWidth || 0;
          } catch (e) {
            // 都取不到就返回 0，调用方会退回父容器宽度
          }
        }
        return w;
      }

      /*
       * 真实可用宽度。向上找第一个「不超过窗口宽」的祖先：
       *   - 祖先宽度 > 窗口宽  → 已被表格撑开，跳过
       *   - 祖先宽度 ≈ 表格宽  → 是按内容撑开的，不能当基准，跳过
       *   - 都不满足则退回窗口宽
       * 这样无论表格比窗口宽还是窄，都能拿到正确的可用宽度。
       */
      _availableWidth() {
        const viewW = this._viewportWidth();
        const tableW = this._tableTotalWidth || 0;
        const docEl = this.ownerDocument.documentElement;
        let node = this.parentNode;
        while (node && node !== docEl) {
          const w = node.clientWidth || 0;
          if (w > 0 && (!viewW || w <= viewW + 1)) {
            const contentDriven = tableW > 0 && Math.abs(w - tableW) <= 2;
            if (!contentDriven) return w;
          }
          node = node.parentNode;
        }
        return viewW > 0 ? viewW : 0;
      }

      // 把宿主宽度钉死在真实可用宽度上，保证「宽表格一定产生横向溢出」
      _fitToAvailableWidth() {
        const target = this._availableWidth();
        if (target <= 0) return;
        if (Math.abs(this.clientWidth - target) > 1) {
          this.style.width = target + "px";
          this.style.maxWidth = target + "px";
        }
      }

      // 表格宽度或容器尺寸变化后重算滑块尺寸与位置；无横向溢出时整条隐藏
      _updateHScroll() {
        if (!this._hbarEl || !this._hbarThumb) return;

        this._fitToAvailableWidth();

        // 首次渲染时把真实布局尺寸落盘，便于定位「横条不出现」类问题
        if (!this._diagDone) {
          this._diagDone = true;
          this._writeDiag("render");
        }

        const maxScroll = this._hMaxScroll();
        const overflow = this._overflowWidth();
        if (overflow <= 1 || this._scrollEl.hasAttribute("hidden")) {
          this._hbarEl.setAttribute("hidden", "hidden");
          return;
        }

        // 必须先取消 hidden 才能量到轨道宽度：display:none 时 clientWidth 恒为 0，
        // 若先量再显示会永远判定为「宽度为 0」而无法出现
        this._hbarEl.removeAttribute("hidden");
        const trackW = this._hbarTrack.clientWidth;
        if (trackW <= 0) {
          this._hbarEl.setAttribute("hidden", "hidden");
          return;
        }

        const clientW = this._scrollEl.clientWidth;
        const scrollW = Math.max(
          this._scrollEl.scrollWidth || 0,
          this._tableTotalWidth || 0,
          clientW + 1,
        );
        const thumbW = Math.max(32, Math.round(trackW * (clientW / scrollW)));
        const maxThumbLeft = Math.max(0, trackW - thumbW);
        const left =
          maxThumbLeft > 0
            ? Math.round(maxThumbLeft * (this._scrollEl.scrollLeft / Math.max(1, maxScroll)))
            : 0;

        this._hbarThumb.style.width = thumbW + "px";
        this._hbarThumb.style.left = left + "px";
      }

      // 把关键布局尺寸写到系统临时目录的 zcr-diag.json，用于远程排查
      _writeDiag(reason) {
        try {
          const parent = this.parentNode;
          const body = this._scrollEl ? this._scrollEl.parentNode : null;
          const win = this.ownerDocument.defaultView;
          const data = {
            time: new Date().toISOString(),
            reason,
            rootClientW: this.clientWidth,
            rootOffsetW: this.offsetWidth,
            parentNode: parent ? parent.nodeName : null,
            parentClass: parent ? parent.getAttribute("class") : null,
            parentClientW: parent ? parent.clientWidth : null,
            bodyClientW: body ? body.clientWidth : null,
            scrollClientW: this._scrollEl ? this._scrollEl.clientWidth : null,
            scrollClientH: this._scrollEl ? this._scrollEl.clientHeight : null,
            scrollScrollW: this._scrollEl ? this._scrollEl.scrollWidth : null,
            tableStyleW: this._tableEl ? this._tableEl.style.width : null,
            tableTotalW: this._tableTotalWidth,
            tableOffsetW: this._tableEl ? this._tableEl.offsetWidth : null,
            overflowW: this._overflowWidth(),
            hbarHidden: this._hbarEl ? this._hbarEl.hasAttribute("hidden") : null,
            hbarTrackW: this._hbarTrack ? this._hbarTrack.clientWidth : null,
            winInnerW: win ? win.innerWidth : null,
            docElClientW: this.ownerDocument.documentElement
              ? this.ownerDocument.documentElement.clientWidth
              : null,
            viewportW: this._viewportWidth(),
            availW: this._availableWidth(),
          };
          const dir = Zotero.getTempDirectory().path;
          const path = PathUtils.join(dir, "zcr-diag.json");
          IOUtils.writeJSON(path, data);
        } catch (e) {
          // 诊断写入失败不能影响主流程
        }
      }

      _onWheel(e) {
        const maxScroll = this._hMaxScroll();
        if (maxScroll <= 0) return;
        let dx = e.deltaX;
        if (!dx && e.shiftKey) dx = e.deltaY;
        if (!dx) return;
        const unit =
          e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this._scrollEl.clientWidth : 1;
        const next = this._scrollEl.scrollLeft + dx * unit;
        this._scrollEl.scrollLeft = Math.max(0, Math.min(maxScroll, next));
        e.preventDefault();
      }

      _onThumbDown(e) {
        if (e.button !== 0) return;
        const maxScroll = this._hMaxScroll();
        const trackW = this._hbarTrack ? this._hbarTrack.clientWidth : 0;
        const thumbW = this._hbarThumb ? this._hbarThumb.offsetWidth : 0;
        const maxThumbLeft = Math.max(0, trackW - thumbW);
        if (maxScroll <= 0 || maxThumbLeft <= 0) return;

        this._hbarDrag = {
          startX: e.clientX,
          startScroll: this._scrollEl.scrollLeft,
          maxThumbLeft,
          maxScroll,
        };
        this._hbarThumb.classList.add("zcr-hbar-dragging");
        try {
          this._hbarThumb.setPointerCapture(e.pointerId);
        } catch (err) {
          // 指针捕获失败时仍可由 document 上的监听兜底
        }
        const doc = this.ownerDocument;
        doc.addEventListener("pointermove", this._onThumbMoveBound, true);
        doc.addEventListener("pointerup", this._onThumbUpBound, true);
        doc.addEventListener("pointercancel", this._onThumbUpBound, true);
        e.preventDefault();
      }

      _onThumbMove(e) {
        const drag = this._hbarDrag;
        if (!drag) return;
        const dx = e.clientX - drag.startX;
        const ratio = drag.maxScroll / drag.maxThumbLeft;
        this._scrollEl.scrollLeft = drag.startScroll + dx * ratio;
      }

      _onThumbUp(e) {
        if (!this._hbarDrag) return;
        this._endHbarDrag();
        if (e && e.pointerId !== undefined) {
          try {
            this._hbarThumb.releasePointerCapture(e.pointerId);
          } catch (err) {
            // 捕获已被系统释放
          }
        }
      }

      _endHbarDrag() {
        const doc = this.ownerDocument;
        if (doc && this._onThumbMoveBound) {
          doc.removeEventListener("pointermove", this._onThumbMoveBound, true);
          doc.removeEventListener("pointerup", this._onThumbUpBound, true);
          doc.removeEventListener("pointercancel", this._onThumbUpBound, true);
        }
        if (this._hbarThumb) this._hbarThumb.classList.remove("zcr-hbar-dragging");
        this._hbarDrag = null;
      }

      // 点击轨道空白处：滑块中心跳到点击位置
      _onTrackDown(e) {
        if (e.button !== 0 || e.target === this._hbarThumb) return;
        const maxScroll = this._hMaxScroll();
        const trackW = this._hbarTrack ? this._hbarTrack.clientWidth : 0;
        const thumbW = this._hbarThumb ? this._hbarThumb.offsetWidth : 0;
        const maxThumbLeft = Math.max(0, trackW - thumbW);
        if (maxScroll <= 0 || maxThumbLeft <= 0) return;

        const rect = this._hbarTrack.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const targetLeft = Math.max(0, Math.min(maxThumbLeft, clickX - thumbW / 2));
        this._scrollEl.scrollLeft = (targetLeft / maxThumbLeft) * maxScroll;
        e.preventDefault();
      }

      // ---------- 区域选中（拖拽 + 红色框线） ----------

      _onPointerDown(e) {
        if (e.button !== 0) return;
        const cell = this._cellFrom(e.target);
        if (!cell) {
          // 落在表格空白/行号/表头上：视为取消选区
          this._clearSelection();
          return;
        }
        const r = parseInt(cell.getAttribute("data-row"), 10);
        const c = parseInt(cell.getAttribute("data-col"), 10);
        if (!Number.isFinite(r) || !Number.isFinite(c)) return;

        // 不调用 preventDefault：单元格已用 user-select:none 屏蔽文本选择，
        // 这里保留默认行为，工具栏输入框才能在点到表格时正常失焦提交（change）
        this._selDrag = { r, c };
        this._sel = { r1: r, c1: c, r2: r, c2: c };
        this._attachSelectionDrag();
        this._updateSelectionOverlay();
      }

      _cellFrom(node) {
        if (!node || typeof node.closest !== "function") return null;
        return node.closest("[data-row][data-col]");
      }

      _attachSelectionDrag() {
        if (this._onSelMoveBound) return;
        const doc = this.ownerDocument;
        this._onSelMoveBound = (ev) => this._onPointerMove(ev);
        this._onSelUpBound = (ev) => this._onPointerUp(ev);
        doc.addEventListener("pointermove", this._onSelMoveBound, true);
        doc.addEventListener("pointerup", this._onSelUpBound, true);
        doc.addEventListener("pointercancel", this._onSelUpBound, true);
      }

      _detachSelectionDrag() {
        const doc = this.ownerDocument;
        if (doc && this._onSelMoveBound) {
          doc.removeEventListener("pointermove", this._onSelMoveBound, true);
          doc.removeEventListener("pointerup", this._onSelUpBound, true);
          doc.removeEventListener("pointercancel", this._onSelUpBound, true);
        }
        this._onSelMoveBound = null;
        this._onSelUpBound = null;
        this._selDrag = null;
      }

      _onPointerMove(e) {
        if (!this._selDrag) return;
        this._autoScroll(e.clientX, e.clientY);
        const cell = this._cellFrom(this.ownerDocument.elementFromPoint(e.clientX, e.clientY));
        if (!cell) return;
        const r = parseInt(cell.getAttribute("data-row"), 10);
        const c = parseInt(cell.getAttribute("data-col"), 10);
        if (!Number.isFinite(r) || !Number.isFinite(c)) return;

        const a = this._selDrag;
        this._sel = {
          r1: Math.min(a.r, r),
          r2: Math.max(a.r, r),
          c1: Math.min(a.c, c),
          c2: Math.max(a.c, c),
        };
        this._updateSelectionOverlay();
      }

      _onPointerUp() {
        if (!this._selDrag) return;
        this._detachSelectionDrag();
      }

      // 拖到视口边缘时自动滚动，便于选中超出可视范围的区域
      _autoScroll(x, y) {
        const rect = this._scrollEl.getBoundingClientRect();
        const edge = CsvReaderViewer.AUTOSCROLL_EDGE;
        const step = CsvReaderViewer.AUTOSCROLL_STEP;

        let dy = 0;
        if (y < rect.top + edge) dy = -step;
        else if (y > rect.bottom - edge) dy = step;
        if (dy) this._scrollEl.scrollTop += dy;

        let dx = 0;
        if (x < rect.left + edge) dx = -step;
        else if (x > rect.right - edge) dx = step;
        if (dx) {
          const max = this._hMaxScroll();
          this._scrollEl.scrollLeft = Math.max(
            0,
            Math.min(max, this._scrollEl.scrollLeft + dx),
          );
        }
      }

      // 选中框定位在滚动内容坐标系：左/上来自「表格偏移 + 列左边界 / 表头高 + 行号×行距」
      _updateSelectionOverlay() {
        if (!this._selEl) return;
        const sel = this._sel;
        if (
          !sel ||
          this._columns < 1 ||
          this._bodyRows.length < 1 ||
          !this._colLeft ||
          this._colLeft.length < this._columns + 1
        ) {
          this._selEl.setAttribute("hidden", "hidden");
          return;
        }

        const maxRow = this._bodyRows.length - 1;
        const maxCol = this._columns - 1;
        const r1 = Math.max(0, Math.min(sel.r1, maxRow));
        const r2 = Math.max(0, Math.min(sel.r2, maxRow));
        const c1 = Math.max(0, Math.min(sel.c1, maxCol));
        const c2 = Math.max(0, Math.min(sel.c2, maxCol));
        if (r1 > r2 || c1 > c2) {
          this._selEl.setAttribute("hidden", "hidden");
          return;
        }

        const left = (this._tableEl.offsetLeft || 0) + this._colLeft[c1];
        const top =
          (this._tableEl.offsetTop || 0) + this._headHeight + r1 * this._rowPitch;
        const width = this._colLeft[c2 + 1] - this._colLeft[c1];
        const height = (r2 - r1 + 1) * this._rowPitch;

        this._selEl.style.left = left + "px";
        this._selEl.style.top = top + "px";
        this._selEl.style.width = width + "px";
        this._selEl.style.height = height + "px";
        this._selEl.removeAttribute("hidden");
        this._attachKeyHandler();
      }

      _attachKeyHandler() {
        if (this._onKeyBound) return;
        const doc = this.ownerDocument;
        this._onKeyBound = (ev) => this._onKeyDown(ev);
        doc.addEventListener("keydown", this._onKeyBound, true);
      }

      _detachKeyHandler() {
        const doc = this.ownerDocument;
        if (doc && this._onKeyBound) {
          doc.removeEventListener("keydown", this._onKeyBound, true);
        }
        this._onKeyBound = null;
      }

      _onKeyDown(e) {
        if (e.key === "Escape") {
          this._clearSelection();
          e.preventDefault();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
          if (this._copySelection()) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }

      _clearSelection() {
        this._sel = null;
        this._detachSelectionDrag();
        this._detachKeyHandler();
        if (this._selEl) this._selEl.setAttribute("hidden", "hidden");
      }

      // 把选区按 TSV 复制：选区被禁用文本选择，这里补回「复制」能力
      _copySelection() {
        const sel = this._sel;
        if (!sel) return false;
        const lines = [];
        for (let r = sel.r1; r <= sel.r2; r++) {
          const cells = this._bodyRows[r] || [];
          const parts = [];
          for (let c = sel.c1; c <= sel.c2; c++) parts.push(c < cells.length ? cells[c] : "");
          lines.push(parts.join("\t"));
        }
        const text = lines.join("\n");
        if (!text) return false;

        const win = this.ownerDocument.defaultView;
        try {
          const clip = win && win.navigator ? win.navigator.clipboard : null;
          if (clip && clip.writeText) {
            clip.writeText(text).catch(() => this._copyFallback(text));
            return true;
          }
        } catch (e) {
          // 落到同步回退方案
        }
        this._copyFallback(text);
        return true;
      }

      _copyFallback(text) {
        try {
          const ta = this._create("textarea", "zcr-clipboard");
          ta.setAttribute("readonly", "readonly");
          ta.value = text;
          this.appendChild(ta);
          ta.select();
          this.ownerDocument.execCommand("copy");
          ta.remove();
        } catch (e) {
          Zotero.logError(e);
        }
      }

      // ---------- 本地化 ----------

      async _localize() {
        const l10n = this.ownerDocument.l10n;
        if (!l10n) return;
        const map = {
          loading: "csvreader-status-loading",
          empty: "csvreader-status-empty",
          loadError: "csvreader-status-load-error",
          libMissing: "csvreader-status-lib-missing",
        };
        for (const key of Object.keys(map)) {
          try {
            const value = await l10n.formatValue(map[key]);
            if (value) this._messages[key] = value;
          } catch (e) {
            // 保留内置中文兜底
          }
        }
      }

      // ---------- 数据加载 ----------

      async _load() {
        this._showMessage(this._messages.loading);
        try {
          const path = this.getAttribute("path");
          const bytes = await IOUtils.read(path);
          this._bytes = bytes;
          this._kind = this._resolveKind(path);

          if (this._kind === CsvReaderFormats.KIND_WORKBOOK) {
            this._loadWorkbook();
          } else {
            this._loadText();
          }
        } catch (e) {
          Zotero.logError(e);
          const detail = e && e.message ? e.message : String(e);
          this._showMessage(this._messages.loadError + detail);
        }
      }

      // tabhost 会写入 format 属性；缺失时退回按扩展名推断，保证老会话也能正常渲染
      _resolveKind(path) {
        const declared = this.getAttribute("format");
        if (declared === CsvReaderFormats.KIND_WORKBOOK || declared === CsvReaderFormats.KIND_TEXT) {
          return declared;
        }
        const name = path || this.getAttribute("path") || "";
        return (
          CsvReaderFormats.kindForName(name, null) || CsvReaderFormats.KIND_TEXT
        );
      }

      _loadText() {
        this._setTextControlsVisible(true);
        this._resetSheets();

        const detected = CsvReaderDetect.detect(this._bytes);
        const preferred = this.getAttribute("encoding");
        this._encoding = CsvReaderDetect.isSupported(preferred) ? preferred : detected.encoding;

        this._text = CsvReaderDetect.decode(this._bytes, this._encoding);
        this._delimiter = CsvReaderCsv.sniffDelimiter(this._text);

        this._syncSelect(this._encodingSelect, this._encoding);
        this._syncSelect(this._delimiterSelect, "auto");
        this._applyRows(CsvReaderCsv.parse(this._text, this._delimiter));
      }

      _loadWorkbook() {
        const XLSX = this._xlsx();
        if (!XLSX) throw new Error(this._messages.libMissing);

        this._setTextControlsVisible(false);
        this._sheetName = null;

        const workbook = XLSX.read(this._bytes, { type: "array" });
        this._workbook = workbook;
        this._sheetNames =
          workbook && Array.isArray(workbook.SheetNames) ? workbook.SheetNames.slice() : [];

        if (!this._sheetNames.length) {
          this._resetSheets();
          this._applyRows([]);
          return;
        }

        this._populateSheets(this._sheetNames);
        this._selectSheet(this._sheetNames[0]);
      }

      _xlsx() {
        const win = this.ownerDocument.defaultView;
        return win && win.XLSX ? win.XLSX : null;
      }

      _selectSheet(name) {
        if (!this._workbook || !name) return;
        const sheet = this._workbook.Sheets[name];
        if (!sheet) {
          this._setMerges(null);
          this._applyRows([]);
          return;
        }
        this._sheetName = name;
        if (this._sheetSelect && this._sheetSelect.value !== name) {
          this._sheetSelect.value = name;
        }
        // sheet_to_json 会把合并区域摊平成空白单元格，合并信息只能从 !merges 取回
        this._setMerges(sheet["!merges"]);
        const rows = this._xlsx().utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          defval: "",
          blankrows: false,
        });
        this._applyRows(rows);
      }

      _setMerges(raw) {
        this._merges = CsvReaderMerges.normalize(raw);
      }

      _bodyCellValue(row, col) {
        const cells = this._bodyRows[row];
        if (!cells) return "";
        return col < cells.length ? cells[col] : "";
      }

      _populateSheets(names) {
        const frag = this.ownerDocument.createDocumentFragment();
        for (const name of names) {
          const option = this._create("option", null, name);
          option.setAttribute("value", name);
          frag.appendChild(option);
        }
        this._sheetSelect.replaceChildren(frag);

        if (names.length > 1) this._sheetField.removeAttribute("hidden");
        else this._sheetField.setAttribute("hidden", "hidden");
      }

      _resetSheets() {
        this._workbook = null;
        this._sheetNames = [];
        this._sheetName = null;
        this._merges = [];
        if (this._sheetSelect) this._sheetSelect.replaceChildren();
        if (this._sheetField) this._sheetField.setAttribute("hidden", "hidden");
      }

      _setTextControlsVisible(visible) {
        for (const field of [this._encodingField, this._delimiterField]) {
          if (!field) continue;
          if (visible) field.removeAttribute("hidden");
          else field.setAttribute("hidden", "hidden");
        }
      }

      _redecode() {
        if (!this._bytes) return;
        try {
          this._text = CsvReaderDetect.decode(this._bytes, this._encoding);
          if (this._delimiterSelect.value === "auto") {
            this._delimiter = CsvReaderCsv.sniffDelimiter(this._text);
          }
          this._applyRows(CsvReaderCsv.parse(this._text, this._delimiter));
        } catch (e) {
          Zotero.logError(e);
          const detail = e && e.message ? e.message : String(e);
          this._showMessage(this._messages.loadError + detail);
        }
      }

      _syncSelect(select, value) {
        if (!value || !select) return;
        const exists = Array.from(select.options).some((option) => option.value === value);
        if (!exists) {
          const option = this._create("option", null, value);
          option.setAttribute("value", value);
          select.appendChild(option);
        }
        select.value = value;
      }

      // ---------- 渲染 ----------

      _applyRows(rows) {
        this._rows = rows;
        this._header = rows.length ? rows[0] : [];
        this._bodyRows = rows.length > 1 ? rows.slice(1) : [];

        // 列数取全表最大值：只看前若干行会漏掉后段才出现的右侧列
        let columns = this._header.length;
        for (const row of this._bodyRows) {
          if (row.length > columns) columns = row.length;
        }
        this._columns = Math.max(columns, 1);

        // 换了数据（新文件 / 新工作表 / 重新分词）后，旧的冻结数与选区都不再适用
        this._clearSelection();
        this._clampFrozen();
        if (this._freezeRowsInput) {
          this._freezeRowsInput.setAttribute("max", String(this._bodyRows.length));
        }
        if (this._freezeColsInput) {
          this._freezeColsInput.setAttribute("max", String(this._columns));
        }

        if (!rows.length) {
          this._colgroupEl.replaceChildren();
          this._theadEl.replaceChildren();
          this._tbodyEl.replaceChildren();
          this._tableEl.style.width = "";
          this._tableTotalWidth = 0;
          this._colLeft = [CsvReaderViewer.ROWNUM_WIDTH];
          this._updateStats();
          this._showMessage(this._messages.empty);
          return;
        }

        this._renderColgroup(this._computeColumnWidths());
        this._renderHead();
        this._scrollEl.scrollTop = 0;
        this._updateStats();
        this._diagDone = false;
        this._hideMessage();
        this._scheduleRender();

        // 标签页刚插入时布局可能还没稳定（flex 高度/宽度在下一帧才确定），
        // 这里补两次延迟重算，确保横条在布局稳定后一定被正确显示或隐藏
        const win = this.ownerDocument.defaultView;
        if (win && win.setTimeout) {
          win.setTimeout(() => this._updateHScroll(), 60);
          win.setTimeout(() => this._updateHScroll(), 260);
        }
      }

      // 依据整列（表头 + 全部数据行）的最长文本一次性算出列宽：
      // 不采样、也不随滚动重算，避免浏览过程中列宽变化
      _computeColumnWidths() {
        const columns = this._columns;
        const widths = new Array(columns);
        for (let c = 0; c < columns; c++) {
          widths[c] = this._displayWidth(this._header[c] || "");
        }
        for (const row of this._bodyRows) {
          const len = Math.min(row.length, columns);
          for (let c = 0; c < len; c++) {
            const width = this._displayWidth(row[c]);
            if (width > widths[c]) widths[c] = width;
          }
        }
        return widths.map((max) => {
          let px = Math.round(max * CsvReaderViewer.CHAR_WIDTH) + CsvReaderViewer.CELL_PADDING;
          if (px < CsvReaderViewer.MIN_COL_WIDTH) px = CsvReaderViewer.MIN_COL_WIDTH;
          if (px > CsvReaderViewer.MAX_COL_WIDTH) px = CsvReaderViewer.MAX_COL_WIDTH;
          return px;
        });
      }

      _displayWidth(text) {
        let width = 0;
        for (let i = 0; i < text.length; i++) {
          width += text.charCodeAt(i) > 0x2e80 ? 2 : 1;
          if (width >= CsvReaderViewer.MAX_MEASURE) break;
        }
        return width;
      }

      _renderColgroup(widths) {
        const frag = this.ownerDocument.createDocumentFragment();
        const corner = this._create("col");
        corner.style.width = CsvReaderViewer.ROWNUM_WIDTH + "px";
        frag.appendChild(corner);

        let total = CsvReaderViewer.ROWNUM_WIDTH;
        for (const width of widths) {
          const col = this._create("col");
          col.style.width = width + "px";
          frag.appendChild(col);
          total += width;
        }
        this._colgroupEl.replaceChildren(frag);

        // 记录每列的左边界（含行号列），冻结列 sticky left 与选中框左边界都要用
        const left = new Array(widths.length + 1);
        left[0] = CsvReaderViewer.ROWNUM_WIDTH;
        for (let c = 0; c < widths.length; c++) left[c + 1] = left[c] + widths[c];
        this._colLeft = left;

        // table-layout:fixed 下必须显式给出总宽，表格才会收缩到内容宽度而非撑满容器
        this._tableEl.style.width = total + "px";
        this._tableTotalWidth = total;
      }

      _renderHead() {
        const tr = this._create("tr");
        const corner = this._create("th", "zcr-rownum zcr-corner", "#");
        tr.appendChild(corner);

        // 表头只承载锚点在第 0 行的合并（含跨到正文的），一律用 colspan 表达
        const { spans, covered } = CsvReaderMerges.headerCells(this._merges, this._columns);
        for (let c = 0; c < this._columns; c++) {
          if (covered.has(c)) continue;
          const text = c < this._header.length ? this._header[c] : "";
          const span = spans.get(c) || 1;
          const frozen = c < this._frozenCols;
          const classes = ["zcr-head"];
          if (span > 1) classes.push("zcr-merged-cell");
          if (frozen) classes.push("zcr-frozen-col");
          const th = this._create("th", classes.join(" "), text);
          th.setAttribute("scope", "col");
          th.setAttribute("title", text);
          if (span > 1) th.setAttribute("colspan", String(span));
          if (frozen) th.style.left = this._colLeft[c] + "px";
          tr.appendChild(th);
        }
        this._theadEl.replaceChildren(tr);
      }

      _scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        const win = this.ownerDocument.defaultView;
        const run = () => {
          this._renderPending = false;
          this._renderWindow();
        };
        if (win && win.requestAnimationFrame) win.requestAnimationFrame(run);
        else run();
      }

      _renderWindow() {
        const total = this._bodyRows.length;
        if (!total) {
          this._tbodyEl.replaceChildren();
          this._updateHScroll();
          return;
        }

        const rowHeight = CsvReaderViewer.ROW_HEIGHT;
        const viewport = this._scrollEl.clientHeight || 0;
        const scrollTop = this._scrollEl.scrollTop;
        const frozen = Math.min(this._frozenRows, total);

        let start = Math.floor(scrollTop / rowHeight) - CsvReaderViewer.OVERSCAN;
        if (start < 0) start = 0;
        let end =
          Math.ceil((scrollTop + viewport) / rowHeight) + CsvReaderViewer.OVERSCAN;
        if (end > total) end = total;

        // 冻结行必须常驻渲染（它们靠 sticky 钉在表头下方），窗口起点不能越过冻结行
        let winStart = Math.max(start, frozen);
        let winEnd = Math.max(end, winStart);
        if (winEnd > total) winEnd = total;
        if (winStart > winEnd) winStart = winEnd;

        // 合并布局要分两段算：冻结行常驻渲染 [0, frozen)，滚动窗口渲染 [winStart, winEnd)。
        // 两段的键都是绝对行列号，直接合并即可；这样跨冻结边界的纵向合并会在两段各自
        // 截断，窗口段以「续接格」补齐，不会出现整行缺格。
        const layout = this._mergeLayouts(
          frozen > 0
            ? CsvReaderMerges.windowLayout(this._merges, this._columns, total, 0, frozen)
            : null,
          CsvReaderMerges.windowLayout(
            this._merges,
            this._columns,
            total,
            winStart,
            winEnd,
          ),
        );

        const frag = this.ownerDocument.createDocumentFragment();
        for (let i = 0; i < frozen; i++) frag.appendChild(this._makeRow(i, layout));

        // 冻结行与滚动窗口之间被跳过的行用占位行补齐，保证总高度不变
        const gapHeight = (winStart - frozen) * rowHeight;
        if (gapHeight > 0) frag.appendChild(this._makeSpacerRow(gapHeight));

        for (let i = winStart; i < winEnd; i++) frag.appendChild(this._makeRow(i, layout));

        const bottomHeight = (total - winEnd) * rowHeight;
        if (bottomHeight > 0) frag.appendChild(this._makeSpacerRow(bottomHeight));
        this._tbodyEl.replaceChildren(frag);

        this._measureMetrics();
        this._updateHScroll();
        this._updateSelectionOverlay();
      }

      // 合并两段窗口布局（skip 取并集，anchors 取并集）；两段行区间不重叠，键不会冲突
      _mergeLayouts(a, b) {
        if (!a) return b;
        if (!b) return a;
        for (const key of b.skip) a.skip.add(key);
        for (const [key, value] of b.anchors) a.anchors.set(key, value);
        return a;
      }

      // 表头高度与行间距在运行时实测：sticky top 偏移必须基于真实像素，不能只靠常量
      _measureMetrics() {
        if (this._theadEl) {
          const h = this._theadEl.getBoundingClientRect().height;
          if (h > 0) this._headHeight = h;
        }
        const rowEl = this._tbodyEl ? this._tbodyEl.querySelector("tr.zcr-row") : null;
        if (rowEl) {
          const h = rowEl.getBoundingClientRect().height;
          if (h > 0) this._rowPitch = h;
        }
      }

      _makeSpacerRow(height) {
        const tr = this._create("tr", "zcr-spacer");
        const td = this._create("td");
        td.setAttribute("colspan", String(this._columns + 1));
        td.style.height = height + "px";
        tr.appendChild(td);
        return tr;
      }

      _makeRow(index, layout) {
        const frozenRow = index < this._frozenRows;
        const frozenTop = frozenRow ? this._frozenRowTop(index) : -1;

        const tr = this._create("tr", index % 2 ? "zcr-row zcr-row-alt" : "zcr-row");
        const th = this._create(
          "th",
          frozenRow ? "zcr-rownum zcr-frozen-row" : "zcr-rownum",
          String(index + 1),
        );
        th.setAttribute("scope", "row");
        th.style.left = "0px";
        if (frozenRow) th.style.top = frozenTop + "px";
        tr.appendChild(th);

        const columns = this._columns;
        const stride = columns + 1;
        const base = index * stride;
        const cells = this._bodyRows[index];
        for (let c = 0; c < columns; c++) {
          // 被合并覆盖的格子不再输出，空位交给锚点格的 colspan/rowspan 占据
          if (layout.skip.has(base + c)) continue;

          const frozenCol = c < this._frozenCols;
          const anchor = layout.anchors.get(base + c);
          if (anchor) {
            const value = anchor.showValue
              ? this._bodyCellValue(anchor.srcRow, anchor.srcCol)
              : "";
            const classes = ["zcr-cell", "zcr-merged-cell"];
            if (frozenCol) classes.push("zcr-frozen-col");
            if (frozenRow) classes.push("zcr-frozen-row");
            const td = this._create("td", classes.join(" "), value);
            if (anchor.colspan > 1) td.setAttribute("colspan", String(anchor.colspan));
            if (anchor.rowspan > 1) td.setAttribute("rowspan", String(anchor.rowspan));
            if (frozenCol) td.style.left = this._colLeft[c] + "px";
            if (frozenRow) td.style.top = frozenTop + "px";
            td.setAttribute("data-row", String(index));
            td.setAttribute("data-col", String(c));
            if (value) td.setAttribute("title", value.length > 200 ? value.slice(0, 200) + "…" : value);
            tr.appendChild(td);
            continue;
          }

          const value = c < cells.length ? cells[c] : "";
          const classes = ["zcr-cell"];
          if (frozenCol) classes.push("zcr-frozen-col");
          if (frozenRow) classes.push("zcr-frozen-row");
          const td = this._create("td", classes.join(" "), value);
          td.setAttribute("data-row", String(index));
          td.setAttribute("data-col", String(c));
          if (frozenCol) td.style.left = this._colLeft[c] + "px";
          if (frozenRow) td.style.top = frozenTop + "px";
          if (value) {
            td.setAttribute("title", value.length > 200 ? value.slice(0, 200) + "…" : value);
          }
          tr.appendChild(td);
        }
        return tr;
      }

      _updateStats() {
        const rows = this._bodyRows.length;
        const cols = this._columns;
        const sheet = this._sheetName;
        const fallback = (sheet ? sheet + " · " : "") + rows + " 行 × " + cols + " 列";
        const l10n = this.ownerDocument.l10n;
        if (!l10n) {
          this._statsEl.textContent = fallback;
          return;
        }
        const id = sheet ? "csvreader-toolbar-stats-sheet" : "csvreader-toolbar-stats";
        const args = sheet ? { sheet, rows, cols } : { rows, cols };
        l10n
          .formatValue(id, args)
          .then((text) => {
            this._statsEl.textContent = text || fallback;
          })
          .catch(() => {
            this._statsEl.textContent = fallback;
          });
      }

      _showMessage(text) {
        this._messageEl.textContent = text;
        this._messageEl.removeAttribute("hidden");
        this._scrollEl.setAttribute("hidden", "hidden");
        if (this._hbarEl) this._hbarEl.setAttribute("hidden", "hidden");
        if (this._selEl) this._selEl.setAttribute("hidden", "hidden");
      }

      _hideMessage() {
        this._messageEl.setAttribute("hidden", "hidden");
        this._scrollEl.removeAttribute("hidden");
        this._updateHScroll();
        this._updateSelectionOverlay();
      }
    }

    win.customElements.define(this.ELEMENT_NAME, CsvReaderView);
  },
};