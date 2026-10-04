# LiveLayer

Aplicație pentru Windows care pune peste joc:
- **chat-ul canalului tău**, în stânga ecranului, cu insigne (👑 🗡️ 💎 ⭐) și emote-uri;
- **alerte cu sunet** la follow, sub și sub-uri cadou;
- **statistici live**: followeri, sub-uri, mesaje, durata live-ului, ultimul follower și ultimul sub;
- **comenzi**: !discord, !social sau ce vrei tu, iar răspunsul apare ca un card pe ecran;
- **filtre**: ascunzi boții și cuvintele interzise, evidențiezi mențiunile și moderatorii;
- **voce (TTS)**: citește mesajele cu !tts, ale abonaților sau toate, plus alertele.

Overlay-ul e transparent și „click-through”: mouse-ul și tastatura merg normal în joc.

## Video pe stream (doar pe live, nu pe ecranul tău)
1. În aplicație, mergi la **Video pe stream** și alege un video pentru sub (opțional și pentru sub-uri cadou sau follow).
2. Copiază linkul (`http://localhost:17777/alerts`).
3. În OBS: Surse → **+** → **Browser** → lipești linkul, 1920×1080, bifezi **„Controlează audio prin OBS”**.
4. Pui sursa în vârful listei. Gata: la sub, video-ul cu muzică rulează doar pe live.

## Instalare
1. Instalează **Node.js LTS** de pe https://nodejs.org
2. Dezarhivează ZIP-ul.
3. Dublu-click pe **Porneste.bat**.

**Actualizare de la o versiune mai veche:** dezarhivează peste folderul vechi și alege „Înlocuiește fișierele”.
Setările tale se păstrează și nu se mai reinstalează nimic.

## Scurtături (merg și din joc)
- `Ctrl + Shift + K`: ascunde sau arată overlay-ul
- `Ctrl + Shift + L`: golește chat-ul de pe ecran
- `Ctrl + Shift + S`: oprește vocea care citește acum

## Bine de știut
- Jocul trebuie să fie pe **Borderless** sau **Windowed Fullscreen**. Peste Exclusive Fullscreen nu se poate afișa nimic.
- În OBS: cu **Display Capture**, și viewerii văd overlay-ul. Cu **Game Capture**, îl vezi doar tu.
- Răspunsurile la comenzi apar doar pe ecran și nu se trimit în chat-ul Kick (pentru asta ar trebui login oficial cu botul tău).
- Pentru voce românească: Setări Windows → Oră și limbă → Vorbire → Adaugă voci → Română.

## Fișier .exe (opțional)
```
npm run build
```
Fișierul apare în folderul `dist`.
