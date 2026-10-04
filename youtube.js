// =====================================================================
// YouTube: login Google (OAuth, doar canalul tău) + chat live
// - identitatea și live-ul activ: YouTube Data API (cost mic de quota)
// - mesajele din chat: citite ca în pagina publică de chat (fără quota)
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const YT_API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const LIVE_CHECK_MS = 30000;

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const NAME_COLORS = ['#ff5c5c', '#ffb347', '#ffd93d', '#6bff95', '#4dd9ff', '#7a9cff', '#c78bff', '#ff7ad9'];
function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}
const runsText = runs => (runs || []).map(r => r.text != null ? r.text
  : r.emoji ? (r.emoji.isCustomEmoji ? (r.emoji.shortcuts && r.emoji.shortcuts[0]) || '' : r.emoji.emojiId || '') : '').join('');

module.exports = function createYouTube(ctx) {
  // ctx: { log, toSettings, toOverlay, getConfig, saveConfig, encrypt, decrypt, openExternal,
  //        appDir, userDataDir, port(), focusSettings, userAgent }
  let accessToken = '';
  let accessExp = 0;
  let pending = null;
  let liveTimer = null;
  let chat = null;           // { videoId, stopped }
  let live = { state: 'off', title: '', message: '' };

  const cfg = () => ctx.getConfig();
  const redirectUri = () => `http://127.0.0.1:${ctx.port()}/google-callback`;
  const userAppPath = () => path.join(ctx.userDataDir(), 'google-app.json');

  function googleApp() {
    for (const p of [path.join(ctx.appDir, 'google-app.json'), userAppPath()]) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j.clientId && j.clientSecret) return j;
      } catch {}
    }
    return null;
  }

  function getState() {
    const y = cfg().youtube;
    return {
      hasApp: !!googleApp(),
      account: y ? { name: y.name, avatar: y.avatar || '', channelId: y.channelId } : null,
      live
    };
  }
  function pushState() { ctx.toSettings('yt-state', getState()); }
  function setLive(state, extra = {}) { live = { state, title: '', message: '', ...extra }; pushState(); }

  // ---------------- OAuth ----------------
  async function tokenRequest(fields) {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`Google a refuzat (${res.status}): ${text.slice(0, 200)}`); e.status = res.status; throw e; }
    return JSON.parse(text);
  }

  async function getToken() {
    if (accessToken && Date.now() < accessExp - 60000) return accessToken;
    const gapp = googleApp();
    const y = cfg().youtube;
    const refresh = y && ctx.decrypt(y.refresh);
    if (!gapp || !refresh) throw Object.assign(new Error('Nu ești conectat cu Google.'), { status: 401 });
    const tok = await tokenRequest({ grant_type: 'refresh_token', client_id: gapp.clientId, client_secret: gapp.clientSecret, refresh_token: refresh });
    accessToken = tok.access_token;
    accessExp = Date.now() + (tok.expires_in || 3600) * 1000;
    return accessToken;
  }

  async function api(endpoint) {
    const token = await getToken();
    const res = await fetch(YT_API + endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text();
      const e = new Error(`YouTube API (${res.status}): ${text.slice(0, 200)}`); e.status = res.status; throw e;
    }
    return res.json();
  }

  function handleCallback(params) {
    const p = pending;
    if (!p) return false;
    if (params.get('state') !== p.state) { pending = null; p.reject(new Error('Răspuns de conectare invalid.')); return false; }
    if (params.get('error')) { pending = null; p.reject(new Error('Ai refuzat accesul: ' + params.get('error'))); return false; }
    const code = params.get('code');
    if (!code) return false;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(code);
    ctx.focusSettings();
    return true;
  }

  async function login() {
    const gapp = googleApp();
    if (!gapp) throw new Error('Completează întâi pașii pentru Google (Client ID și Client Secret).');
    if (pending) { pending.reject(new Error('Conectare anulată.')); pending = null; }

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const url = GOOGLE_AUTH + '?' + new URLSearchParams({
      client_id: gapp.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
      code_challenge: challenge, code_challenge_method: 'S256', state,
      access_type: 'offline', prompt: 'consent'
    });

    setLive('off', { message: 'S-a deschis pagina Google în browser. Alege contul și apasă „Continuă” / „Permite”...' });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending && pending.state === state) { pending = null; reject(new Error('Conectarea a expirat (5 minute).')); }
      }, 5 * 60 * 1000);
      pending = { state, resolve, reject, timer };
      ctx.openExternal(url);
    });

    const tok = await tokenRequest({
      grant_type: 'authorization_code', client_id: gapp.clientId, client_secret: gapp.clientSecret,
      code, code_verifier: verifier, redirect_uri: redirectUri()
    });
    accessToken = tok.access_token;
    accessExp = Date.now() + (tok.expires_in || 3600) * 1000;

    const ch = await api('/channels?part=snippet&mine=true');
    const item = ch.items && ch.items[0];
    if (!item) throw new Error('Contul Google ales nu are un canal de YouTube.');

    const c = cfg();
    c.youtube = {
      channelId: item.id,
      name: item.snippet.title,
      avatar: (item.snippet.thumbnails && (item.snippet.thumbnails.default || {}).url) || '',
      refresh: ctx.encrypt(tok.refresh_token || '')
    };
    ctx.saveConfig(c);
    ctx.log('YouTube: logat ca', item.snippet.title, item.id);
    startWatcher();
    return getState();
  }

  function logout(message) {
    stopWatcher();
    stopChat();
    const c = cfg();
    delete c.youtube;
    ctx.saveConfig(c);
    accessToken = '';
    accessExp = 0;
    setLive('off', { message: message || '' });
  }

  async function saveGoogleApp(d) {
    const clientId = String((d && d.clientId) || '').trim();
    const clientSecret = String((d && d.clientSecret) || '').trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) return { ok: false, error: 'Client ID-ul de la Google se termină cu „.apps.googleusercontent.com”. Verifică ce ai lipit.' };
    if (clientSecret.length < 8) return { ok: false, error: 'Lipește și Client Secret-ul.' };
    fs.mkdirSync(ctx.userDataDir(), { recursive: true });
    fs.writeFileSync(userAppPath(), JSON.stringify({ clientId, clientSecret }, null, 2));
    pushState();
    return { ok: true };
  }

  // ---------------- detectare live ----------------
  function startWatcher() {
    stopWatcher();
    const tick = async () => {
      if (!cfg().youtube) return;
      try {
        const r = await api('/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&maxResults=1');
        const b = r.items && r.items[0];
        if (b) {
          if (!chat || chat.videoId !== b.id) startChat(b.id, b.snippet.title);
        } else {
          if (chat) stopChat();
          if (live.state !== 'off' || !live.message) setLive('off', { message: 'Nu ești live pe YouTube acum. Verific din nou la 30 de secunde.' });
        }
      } catch (err) {
        ctx.log('YouTube verificare live', err.message);
        if (err.status === 400 || err.status === 401) { logout('Login-ul Google a expirat. Conectează-te din nou.'); return; }
        if (err.status === 403 && /quota/i.test(err.message)) setLive('error', { message: 'Limita zilnică YouTube API a fost atinsă. Reîncerc mai târziu.' });
        else setLive('error', { message: 'Nu am putut verifica live-ul YouTube: ' + err.message.slice(0, 120) });
      }
    };
    tick();
    liveTimer = setInterval(tick, LIVE_CHECK_MS);
  }
  function stopWatcher() { clearInterval(liveTimer); liveTimer = null; }

  // ---------------- chat live ----------------
  function stopChat() {
    if (chat) chat.stopped = true;
    chat = null;
  }

  const ytHeaders = () => ({
    'User-Agent': ctx.userAgent,
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Cookie': 'SOCS=CAI; CONSENT=YES+'
  });

  function parseInitialData(html) {
    const m = /(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\})\s*;\s*<\/script>/s.exec(html);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  function pickContinuation(data, html) {
    const r = data && data.contents && data.contents.liveChatRenderer;
    // preferăm „Live chat” (toate mesajele), nu „Top chat”
    try {
      const items = r.header.liveChatHeaderRenderer.viewSelector.sortFilterSubMenuRenderer.subMenuItems;
      const all = items[items.length - 1];
      const c = all.continuation.reloadContinuationData.continuation;
      if (c) return c;
    } catch {}
    try {
      const c0 = r.continuations[0];
      const cd = c0.invalidationContinuationData || c0.timedContinuationData || c0.reloadContinuationData;
      if (cd && cd.continuation) return cd.continuation;
    } catch {}
    const m = /"continuation":"([^"]+)"/.exec(html);
    return m && m[1];
  }

  async function startChat(videoId, title) {
    stopChat();
    const me = { videoId, stopped: false };
    chat = me;
    setLive('connecting', { title, message: 'Te-am găsit live! Mă conectez la chat-ul YouTube...' });
    try {
      const html = await (await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`, { headers: ytHeaders() })).text();
      const key = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
      const ver = (/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1] || '2.20250101.00.00';
      let cont = pickContinuation(parseInitialData(html), html);
      if (!key || !cont) throw new Error('Chat-ul live nu e disponibil (e dezactivat la acest live?).');

      setLive('live', { title, message: 'Chat-ul YouTube e conectat.' });
      let first = true;  // primul răspuns conține mesaje vechi – le sărim
      let errors = 0;
      while (!me.stopped) {
        let j;
        try {
          const res = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${key}&prettyPrint=false`, {
            method: 'POST',
            headers: { ...ytHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'ro' } }, continuation: cont })
          });
          j = await res.json();
          errors = 0;
        } catch (e) {
          if (++errors > 5) throw e;
          await sleep(3000);
          continue;
        }
        const lc = j && j.continuationContents && j.continuationContents.liveChatContinuation;
        if (!lc) throw new Error('Live-ul YouTube s-a încheiat sau chat-ul nu mai răspunde.');
        if (!first) for (const a of lc.actions || []) handleAction(a);
        first = false;
        const c = lc.continuations && lc.continuations[0];
        const cd = c && (c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData);
        if (!cd) throw new Error('Live-ul YouTube s-a încheiat.');
        cont = cd.continuation;
        await sleep(Math.min(Math.max(cd.timeoutMs || 2000, 1000), 6000));
      }
    } catch (err) {
      ctx.log('YouTube chat', err.message);
      if (chat === me) {
        chat = null;
        setLive('error', { title, message: err.message + ' Reîncerc automat.' });
      }
    }
  }

  function badgesOf(r) {
    const out = [];
    for (const b of r.authorBadges || []) {
      const x = b.liveChatAuthorBadgeRenderer || {};
      const t = x.icon && x.icon.iconType;
      if (t === 'OWNER') out.push({ type: 'broadcaster' });
      else if (t === 'MODERATOR') out.push({ type: 'moderator' });
      else if (t === 'VERIFIED') out.push({ type: 'verified' });
      else if (x.customThumbnail) out.push({ type: 'subscriber' });
    }
    return out;
  }

  function sendChat(r, text) {
    const name = (r.authorName && r.authorName.simpleText) || 'YouTube';
    ctx.toOverlay('yt-chat', {
      id: 'yt-' + r.id,
      content: text,
      platform: 'youtube',
      sender: { username: name, identity: { color: colorFor(name), badges: badgesOf(r) } }
    });
  }

  function handleAction(a) {
    const item = a.addChatItemAction && a.addChatItemAction.item;
    if (!item) return;
    if (item.liveChatTextMessageRenderer) {
      const r = item.liveChatTextMessageRenderer;
      const text = runsText(r.message && r.message.runs);
      if (text.trim()) sendChat(r, text);
    } else if (item.liveChatPaidMessageRenderer) {
      const r = item.liveChatPaidMessageRenderer;
      const name = (r.authorName && r.authorName.simpleText) || 'Cineva';
      const amount = (r.purchaseAmountText && r.purchaseAmountText.simpleText) || '';
      const text = runsText(r.message && r.message.runs);
      ctx.toOverlay('yt-alert', { type: 'superchat', user: name, amount, text });
      if (text.trim()) sendChat(r, `💰 ${amount} · ${text}`);
    } else if (item.liveChatMembershipItemRenderer) {
      const r = item.liveChatMembershipItemRenderer;
      const name = (r.authorName && r.authorName.simpleText) || 'Cineva';
      ctx.toOverlay('yt-alert', { type: 'member', user: name, text: runsText(r.headerSubtext && r.headerSubtext.runs) });
    } else if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
      const r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
      const h = (r.header && r.header.liveChatSponsorshipsHeaderRenderer) || {};
      const name = (h.authorName && h.authorName.simpleText) || 'Cineva';
      const n = parseInt((runsText(h.primaryText && h.primaryText.runs).match(/\d+/) || ['1'])[0], 10);
      ctx.toOverlay('yt-alert', { type: 'gift', user: name, count: n });
    }
  }

  function restore() {
    pushState();
    if (cfg().youtube) startWatcher();
  }

  return { getState, login, logout, handleCallback, saveGoogleApp, restore, hasApp: () => !!googleApp() };
};
