# Zotero Table Reader

在 Zotero 标签页内直接预览 **CSV / TSV** 与 **Excel（xlsx / xls）/ ODS** 表格附件，无需调用外部程序打开。

Zotero 本身没有为第三方阅读器提供注册接口，本插件通过包装 `Zotero.FileHandlers.open()` 接管表格类附件的打开流程：命中表格类型时在 Zotero 主窗口内新建一个自定义标签页渲染表格，其它类型则原样交回系统处理。

## 功能特性

- **双击即开**：在条目面板双击 CSV/TSV/Excel/ODS 附件，直接在 Zotero 标签页内打开表格，不再弹出「用外部程序打开」。
- **多格式支持**：CSV、TSV 由内置解析器处理；xlsx / xls / ODS 通过 SheetJS（`lib/xlsx.full.min.js`）解析。
- **保留合并单元格**：读取并还原工作表中的合并区域效果。
- **分隔符与编码自动识别**：自动探测逗号/制表符等分隔符与文件编码，可在界面中手动切换。
- **大表可用的表头与列宽**：表头固定，列宽按整列最长文本一次性计算并保持稳定；横向滚动条按可视宽度正确显示。
- **偏好设置**：
  - `extensions.zotero.csvreader.openMode`：打开方式（默认 `inTab`）
  - `extensions.zotero.csvreader.tableAlign`：表格对齐（`left` / `center` / `right`）
  - `extensions.zotero.csvreader.freezeRows` / `freezeCols`：冻结行 / 列数
- **主题兼容**：样式作用域化并复用 Cupertino 主题变量，与美化插件共存而不干扰条目树。
- **多语言**：内置 `zh-CN` 与 `en-US` 界面文案。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| Zotero | 7.0 及以上（`strict_max_version` 为 `10.*.*`，已在 Zotero 10.0.5 上验证） |
| 插件 ID | `csvreader@zotero.local` |
| 当前版本 | 0.3.0 |

## 安装

### 方式一：使用已打包的 XPI

1. 在 Zotero 中打开 **工具 → 插件**。
2. 点击右上角齿轮 → **Install Plugin From File…**。
3. 选择 `csvreader@zotero.local.xpi`，安装后重启 Zotero。

### 方式二：从源码打包

源码位于 `Zotero-CsvReader/`，使用仓库根目录的打包脚本生成 XPI：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1
```

脚本会将 `Zotero-CsvReader/` 下的全部文件按相对路径压缩为 `csvreader@zotero.local.xpi`。

## 使用方法

1. 在 Zotero 条目列表中选中一条带有 CSV / Excel / ODS 附件的条目。
2. 在右侧条目面板中双击该附件。
3. 插件会在 Zotero 主窗口中新建标签页并渲染表格。

若某种文件类型未被接管，插件会回退到系统默认处理方式，不会影响原有行为。

## 目录结构

```
Zotero-CsvReader/
├── manifest.json          # 插件清单（版本、兼容范围、ID）
├── bootstrap.js           # 生命周期入口：加载子脚本、注入样式、安装拦截层
├── prefs.js               # 默认偏好设置
├── lib/
│   └── xlsx.full.min.js   # SheetJS，用于 xlsx / xls / ODS
├── locale/
│   ├── en-US/csvreader.ftl
│   └── zh-CN/csvreader.ftl
├── src/
│   ├── interceptor.js     # 包装 Zotero.FileHandlers.open
│   ├── tabhost.js         # 自定义标签页的创建与生命周期
│   ├── viewer.js          # 表格渲染、列宽计算、滚动与交互
│   └── parser/
│       ├── formats.js     # 支持的格式判定
│       ├── detect.js      # 编码 / 分隔符探测
│       ├── csv.js         # CSV / TSV 解析
│       └── merges.js      # 合并单元格还原
└── style/
    └── viewer.css         # 表格与容器样式（作用域化，兼容 Cupertino）
```

## 开发说明

- 子脚本在 `bootstrap.js` 的 `CSVREADER_SUBSCRIPTS` 中按顺序加载，新增模块需同时在此登记。
- 拦截层采用「包装而非替换」的方式，其它同样包装 `Zotero.FileHandlers.open` 的插件可以与本插件自然串成调用链。
- 表格样式全部限定在插件根容器前缀下，避免污染 Zotero 与其它插件的界面。

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。