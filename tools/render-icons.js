const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { decode, downscale } = require("./png");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const assets = path.resolve(__dirname, "..", "Zotero-CsvReader", "assets");
const branding = path.resolve(__dirname, "..", "branding");
fs.mkdirSync(branding, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "icon-"));

const jobs = [
  { svg: "icon.svg", size: 256, dir: branding },
  { svg: "icon.svg", size: 512, dir: branding },
  { svg: "icon.svg", size: 48 },
  { svg: "icon.svg", size: 96 },
  { svg: "icon-small.svg", size: 16 },
  { svg: "icon-small.svg", size: 32 },
];

// Edge 无头栅格化在 128 下会丢帧，改为从 256 降采样。
const derived = [{ from: path.join(branding, "icon-256.png"), out: "icon-128.png", size: 128 }];

function render({ svg, size, dir = assets }, index) {
  const src = fs.readFileSync(path.join(assets, svg), "utf8")
    .replace('viewBox="0 0 128 128"', `viewBox="0 0 128 128" width="${size}" height="${size}"`);
  const html = path.join(tmp, `${index}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>${src}`);
  const out = path.join(dir, `icon-${size}.png`);
  return new Promise((resolve) => {
    execFile(EDGE, [
      `--user-data-dir=${path.join(tmp, "profile" + index)}`,
      "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
      "--force-device-scale-factor=1", "--virtual-time-budget=2000",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${out}`, "file:///" + html.replace(/\\/g, "/"),
    ], { timeout: 90000 }, () => resolve(check(out)));
  });
}

// 检查是否只画出了局部（底部整行透明即为丢帧）。
function check(file) {
  if (!fs.existsSync(file)) return console.log(path.basename(file), "MISSING");
  const { w, h, ch, data } = decode(file);
  let bottom = 0;
  for (let x = 0; x < w; x++) if (data[((h - 2) * w + x) * ch + 3] > 10) bottom++;
  console.log(path.basename(file), `${w}x${h}`, fs.statSync(file).size + "B", bottom > w * 0.5 ? "ok" : "PARTIAL RENDER");
  return bottom > w * 0.5;
}

Promise.all(jobs.map(render)).then(() => {
  for (const { from, out, size } of derived) {
    const dst = path.join(assets, out);
    downscale(from, dst, size);
    check(dst);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
