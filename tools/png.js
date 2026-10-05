const fs = require("fs");
const zlib = require("zlib");

function decode(file) {
  const buf = fs.readFileSync(file);
  let p = 8, idat = [], meta;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      meta = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  if (meta.depth !== 8 || (meta.color !== 6 && meta.color !== 2)) throw new Error("unsupported PNG colour type");
  const ch = meta.color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = meta.w * ch;
  const out = Buffer.alloc(meta.h * stride);
  let off = 0;
  for (let y = 0; y < meta.h; y++) {
    const filter = raw[off++];
    const line = raw.subarray(off, off + stride);
    off += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = y ? (x >= ch ? prev[x - ch] : 0) : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { ...meta, ch, data: out };
}

function encode(file, w, h, ch, data) {
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunks = [];
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const crcBuf = Buffer.concat([head.subarray(4), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf) >>> 0, 0);
    chunks.push(head, body, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : 2;
  chunk("IHDR", ihdr);
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 }));
  chunk("IEND", Buffer.alloc(0));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]));
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return c ^ -1;
}

// Box filter on premultiplied alpha.
function downscale(srcFile, dstFile, size) {
  const { w, h, ch, data } = decode(srcFile);
  const sx = w / size, sy = h / size;
  const out = Buffer.alloc(size * size * ch);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * ch;
          const al = ch === 4 ? data[i + 3] / 255 : 1;
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * size + x) * ch;
      const af = a / n;
      if (ch === 4) out[o + 3] = Math.round(af * 255);
      const k = af > 0 ? 1 / af : 0;
      out[o] = Math.round((r / n) * k);
      out[o + 1] = Math.round((g / n) * k);
      out[o + 2] = Math.round((b / n) * k);
    }
  }
  encode(dstFile, size, size, ch, out);
}

module.exports = { decode, encode, downscale };
