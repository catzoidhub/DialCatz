import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { API_METHODS, uid, type ConnectRequest, type DialCatzApi, type HistoryEntry, type TreeItem, type WireRequest } from '@shared/types';
import { dataDir, store } from './store';
import { applySettings, setAiKey, setSettings, settings } from './settings';
import * as http from './http';
import * as sockets from './ws';
import * as ws from './workspaces';
import * as srv from './servers';
import * as live from './live';
import { copyPlan, exportCollection, importText } from './importers';
import * as devcatz from './devcatz';
import * as dbcatz from './dbcatz';
import * as postman from './postman';
import * as postmanApi from './postman-api';
import * as datafile from './datafile';
import * as ai from './ai-features';
import { siteBase } from './shared';
import * as updates from './updates';
import * as uninstall from './uninstall';
import * as reports from './reports';

/**
 * DialCatz — an API client: collections, environments and history on this computer, team workspaces synced
 * through a self-hosted DialCatz Den. Links it answers:
 *   dialcatz://open                                  bring the window up
 *   dialcatz://open?site=<DevCatz site id>           the DevCatz import for that site (asks before importing)
 *   dialcatz://connect?server=<url>&code=<code>       join a team server with a one-time invite code; the window
 *                                                    shows the server address and asks before anything is sent
 */

let win: BrowserWindow | null = null;
let pendingConnect: ConnectRequest | null = null;
const HISTORY = 'history';
const HISTORY_MAX = 300;

function createWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 560,
    title: 'DialCatz',
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar' as const, backgroundColor: '#00000000' } : {}),
    show: false,
    // plugins: the built-in PDF viewer for PDF responses.
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, plugins: true },
  });
  const w = win;
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => (win = null));
  // Links in responses / docs open in the browser, never inside the app window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, '../renderer/index.html'));
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

function handleLink(raw: string): void {
  createWindow();
  try {
    const u = new URL(raw);
    if (u.hostname === 'open' && u.searchParams.get('site')) {
      // From DevCatz: show the import for that site (nothing happens without the user's click).
      const site = u.searchParams.get('site')!;
      if (/^[\w-]{1,64}$/.test(site)) send('app:devcatz', site);
      return;
    }
    if (u.hostname === 'connect') {
      const server = u.searchParams.get('server') ?? '';
      const code = u.searchParams.get('code') ?? '';
      // Only shape checks here; the window shows the address and the user decides.
      if (!server || !/^[\w-]{6,128}$/.test(code)) throw new Error('missing or bad server / code');
      pendingConnect = { server: srv.normaliseUrl(server), code };
      send('app:connect', pendingConnect);
    }
  } catch (e) {
    console.warn(`dialcatz link ignored: ${raw} (${(e as Error).message})`);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('dialcatz://'));
  if (link) handleLink(link);
  else createWindow();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (app.isReady()) handleLink(url);
  else app.once('ready', () => handleLink(url));
});
app.on('activate', () => createWindow());
app.on('before-quit', () => (sockets.closeAll(), live.stopAll()));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function api(): DialCatzApi {
  return {
    appInfo: async () => ({
      version: app.getVersion(),
      platform: process.platform,
      dataDir: dataDir(),
      site: siteBase(),
      arch: process.arch,
      os: process.getSystemVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }),
    settings: async () => settings(),
    setSettings: async (patch) => setSettings(patch),
    setAiKey: (provider, key) => setAiKey(provider, key),

    workspaces: async () => ws.list(),
    workspace: async (id) => ws.load(id),
    createWorkspace: async (name) => ws.create(name),
    renameWorkspace: async (id, name) => {
      const w = ws.load(id);
      if (w.serverId) throw new Error('Team workspaces are renamed by the server admin');
      return ws.save({ ...w, name: name.trim().slice(0, 120) || w.name });
    },
    deleteWorkspace: async (id) => {
      if (ws.load(id).serverId) throw new Error('Hide a team workspace from the Team page instead');
      if (ws.list().filter((w) => !w.serverId).length <= 1) throw new Error('Keep at least one personal workspace');
      ws.remove(id);
    },
    saveItems: async (id, items) => ws.saveItems(id, items),
    deleteItems: async (id, ids) => ws.deleteItems(id, ids),
    saveEnvironment: async (id, env) => ws.saveEnvironment(id, env),
    deleteEnvironment: async (id, envId) => ws.deleteEnvironment(id, envId),
    setActiveEnvironment: async (id, envId) => ws.setActiveEnvironment(id, envId),
    saveGlobals: async (id, globals) => ws.saveGlobals(id, globals),
    saveLayout: async (id, layout) => ws.saveLayout(id, layout),
    importText: async (id, text) => doImport(id, text),
    importFile: async (id) => {
      const r = await dialog.showOpenDialog(win!, { title: 'Import a collection', properties: ['openFile'], filters: [{ name: 'Collections (JSON, YAML)', extensions: ['json', 'yaml', 'yml'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      return doImport(id, readFileSync(r.filePaths[0], 'utf8'));
    },
    copyCollection: async (fromId, collectionId, toId, mode, name) => {
      if (fromId === toId && mode !== 'new') throw new Error('Pick another workspace');
      if (!['new', 'replace', 'merge'].includes(mode)) throw new Error('Unknown copy mode');
      const data = exportCollection(ws.load(fromId).items, collectionId);
      const plan = copyPlan(ws.load(toId).items, data, mode, String(name ?? ''));
      if (plan.remove.length) ws.deleteItems(toId, plan.remove);
      const w = ws.saveItems(toId, plan.save);
      // A team workspace sends the copy now rather than at the next minute's sync.
      if (w.serverId) void srv.sync(toId).then(() => send('app:workspaces', null));
      return { workspace: w, collectionId: plan.collectionId };
    },
    devcatzSites: async () => ({ installed: devcatz.installed(), sites: devcatz.sites() }),
    dbcatzInfo: async () => ({ installed: dbcatz.installed(), ...dbcatz.connections() }),
    dbcatzOpen: (target) => dbcatz.open(target),
    saveDbTarget: async (id, collectionId, database, requestId, table) => ws.saveDbTarget(id, String(collectionId), database, requestId ? String(requestId) : null, table == null ? null : String(table)),
    devcatzImport: async (id, siteId, what) => {
      const site = devcatz.site(String(siteId));
      let w = ws.load(id);
      let collectionId: string | null = null;
      let requests = 0;
      let source: string | null = null;
      if (what.routes) {
        const r = await devcatz.routes(site, what.app);
        r.root.sort = w.items.filter((i) => i.kind === 'collection').length;
        w = ws.saveItems(id, [r.root, ...r.items]);
        collectionId = r.root.id;
        requests = r.items.filter((i) => i.kind === 'request').length;
        source = r.source;
      }
      if (what.environment) {
        const name = `DevCatz · ${site.name}`;
        const env = w.environments.find((e) => e.name === name);
        const extra = what.envVars ? devcatz.envVariables(site) : [];
        const base = devcatz.baseUrl(site, what.app);
        const urls = [{ key: 'baseUrl', value: base, enabled: true, secret: false }, ...(base !== site.url ? [{ key: 'siteUrl', value: site.url, enabled: true, secret: false }] : [])];
        const vars = [...urls, ...extra.filter((v) => !urls.some((u) => u.key === v.key))];
        // Again for the same site: the values are refreshed, variables added by hand stay.
        const merged = env ? [...vars, ...env.variables.filter((v) => !vars.some((x) => x.key === v.key) && !(v.key === 'siteUrl' && base === site.url))] : vars;
        w = ws.saveEnvironment(id, { id: env?.id ?? uid('e_'), name, variables: merged, shared: env?.shared });
        const envId = w.environments.find((e) => e.name === name)!.id;
        // The imported collection uses the site's environment, so sites with the same variable names never mix.
        const col = collectionId ? w.items.find((i) => i.id === collectionId) : null;
        if (col) w = ws.saveItems(id, [{ ...col, environmentId: envId }]);
        else if (!w.activeEnvironmentId) w = ws.setActiveEnvironment(id, envId);
      }
      if (w.serverId) void srv.sync(id).then(() => send('app:workspaces', null));
      return { workspace: w, collectionId, requests, source };
    },
    postmanReadExport: async (how) => {
      const r = await dialog.showOpenDialog(win!, {
        title: how === 'folder' ? 'Choose the folder of your Postman export' : 'Choose your Postman export (zip) or exported JSON files',
        properties: how === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
        filters: how === 'folder' ? undefined : [{ name: 'Postman export', extensions: ['zip', 'json'] }],
      });
      if (r.canceled || !r.filePaths.length) return null;
      const found = await postman.read(r.filePaths);
      if (!found.collections.length && !found.environments.length && !found.globals.length) throw new Error(`No Postman collections or environments in there${found.skipped.length ? ` (${found.skipped.length} file(s) skipped)` : ''}`);
      // kept until the user has picked (only the last export read)
      postmanExport = { token: uid('px_'), found };
      return {
        token: postmanExport.token,
        groups: [{ name: 'Export', collections: found.collections.map((c, i) => ({ id: String(i), name: c.root.name, requests: c.items.filter((x) => x.kind === 'request').length })), environments: found.environments.map((e, i) => ({ id: String(i), name: e.name })) }],
        globals: found.globals.length > 0,
        skipped: found.skipped.map(shortSkip),
      };
    },
    migratePostman: async (id, token, pick) => {
      if (!postmanExport || postmanExport.token !== token) throw new Error('Choose the Postman export again');
      const { found } = postmanExport;
      const c = new Set((pick?.collections ?? []).map(String));
      const e = new Set((pick?.environments ?? []).map(String));
      const picked: postman.PostmanFound = { collections: found.collections.filter((_, i) => c.has(String(i))), environments: found.environments.filter((_, i) => e.has(String(i))), globals: pick?.globals ? found.globals : [], skipped: found.skipped };
      if (!picked.collections.length && !picked.environments.length && !picked.globals.length) throw new Error('Choose at least one collection or environment');
      postmanExport = null;
      return applyPostman(id, picked);
    },
    postmanWorkspaces: (key) => postmanApi.workspaces(String(key ?? '')),
    postmanContents: (key, ids) => postmanApi.contents(String(key ?? ''), (Array.isArray(ids) ? ids : []).map(String).filter(Boolean)),
    migratePostmanApi: async (id, key, ids, pick) => {
      const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
      if (!list.length) throw new Error('Choose at least one Postman workspace');
      const p = { collections: (pick?.collections ?? []).map(String), environments: (pick?.environments ?? []).map(String), globals: !!pick?.globals };
      if (!p.collections.length && !p.environments.length && !p.globals) throw new Error('Choose at least one collection or environment');
      const found = await postmanApi.pull(String(key ?? ''), list, p, (pr) => send('app:postman', pr));
      if (!found.collections.length && !found.environments.length && !found.globals.length) throw new Error(`Nothing could be read from Postman${found.skipped.length ? ` (${found.skipped.length} could not be read)` : ''}`);
      return applyPostman(id, found);
    },
    exportCollection: async (id, collectionId) => {
      const w = ws.load(id);
      const data = exportCollection(w.items, collectionId);
      const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), `${data.collection.name.replace(/[^\w.-]+/g, '-')}.dialcatz.json`), filters: [{ name: 'DialCatz collection', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return false;
      writeFileSync(r.filePath, JSON.stringify(data, null, 2));
      return true;
    },

    // The window sends the wire form it built (variables resolved); its shape is checked here.
    send: async (wire, token, options) => {
      const w: WireRequest = {
        method: String(wire.method).toUpperCase().slice(0, 20),
        url: String(wire.url),
        headers: (Array.isArray(wire.headers) ? wire.headers : []).map(([k, v]) => [String(k), String(v)] as [string, string]).filter(([k]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)),
        body: wire.body === undefined ? undefined : String(wire.body),
        multipart: Array.isArray(wire.multipart) ? wire.multipart.map((p) => (p.file !== undefined ? { name: String(p.name), file: String(p.file) } : { name: String(p.name), value: String(p.value ?? '') })) : undefined,
        bodyFile: wire.bodyFile === undefined ? undefined : String(wire.bodyFile),
      };
      return http.send(w, token, { ...settings().requests, ...(options ?? {}) });
    },
    aiModels: (provider) => ai.models(provider),
    aiTest: () => ai.test(),
    aiAsk: (prompt, history, context, token) => ai.ask(String(prompt), Array.isArray(history) ? history : [], context, String(token)),
    aiExplain: (wire, response, token) => ai.explain(wire, response, String(token)),
    aiTests: (wire, response, current, token) => ai.tests(wire, response, String(current ?? ''), String(token)),
    aiBody: (request, instruction, token) => ai.body(request, String(instruction), String(token)),
    aiCancel: async (token) => ai.cancel(String(token)),
    pickDataFile: async () => {
      const r = await dialog.showOpenDialog(win!, { title: 'Choose a data file for the runner', properties: ['openFile'], filters: [{ name: 'CSV or JSON', extensions: ['csv', 'tsv', 'txt', 'json'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      return datafile.read(r.filePaths[0]);
    },
    saveText: async (name, text) => {
      const clean = String(name ?? 'results.txt').replace(/[^\w.-]+/g, '-');
      const ext = clean.split('.').pop() ?? 'txt';
      const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), clean), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (r.canceled || !r.filePath) return false;
      writeFileSync(r.filePath, String(text ?? ''));
      return true;
    },
    pickFile: async (title) => {
      const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return null;
      http.allowFile(r.filePaths[0]);
      return r.filePaths[0];
    },
    cancel: async (token) => http.cancel(token),
    wsConnect: async (token, url, headers, protocols) => sockets.connect(String(token), String(url), (Array.isArray(headers) ? headers : []).map(([k, v]) => [String(k), String(v)] as [string, string]), (Array.isArray(protocols) ? protocols : []).map(String)),
    wsSend: async (token, data) => sockets.send(String(token), String(data)),
    wsClose: async (token) => sockets.close(String(token)),
    saveResponse: async (token, suggestedName) => {
      const body = http.lastBody(token);
      if (!body) return false;
      const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), suggestedName.replace(/[/\\]/g, '-')) });
      if (r.canceled || !r.filePath) return false;
      writeFileSync(r.filePath, body);
      return true;
    },

    history: async () => store.extra<HistoryEntry[]>(HISTORY) ?? [],
    addHistory: async (entry) => {
      const list = store.extra<HistoryEntry[]>(HISTORY) ?? [];
      store.setExtra(HISTORY, [{ ...entry, id: entry.id || uid('h_') }, ...list].slice(0, HISTORY_MAX));
    },
    clearHistory: async () => store.setExtra(HISTORY, []),

    servers: async () => srv.servers(),
    probeServer: (url) => srv.probe(url),
    connectWithToken: async (url, token) => {
      const c = await srv.connectWithToken(url, token);
      void srv.syncAll().then(() => (live.refresh(), send('app:workspaces', null)));
      return c;
    },
    connectWithCode: async (url, code, device) => {
      const c = await srv.connectWithCode(url, code, device);
      pendingConnect = null;
      void srv.syncAll().then(() => (live.refresh(), send('app:workspaces', null)));
      return c;
    },
    refreshServer: (id) => srv.refresh(id),
    disconnectServer: async (id) => {
      await srv.disconnect(id);
      live.refresh();
    },
    subscribeWorkspace: async (serverId, wsId, on) => {
      const c = srv.subscribe(serverId, wsId, on);
      void srv.syncAll().then(() => (live.refresh(), send('app:workspaces', null)));
      return c;
    },
    setPresence: async (id, itemId) => live.setPresence(String(id), itemId === null ? null : String(itemId)),
    presence: async (id) => live.presenceOf(String(id)),
    syncWorkspace: (id) => srv.sync(id),
    resolveConflict: (id, itemId, keep) => srv.resolveConflict(String(id), String(itemId), keep === 'mine' ? 'mine' : 'theirs'),

    openUrl: async (url) => {
      // app:licenses — the third-party licences shipped inside the app (Catzoid #66), readable offline
      if (url === 'app:licenses') await shell.openPath(app.isPackaged ? join(process.resourcesPath, 'third-party-licenses.txt') : join(app.getAppPath(), 'resources', 'third-party-licenses.txt'));
      else if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    },
    copyText: async (text) => clipboard.writeText(text),
    hostName: () => deviceName(),

    updateState: async () => updates.current(),
    updateCheck: () => updates.check(true),
    updateDownload: () => updates.download(),
    updateCancel: async () => updates.cancelDownload(),
    updateInstall: async (when) => updates.install(when === 'quit' ? 'quit' : 'now'),
    updateSkip: async (version) => updates.skip(String(version)),
    updatePrefs: async () => updates.prefs(),
    setUpdatePrefs: async (patch) => updates.setPrefs(patch ?? {}),
    uninstallPlan: async () => uninstall.plan(),
    uninstall: (removeShared) => uninstall.run(removeShared === true),
    reportPreview: async (draft) => reports.preview(draft),
    reportSend: (draft) => reports.send(draft),
    captureWindow: async () => (win && !win.isDestroyed() ? (await win.webContents.capturePage()).toPNG().toString('base64') : ''),
    reportError: (message, stack) => reports.error(String(message ?? ''), String(stack ?? ''), 'renderer'),
    reportPrefs: async () => reports.prefs(),
    setReportPrefs: async (patch) => reports.setPrefs(patch ?? {}),
  };
}

/** The Postman export read last, until the user has picked what to bring over. */
let postmanExport: { token: string; found: postman.PostmanFound } | null = null;
/** A skipped file without the temporary unzip folder in front. */
const shortSkip = (f: string) => f.replace(/^.*dialcatz-postman-[^/]+\//, '');

/** Saves what was found in Postman (export or API) into the workspace: collections, environments, globals. */
function applyPostman(id: string, found: postman.PostmanFound) {
  let w = ws.load(id);
  let sort = w.items.filter((i) => i.kind === 'collection').length;
  const all: TreeItem[] = [];
  for (const c of found.collections) all.push({ ...c.root, sort: sort++ }, ...c.items);
  if (all.length) w = ws.saveItems(id, all);
  for (const e of found.environments) w = ws.saveEnvironment(id, e);
  if (found.globals.length) w = ws.saveGlobals(id, [...w.globals.filter((g) => !found.globals.some((x) => x.key === g.key)), ...found.globals]);
  if (!w.activeEnvironmentId && w.environments.length) w = ws.setActiveEnvironment(id, w.environments[0].id);
  if (w.serverId) void srv.sync(id).then(() => send('app:workspaces', null));
  return {
    workspace: w,
    summary: { collections: found.collections.map((c) => ({ name: c.root.name, requests: c.items.filter((i) => i.kind === 'request').length })), environments: found.environments.map((e) => e.name), globals: found.globals.length, skipped: found.skipped.map(shortSkip) },
  };
}

/** A readable name for this computer ("Andi's MacBook Pro"): the hostname can be an IP address on some networks. */
function deviceName(): Promise<string> {
  const fallback = () => {
    const h = (process.env.COMPUTERNAME || hostname()).replace(/\.local$/, '');
    return /^[\d.:]+$/.test(h) ? 'My computer' : h;
  };
  if (process.platform !== 'darwin') return Promise.resolve(fallback());
  return new Promise((resolve) => execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 3000 }, (err, out) => resolve(!err && String(out).trim() ? String(out).trim() : fallback())));
}

function doImport(workspaceId: string, text: string) {
  const { root, items, baseUrl } = importText(text);
  const w0 = ws.load(workspaceId);
  root.sort = w0.items.filter((i) => i.kind === 'collection').length;
  let w = ws.saveItems(workspaceId, [root, ...items]);
  // An OpenAPI server address becomes an environment, so {{baseUrl}} works at once.
  if (baseUrl && !w.environments.some((e) => e.variables.some((v) => v.key === 'baseUrl' && v.value === baseUrl))) {
    w = ws.saveEnvironment(workspaceId, { id: uid('e_'), name: root.name, variables: [{ key: 'baseUrl', value: baseUrl, enabled: true, secret: false }] });
    if (!w.activeEnvironmentId) w = ws.setActiveEnvironment(workspaceId, w.environments[w.environments.length - 1].id);
  }
  return { workspace: w, collectionId: root.id, count: items.filter((i) => i.kind === 'request').length };
}

function applyMenu(): void {
  const mac = process.platform === 'darwin';
  const cmd = (command: string) => () => send('app:command', command);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // The app menu's About DialCatz opens Settings → About (Catzoid TODO #62).
      ...(mac
        ? [
            {
              label: app.name,
              submenu: [
                { label: `About ${app.name}`, click: cmd('about') },
                // Check for Updates… right under About (Catzoid #54); "Update Available…" once a version is found.
                { label: updateLabel(), click: cmd('checkUpdates') },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Request', accelerator: 'CmdOrCtrl+N', click: cmd('newRequest') },
          { label: 'New Collection', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('newCollection') },
          { type: 'separator' },
          { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: cmd('import') },
          { type: 'separator' },
          { label: 'Save Request', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('closeTab') },
          ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Request',
        submenu: [
          { label: 'Send', accelerator: 'CmdOrCtrl+Enter', click: cmd('send') },
          { label: 'Focus Address', accelerator: 'CmdOrCtrl+L', click: cmd('focusUrl') },
        ],
      },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help' as const,
        submenu: [
          { label: 'Report a Bug…', click: cmd('reportBug') },
          { label: 'Send Feedback…', click: cmd('sendFeedback') },
          { type: 'separator' as const },
          { label: 'DialCatz Docs', click: () => void shell.openExternal(`${siteBase()}/docs`) },
          { label: 'Privacy and Data', click: () => void shell.openExternal(`${siteBase()}/docs/privacy-and-data`) },
          ...(mac ? [] : [{ type: 'separator' as const }, { label: updateLabel(), click: cmd('checkUpdates') }]),
        ],
      },
    ]),
  );
}

function updateLabel(): string {
  const k = updates.current().kind;
  return k === 'available' || k === 'downloading' || k === 'verifying' || k === 'downloaded' ? 'Update Available…' : 'Check for Updates…';
}

// Crash and error reports (Catzoid #65): crashReporter starts before the window; uploads only when the user opted in.
reports.init();

app.whenReady().then(() => {
  if (app.isPackaged) app.setAsDefaultProtocolClient('dialcatz');
  ws.ensureDefault();
  const impl = api() as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const m of API_METHODS) ipcMain.handle(`dialcatz:${m}`, (_e, ...args) => impl[m](...args));
  ipcMain.handle('dialcatz:pendingConnect', () => pendingConnect);
  ipcMain.handle('dialcatz:dismissConnect', () => (pendingConnect = null));
  applySettings((s) => send('app:settings', s));
  sockets.onEvent((e) => send('app:ws', e));
  applyMenu();
  createWindow();
  // Updates (Catzoid #54): every state change reaches the window and relabels the menu item.
  let lastKind = '';
  updates.init(
    (st) => {
      send('app:update', st);
      if (st.kind !== lastKind) (lastKind = st.kind), applyMenu();
    },
    () => {
      if (!win) createWindow();
      win?.show();
      win?.focus();
      send('app:command', 'whatsNew');
    },
  );
  const link = process.argv.find((a) => a.startsWith('dialcatz://'));
  if (link) handleLink(link);
  // Team workspaces: refresh identities, then sync every minute while the app runs.
  live.hooks({ presence: (id, list) => send('app:presence', { workspaceId: id, presence: list }), synced: () => send('app:synced', null) });
  void Promise.all(srv.servers().map((s) => srv.refresh(s.id)))
    .then(() => srv.syncAll())
    .then(() => (live.refresh(), send('app:workspaces', null)));
  setInterval(() => void srv.syncAll().then(() => send('app:synced', null)), 60_000);
});
