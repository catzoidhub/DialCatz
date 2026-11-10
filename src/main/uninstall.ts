import { app, shell } from 'electron';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { words } from '@shared/platform';
import { AI_PROVIDERS, type UninstallPlan } from '@shared/types';
import { deleteToken, tokenStore } from './secrets';
import { servers } from './servers';
import { SHARED_DIR, setSharedKey } from './shared';
import { appImageDesktopFile, appImageIconFile } from './appimage';
import { runAsRootLinux, shq } from './linuxadmin';
import { isLinux, isWin } from './platform';

/**
 * Uninstall DialCatz (Catzoid family #55; the list is DialCatz TODO #53 and the Homebrew cask's `zap`): its data folder
 * (collections, environments, history, settings), the Keychain items with DialCatz Den tokens, caches, logs, saved
 * window state and preferences. The shared Catzoid settings and the "Catzoid AI" key go only when the user says so
 * (default: kept while another Catzoid app is installed). Never the user's own files (exports, saved responses).
 * The app bundle goes to the Trash and the app quits; the data folder is removed right after the quit (Electron
 * still writes to it while running). DIALCATZ_UNINSTALL_DRY_RUN=1 removes nothing (tests).
 *
 * Windows (as DevCatz and DBCatz): the data folder %APPDATA%\DialCatz (the Den tokens are DPAPI-encrypted inside it)
 * and electron-updater's %LOCALAPPDATA%\dialcatz-updater go to the Recycle Bin, the app goes with its own NSIS
 * uninstaller (the app, its shortcuts, its entry in Installed apps), and the dialcatz:// link goes — all from a small
 * progress window that starts once DialCatz has quit (Windows keeps a running app's profile locked). The shared AI
 * keys and Git tokens are the Catzoid\keys\*.dpapi files.
 *
 * Linux (#87, as DoCatz): the data folder ~/.config/DialCatz, ~/.cache/DialCatz and ~/.cache/dialcatz-updater, the
 * AppImage's menu entry and icon, and the app: the AppImage file is deleted, a .deb goes with `dpkg -r` behind the
 * password prompt while DialCatz still runs (a running program keeps its open files).
 */

const ID = 'com.mrcatz.dialcatz';
const LIB = join(homedir(), 'Library');
const SIBLINGS = ['DevCatz', 'DBCatz', 'DoCatz'];

function bundle(): string | null {
  // Linux: the AppImage file, or a .deb's /opt/DialCatz.
  if (isLinux) return app.isPackaged ? process.env.APPIMAGE || (process.execPath.startsWith('/opt/') ? dirname(process.execPath) : null) : null;
  // Windows: the NSIS uninstaller next to DialCatz.exe.
  if (isWin) {
    const u = join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
    return app.isPackaged && existsSync(u) ? u : null;
  }
  // …/DialCatz.app/Contents/MacOS/DialCatz → …/DialCatz.app
  const p = dirname(dirname(dirname(app.getPath('exe'))));
  return app.isPackaged && p.endsWith('.app') ? p : null;
}

/** Folders and files DialCatz (or macOS on its behalf) put on this Mac, the data folder first. */
function paths(): string[] {
  return [
    app.getPath('userData'),
    join(LIB, 'Caches', ID),
    join(LIB, 'Caches', `${ID}.ShipIt`),
    join(LIB, 'Caches', `${app.getName()}-updater`),
    join(LIB, 'Caches', 'dialcatz-updater'),
    join(LIB, 'Logs', app.getName()),
    join(LIB, 'HTTPStorages', ID),
    join(LIB, 'Saved Application State', `${ID}.savedState`),
    join(LIB, 'Preferences', `${ID}.plist`),
    join(LIB, 'Application Support', 'CrashReporter', `${app.getName()}_*`),
  ];
}

/** Windows: what DialCatz keeps outside its data folder (electron-updater's downloads). */
function winLeftovers(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [join(local, 'dialcatz-updater')].filter(existsSync);
}

/** Linux: the .deb package this DialCatz came from (null for an AppImage or a copied folder). */
function linuxPackage(): string | null {
  if (!isLinux || process.env.APPIMAGE || !app.isPackaged) return null;
  const r = spawnSync('dpkg', ['-S', process.execPath], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.split(':')[0]?.trim() || null : null;
}

/** Linux: what DialCatz keeps outside its data folder (caches, update downloads, the AppImage's menu entry). */
function linuxLeftovers(): { label: string; path: string }[] {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return [
    { label: 'Caches', path: join(cache, app.getName()) },
    { label: 'Update downloads', path: join(cache, 'dialcatz-updater') },
    { label: 'The menu entry', path: appImageDesktopFile() },
    { label: 'The menu entry’s icon', path: appImageIconFile() },
  ].filter((f) => existsSync(f.path));
}

function otherApps(): string[] {
  if (isWin) {
    // The per-user NSIS install folder (the default), or the app's uninstall entry in the registry's folder.
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return SIBLINGS.filter((n) => existsSync(join(local, 'Programs', n, `${n}.exe`)) || existsSync(join(local, 'Programs', n.toLowerCase(), `${n}.exe`)));
  }
  if (isLinux)
    return SIBLINGS.filter((n) => [join(homedir(), 'Applications', `${n}.AppImage`), join('/opt', n, n.toLowerCase())].some(existsSync));
  return SIBLINGS.filter((n) => [join('/Applications', `${n}.app`), join(homedir(), 'Applications', `${n}.app`)].some(existsSync));
}

function brew(): string | null {
  return ['/opt/homebrew/Caskroom/dialcatz', '/usr/local/Caskroom/dialcatz'].some(existsSync) ? 'brew uninstall --cask dialcatz' : null;
}

export function plan(): UninstallPlan {
  const tokens = servers().length;
  const home = (p: string) => p.replace(homedir(), '~');
  const b = bundle();
  if (isWin)
    return {
      items: [
        { label: 'Collections, environments, history and settings', detail: app.getPath('userData') },
        ...(tokens ? [{ label: `${tokens} DialCatz Den token${tokens === 1 ? '' : 's'}`, detail: tokenStore() }] : []),
        ...winLeftovers().map((p) => ({ label: 'Update downloads', detail: p })),
        ...(b ? [{ label: 'The app, its shortcuts and its entry in Installed apps', detail: 'its own uninstaller' }] : []),
      ],
      otherApps: otherApps(),
      brew: null,
      dev: !b,
    };
  if (isLinux) {
    const pkg = linuxPackage();
    return {
      items: [
        { label: 'Collections, environments, history and settings', detail: home(app.getPath('userData')) },
        ...(tokens ? [{ label: `${tokens} DialCatz Den token${tokens === 1 ? '' : 's'}`, detail: tokenStore() }] : []),
        ...linuxLeftovers().map((f) => ({ label: f.label, detail: home(f.path) })),
        ...(b ? [{ label: pkg ? `The app (the ${pkg} package, removed with your password)` : 'The app', detail: home(b) }] : []),
      ],
      otherApps: otherApps(),
      brew: null,
      dev: !b,
    };
  }
  return {
    items: [
      { label: 'Collections, environments, history and settings', detail: home(app.getPath('userData')) },
      ...(tokens ? [{ label: `${tokens} DialCatz Den token${tokens === 1 ? '' : 's'}`, detail: tokenStore() }] : []),
      { label: 'Caches, logs and saved window state', detail: '~/Library/Caches, Logs, Saved Application State, Preferences' },
      ...(b ? [{ label: 'The app', detail: `${home(b)} → Trash` }] : []),
    ],
    otherApps: otherApps(),
    brew: brew(),
    dev: !b,
  };
}

export async function run(removeShared: boolean): Promise<void> {
  const dry = !!process.env.DIALCATZ_UNINSTALL_DRY_RUN;
  if (dry) return;
  // Secrets first, while the app still knows its server list.
  for (const s of servers()) await deleteToken(s.id).catch(() => {});
  if (removeShared) {
    for (const p of AI_PROVIDERS) await setSharedKey(p.id, '').catch(() => {});
  }
  if (isWin) {
    const folders = [app.getPath('userData'), ...winLeftovers(), ...(removeShared && existsSync(SHARED_DIR) ? [SHARED_DIR] : [])];
    await afterQuitWin(bundle(), folders);
    setTimeout(() => app.exit(0), 300);
    return;
  }
  if (isLinux) {
    const pkg = linuxPackage();
    if (pkg) {
      const r = await runAsRootLinux(`dpkg -r ${shq(pkg)} >/dev/null`);
      if (!r.ok) console.warn('uninstall: dpkg -r:', r.message);
    }
    const b = bundle();
    const folders = [app.getPath('userData'), ...linuxLeftovers().map((f) => f.path), ...(b && !pkg ? [b] : []), ...(removeShared ? [SHARED_DIR] : [])];
    const child = spawn('/bin/sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; rm -rf ${folders.map(shq).join(' ')}`], { detached: true, stdio: 'ignore', cwd: homedir() });
    child.unref();
    setTimeout(() => app.exit(0), 300);
    return;
  }
  const remove = [...paths(), ...(removeShared ? [SHARED_DIR] : [])];
  const b = bundle();
  if (b) await shell.trashItem(b).catch(() => {});
  // After the quit (the running app keeps writing to its data folder): a detached shell waits for this process to end.
  const quoted = remove.map((p) => (p.endsWith('*') ? `"${p.slice(0, -1)}"*` : `"${p}"`)).join(' ');
  const child = spawn('/bin/sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; rm -rf ${quoted}`], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => app.exit(0), 300);
}

/**
 * Windows: a detached PowerShell (DevCatz's and DBCatz's helper) that finishes once DialCatz has quit, in a small window
 * of its own so the user sees it happen: waits for DialCatz to close, runs the NSIS uninstaller silently, removes the
 * dialcatz:// link, moves the folders to the Recycle Bin, says it is done and removes itself. Started by Task Scheduler
 * as a task of this user, not as DialCatz's child (a child went with DialCatz when it quit).
 */
async function afterQuitWin(uninstaller: string | null, folders: string[]): Promise<void> {
  const pq = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const task = `DialCatz uninstall ${Date.now()}`;
  const script = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$exe = ${pq(process.execPath)}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Win.Dpi]::SetProcessDPIAware() | Out-Null
[Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object Windows.Forms.Form
$f.Text = 'Uninstalling DialCatz'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.ClientSize = New-Object Drawing.Size(460, 254); $f.Font = New-Object Drawing.Font('Segoe UI', 9.5); $f.TopMost = $true
$f.Icon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
$title = New-Object Windows.Forms.Label; $title.Text = 'Removing DialCatz from this PC'; $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 11)
$title.SetBounds(20, 16, 420, 26); $f.Controls.Add($title)
$names = @('Waiting for DialCatz to close', 'Removing the app, its shortcuts and its entry in Installed apps', 'Moving its data and settings to the Recycle Bin')
$rows = @(); $y = 52
foreach ($n in $names) { $l = New-Object Windows.Forms.Label; $l.Text = "○  $n"; $l.ForeColor = [Drawing.Color]::Gray; $l.SetBounds(20, $y, 420, 22); $f.Controls.Add($l); $rows += $l; $y += 26 }
$bar = New-Object Windows.Forms.ProgressBar; $bar.SetBounds(20, 136, 420, 14); $bar.Maximum = $names.Count; $f.Controls.Add($bar)
$note = New-Object Windows.Forms.Label; $note.Text = 'Your exports, saved responses and workspace folders are not touched.'; $note.ForeColor = [Drawing.Color]::Gray; $note.SetBounds(20, 160, 420, 40); $f.Controls.Add($note)
$ok = New-Object Windows.Forms.Button; $ok.Text = 'Close'; $ok.SetBounds(350, 208, 90, 30); $ok.Enabled = $false; $ok.Add_Click({ $f.Close() }); $f.Controls.Add($ok)
$f.Show(); [Windows.Forms.Application]::DoEvents()
function Step($i) { if ($i -gt 0) { $rows[$i - 1].Text = '✓  ' + $names[$i - 1]; $rows[$i - 1].ForeColor = [Drawing.Color]::FromArgb(22, 128, 61) }; if ($i -lt $rows.Count) { $rows[$i].Text = '●  ' + $names[$i]; $rows[$i].ForeColor = [Drawing.SystemColors]::ControlText }; $bar.Value = $i; [Windows.Forms.Application]::DoEvents() }
function Wait($cond) { for ($i = 0; $i -lt 240 -and (& $cond); $i++) { Start-Sleep -Milliseconds 250; [Windows.Forms.Application]::DoEvents() } }
Step 0; Wait { Get-Process | Where-Object { $_.Path -eq $exe } }
Step 1
${uninstaller ? `$u = Start-Process -FilePath ${pq(uninstaller)} -ArgumentList '/S' -PassThru; Wait { -not $u.HasExited }
# The uninstaller hands over to a copy of itself in the temp folder and returns at once: wait for the app to go.
Wait { Test-Path $exe }` : ''}
# The dialcatz:// link Electron registered for this user (the uninstaller leaves it), when it still points here.
$link = 'HKCU:\Software\Classes\dialcatz'; if ((Get-ItemProperty "$link\shell\open\command").'(default)' -like "*$exe*") { Remove-Item -Recurse -Force $link }
Step 2
foreach ($p in @(${folders.map(pq).join(', ')})) { if (Test-Path $p) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { Remove-Item -Recurse -Force $p } }; [Windows.Forms.Application]::DoEvents() }
Step 3
$title.Text = 'DialCatz has been removed'
$note.Text = 'Your exports, saved responses and workspace folders are not touched. Its data is in the Recycle Bin until you empty it.'
$ok.Enabled = $true; $ok.Focus() | Out-Null
Remove-Item -Force $MyInvocation.MyCommand.Path
schtasks.exe /delete /tn ${pq(task)} /f | Out-Null
$t = New-Object Windows.Forms.Timer; $t.Interval = 30000; $t.Add_Tick({ $f.Close() }); $t.Start()
while ($f.Visible) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
`;
  const file = join(tmpdir(), `dialcatz-uninstall-${Date.now()}.ps1`);
  // UTF-8 with a byte-order mark: Windows PowerShell 5 reads a file without one as the ANSI code page (✓ ● ○).
  writeFileSync(file, `\ufeff${script.replace(/\r?\n/g, '\r\n')}`);
  const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${file}"`;
  const made = await runCode('schtasks.exe', ['/create', '/tn', task, '/tr', ps, '/sc', 'once', '/st', '00:00', '/it', '/f']);
  if (made === 0 && (await runCode('schtasks.exe', ['/run', '/tn', task])) === 0) return;
  console.warn('uninstall: schtasks failed, starting the helper directly');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
const runCode = (cmd: string, args: string[]) =>
  new Promise<number>((resolve) => execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (e) => resolve(e ? Number((e as NodeJS.ErrnoException).code) || 1 : 0)));
