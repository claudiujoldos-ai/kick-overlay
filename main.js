const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, clipboard, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

// Setările rămân în același folder ca la versiunile vechi (%APPDATA%\kick-overlay)
app.setPath('userData', path.join(app.getPath('appData'), 'kick-overlay'));

// Jurnal de erori: %APPDATA%\kick-overlay\jurnal.txt
const logPath = () => path.join(app.getPath('userData'), 'jurnal.txt');
function log(...parts) {
  const line = `[${new Date().toLocaleString('ro-RO')}] ${parts.map(p => (p && p.stack) || (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' ')}\n`;
  try { fs.mkdirSync(path.dirname(logPath()), { recursive: true }); fs.appendFileSync(logPath(), line); } catch {}
}
process.on('uncaughtException', err => {
  log('EROARE', err);
  try { setStatus({ text: 'Eroare internă: ' + err.message, ok: false }); } catch {}
});
process.on('unhandledRejection', err => log('EROARE (promise)', err));

// O singură copie a aplicației (altfel se bat pe portul pentru OBS)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let autoUpdater = null; // se încarcă doar în varianta instalată (.exe)

const ICON = path.join(__dirname, 'build', 'icon.png');

// Sunetele și vocea trebuie să poată porni fără click în fereastra overlay
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// User-agent identic cu un Chrome normal, ca Kick (Cloudflare) să ne răspundă
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = CHROME_UA;

const DEFAULTS = {

  // Alerte & sunete
  volume: 0.8,
  followSound: '',
  subSound: '',
  alertDuration: 5,
  chatSound: false,

  // Chat
  messageLifetime: 30,
  maxMessages: 12,
  hideCommandMessages: false,

  // Filtre
  hiddenUsers: ['botrix', 'kickbot'],
  bannedWords: [],
  bannedMode: 'censor',          // 'censor' = ***  |  'hide' = mesajul nu apare
  highlightMentions: true,
  highlightKeywords: [],
  highlightMods: true,

  // Comenzi
  commands: [
    { trigger: '!discord', response: 'Intră pe Discord: discord.gg/exemplu' },
    { trigger: '!social', response: 'TikTok & Instagram: @numele_tau' }
  ],
  commandCooldown: 30,

  // Voce (TTS)
  ttsEnabled: false,
  ttsMode: 'command',            // 'command' | 'subs' | 'all'
  ttsCommand: '!tts',
  ttsReadAlerts: true,
  ttsVoice: '',
  ttsRate: 1,
  ttsVolume: 1,
  ttsMaxLength: 200,

  // Statistici
  showStats: true,

  // Aspect
  overlayWidth: 380,
  fontSize: 17,
  opacity: 0.55,
  topPercent: 22,
  bottomPercent: 38,             // chat-ul se oprește deasupra hărții din GTA (Senora Way)
  accentColor: '#53fc18',

  // Video pe stream (OBS Browser Source)
  subVideo: '',
  giftVideo: '',
  followVideo: '',
  streamVideoVolume: 1,
  streamVideoSize: 100,
  streamShowText: true,
  streamPort: 17777,

  // Muzică pe live (OBS WebSocket)
  obsEnabled: false,
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsPassword: '',
  musicSource: '',
  musicIndicator: true,

  // Tehnic
  pusherKey: '32cbd69e4b950bf97679',
  pusherCluster: 'us2'
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  const c = { ...DEFAULTS, ...saved };
  if (saved.alertDuration === 6) c.alertDuration = 5; // vechea valoare implicită -> 5 secunde
  for (const k of ['hiddenUsers', 'bannedWords', 'highlightKeywords', 'commands']) {
    if (!Array.isArray(c[k])) c[k] = DEFAULTS[k];
  }
  return c;
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

let config;
let settingsWin = null;
let overlayWin = null;
let overlayReady;
let channelInfo = null;
let lastStatus = { text: 'Neconectat', ok: false };
let lastStats = null;
let lastObs = { state: 'off', message: '', inputs: [], muted: null, source: '' };

const toSettings = (ch, data) => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(ch, data);
};
const toOverlay = (ch, ...args) => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(ch, ...args);
};
function setStatus(s) { lastStatus = s; log('Status:', s.text); toSettings('status', s); }

// Configurația fără datele de login (tokenurile nu ajung niciodată în ferestre)
function safeConfig() {
  const { auth, channel, youtube, ...rest } = config;
  return rest;
}

function overlayPayload() {
  const toUrl = p => (p && fs.existsSync(p) ? pathToFileURL(p).href : '');
  return {
    ...safeConfig(),
    ...(channelInfo || {}),
    followSoundUrl: toUrl(config.followSound),
    subSoundUrl: toUrl(config.subSound)
  };
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true); // click-urile trec prin overlay, în joc
  overlayReady = new Promise(res => overlayWin.webContents.once('did-finish-load', res));
  overlayWin.loadFile('overlay.html');
  overlayWin.webContents.on('preload-error', (_e, p, err) => log('Preload overlay', err));
  overlayReady.then(() => toOverlay('config', overlayPayload()));

  // Unele jocuri "fură" poziția de sus; o reafirmăm periodic și ne asigurăm că rămâne click-through
  setInterval(() => {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
      overlayWin.setIgnoreMouseEvents(true);
    }
  }, 3000);
}

// Ecranul de pornire (splash) cu logo-ul LiveLayer
let splashWin = null;
function createSplash() {
  splashWin = new BrowserWindow({
    width: 460, height: 320, frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, center: true, show: true, icon: ICON,
    webPreferences: { contextIsolation: true }
  });
  splashWin.loadFile('splash.html', { query: { v: app.getVersion() } });
  splashWin.on('closed', () => { splashWin = null; });
}

function createSettings() {
  const started = Date.now();
  settingsWin = new BrowserWindow({
    width: 1060, height: 780, minWidth: 900, minHeight: 620, show: false,
    title: 'LiveLayer', backgroundColor: '#07080c', autoHideMenuBar: true, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  // arată fereastra principală după splash (minim ~1.8 secunde)
  let shown = false;
  const reveal = () => {
    if (shown || !settingsWin || settingsWin.isDestroyed()) return;
    shown = true;
    setTimeout(() => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.show();
      if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    }, Math.max(0, 1800 - (Date.now() - started)));
  };
  settingsWin.once('ready-to-show', reveal);
  setTimeout(reveal, 6000); // plasă de siguranță
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => app.quit());
  // F12 deschide consola de erori (pentru depanare)
  settingsWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') settingsWin.webContents.toggleDevTools();
  });
  settingsWin.webContents.on('preload-error', (_e, p, err) => log('Preload setări', err));
}

// =====================================================================
// Server local pentru OBS: alertele video apar doar pe stream
// =====================================================================
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.gif': 'image/gif'
};
const sseClients = new Set();
let streamServerError = '';

const streamUrl = () => `http://localhost:${config.streamPort || 17777}/alerts`;

function streamInfo() {
  return { url: streamUrl(), clients: sseClients.size, error: streamServerError };
}
function notifyStreamInfo() { toSettings('stream-info', streamInfo()); }

function sseSend(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of sseClients) sseSend(res, event, data); }

function serveFile(req, res, file) {
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = Math.min(range[2] ? parseInt(range[2], 10) : size - 1, size - 1);
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

function startStreamServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/' || u.pathname === '/alerts') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      fs.createReadStream(path.join(__dirname, 'stream-alerts.html')).pipe(res);
      return;
    }
    if (u.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      notifyStreamInfo();
      req.on('close', () => { sseClients.delete(res); notifyStreamInfo(); });
      return;
    }
    if (u.pathname === '/google-callback') {
      const ok = yt.handleCallback(u.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPage(ok, 'Google / YouTube'));
      return;
    }
    if (u.pathname === '/callback') {
      const ok = handleAuthCallback(u.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPage(ok));
      return;
    }
    const m = u.pathname.match(/^\/media\/(follow|sub|gift)$/);
    if (m) return serveFile(req, res, videoFor(m[1]));
    res.writeHead(404); res.end();
  });
  server.on('error', err => {
    streamServerError = err.code === 'EADDRINUSE'
      ? `Portul ${config.streamPort} e ocupat (aplicația e deja pornită de 2 ori?)`
      : err.message;
    notifyStreamInfo();
  });
  server.listen(config.streamPort || 17777, '127.0.0.1');
  setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 20000);
}

function videoFor(type) {
  const p = type === 'gift' ? (config.giftVideo || config.subVideo) : config[type + 'Video'];
  return p && fs.existsSync(p) ? p : '';
}

function streamAlert(a) {
  const file = videoFor(a.type);
  if (!file) return;
  broadcast('alert', {
    ...a,
    video: `/media/${a.type}?v=${fs.statSync(file).mtimeMs}`,
    isImage: path.extname(file).toLowerCase() === '.gif',
    volume: config.streamVideoVolume ?? 1,
    size: config.streamVideoSize || 100,
    showText: !!config.streamShowText,
    accent: config.accentColor || '#53fc18'
  });
}

// =====================================================================
// Actualizări automate (din GitHub Releases)
// =====================================================================
let updateState = { state: 'idle' };
function setUpdate(s) { updateState = s; toSettings('update', s); }

function cleanNotes(n) {
  if (Array.isArray(n)) n = n.map(x => x.note || '').join('\n');
  return String(n || '').replace(/<[^>]+>/g, '').trim().slice(0, 800);
}

function initUpdater() {
  if (app.isPackaged) {
    try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log('electron-updater indisponibil', e); }
  }
  if (!autoUpdater || !app.isPackaged) {
    setUpdate({ state: 'dev' });
    return;
  }
  autoUpdater.autoDownload = false;          // descarcă doar când apeși butonul
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', i => setUpdate({ state: 'available', version: i.version, notes: cleanNotes(i.releaseNotes) }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }));
  autoUpdater.on('download-progress', p => setUpdate({ ...updateState, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', i => {
    setUpdate({ state: 'ready', version: i.version });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500); // instalează și repornește singur
  });
  autoUpdater.on('error', e => setUpdate({ state: 'error', message: (e && e.message || String(e)).split('\n')[0] }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 2 * 60 * 60 * 1000); // la fiecare 2 ore
}

// Deschide adresa ca un browser invizibil (trece de verificarea Cloudflare) și citește JSON-ul
async function loadJson(url, seconds = 20) {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  let httpCode = 0;
  win.webContents.on('did-navigate', (_e, _u, code) => { httpCode = code || httpCode; });
  try {
    await win.loadURL(url, { userAgent: CHROME_UA }).catch(() => {});
    for (let i = 0; i < seconds; i++) {
      const text = await win.webContents
        .executeJavaScript('document.body ? document.body.innerText : ""')
        .catch(() => '');
      try { return { json: JSON.parse(text), httpCode }; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    const title = await win.webContents.executeJavaScript('document.title').catch(() => '');
    return { json: null, httpCode, title };
  } finally {
    win.destroy();
  }
}

async function fetchChannel(slug) {
  const s = encodeURIComponent(slug);
  let last = null;
  for (const url of [`https://kick.com/api/v2/channels/${s}`, `https://kick.com/api/v1/channels/${s}`]) {
    const r = await loadJson(url);
    last = r;
    log('Kick API', url, 'cod', r.httpCode, r.json ? 'JSON ok' : `fără JSON (${r.title || ''})`);
    const j = r.json;
    if (j && j.id && j.chatroom && j.chatroom.id) {
      return { channelId: j.id, chatroomId: j.chatroom.id, username: (j.user && j.user.username) || slug };
    }
    if (r.httpCode === 404) throw new Error(`Canalul „${slug}” nu există pe Kick. Verifică numele.`);
  }
  const why = last && last.httpCode ? ` (cod ${last.httpCode}${last.title ? ', ' + last.title : ''})` : '';
  throw new Error(`Kick a blocat sau nu a răspuns la căutarea canalului${why}. Încearcă din nou peste un minut.`);
}

// ---------------- YouTube (vezi youtube.js) ----------------
const yt = require('./youtube.js')({
  log,
  toSettings: (ch, d) => toSettings(ch, d),
  toOverlay: (ch, d) => toOverlay(ch, d),
  getConfig: () => config,
  saveConfig: c => { config = c; saveConfig(c); },
  encrypt: s => encrypt(s),
  decrypt: s => decrypt(s),
  openExternal: url => shell.openExternal(url),
  appDir: __dirname,
  userDataDir: () => app.getPath('userData'),
  port: () => config.streamPort || 17777,
  focusSettings: () => { if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); } },
  userAgent: CHROME_UA
});

// Se apelează DOAR cu canalul contului logat (vezi loginWithKick / restoreLogin)
async function connectChannel(slug) {
  setStatus({ text: `Mă conectez la canalul tău (${slug})...`, ok: false });
  channelInfo = await fetchChannel(slug);
  await overlayReady;
  toOverlay('connect', overlayPayload());
  return channelInfo;
}

// =====================================================================
// Login oficial Kick (OAuth 2.1 + PKCE) – te conectezi doar la contul tău
// =====================================================================
const KICK_AUTH = 'https://id.kick.com/oauth/authorize';
const KICK_TOKEN = 'https://id.kick.com/oauth/token';
const KICK_API = 'https://api.kick.com/public/v1';
const redirectUri = () => `http://localhost:${config.streamPort || 17777}/callback`;
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let pendingAuth = null;
let accessToken = '';

// Datele aplicației Kick: întâi cele incluse în .exe, apoi cele introduse din aplicație
const userKickAppPath = () => path.join(app.getPath('userData'), 'kick-app.json');
function kickApp() {
  for (const p of [path.join(__dirname, 'kick-app.json'), userKickAppPath()]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.clientId && j.clientSecret && !/PUNE_AICI/.test(j.clientId + j.clientSecret)) return j;
    } catch {}
  }
  return null;
}

function encrypt(s) {
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64'); } catch {}
  return 'raw:' + Buffer.from(s).toString('base64');
}
function decrypt(s) {
  if (!s) return '';
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString();
  } catch {}
  return '';
}

function publicAuth() {
  return config.auth ? { name: config.auth.name, slug: config.auth.slug, avatar: config.auth.avatar || '' } : null;
}

function callbackPage(ok, who = 'Kick') {
  const msg = ok ? `Te-ai conectat cu ${who}! Poți închide acest tab și te întorci în aplicație.`
                 : 'Conectarea nu a reușit sau a expirat. Întoarce-te în aplicație și încearcă din nou.';
  return `<!doctype html><meta charset="utf-8"><title>LiveLayer</title>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:#07080c;color:#fff;font:18px Segoe UI,sans-serif">
  <div style="text-align:center;padding:30px 40px;border-radius:16px;background:#131821;border:1px solid ${ok ? '#53fc18' : '#ff3b5c'}">
  <div style="font-size:48px">${ok ? '✅' : '⚠️'}</div><p>${msg}</p></div></body>`;
}

function handleAuthCallback(params) {
  const p = pendingAuth;
  if (!p) return false;
  if (params.get('state') !== p.state) { p.reject(new Error('Răspuns de conectare invalid. Încearcă din nou.')); pendingAuth = null; return false; }
  if (params.get('error')) { p.reject(new Error('Ai refuzat accesul sau Kick a dat o eroare: ' + params.get('error'))); pendingAuth = null; return false; }
  const code = params.get('code');
  if (!code) return false;
  pendingAuth = null;
  clearTimeout(p.timer);
  p.resolve(code);
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); }
  return true;
}

async function tokenRequest(fields) {
  const res = await fetch(KICK_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`Kick a refuzat (${res.status}): ${text.slice(0, 200)}`); e.status = res.status; throw e; }
  return JSON.parse(text);
}

async function kickGet(endpoint) {
  const res = await fetch(KICK_API + endpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) { const e = new Error(`Kick API ${endpoint}: ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// Află din contul logat care e canalul lui – singurul la care ne conectăm
async function saveTokensAndIdentify(tok) {
  accessToken = tok.access_token;
  const ch = await kickGet('/channels');
  const channel = ch && ch.data && ch.data[0];
  if (!channel || !channel.slug) throw new Error('Nu am găsit canalul contului tău de Kick.');
  let name = channel.slug, avatar = '';
  try {
    const u = await kickGet('/users');
    const user = u && u.data && u.data[0];
    if (user) { name = user.name || name; avatar = user.profile_picture || ''; }
  } catch {}
  config.auth = {
    slug: channel.slug,
    userId: channel.broadcaster_user_id,
    name, avatar,
    refresh: encrypt(tok.refresh_token || (config.auth && decrypt(config.auth.refresh)) || '')
  };
  delete config.channel; // nu mai folosim nume scrise de mână
  saveConfig(config);
  toSettings('auth', publicAuth());
  return config.auth.slug;
}

async function loginWithKick() {
  const kapp = kickApp();
  if (!kapp) throw new Error('Lipsește fișierul kick-app.json (Client ID + Client Secret). Vezi CONECTARE-KICK.md.');
  if (streamServerError) throw new Error('Serverul local nu merge: ' + streamServerError);
  if (pendingAuth) { pendingAuth.reject(new Error('Conectare anulată.')); pendingAuth = null; }

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const url = KICK_AUTH + '?' + new URLSearchParams({
    response_type: 'code', client_id: kapp.clientId, redirect_uri: redirectUri(),
    scope: 'user:read channel:read', code_challenge: challenge, code_challenge_method: 'S256', state
  });

  setStatus({ text: 'S-a deschis pagina Kick în browser. Loghează-te și apasă „Allow / Permite”...', ok: false });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingAuth && pendingAuth.state === state) { pendingAuth = null; reject(new Error('Conectarea a expirat (5 minute). Încearcă din nou.')); }
    }, 5 * 60 * 1000);
    pendingAuth = { state, resolve, reject, timer };
    shell.openExternal(url);
  });

  setStatus({ text: 'Verific contul...', ok: false });
  const tok = await tokenRequest({
    grant_type: 'authorization_code', client_id: kapp.clientId, client_secret: kapp.clientSecret,
    redirect_uri: redirectUri(), code_verifier: verifier, code
  });
  const slug = await saveTokensAndIdentify(tok);
  log('Logat ca', config.auth.name, '/', slug);
  return connectChannel(slug);
}

// La pornire: reînnoiește login-ul salvat și reconfirmă canalul din contul tău
async function restoreLogin() {
  if (!config.auth) {
    setStatus({ text: 'Apasă „Conectează-te cu Kick” ca să-ți legi contul.', ok: false });
    return;
  }
  const kapp = kickApp();
  const refresh = decrypt(config.auth.refresh);
  if (!kapp || !refresh) { logout('Te rog conectează-te din nou cu Kick.'); return; }
  try {
    setStatus({ text: 'Verific login-ul Kick...', ok: false });
    const tok = await tokenRequest({ grant_type: 'refresh_token', client_id: kapp.clientId, client_secret: kapp.clientSecret, refresh_token: refresh });
    const slug = await saveTokensAndIdentify(tok);
    await connectChannel(slug);
  } catch (err) {
    log('Restaurare login eșuată', err);
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      logout('Login-ul Kick a expirat. Apasă „Conectează-te cu Kick” din nou.');
    } else {
      // fără internet / Kick picat: folosim canalul confirmat la ultimul login (tot al tău)
      setStatus({ text: 'Nu am putut verifica login-ul acum, reîncerc conectarea...', ok: false });
      connectChannel(config.auth.slug).catch(e => setStatus({ text: e.message, ok: false }));
    }
  }
}

function logout(message) {
  delete config.auth;
  delete config.channel;
  accessToken = '';
  channelInfo = null;
  saveConfig(config);
  toOverlay('disconnect');
  toSettings('auth', null);
  setStatus({ text: message || 'Te-ai deconectat.', ok: false });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  log(`=== Pornire LiveLayer v${app.getVersion()} (Electron ${process.versions.electron}) ===`);
  config = loadConfig();
  ipcMain.on('open-log', () => { log('Jurnal deschis'); shell.openPath(logPath()); });
  ipcMain.on('renderer-error', (_e, msg) => log('Eroare în fereastră:', msg));
  createSplash();
  createOverlay();
  createSettings();
  startStreamServer();
  initUpdater();

  app.on('second-instance', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.focus();
    }
  });

  ipcMain.handle('get-state', () => ({
    config: safeConfig(), status: lastStatus, stats: lastStats, stream: streamInfo(),
    version: app.getVersion(), update: updateState, auth: publicAuth(), hasKickApp: !!kickApp(),
    redirectUri: redirectUri(), yt: yt.getState(), obs: lastObs
  }));
  ipcMain.handle('login', async () => {
    try { await loginWithKick(); return { ok: true }; }
    catch (err) { log('Login eșuat', err); setStatus({ text: err.message, ok: false }); return { ok: false, error: err.message }; }
  });
  ipcMain.on('logout', () => logout());
  ipcMain.handle('yt-login', async () => {
    try { await yt.login(); return { ok: true }; }
    catch (err) { log('YouTube login eșuat', err); return { ok: false, error: err.message }; }
  });
  ipcMain.on('yt-logout', () => yt.logout('Te-ai deconectat de la YouTube.'));
  ipcMain.handle('save-google-app', (_e, d) => yt.saveGoogleApp(d));
  ipcMain.handle('save-kick-app', (_e, d) => {
    const clientId = String((d && d.clientId) || '').trim();
    const clientSecret = String((d && d.clientSecret) || '').trim();
    if (clientId.length < 8 || clientSecret.length < 8) return { ok: false, error: 'Lipește atât Client ID cât și Client Secret.' };
    fs.mkdirSync(path.dirname(userKickAppPath()), { recursive: true });
    fs.writeFileSync(userKickAppPath(), JSON.stringify({ clientId, clientSecret }, null, 2));
    log('Date aplicație Kick salvate');
    setStatus({ text: 'Gata! Acum apasă „Conectează-te cu Kick”.', ok: true });
    return { ok: true };
  });
  ipcMain.on('open-url', (_e, url) => {
    // doar linkuri sigure, cunoscute
    if (/^https:\/\/(kick\.com|obsproject\.com|console\.cloud\.google\.com|github\.com\/claudiujoldos-ai)\//.test(String(url))) shell.openExternal(url);
  });
  ipcMain.on('update-check', () => {
    if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
    else setUpdate({ state: 'dev' });
  });
  ipcMain.on('update-download', () => {
    if (!autoUpdater || !app.isPackaged) return;
    setUpdate({ ...updateState, state: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate().catch(e => setUpdate({ state: 'error', message: e.message }));
  });

  ipcMain.handle('pick-video', async () => {
    const r = await dialog.showOpenDialog(settingsWin, {
      title: 'Alege un video pentru stream',
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'gif'] }],
      properties: ['openFile']
    });
    return r.canceled ? '' : r.filePaths[0];
  });
  ipcMain.on('stream-alert', (_e, a) => streamAlert(a));
  ipcMain.on('stream-test', (_e, type) => {
    const titles = { follow: 'TestUser te urmărește!', sub: 'TestUser s-a abonat!', gift: 'TestUser a dăruit 5 sub-uri!' };
    streamAlert({ type, title: titles[type] || 'Test', subtitle: '' });
  });
  ipcMain.on('copy-text', (_e, t) => clipboard.writeText(String(t)));

  ipcMain.handle('save-config', (_e, partial) => {
    const { auth, channel, youtube, ...allowed } = partial || {}; // conturile nu se pot schimba din setări
    config = { ...config, ...allowed };
    saveConfig(config);
    toOverlay('config', overlayPayload());
    return safeConfig();
  });

  ipcMain.handle('pick-sound', async () => {
    const r = await dialog.showOpenDialog(settingsWin, {
      title: 'Alege un sunet',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
      properties: ['openFile']
    });
    return r.canceled ? '' : r.filePaths[0];
  });

  ipcMain.on('test', (_e, type, payload) => toOverlay('test', type, payload));
  ipcMain.on('reset-stats', () => toOverlay('reset-stats'));
  ipcMain.on('status', (_e, s) => setStatus(s));
  ipcMain.on('obs-status', (_e, s) => { lastObs = s; toSettings('obs-status', s); });
  ipcMain.on('obs-cmd', (_e, c) => toOverlay('obs-cmd', c));
  ipcMain.on('obs-set-source', (_e, name) => {
    config.musicSource = String(name || '');
    saveConfig(config);
    toOverlay('config', overlayPayload());
    toSettings('config-changed', { musicSource: config.musicSource });
  });
  ipcMain.on('stats', (_e, s) => { lastStats = s; toSettings('stats', s); });

  // Scurtături care merg și din joc
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    overlayWin.isVisible() ? overlayWin.hide() : overlayWin.showInactive();
  });
  globalShortcut.register('CommandOrControl+Shift+L', () => toOverlay('clear'));
  globalShortcut.register('CommandOrControl+Shift+S', () => toOverlay('tts-skip'));
  globalShortcut.register('CommandOrControl+Shift+M', () => toOverlay('obs-cmd', { type: 'toggle' }));

  setTimeout(() => restoreLogin().catch(err => setStatus({ text: err.message, ok: false })), 500);
  setTimeout(() => yt.restore(), 800);
}).catch(err => {
  log('EROARE la pornire', err);
  dialog.showErrorBox('LiveLayer – eroare la pornire', String((err && err.stack) || err));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
