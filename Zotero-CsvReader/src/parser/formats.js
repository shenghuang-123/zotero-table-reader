/*
 * formats.js —— 表格格式登记表：判定附件属于「文本表格」还是「二进制工作簿」。
 * 文本表格（csv/tsv）走内置 RFC 4180 分词器；工作簿（xlsx/xls/ods…）交给 SheetJS。
 *
 * 这里只登记「明确是表格」的扩展名与 MIME，避免把 text/plain 之类的通用类型也吃进来，
 * 否则 .md/.py/.json 这类纯文本附件会被误接管。
 */

var CsvReaderFormats = {
  KIND_TEXT: "text",
  KIND_WORKBOOK: "workbook",

  TEXT_EXTENSIONS: new Set(["csv", "tsv", "tab"]),

  WORKBOOK_EXTENSIONS: new Set([
    "xlsx",
    "xlsm",
    "xlsb",
    "xls",
    "xltx",
    "xltm",
    "xlt",
    "xla",
    "xlam",
    "ods",
    "fods",
  ]),

  TEXT_MIME_TYPES: new Set([
    "text/csv",
    "text/tab-separated-values",
    "application/csv",
    "application/x-csv",
  ]),

  // 统一小写比较
  WORKBOOK_MIME_TYPES: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    "application/vnd.ms-excel",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "application/vnd.ms-excel.template.macroenabled.12",
    "application/vnd.ms-excel.addin.macroenabled.12",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.spreadsheet-flat-xml",
  ]),

  extensionOf(name) {
    if (!name) return "";
    let base = String(name);
    const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
    if (slash >= 0) base = base.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  },

  /**
   * @param {{extension?: String, contentType?: String}} source
   * @returns {"text"|"workbook"|null}
   */
  kindFor(source) {
    const extension = source && source.extension ? String(source.extension).toLowerCase() : "";
    const contentType = source && source.contentType ? String(source.contentType).toLowerCase() : "";

    if (this.WORKBOOK_EXTENSIONS.has(extension) || this.WORKBOOK_MIME_TYPES.has(contentType)) {
      return this.KIND_WORKBOOK;
    }
    if (this.TEXT_EXTENSIONS.has(extension) || this.TEXT_MIME_TYPES.has(contentType)) {
      return this.KIND_TEXT;
    }
    return null;
  },

  kindForName(name, contentType) {
    return this.kindFor({ extension: this.extensionOf(name), contentType });
  },
};