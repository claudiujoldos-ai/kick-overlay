// =====================================================================
// Legătura cu OBS (obs-websocket v5, inclus în OBS 28+)
// Oprește/pornește DOAR sursa de muzică pe live; tu o auzi în continuare.
// Rulează în fereastra overlay (mereu deschisă cât merge aplicația).
// =====================================================================
(() => {
  let ws = null;
  let cfg = {};
  let connKey = '';
  let reqId = 0;
  let retryTimer = null;
  let identified = false;
  const pending = new Map();
  const state = { state: 'off', message: '', inputs: [], muted: null, source: '' };
  const pill = document.getElementById('musicPill');

  function push(patch) {
    Object.assign(state, patch);
    state.source = cfg.musicSource || '';
    window.api.send('obs-status', { ...state });
    updatePill();
  }

  function updatePill() {
    if (!pill) return;
    pill.style.display = (cfg.musicIndicator !== false && state.state === 'connected' && state.muted === true) ? '' : 'none';
  }

  async function sha256b64(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  function close() {
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
    identified = false;
    for (const p of pending.values()) p.reject(new Error('Deconectat de la OBS.'));
    pending.clear();
  }

  function fail(message) {
    close();
    push({ state: 'error', message, muted: null });
  }

  function connect() {
    close();
    if (!cfg.obsEnabled) { push({ state: 'off', message: '', muted: null, inputs: [] }); return; }
    push({ state: 'connecting', message: 'Mă conectez la OBS...' });
    try {
      ws = new WebSocket(`ws://${cfg.obsHost || '127.0.0.1'}:${Number(cfg.obsPort) || 4455}`);
    } catch {
      fail('Adresa OBS nu e validă.');
      return;
    }

    ws.onmessage = async ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.op === 0) {                                   // Hello
        const d = { rpcVersion: 1, eventSubscriptions: 8 }; // 8 = evenimente pentru surse audio
        const auth = m.d && m.d.authentication;
        if (auth) {
          if (!cfg.obsPassword) { fail('OBS cere parolă. Copiaz-o din OBS → Instrumente → Setări server WebSocket.'); return; }
          d.authentication = await sha256b64((await sha256b64(cfg.obsPassword + auth.salt)) + auth.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) {                            // Identified
        identified = true;
        push({ state: 'connected', message: 'Conectat la OBS.' });
        refresh();
      } else if (m.op === 7) {                            // RequestResponse
        const p = pending.get(m.d.requestId);
        if (!p) return;
        pending.delete(m.d.requestId);
        const st = m.d.requestStatus || {};
        st.result ? p.resolve(m.d.responseData || {}) : p.reject(new Error(st.comment || ('cod ' + st.code)));
      } else if (m.op === 5) {                            // Event
        const t = m.d.eventType;
        if (t === 'InputMuteStateChanged' && m.d.eventData.inputName === cfg.musicSource) {
          push({ muted: m.d.eventData.inputMuted });
        } else if (/^Input(Created|Removed|NameChanged)$/.test(t)) {
          refresh();
        }
      }
    };

    ws.onclose = ev => {
      const wasConnected = identified;
      identified = false;
      ws = null;
      for (const p of pending.values()) p.reject(new Error('Deconectat de la OBS.'));
      pending.clear();
      if (ev.code === 4009) { push({ state: 'error', message: 'Parola OBS e greșită.', muted: null }); return; }
      push({
        state: 'error', muted: null,
        message: wasConnected ? 'Legătura cu OBS s-a pierdut. Reîncerc...' : 'Nu găsesc OBS. E pornit și are serverul WebSocket activat? Reîncerc...'
      });
      if (cfg.obsEnabled) retryTimer = setTimeout(connect, 5000);
    };
  }

  function request(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || !identified) { reject(new Error('OBS nu e conectat.')); return; }
      const requestId = 'r' + (++reqId);
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => {
        if (pending.has(requestId)) { pending.delete(requestId); reject(new Error('OBS nu a răspuns.')); }
      }, 5000);
    });
  }

  async function refresh() {
    try {
      const r = await request('GetInputList');
      const inputs = (r.inputs || []).map(i => i.inputName);
      let muted = null;
      let message = 'Conectat la OBS.';
      if (cfg.musicSource) {
        if (inputs.includes(cfg.musicSource)) {
          muted = (await request('GetInputMute', { inputName: cfg.musicSource })).inputMuted;
        } else {
          message = `Nu găsesc sursa „${cfg.musicSource}” în OBS. Alege alta din listă.`;
        }
      } else {
        message = 'Conectat la OBS. Alege mai jos sursa de muzică.';
      }
      push({ inputs, muted, message });
    } catch (e) {
      push({ message: e.message });
    }
  }

  async function setMuted(m) {
    if (!cfg.musicSource) { push({ message: 'Alege întâi sursa de muzică.' }); return; }
    try {
      await request('SetInputMute', { inputName: cfg.musicSource, inputMuted: m });
      push({ muted: m, message: m ? 'Muzica e OPRITĂ pe live (tu o auzi în continuare).' : 'Muzica SE AUDE pe live.' });
      if (window.LiveLayerToast) window.LiveLayerToast(m ? '🔇 Muzica oprită pe live' : '🔊 Muzica se aude pe live');
    } catch (e) {
      push({ message: 'Nu am putut schimba muzica: ' + e.message });
    }
  }

  window.LiveLayerOBS = {
    applyConfig(c) {
      const key = [c.obsEnabled, c.obsHost, c.obsPort, c.obsPassword].join('|');
      const sourceChanged = c.musicSource !== cfg.musicSource;
      cfg = c;
      if (key !== connKey) { connKey = key; connect(); return; }
      if (sourceChanged && identified) refresh();
      updatePill();
    },
    command(cmd) {
      const t = cmd && cmd.type;
      if (t === 'toggle') {
        if (!identified) { push({ message: 'OBS nu e conectat.' }); if (window.LiveLayerToast) window.LiveLayerToast('⚠ OBS nu e conectat'); return; }
        if (state.muted === null) { push({ message: 'Alege întâi sursa de muzică.' }); return; }
        setMuted(!state.muted);
      } else if (t === 'mute') setMuted(true);
      else if (t === 'unmute') setMuted(false);
      else if (t === 'refresh') refresh();
      else if (t === 'reconnect') { connKey = ''; this.applyConfig(cfg); }
    },
    getState: () => ({ ...state })
  };
})();
