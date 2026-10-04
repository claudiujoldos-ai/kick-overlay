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
  const state = { state: 'off', message: '', inputs: [], muted: null, source: '', apps: [] };
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

  // ---------------- Configurare automată ----------------
  const MUSIC_INPUT = 'LiveLayer – Muzică';
  const GAME_INPUT = 'LiveLayer – Joc';
  const APP_KIND = 'wasapi_process_output_capture';
  const exeOf = v => String(v || '').split(':').pop().toLowerCase();

  async function ensureInput(name) {
    const list = (await request('GetInputList')).inputs || [];
    if (list.some(i => i.inputName === name)) return;
    const cur = await request('GetCurrentProgramScene');
    await request('CreateInput', {
      sceneName: cur.currentProgramSceneName || cur.sceneName,
      inputName: name, inputKind: APP_KIND, inputSettings: { priority: 2 }, sceneItemEnabled: true
    });
  }

  async function addToAllScenes(name) {
    const scenes = (await request('GetSceneList')).scenes || [];
    for (const s of scenes) {
      try { await request('GetSceneItemId', { sceneName: s.sceneName, sourceName: name }); }
      catch { try { await request('CreateSceneItem', { sceneName: s.sceneName, sourceName: name }); } catch {} }
    }
  }

  async function autoScan() {
    try {
      push({ message: 'Caut aplicațiile care fac sunet...' });
      await ensureInput(MUSIC_INPUT);
      const r = await request('GetInputPropertiesListPropertyItems', { inputName: MUSIC_INPUT, propertyName: 'window' });
      const apps = (r.propertyItems || [])
        .filter(i => i.itemValue && i.itemEnabled !== false)
        .map(i => ({ name: i.itemName, value: i.itemValue }));
      push({ apps, message: apps.length ? 'Alege mai jos aplicația cu muzica și jocul, apoi apasă „Configurează automat”.' : 'Nu am găsit aplicații. Pornește muzica și jocul, apoi caută din nou.' });
    } catch (e) {
      push({ message: 'Nu am putut căuta aplicațiile: ' + e.message });
    }
  }

  async function autoApply(musicValue, gameValue) {
    if (!musicValue) { push({ message: 'Alege aplicația cu muzica.' }); return; }
    const done = [];
    try {
      push({ message: 'Configurez OBS...' });
      // 1. sursa de muzică
      await ensureInput(MUSIC_INPUT);
      await request('SetInputSettings', { inputName: MUSIC_INPUT, inputSettings: { window: musicValue, priority: 2 }, overlay: true });
      await addToAllScenes(MUSIC_INPUT);
      done.push('sursa „' + MUSIC_INPUT + '”');
      // 2. sursa jocului (opțional)
      if (gameValue) {
        await ensureInput(GAME_INPUT);
        await request('SetInputSettings', { inputName: GAME_INPUT, inputSettings: { window: gameValue, priority: 2 }, overlay: true });
        await addToAllScenes(GAME_INPUT);
        await request('SetInputMute', { inputName: GAME_INPUT, inputMuted: false });
        done.push('sursa „' + GAME_INPUT + '”');
      }
      // 3. Desktop Audio (prinde tot, deci și muzica) -> oprit pe live
      let muted = 0;
      const special = await request('GetSpecialInputs').catch(() => ({}));
      const desktopNames = new Set([special.desktop1, special.desktop2].filter(Boolean));
      const outs = (await request('GetInputList', { inputKind: 'wasapi_output_capture' })).inputs || [];
      outs.forEach(i => desktopNames.add(i.inputName));
      for (const n of desktopNames) {
        try { await request('SetInputMute', { inputName: n, inputMuted: true }); muted++; } catch {}
      }
      // 4. alte capturi ale aceleiași aplicații de muzică -> oprite (altfel se aude dublat)
      const musicExe = exeOf(musicValue);
      const apps = (await request('GetInputList', { inputKind: APP_KIND })).inputs || [];
      for (const i of apps) {
        if (i.inputName === MUSIC_INPUT || i.inputName === GAME_INPUT) continue;
        try {
          const s = await request('GetInputSettings', { inputName: i.inputName });
          if (exeOf(s.inputSettings && s.inputSettings.window) === musicExe) {
            await request('SetInputMute', { inputName: i.inputName, inputMuted: true }); muted++;
          }
        } catch {}
      }
      if (muted) done.push(`${muted} surs${muted > 1 ? 'e' : 'ă'} de tip „Desktop Audio” / dublură oprit${muted > 1 ? 'e' : 'ă'} pe live`);
      // 5. LiveLayer controlează de acum sursa de muzică
      window.api.send('obs-set-source', MUSIC_INPUT);
      cfg.musicSource = MUSIC_INPUT;
      await refresh();
      push({ message: '✅ Gata! Am configurat: ' + done.join(', ') + '. Acum apasă butonul mare sau Ctrl+Shift+M.' });
    } catch (e) {
      push({ message: 'Configurarea nu a reușit: ' + e.message });
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
      else if (t === 'auto-scan') { if (identified) autoScan(); else push({ message: 'Conectează întâi OBS.' }); }
      else if (t === 'auto-apply') { if (identified) autoApply(cmd.music, cmd.game); else push({ message: 'Conectează întâi OBS.' }); }
      else if (t === 'reconnect') { connKey = ''; this.applyConfig(cfg); }
    },
    getState: () => ({ ...state })
  };
})();
