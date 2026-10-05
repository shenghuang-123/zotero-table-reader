/*
 * csv.js —— RFC 4180 分词器与分隔符嗅探。
 * 支持引号包裹、字段内换行、双引号转义；分隔符在 , ; \t | 中按首行出现频次选择。
 */

var CsvReaderCsv = {
  DELIMITERS: [",", ";", "\t", "|"],
  SNIFF_LINES: 10,

  sniffDelimiter(text) {
    const lines = this._sampleLines(text);
    let best = ",";
    let bestCount = 0;
    for (const delimiter of this.DELIMITERS) {
      let count = 0;
      for (const line of lines) {
        count += this._countOutsideQuotes(line, delimiter);
      }
      if (count > bestCount) {
        bestCount = count;
        best = delimiter;
      }
    }
    return best;
  },

  parse(text, delimiter) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const length = text.length;

    while (i < length) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === delimiter) {
        row.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (ch === "\r") {
        if (text[i + 1] === "\n") i += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 1;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }

    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  },

  _sampleLines(text) {
    const lines = [];
    const limit = Math.min(text.length, 65536);
    let start = 0;
    for (let i = 0; i <= limit && lines.length < this.SNIFF_LINES; i++) {
      if (i === limit || text[i] === "\n") {
        const line = text.slice(start, i).replace(/\r$/, "");
        if (line.length) lines.push(line);
        start = i + 1;
      }
    }
    return lines;
  },

  _countOutsideQuotes(line, delimiter) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        count++;
      }
    }
    return count;
  },
};
