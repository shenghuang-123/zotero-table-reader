/*
 * merges.js —— 合并区域（!merges）的归一化与渲染布局计算。
 *
 * 纯函数，不碰 DOM：输入 SheetJS 的 !merges 与当前可视窗口，输出每个渲染行应当
 * 跳过（被合并覆盖）或跨行/跨列（合并锚点）的单元格。这样合并逻辑可以脱离浏览器单测。
 *
 * 坐标系：SheetJS 一律 0 基行列，形如 [{ s: { r, c }, e: { r, c } }]。
 * 本插件把工作表第 0 行当表头、其余当正文，因此正文第 i 行对应工作表第 i+1 行。
 * 正文布局用 row*(columns+1)+col 作为键，与渲染时逐行遍历的索引保持一致。
 */

var CsvReaderMerges = {
  /**
   * 归一化并过滤 !merges：丢掉非法、单格与重复项，统一成 { r1, c1, r2, c2 }。
   * @returns {Array<{r1:number,c1:number,r2:number,c2:number}>}
   */
  normalize(raw) {
    const list = [];
    if (!Array.isArray(raw)) return list;

    const seen = new Set();
    for (const entry of raw) {
      if (!entry || !entry.s || !entry.e) continue;

      const r1 = Number(entry.s.r);
      const c1 = Number(entry.s.c);
      const r2 = Number(entry.e.r);
      const c2 = Number(entry.e.c);
      if (
        !Number.isInteger(r1) ||
        !Number.isInteger(c1) ||
        !Number.isInteger(r2) ||
        !Number.isInteger(c2)
      ) {
        continue;
      }
      if (r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1) continue;
      // 单格“合并”没有任何视觉效果，反而会干扰表头的覆盖判定
      if (r1 === r2 && c1 === c2) continue;

      const key = r1 + ":" + c1 + ":" + r2 + ":" + c2;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ r1, c1, r2, c2 });
    }
    return list;
  },

  /**
   * 表头（工作表第 0 行）的合并：锚点落在第 0 行的一律以 colspan 表达。
   * 纯纵向合并（c1 === c2）在表头没有横向跨度，不处理。
   * @returns {{spans: Map<number, number>, covered: Set<number>}}
   */
  headerCells(merges, columns) {
    const spans = new Map();
    const covered = new Set();
    if (!Array.isArray(merges) || columns < 1) return { spans, covered };

    for (const m of merges) {
      if (m.r1 !== 0) continue;
      if (m.c1 >= columns) continue;

      const last = Math.min(m.c2, columns - 1);
      if (last <= m.c1) continue;

      spans.set(m.c1, last - m.c1 + 1);
      for (let c = m.c1 + 1; c <= last; c++) covered.add(c);
    }
    return { spans, covered };
  },

  /**
   * 正文可视窗口 [start, end) 的合并布局。虚拟滚动只渲染这一窗口，
   * 因此跨行合并的 rowspan 必须裁剪到窗口内；锚点被滚出窗口时，
   * 在窗口顶行补一个“续接”单元格，保证合并框在滚动中始终连续。
   *
   * @param {Array} merges 归一化后的合并列表
   * @param {number} columns 正文列数
   * @param {number} totalBodyRows 正文总行数
   * @param {number} start 窗口起始行（含）
   * @param {number} end 窗口结束行（不含）
   * @returns {{skip: Set<number>, anchors: Map<number, {rowspan:number,colspan:number,srcRow:number,srcCol:number,showValue:boolean}>}}
   */
  windowLayout(merges, columns, totalBodyRows, start, end) {
    const skip = new Set();
    const anchors = new Map();
    if (!Array.isArray(merges) || !merges.length) return { skip, anchors };
    if (columns < 1 || totalBodyRows < 1 || end <= start) return { skip, anchors };

    const stride = columns + 1;
    const lastRow = Math.min(end - 1, totalBodyRows - 1);

    for (const m of merges) {
      // 锚点落在表头的合并交给 headerCells，正文不再重复表达
      const br1 = m.r1 - 1;
      const br2 = m.r2 - 1;
      if (br1 < 0 || br2 < 0) continue;
      if (br2 < start || br1 > lastRow) continue;

      const bc1 = m.c1;
      if (bc1 >= columns) continue;
      const bc2 = Math.min(m.c2, columns - 1);
      if (bc2 < bc1) continue;

      const vr1 = Math.max(br1, start);
      const vr2 = Math.min(br2, lastRow);
      if (vr1 > vr2) continue;

      anchors.set(vr1 * stride + bc1, {
        rowspan: vr2 - vr1 + 1,
        colspan: bc2 - bc1 + 1,
        srcRow: br1,
        srcCol: bc1,
        // 锚点仍在窗口内才显示内容；否则保持 Excel 那样的空框，避免文字随滚动“粘”在顶部
        showValue: vr1 === br1,
      });

      for (let r = vr1; r <= vr2; r++) {
        const base = r * stride;
        for (let c = bc1; c <= bc2; c++) {
          if (r === vr1 && c === bc1) continue;
          skip.add(base + c);
        }
      }
    }
    return { skip, anchors };
  },
};