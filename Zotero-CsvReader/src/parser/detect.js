/*
 * detect.js —— 编码探测与解码。顺序：BOM → 严格 UTF-8 → GB18030 兜底。
 */

var CsvReaderDetect = {
  FALLBACK_ENCODING: "gb18030",

  detect(bytes) {
    if (this._hasPrefix(bytes, [0xef, 0xbb, 0xbf])) return { encoding: "utf-8", bomLength: 3 };
    if (this._hasPrefix(bytes, [0xff, 0xfe])) return { encoding: "utf-16le", bomLength: 2 };
    if (this._hasPrefix(bytes, [0xfe, 0xff])) return { encoding: "utf-16be", bomLength: 2 };
    if (this._isValidUtf8(bytes)) return { encoding: "utf-8", bomLength: 0 };
    return { encoding: this.FALLBACK_ENCODING, bomLength: 0 };
  },

  isSupported(encoding) {
    if (!encoding) return false;
    try {
      new TextDecoder(encoding);
      return true;
    } catch (e) {
      return false;
    }
  },

  decode(bytes, encoding) {
    const target = this.isSupported(encoding) ? encoding : this.FALLBACK_ENCODING;
    let data = bytes;
    if (target === "utf-8" && this._hasPrefix(bytes, [0xef, 0xbb, 0xbf])) {
      data = bytes.subarray(3);
    } else if (target === "utf-16le" && this._hasPrefix(bytes, [0xff, 0xfe])) {
      data = bytes.subarray(2);
    } else if (target === "utf-16be" && this._hasPrefix(bytes, [0xfe, 0xff])) {
      data = bytes.subarray(2);
    }
    try {
      return new TextDecoder(target).decode(data);
    } catch (e) {
      Zotero.logError(e);
      return new TextDecoder("utf-8").decode(bytes);
    }
  },

  _hasPrefix(bytes, prefix) {
    if (bytes.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (bytes[i] !== prefix[i]) return false;
    }
    return true;
  },

  _isValidUtf8(bytes) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch (e) {
      return false;
    }
  },
};
