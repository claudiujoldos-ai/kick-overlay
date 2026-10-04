const $ = id => document.getElementById(id);
const chatEl = $('chat');
const alertEl = $('alert');
const statsEl = $('stats');

let cfg = {};
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 3000;
let bannedRe = null;

const seenMessages = new Set();
const recentEvents = new Map();       // dedup alerte (aceleași evenimente vin pe mai multe canale)
const followedThisSession = new Set();
const cmdCooldown = new Map();

const stats = { startedAt: null, followers: 0, subs: 0, gifts: 0, messages: 0, lastFollower: '', lastSub: '' };

// =====================================================================
// Config & stil
// =====================================================================
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applyConfig() {
  const r = document.documentElement.style;
  r.setProperty('--w', (cfg.overlayWidth || 380) + 'px');
  r.setProperty('--fs', (cfg.fontSize || 17) + 'px');
  r.setProperty('--op', cfg.opacity ?? 0.55);
  r.setProperty('--top', (cfg.topPercent ?? 22) + '%');
  r.setProperty('--bottom', (cfg.bottomPercent ?? 38) + '%');
  r.setProperty('--neon', cfg.accentColor || '#53fc18');
  statsEl.style.display = cfg.showStats ? '' : 'none';

  const words = (cfg.bannedWords || []).map(w => w.trim()).filter(Boolean);
  bannedRe = words.length ? new RegExp(words.map(escRe).join('|'), 'gi') : null;
  if (window.LiveLayerOBS) window.LiveLayerOBS.applyConfig(cfg);
}

// Mesaj scurt în mijlocul ecranului (ex: la Ctrl+Shift+M)
let toastTimer = null;
window.LiveLayerToast = text => {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
};
window.api.on('obs-cmd', c => window.LiveLayerOBS && window.LiveLayerOBS.command(c));

function status(text, ok = false) { window.api.send('status', { text, ok }); }

// =====================================================================
// Conexiune Kick (websocket Pusher)
// =====================================================================
function connect() {
  if (!cfg.chatroomId) return;
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  clearTimeout(reconnectTimer);

  const url = `wss://ws-${cfg.pusherCluster}.pusher.com/app/${cfg.pusherKey}?protocol=7&client=js&version=8.4.0&flash=false`;
  status('Mă conectez la chat...');
  ws = new WebSocket(url);

  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    status(`Conexiune pierdută, reîncerc în ${Math.round(reconnectDelay / 1000)}s...`);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  };
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function isDuplicate(key, ms = 10000) {
  const now = Date.now();
  for (const [k, t] of recentEvents) if (now - t > ms) recentEvents.delete(k);
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, now);
  return false;
}

function handle(msg, isTest = false) {
  let data = msg.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
  data = data || {};
  const ev = msg.event || '';

  if (ev === 'pusher:connection_established') {
    reconnectDelay = 3000;
    [`chatrooms.${cfg.chatroomId}.v2`, `chatroom_${cfg.chatroomId}`, `channel.${cfg.channelId}`, `channel_${cfg.channelId}`]
      .forEach(ch => send({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
    if (!stats.startedAt) { stats.startedAt = Date.now(); pushStats(); }
    status(`Conectat la ${cfg.username}`, true);
    return;
  }
  if (ev === 'pusher:ping') { send({ event: 'pusher:pong', data: {} }); return; }

  const name = ev.split('\\').pop();   // App\Events\ChatMessageEvent -> ChatMessageEvent

  switch (name) {
    case 'ChatMessageEvent':
      addChat(data, isTest);
      break;

    case 'SubscriptionEvent':
    case 'ChannelSubscriptionEvent': {
      const user = data.username || (data.user && data.user.username) || 'Cineva';
      if (isDuplicate('sub:' + user)) return;
      const months = data.months || 1;
      if (!isTest) { stats.subs++; stats.lastSub = user; pushStats('subs'); }
      showAlert({ type: 'sub', icon: '⭐', label: 'SUB NOU', title: user,
        subtitle: months > 1 ? `s-a abonat din nou · ${months} luni la rând!` : 'tocmai s-a abonat! Mulțumesc!',
        speech: `${user} s-a abonat! Mulțumesc!` });
      break;
    }

    case 'GiftedSubscriptionsEvent': {
      const gifter = data.gifter_username || 'Cineva';
      const n = (data.gifted_usernames && data.gifted_usernames.length) || 1;
      if (isDuplicate(`gift:${gifter}:${n}`)) return;
      if (!isTest) { stats.subs += n; stats.gifts += n; stats.lastSub = `${gifter} (🎁 ${n})`; pushStats('subs'); }
      showAlert({ type: 'gift', icon: '🎁', label: 'SUB-URI CADOU', title: gifter,
        subtitle: `a dăruit ${n} sub${n > 1 ? '-uri' : ''} comunității!`,
        speech: `${gifter} a dăruit ${n} ${n > 1 ? 'sub-uri' : 'sub'}! Mulțumesc frumos!` });
      break;
    }

    case 'FollowersUpdated':
    case 'ChannelFollowed':
    case 'FollowEvent': {
      if (data.followed === false) return; // unfollow
      const user = data.username || (data.follower && data.follower.username) || '';
      if (user) {
        if (followedThisSession.has(user)) return; // anti spam follow/unfollow
        followedThisSession.add(user);
      } else if (isDuplicate('follow-anon', 2000)) return;
      if (!isTest) { stats.followers++; stats.lastFollower = user || 'anonim'; pushStats('followers'); }
      showAlert({ type: 'follow', icon: '💚', label: 'FOLLOW NOU', title: user || 'Follower nou!',
        subtitle: 'bine ai venit în comunitate!',
        speech: user ? `${user} te urmărește acum!` : 'Ai un follower nou!' });
      break;
    }
  }
}

// =====================================================================
// Statistici
// =====================================================================
function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function renderStats(popKey) {
  statsEl.querySelectorAll('[data-s]').forEach(el => {
    const k = el.dataset.s;
    if (k === 'lastFollower' || k === 'lastSub') {
      el.innerHTML = stats[k] ? escapeHtml(stats[k])
        : `<em>${k === 'lastFollower' ? 'niciun follower încă' : 'niciun sub încă'}</em>`;
    } else {
      el.textContent = stats[k];
      if (k === popKey) { el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 350); }
    }
  });
}

function pushStats(popKey) {
  renderStats(popKey);
  window.api.send('stats', { ...stats });
}

setInterval(() => {
  if (stats.startedAt) $('timer').textContent = fmtTime(Date.now() - stats.startedAt);
}, 1000);

// =====================================================================
// Chat
// =====================================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderContent(text) {
  return escapeHtml(text).replace(/\[emote:(\d+):([^\]]*)\]/g,
    (_m, id, nm) => `<img class="emote" src="https://files.kick.com/emotes/${id}/fullsize" alt="${nm}">`);
}

const BADGES = {
  broadcaster: '👑', moderator: '🗡️', vip: '💎', og: '🔥', founder: '🏆',
  subscriber: '⭐', verified: '✔️', staff: '🛠️', sub_gifter: '🎁'
};

function safeColor(c) { return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : (cfg.accentColor || '#53fc18'); }

function pushMessage(el, lifetimeSec) {
  chatEl.appendChild(el);
  while (chatEl.children.length > (cfg.maxMessages || 12)) chatEl.firstElementChild.remove();
  const life = Number(lifetimeSec) || 0;
  if (life > 0) {
    setTimeout(() => el.classList.add('out'), life * 1000);
    setTimeout(() => el.remove(), life * 1000 + 900);
  }
}

function addChat(data, isTest = false) {
  if (!data || !data.content) return;
  if (data.id) {
    if (seenMessages.has(data.id)) return;
    seenMessages.add(data.id);
    if (seenMessages.size > 500) seenMessages.delete(seenMessages.values().next().value);
  }

  const sender = data.sender || {};
  const user = sender.username || '???';
  const lowerUser = user.toLowerCase();

  // 1. utilizatori ascunși (boți)
  if ((cfg.hiddenUsers || []).some(u => u.trim().toLowerCase() === lowerUser)) return;

  let text = String(data.content);
  const badges = ((sender.identity && sender.identity.badges) || []).map(b => b.type);

  // 2. comenzi
  const isCommand = text.trim().startsWith('!') && handleCommand(user, text);
  if (text.trim().startsWith('!') && cfg.hideCommandMessages) return;

  // 3. cuvinte interzise
  if (bannedRe) {
    const censored = text.replace(bannedRe, m => '*'.repeat(m.length));
    if (censored !== text) {
      if (cfg.bannedMode === 'hide') return;
      text = censored;
    }
  }

  // 4. evidențieri
  const lower = text.toLowerCase();
  const me = (cfg.username || cfg.channel || '').toLowerCase();
  const mention = cfg.highlightMentions && (
    (me && lower.includes('@' + me)) ||
    (cfg.highlightKeywords || []).some(k => k.trim() && lower.includes(k.trim().toLowerCase()))
  );
  const isHost = badges.includes('broadcaster');
  const isMod = badges.includes('moderator');

  const el = document.createElement('div');
  el.className = 'msg' + (mention ? ' mention' : '') + (isHost ? ' host' : (isMod && cfg.highlightMods ? ' mod' : ''));
  const color = safeColor(sender.identity && sender.identity.color);
  if (!isHost) el.style.setProperty('--c', color);
  const platHtml = data.platform === 'youtube' ? '<span class="plat yt" title="YouTube">▶</span>' : '';
  const badgeHtml = platHtml + badges.filter(b => BADGES[b]).map(b => `<span class="badge">${BADGES[b]}</span>`).join('');
  el.innerHTML = `${badgeHtml}<span class="name">${escapeHtml(user)}</span>${renderContent(text)}`;
  pushMessage(el, cfg.messageLifetime);

  if (!isTest) { stats.messages++; pushStats(); }
  if (cfg.chatSound) playSynth('chat');

  // 5. voce
  if (cfg.ttsEnabled && !isCommand) {
    const isSub = badges.some(b => ['subscriber', 'founder', 'og'].includes(b));
    if (cfg.ttsMode === 'all' || (cfg.ttsMode === 'subs' && isSub)) {
      const t = cleanForTts(text);
      if (t) speak(`${user} spune: ${t}`);
    }
  }
}

// Returnează true dacă mesajul a fost tratat ca o comandă
function handleCommand(user, text) {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/)[0].toLowerCase();

  // !tts
  const ttsCmd = (cfg.ttsCommand || '!tts').toLowerCase();
  if (first === ttsCmd) {
    if (cfg.ttsEnabled && cfg.ttsMode === 'command') {
      const rest = cleanForTts(trimmed.slice(first.length));
      if (rest) speak(`${user} spune: ${rest}`);
    }
    return true;
  }

  const cmd = (cfg.commands || []).find(c => c.trigger && c.trigger.toLowerCase() === first);
  if (!cmd) return false;

  const cd = (Number(cfg.commandCooldown) || 0) * 1000;
  const last = cmdCooldown.get(first) || 0;
  if (Date.now() - last < cd) return true;
  cmdCooldown.set(first, Date.now());
  showCommandCard(cmd, user);
  return true;
}

function showCommandCard(cmd, user) {
  const el = document.createElement('div');
  el.className = 'msg cmd';
  const response = String(cmd.response || '').replace(/\{user\}/gi, user);
  el.innerHTML = `<span class="cmd-tag">${escapeHtml(cmd.trigger)}</span>${renderContent(response)}` +
    `<span class="cmd-by">cerut de ${escapeHtml(user)}</span>`;
  pushMessage(el, Math.max(Number(cfg.messageLifetime) || 0, 20));
}

// =====================================================================
// Alerte
// =====================================================================
const alertQueue = [];
let alertBusy = false;

function showAlert(a) {
  // video-ul pentru stream (OBS) – nu apare pe ecranul tău
  window.api.send('stream-alert', { type: a.type, label: a.label, title: a.title, subtitle: a.subtitle });
  alertQueue.push(a);
  if (!alertBusy) nextAlert();
}

function nextAlert() {
  const a = alertQueue.shift();
  if (!a) { alertBusy = false; return; }
  alertBusy = true;
  const dur = Math.max(2, Number(cfg.alertDuration) || 5);

  alertEl.className = a.type;
  alertEl.style.setProperty('--dur', dur + 's');
  alertEl.querySelector('.al-icon').textContent = a.icon;
  alertEl.querySelector('.al-label').textContent = a.label;
  alertEl.querySelector('.al-title').textContent = a.title;
  alertEl.querySelector('.al-sub').textContent = a.subtitle || '';
  void alertEl.offsetWidth; // repornește animațiile
  alertEl.classList.add('show');

  const colors = {
    follow: [cfg.accentColor || '#53fc18', '#ffffff', '#00e5ff'],
    sub: ['#ffc83d', '#fff1a8', '#ff8a00', '#ffffff'],
    gift: ['#ff3df2', '#00e5ff', '#ffc83d', '#ffffff']
  }[a.type];
  playSound(a.type === 'gift' ? 'sub' : a.type);
  if (cfg.ttsEnabled && cfg.ttsReadAlerts && a.speech) setTimeout(() => speak(a.speech), 900);

  setTimeout(() => {
    alertEl.classList.remove('show');
    setTimeout(nextAlert, 600);
  }, dur * 1000);
}

// ---------- confetti ----------
const fx = $('fx');
const fxCtx = fx.getContext('2d');
let particles = [];
let fxRunning = false;

function burst(colors, count) {
  fx.width = innerWidth; fx.height = innerHeight;
  const r = alertEl.getBoundingClientRect();
  const cx = innerWidth / 2;
  const cy = r.height ? r.top + r.height / 2 : innerHeight * 0.1;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 4 + Math.random() * 10;
    particles.push({
      x: cx + (Math.random() - .5) * 200, y: cy,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5,
      life: 1, decay: .008 + Math.random() * .01,
      c: colors[i % colors.length], s: 4 + Math.random() * 6, rot: Math.random() * 6, vr: (Math.random() - .5) * .4
    });
  }
  if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxStep); }
}

function fxStep() {
  fxCtx.clearRect(0, 0, fx.width, fx.height);
  particles = particles.filter(p => p.life > 0 && p.y < fx.height + 20);
  for (const p of particles) {
    p.vy += .22; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
    fxCtx.save();
    fxCtx.globalAlpha = Math.max(p.life, 0);
    fxCtx.translate(p.x, p.y);
    fxCtx.rotate(p.rot);
    fxCtx.fillStyle = p.c;
    fxCtx.shadowColor = p.c;
    fxCtx.shadowBlur = 10;
    fxCtx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
    fxCtx.restore();
  }
  if (particles.length) requestAnimationFrame(fxStep);
  else { fxRunning = false; fxCtx.clearRect(0, 0, fx.width, fx.height); }
}

// =====================================================================
// Sunete
// =====================================================================
let audioCtx = null;

function playSound(type) {
  const url = type === 'sub' ? cfg.subSoundUrl : cfg.followSoundUrl;
  if (url) {
    const a = new Audio(url);
    a.volume = cfg.volume ?? 0.8;
    a.play().catch(() => playSynth(type));
  } else {
    playSynth(type);
  }
}

// Sunete generate, ca să meargă și fără fișiere audio
function playSynth(type) {
  audioCtx = audioCtx || new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const vol = cfg.volume ?? 0.8;
  const notes = {
    follow: [[880, 0], [1320, 0.15]],
    sub: [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.36]],
    chat: [[1200, 0]]
  }[type] || [[880, 0]];
  const dur = type === 'chat' ? 0.08 : 0.35;
  const gainMul = type === 'chat' ? 0.15 : 0.5;

  notes.forEach(([freq, delay]) => {
    const t = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * gainMul, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  });
}

// =====================================================================
// Voce (text-to-speech)
// =====================================================================
function cleanForTts(t) {
  return String(t)
    .replace(/\[emote:\d+:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/(.)\1{4,}/g, '$1$1$1')      // "aaaaaaaa" -> "aaa"
    .replace(/\s+/g, ' ')
    .trim();
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(cleanForTts(text).slice(0, Number(cfg.ttsMaxLength) || 200));
  const voices = speechSynthesis.getVoices();
  const v = voices.find(x => x.name === cfg.ttsVoice) || voices.find(x => x.lang && x.lang.toLowerCase().startsWith('ro'));
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'ro-RO';
  u.rate = Number(cfg.ttsRate) || 1;
  u.volume = cfg.ttsVolume ?? 1;
  speechSynthesis.speak(u);
}
speechSynthesis.getVoices(); // încarcă lista de voci din timp

// =====================================================================
// Mesaje din aplicație
// =====================================================================
window.api.on('connect', data => { cfg = data; applyConfig(); connect(); });
window.api.on('config', data => { cfg = { ...cfg, ...data }; applyConfig(); });
window.api.on('clear', () => { chatEl.innerHTML = ''; });

// ---------- YouTube ----------
window.api.on('yt-chat', data => addChat(data));
window.api.on('yt-alert', a => {
  const user = a.user || 'Cineva';
  if (a.type === 'member') {
    stats.subs++; stats.lastSub = user + ' (YT)'; pushStats('subs');
    showAlert({ type: 'sub', icon: '⭐', label: 'MEMBRU NOU · YOUTUBE', title: user,
      subtitle: a.text || 'a devenit membru al canalului!', speech: `${user} a devenit membru pe YouTube! Mulțumesc!` });
  } else if (a.type === 'gift') {
    const n = a.count || 1;
    stats.subs += n; stats.gifts += n; stats.lastSub = `${user} (🎁 ${n} YT)`; pushStats('subs');
    showAlert({ type: 'gift', icon: '🎁', label: 'MEMBERSHIP CADOU · YOUTUBE', title: user,
      subtitle: `a dăruit ${n} membership${n > 1 ? '-uri' : ''}!`, speech: `${user} a dăruit ${n} membership pe YouTube!` });
  } else if (a.type === 'superchat') {
    showAlert({ type: 'gift', icon: '💰', label: 'SUPER CHAT · YOUTUBE', title: `${user} · ${a.amount || ''}`,
      subtitle: a.text || 'Mulțumesc pentru Super Chat!', speech: `${user} a trimis un Super Chat. ${a.text || ''}` });
  }
});
window.api.on('disconnect', () => {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
  cfg.chatroomId = null; cfg.channelId = null;
  chatEl.innerHTML = '';
});
window.api.on('tts-skip', () => speechSynthesis.cancel());
window.api.on('reset-stats', () => {
  Object.assign(stats, { startedAt: Date.now(), followers: 0, subs: 0, gifts: 0, messages: 0, lastFollower: '', lastSub: '' });
  pushStats();
});

const TEST_NAMES = ['NeonNinja', 'GamerRO', 'PixelQueen', 'Viteazu99', 'LunaPlays', 'TurboMihai'];
const TEST_MSGS = ['Salut! Ce faci azi? 👋', 'GG, ce clutch! 🔥', 'Ce setări ai la sensibilitate?', 'Primul mesaj pe stream 😄', 'Hai că poți!!'];
const pick = a => a[Math.floor(Math.random() * a.length)];
const randColor = () => pick(['#53fc18', '#00e5ff', '#ff3df2', '#ffc83d', '#a78bfa', '#ff7a45', '#4ade80', '#60a5fa']);

window.api.on('test', (type, payload) => {
  const name = pick(TEST_NAMES) + Math.floor(Math.random() * 100);
  const E = 'App\\Events\\';
  if (type === 'follow') handle({ event: E + 'FollowersUpdated', data: { followed: true, username: name } }, true);
  if (type === 'sub') handle({ event: E + 'SubscriptionEvent', data: { username: name, months: 3 } }, true);
  if (type === 'gift') handle({ event: E + 'GiftedSubscriptionsEvent', data: { gifter_username: name, gifted_usernames: ['a', 'b', 'c', 'd', 'e'] } }, true);
  if (type === 'chat' || type === 'mod' || type === 'mention' || type === 'command') {
    const badges = type === 'mod' ? [{ type: 'moderator' }] : (Math.random() < .4 ? [{ type: 'subscriber' }] : []);
    let content = pick(TEST_MSGS);
    if (type === 'mention') content = `@${cfg.username || cfg.channel || 'streamer'} salut, mă saluți? 😁`;
    if (type === 'command') content = (cfg.commands && cfg.commands[0] && cfg.commands[0].trigger) || '!discord';
    if (type === 'command') cmdCooldown.clear();
    addChat({ id: 'test-' + Date.now() + Math.random(), content,
      sender: { username: name, identity: { color: randColor(), badges } } }, true);
  }
  if (type === 'yt') addChat({ id: 'test-yt-' + Date.now() + Math.random(), content: pick(TEST_MSGS), platform: 'youtube',
    sender: { username: '@' + name, identity: { color: randColor(), badges: [] } } }, true);
  if (type === 'tts') speak(payload || 'Salut! Acesta este un test de voce pentru stream.');
});
