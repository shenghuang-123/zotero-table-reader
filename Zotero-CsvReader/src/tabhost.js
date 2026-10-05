/*
 * tabhost.js —— 标签页宿主：创建/聚焦/关闭自定义标签页，维护 itemID → tabID 索引。
 *
 * tab type 用 "csvreader"（不含 "-"，否则会被 Zotero_Tabs.parseTabType 拆成 type-state）。
 * Zotero_Tabs.tabHooks 对未知类型全部回退为 no-op，因此自定义类型可以安全使用。
 */

var CsvReaderTabHost = {
  TAB_TYPE: "csvreader",
  SHEETJS_PATH: "lib/xlsx.full.min.js",

  _app: null,
  _windows: null,
  _tabs: null,

  init(app) {
    this._app = app;
    this._windows = new Set();
    this._tabs = new Map();
  },

  onWindowLoad(app, win) {
    if (!win || this._windows.has(win)) return;
    this._windows.add(win);

    this._installTitleHook(win);
    this._loadSheetJS(app, win);
    try {
      CsvReaderViewer.defineElement(win);
    } catch (e) {
      Zotero.logError(e);
    }
    try {
      win.MozXULElement.insertFTLIfNeeded("csvreader.ftl");
    } catch (e) {
      Zotero.logError(e);
    }
  },

  /*
   * SheetJS 加载到窗口作用域：loadSubScript 的 target 即脚本全局对象，
   * 库顶层声明的 var XLSX 会落到 win.XLSX，viewer 通过 ownerDocument.defaultView.XLSX 取用。
   */
  _loadSheetJS(app, win) {
    if (win.XLSX) return;
    try {
      Services.scriptloader.loadSubScript(app.rootURI + this.SHEETJS_PATH, win);
    } catch (e) {
      Zotero.logError(e);
    }
  },

  onWindowUnload(app, win) {
    this._uninstallTitleHook(win);
    if (this._windows) this._windows.delete(win);
  },

  /*
   * Zotero_Tabs.rename(id) 在未传标题时会查 tabHooks.getTitle[type]；
   * 自定义类型若没有这个钩子，tab.title 会被直接置为 undefined。
   * 而附件条目每次被 modify，Zotero_Tabs.notify 都会对这些 tab 调一次 rename，
   * 于是标题被清空。这里为 csvreader 补上钩子，让 rename 能重新解析出标题。
   */
  _installTitleHook(win) {
    const tabs = win && win.Zotero_Tabs;
    if (!tabs || !tabs.tabHooks) return;
    if (!tabs.tabHooks.getTitle) tabs.tabHooks.getTitle = {};
    const self = this;
    tabs.tabHooks.getTitle[this.TAB_TYPE] = async (tab) => {
      const itemID = tab && tab.data ? tab.data.itemID : null;
      const item = itemID ? Zotero.Items.get(itemID) : null;
      return item ? self._titleFor(item) : "";
    };
  },

  _uninstallTitleHook(win) {
    const tabs = win && win.Zotero_Tabs;
    if (tabs && tabs.tabHooks && tabs.tabHooks.getTitle) {
      delete tabs.tabHooks.getTitle[this.TAB_TYPE];
    }
  },

  /*
   * Zotero_Tabs 是主窗口的全局变量（zoteroPane.xhtml 以 loadSubScript(..., this) 载入），
   * 插件沙箱里并没有这个裸标识符，直接引用会抛 ReferenceError。
   * 必须从主窗口取，这与 jasminum / windingwind 等插件的做法一致。
   */
  _tabsApi() {
    const win = Zotero.getMainWindow();
    const tabs = win && win.Zotero_Tabs;
    if (!tabs) {
      Zotero.debug("[csvreader] Zotero_Tabs unavailable on main window");
      return null;
    }
    return tabs;
  },

  async openForItem(item, kind) {
    const tabs = this._tabsApi();
    if (!tabs) return false;

    const existingTabID = tabs.getTabIDByItemID(item.id);
    if (existingTabID) {
      tabs.select(existingTabID);
      return true;
    }

    const path = await item.getFilePathAsync();
    if (!path) {
      Zotero.debug("[csvreader] no local file for attachment " + item.libraryKey);
      return false;
    }

    const title = this._titleFor(item);
    const { id: tabID, container } = tabs.add({
      type: this.TAB_TYPE,
      data: { itemID: item.id, icon: this._iconFor(item) },
      title,
      select: true,
      onClose: () => this._release(tabID),
    });
    this._tabs.set(tabID, { itemID: item.id });

    const view = container.ownerDocument.createXULElement(CsvReaderViewer.ELEMENT_NAME);
    view.setAttribute("path", path);
    view.setAttribute("title", title);
    view.setAttribute("item-id", String(item.id));
    view.setAttribute("format", kind || CsvReaderFormats.KIND_TEXT);
    // 二进制工作簿没有「字符编码」概念，只有文本表格才带 charset
    if (kind !== CsvReaderFormats.KIND_WORKBOOK) {
      const charset = item.attachmentCharset;
      if (charset) view.setAttribute("encoding", String(charset).toLowerCase());
    }
    container.appendChild(view);

    return true;
  },

  shutdown(app) {
    if (this._windows) {
      for (const win of this._windows) this._uninstallTitleHook(win);
    }
    if (!this._tabs) return;
    const tabs = this._tabsApi();
    for (const tabID of Array.from(this._tabs.keys())) {
      try {
        if (tabs) tabs.close(tabID);
      } catch (e) {
        Zotero.logError(e);
      }
    }
    this._tabs.clear();
    this._windows = new Set();
    this._app = null;
  },

  _release(tabID) {
    if (this._tabs) this._tabs.delete(tabID);
  },

  _titleFor(item) {
    const title = item.getField("title");
    if (title) return title;
    return item.attachmentFilename || "Table";
  },

  _iconFor(item) {
    try {
      return item.getItemTypeIconName(true);
    } catch (e) {
      return undefined;
    }
  },
};