/**
 * p19-ide W2 (docs/design/p19-ide.md §4, §6, §8): the Remyral bridge extension v1, installed into every IDE workspace's
 * own extensions dir at start (always on). It runs in the IDE's extension host on the worker and talks only to the
 * worker's loopback bridge endpoint (bridge.ts) with the workspace's bridge token from its environment:
 *
 *  - **Sohbete ekle** (editor context menu, Ctrl+Alt+K): the selected lines become a pending chat reference of the
 *    workspace owner in the console (path + range only; the master re-reads the text when the message is sent);
 *  - **Gönder** (status bar): commit everything with a message and push the workspace branch — through the daemon, the
 *    IDE never holds a git write token — optionally opening / updating a pull request;
 *  - **terminal audit**: every opened terminal is reported (best effort; the start of the IDE is the privileged act);
 *  - **Konsola dön**: opens the console;
 *  - **settings sync** (v2, p19-ide W3): at start the user's settings.json / keybindings.json stored on the master
 *    (fetched by the worker for this start) are written into the IDE's user data (`vscode-userdata:/User/…`, the
 *    browser-side store of the web workbench, through `workspace.fs`); then every 10 s (and on a configuration change,
 *    debounced) a changed file is saved back through the worker to the master, which refuses a file over 256 KiB or with
 *    a secret-looking value (shown as a warning). Where the user-data files cannot be written, settings are applied
 *    key by key through the configuration API (keybindings then stay local).
 *
 * Plain CommonJS against the stable `vscode` API (no build step, no dependencies), kept small on purpose: the files are
 * written by the worker, so a release pins exactly this code.
 */

export const BRIDGE_EXTENSION_ID = 'remyral.ide-bridge';
export const BRIDGE_EXTENSION_VERSION = '2.0.0';
export const BRIDGE_EXTENSION_DIR = `${BRIDGE_EXTENSION_ID}-${BRIDGE_EXTENSION_VERSION}`;

const PACKAGE_JSON = {
  name: 'ide-bridge',
  publisher: 'remyral',
  displayName: 'Remyral',
  description: 'Remyral konsolu ile köprü: Sohbete ekle, Gönder, terminal denetimi.',
  version: BRIDGE_EXTENSION_VERSION,
  license: 'Apache-2.0',
  engines: { vscode: '^1.80.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [
      { command: 'remyral.addToChat', title: 'Sohbete ekle', category: 'Remyral' },
      { command: 'remyral.send', title: 'Gönder', category: 'Remyral' },
      { command: 'remyral.openConsole', title: 'Konsola dön', category: 'Remyral' },
      { command: 'remyral.syncSettings', title: 'Ayarları eşitle', category: 'Remyral' },
    ],
    menus: {
      'editor/context': [{ command: 'remyral.addToChat', when: 'editorHasSelection', group: '9_remyral@1' }],
    },
    keybindings: [{ command: 'remyral.addToChat', key: 'ctrl+alt+k', when: 'editorTextFocus' }],
  },
};

const EXTENSION_JS = String.raw`'use strict';
const vscode = require('vscode');
const http = require('http');

const BRIDGE = process.env.REMYRAL_IDE_BRIDGE_URL || '';
const TOKEN = process.env.REMYRAL_IDE_BRIDGE_TOKEN || '';
const CONSOLE = process.env.REMYRAL_CONSOLE_URL || '';
const LABEL = process.env.REMYRAL_IDE_LABEL || 'Remyral';

function call(path, body, timeoutMs, method) {
  return new Promise((resolve) => {
    if (BRIDGE === '' || TOKEN === '') {
      resolve({ status: 'failed', message: 'Remyral köprüsü bu oturumda yok.' });
      return;
    }
    let url;
    try {
      url = new URL(BRIDGE + path);
    } catch (e) {
      resolve({ status: 'failed', message: 'Remyral köprüsü adresi geçersiz.' });
      return;
    }
    const verb = method || 'POST';
    const data = verb === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: verb,
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          authorization: 'Bearer ' + TOKEN,
        },
        timeout: timeoutMs || 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            resolve({ status: 'failed', message: 'Remyral köprüsü anlaşılmayan bir yanıt verdi.' });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 'failed', message: 'Remyral köprüsüne ulaşılamadı.' }));
    req.end(data);
  });
}

async function addToChat() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-remote') {
    vscode.window.showWarningMessage('Yalnız çalışma alanındaki dosyalar sohbete eklenebilir.');
    return;
  }
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  if (rel === doc.uri.fsPath || rel.startsWith('..') || rel.startsWith('/')) {
    vscode.window.showWarningMessage('Bu dosya çalışma alanının dışında.');
    return;
  }
  const sel = editor.selection;
  let start = sel.start.line + 1;
  let end = sel.end.line + 1;
  if (!sel.isEmpty && sel.end.character === 0 && end > start) end -= 1;
  const r = await call('/reference', { path: rel.split('\\').join('/'), startLine: start, endLine: end });
  if (r.status === 'ok') vscode.window.showInformationMessage('Sohbete eklendi: ' + rel + ':' + start + (end > start ? '-' + end : ''));
  else vscode.window.showWarningMessage(r.message || 'Sohbete eklenemedi.');
}

async function send() {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Gönder', description: 'Değişiklikleri commit et ve branch’i push et', pr: false },
      { label: 'Gönder ve PR aç', description: 'Ayrıca birleştirme isteği aç / güncelle', pr: true },
    ],
    { placeHolder: 'Değişiklikler ' + LABEL + ' branch’ine gönderilir' },
  );
  if (!pick) return;
  const message = await vscode.window.showInputBox({
    prompt: 'Commit mesajı',
    value: 'IDE: değişiklikler',
    validateInput: (v) => (v.trim().length === 0 ? 'Bir mesaj yazın' : v.length > 2000 ? 'En fazla 2000 karakter' : null),
  });
  if (message === undefined) return;
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Gönderiliyor…' },
    () => call('/push', { message: message.trim(), pullRequest: pick.pr }, 180000),
  );
  if (r.status === 'ok') {
    if (r.url) {
      const open = await vscode.window.showInformationMessage(r.message || 'Gönderildi.', 'Aç');
      if (open === 'Aç') vscode.env.openExternal(vscode.Uri.parse(r.url));
    } else {
      vscode.window.showInformationMessage(r.message || 'Gönderildi.');
    }
  } else {
    vscode.window.showErrorMessage(r.message || 'Gönderilemedi.');
  }
}

// ---------------------------------------------------------------------------------------- settings sync (v2)
const SYNC_FILES = [['settings', 'settings.json'], ['keybindings', 'keybindings.json']];
const SYNC_MAX = 256 * 1024;
const synced = { settings: null, keybindings: null };
const warned = { settings: null, keybindings: null };
let syncOn = false;
let pushing = false;

function userUri(name) {
  return vscode.Uri.from({ scheme: 'vscode-userdata', path: '/User/' + name });
}

async function readLocal(name) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(userUri(name))).toString('utf8');
  } catch (e) {
    return null;
  }
}

function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    out += c;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function applyByApi(text) {
  let obj;
  try {
    obj = JSON.parse(stripJsonc(text));
  } catch (e) {
    return;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const config = vscode.workspace.getConfiguration();
  for (const key of Object.keys(obj).slice(0, 2000)) {
    try {
      await config.update(key, obj[key], vscode.ConfigurationTarget.Global);
    } catch (e) {
      // an unknown or machine-scoped key: left out
    }
  }
}

async function pullSettings() {
  const r = await call('/settings', undefined, 15000, 'GET');
  if (!r || r.sync !== true) return false;
  syncOn = true;
  for (const [file, name] of SYNC_FILES) {
    const remote = r[file];
    const local = await readLocal(name);
    if (typeof remote === 'string') {
      if (local !== remote) {
        try {
          await vscode.workspace.fs.writeFile(userUri(name), Buffer.from(remote, 'utf8'));
        } catch (e) {
          if (file === 'settings') await applyByApi(remote);
        }
      }
      synced[file] = remote;
    } else {
      synced[file] = local;
    }
  }
  return true;
}

async function pushSettings(manual) {
  if (!syncOn || pushing) return;
  pushing = true;
  try {
    let saved = 0;
    for (const [file, name] of SYNC_FILES) {
      const local = await readLocal(name);
      if (local === null || local === synced[file] || local === warned[file]) continue;
      if (Buffer.byteLength(local, 'utf8') > SYNC_MAX) {
        warned[file] = local;
        vscode.window.showWarningMessage('Remyral: ' + name + ' 256 KiB sınırını aşıyor; eşitlenmedi.');
        continue;
      }
      const r = await call('/settings', { file: file, content: local }, 30000);
      if (r.status === 'ok') {
        synced[file] = local;
        saved += 1;
      } else {
        warned[file] = local;
        vscode.window.showWarningMessage(r.message || 'Ayarlar kaydedilemedi.');
      }
    }
    if (manual) vscode.window.showInformationMessage(saved > 0 ? 'Ayarlar eşitlendi.' : 'Ayarlar zaten eşit.');
  } finally {
    pushing = false;
  }
}

function startSync(context) {
  void pullSettings().then((on) => {
    if (!on) return;
    const timer = setInterval(() => void pushSettings(false), 10000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    let debounce = null;
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void pushSettings(false), 3000);
      }),
    );
  });
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = '$(cloud-upload) Gönder';
  item.tooltip = LABEL + ': kaydet ve gönder';
  item.command = 'remyral.send';
  item.show();
  context.subscriptions.push(item);
  context.subscriptions.push(vscode.commands.registerCommand('remyral.addToChat', addToChat));
  context.subscriptions.push(vscode.commands.registerCommand('remyral.send', send));
  context.subscriptions.push(
    vscode.commands.registerCommand('remyral.openConsole', () => {
      if (CONSOLE !== '') vscode.env.openExternal(vscode.Uri.parse(CONSOLE));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('remyral.syncSettings', () => {
      if (!syncOn) {
        vscode.window.showInformationMessage('Ayar eşitleme bu oturumda kapalı.');
        return;
      }
      void pushSettings(true);
    }),
  );
  startSync(context);
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((t) => {
      void call('/terminal', { name: String((t && t.name) || '').slice(0, 80) });
    }),
  );
  for (const t of vscode.window.terminals) void call('/terminal', { name: String(t.name || '').slice(0, 80) });
}

function deactivate() {}

module.exports = { activate, deactivate };
`;

/** The extension's files (relative path → content). */
export function bridgeExtensionFiles(): Readonly<Record<string, string>> {
  return {
    'package.json': `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`,
    'extension.js': EXTENSION_JS,
  };
}

/**
 * The `extensions.json` entry that registers the extension in the workspace's own extensions dir (the scanner of the
 * pinned server lists only registered folders; UNVERIFIED-LIVE until the IDE runs on a Linux worker).
 */
export function bridgeExtensionsJson(extensionsDir: string, now: Date): string {
  const location = `${extensionsDir.replace(/\/+$/, '')}/${BRIDGE_EXTENSION_DIR}`;
  return JSON.stringify([
    {
      identifier: { id: BRIDGE_EXTENSION_ID },
      version: BRIDGE_EXTENSION_VERSION,
      location: { $mid: 1, path: location, scheme: 'file' },
      relativeLocation: BRIDGE_EXTENSION_DIR,
      metadata: { installedTimestamp: now.getTime(), source: 'vsix', isBuiltin: false, pinned: true },
    },
  ]);
}
