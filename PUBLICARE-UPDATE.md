# Cum faci .exe-ul și cum publici actualizările

Actualizările vin de pe **github.com/claudiujoldos-ai/kick-overlay**.
Aplicația verifică singură la pornire și la fiecare 2 ore. Când găsește o versiune nouă, apare un banner
„🚀 Versiune nouă disponibilă”. Apeși **Descarcă și instalează**, iar aplicația se actualizează și repornește singură.

---

## A. O singură dată: faci repository-ul pe GitHub
1. Intră pe github.com (logat ca **claudiujoldos-ai**) → sus-dreapta **+** → **New repository**.
2. La *Repository name* scrii exact: **kick-overlay**
3. Lași pe **Public** (obligatoriu, altfel aplicațiile nu pot vedea update-urile).
4. Bifezi „Add a README file” → **Create repository**.

## B. Faci .exe-ul
1. Dublu-click pe **Construieste-EXE.bat** (în folderul aplicației).
2. Așteaptă. La final se deschide folderul **dist** cu 3 fișiere:
   - `LiveLayer-Setup-2.4.0.exe` (installer-ul)
   - `LiveLayer-Setup-2.4.0.exe.blockmap`
   - `latest.yml`

## C. Publici versiunea pe GitHub (de fiecare dată)
1. Pe pagina repository-ului → în dreapta, **Releases** → **Create a new release**
   (sau direct: github.com/claudiujoldos-ai/kick-overlay/releases/new)
2. **Choose a tag** → scrii `v2.4.0` (cu **v** în față, aceeași versiune ca în installer) → *Create new tag*.
3. *Release title*: de ex. `LiveLayer 2.4.0`
4. În descriere scrii ce e nou. Textul ăsta apare în bannerul de update din aplicație.
5. Tragi **toate cele 3 fișiere** din `dist` în zona „Attach binaries”.
6. **Publish release**.

Gata! Toți cei care au aplicația instalată vor vedea update-ul.

## D. Pe site-ul tău (în viitor)
Pui un buton de download cu linkul:
```
https://github.com/claudiujoldos-ai/kick-overlay/releases/latest
```
Linkul duce mereu la ultima versiune.

---

## Când facem o versiune nouă
1. Îți dau fișierele noi, cu versiunea crescută în `package.json` (de ex. 2.4.0).
2. Le pui peste folderul vechi.
3. Repeți **B** și **C** cu tag-ul nou (`v2.4.0`).

⚠ Tag-ul de pe GitHub trebuie să fie identic cu versiunea din `package.json`, cu **v** în față.
⚠ Prima versiune (2.4.0) trebuie instalată manual cu .exe-ul. De la ea încolo, update-urile vin singure.

## Notă: Windows SmartScreen
Fiind o aplicație nouă, nesemnată digital, la prima instalare Windows poate afișa
„Windows a protejat computerul”. Apeși **Mai multe informații → Rulează oricum**. E normal.
