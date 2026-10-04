# Login cu Kick: înregistrarea aplicației (o singură dată)

Ca butonul **„Conectează-te cu Kick”** să meargă, aplicația **LiveLayer** trebuie înregistrată la Kick.
Faci asta o singură dată, din contul tău. După aceea, oricine descarcă aplicația se loghează cu contul lui
și se conectează doar la canalul lui.

## 1. Creezi aplicația pe Kick
1. Intră pe **kick.com**, logat cu contul tău.
2. Mergi la **Settings → Developer** (adresa directă: `https://kick.com/settings/developer`).
   Dacă îți cere, activează întâi **2FA** (autentificarea în doi pași) din Settings → Security.
3. Apasă **Create App** și completezi:
   - **App Name:** un nume unic, de ex. `LiveLayer` (numele trebuie să nu fie luat pe Kick)
   - **Description:** `Overlay pentru streameri: chat pe ecran, alerte la follow și sub, statistici. Citește doar numele contului și al canalului.`
   - **Redirect URL:** `http://localhost:17777/callback` (exact așa)
   - **Scopes / permisiuni:** bifează **Read user information** (`user:read`) și **Read channel information** (`channel:read`)
4. Salvezi. Primești un **Client ID** și un **Client Secret**.

## 2. Le pui în aplicație
1. În folderul aplicației găsești fișierul **kick-app.example.json**.
2. Fă o copie a lui și redenumește copia în **kick-app.json**.
3. Deschide-l cu Notepad și înlocuiește textele:
   ```json
   {
     "clientId": "aici Client ID-ul tău",
     "clientSecret": "aici Client Secret-ul tău"
   }
   ```
4. Salvează și pornește aplicația. Apasă **Conectează-te cu Kick**, loghează-te în browser și apasă **Allow**.

## Important
- **Nu trimite nimănui Client Secret-ul** (nici pe chat, nici pe Discord). Îl pui doar în fișierul `kick-app.json`.
- `kick-app.json` intră automat în `.exe` când rulezi `Construieste-EXE.bat`, deci cei care descarcă aplicația nu trebuie să facă nimic din toate astea.
- Când îți dau versiuni noi, fișierul `kick-app.json` rămâne neatins (ZIP-urile mele nu îl conțin).
- Aplicația cere doar permisiunea de a citi numele contului și al canalului. Nu poate scrie în chat, nu poate schimba nimic pe cont și nu vede parola.
