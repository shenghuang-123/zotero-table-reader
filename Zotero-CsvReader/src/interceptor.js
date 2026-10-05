/*
 * interceptor.js —— 包装 Zotero.FileHandlers.open，命中表格类型才接管。
 * 采用「包装而非替换」：其它插件若也包装了同一方法，两层的包装会自然串成链。
 *
 * 调用链已对照 Zotero 10.0.5 源码（chrome/content/zotero/zoteroPane.js）核实：
 *   双击附件 → ZoteroPane.viewAttachment() → launchFile()
 *   → Zotero.FileHandlers.open(item, { location, openInWindow })
 * 其中 openInWindow 取自 pref openReaderInNewWindow，默认 false，所以正常双击一定会进来。
 */

var CsvReaderInterceptor = {
  _originalOpen: null,
  _wrappedOpen: null,

  install(app) {
    if (this._wrappedOpen) return;

    const self = this;
    this._originalOpen = Zotero.FileHandlers.open;

    const wrapped = async function (item, params) {
      try {
        const kind = self._kindFor(item, params);
        if (kind) {
          const handled = await app.CsvReaderTabHost.openForItem(item, kind);
          if (handled) return true;
        }
      } catch (e) {
        Zotero.logError(e);
        Zotero.debug("[csvreader] tab open failed, falling back to system handler: " +
          (e && e.message ? e.message : e));
      }
      return self._originalOpen.call(this, item, params);
    };

    this._wrappedOpen = wrapped;
    Zotero.FileHandlers.open = wrapped;
    Zotero.debug("[csvreader] FileHandlers.open intercepted");
  },

  uninstall(app) {
    // 仅当当前实现仍是本插件安装的那个函数时才还原，避免踩掉后装插件的包装
    if (this._wrappedOpen && Zotero.FileHandlers.open === this._wrappedOpen) {
      Zotero.FileHandlers.open = this._originalOpen;
    }
    this._wrappedOpen = null;
    this._originalOpen = null;
  },

  /**
   * @returns {"text"|"workbook"|null} 需要接管时返回类型，否则 null
   */
  _kindFor(item, params) {
    // FileHandlers.open 也会被以路径字符串调用（Zotero.OpenPDF 等），那种情况直接放行
    if (!item || typeof item.isFileAttachment !== "function" || !item.isFileAttachment()) {
      return null;
    }
    // 显式要求在新窗口打开时，交回原生逻辑
    if (params && params.openInWindow) return null;

    const mode = Zotero.Prefs.get("extensions.zotero.csvreader.openMode") || "inTab";
    if (mode !== "inTab") return null;

    const name = item.attachmentFilename || item.attachmentPath || "";
    const kind = CsvReaderFormats.kindForName(name, item.attachmentContentType);
    if (kind) {
      Zotero.debug("[csvreader] intercepting " + item.libraryKey + " as " + kind);
    }
    return kind;
  },
};