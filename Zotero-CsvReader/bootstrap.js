/*
 * Zotero CSV Reader —— 生命周期入口。
 * 职责：加载子脚本、注入样式表、安装/卸载 FileHandlers.open 拦截层。
 */

var CsvReaderApp = null;
var csvReaderStyleSheet = null;

var CSVREADER_SUBSCRIPTS = [
  "src/parser/formats.js",
  "src/parser/detect.js",
  "src/parser/csv.js",
  "src/parser/merges.js",
  "src/viewer.js",
  "src/tabhost.js",
  "src/interceptor.js",
];

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
  await Zotero.initializationPromise;

  const app = {
    id,
    version,
    rootURI,
    mainWindows: new Set(),
  };
  app._globalThis = app;

  for (const file of CSVREADER_SUBSCRIPTS) {
    Services.scriptloader.loadSubScript(rootURI + file, app);
  }
  CsvReaderApp = app;

  csvReaderStyleSheet = registerStyleSheet(rootURI + "style/viewer.css");

  app.CsvReaderTabHost.init(app);
  app.CsvReaderInterceptor.install(app);

  for (const win of Zotero.getMainWindows()) {
    app.CsvReaderTabHost.onWindowLoad(app, win);
  }

  Zotero.debug("[csvreader] started v" + version + " (" + reason + ")");
}

function onMainWindowLoad({ window: win }) {
  if (!CsvReaderApp) return;
  CsvReaderApp.CsvReaderTabHost.onWindowLoad(CsvReaderApp, win);
}

function onMainWindowUnload({ window: win }) {
  if (!CsvReaderApp) return;
  CsvReaderApp.CsvReaderTabHost.onWindowUnload(CsvReaderApp, win);
}

function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;

  const app = CsvReaderApp;
  if (!app) return;

  try {
    app.CsvReaderInterceptor.uninstall(app);
  } catch (e) {
    Zotero.logError(e);
  }
  try {
    app.CsvReaderTabHost.shutdown(app);
  } catch (e) {
    Zotero.logError(e);
  }

  unregisterStyleSheet();
  CsvReaderApp = null;
  Zotero.debug("[csvreader] shutdown (" + reason + ")");
}

function getStyleSheetService() {
  return Components.classes["@mozilla.org/content/style-sheet-service;1"]
    .getService(Components.interfaces.nsIStyleSheetService);
}

function registerStyleSheet(cssURI) {
  const uri = Services.io.newURI(cssURI);
  const service = getStyleSheetService();
  service.loadAndRegisterSheet(uri, service.AUTHOR_SHEET);
  return { uri, type: service.AUTHOR_SHEET };
}

function unregisterStyleSheet() {
  if (!csvReaderStyleSheet) return;
  try {
    const service = getStyleSheetService();
    const { uri, type } = csvReaderStyleSheet;
    if (service.sheetRegistered(uri, type)) {
      service.unregisterSheet(uri, type);
    }
  } catch (e) {
    Zotero.logError(e);
  }
  csvReaderStyleSheet = null;
}
