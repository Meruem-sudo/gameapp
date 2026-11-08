# Last Line

Gioco mobile a ondate: la navicella si muove solo a destra/sinistra (trascinando il dito), spara da sola.
I nemici scendono a ondate; se superano la linea rossa perdi una vita. Ogni 5 ondate c'è un boss.
Tra un'ondata e l'altra scegli 1 potenziamento su 3.

Stack: HTML5 Canvas + JavaScript puro (`www/`), impacchettato per Android con Capacitor 8 (`android/`).

## Provare nel browser
```
npm run serve   # poi apri http://localhost:8080 (anche da telefono sulla stessa rete)
```
Da tastiera: frecce / A-D per muoversi, P o Esc per la pausa, 1-2-3 per i potenziamenti.

## Build Android
Ogni push su GitHub avvia `.github/workflows/android.yml`, che produce l'APK di debug
(scaricabile da Actions → run → Artifacts → `last-line-debug-apk`) da installare direttamente sul telefono.

In locale (serve Android Studio / Android SDK + JDK 21):
```
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug
```
Dopo ogni modifica a `www/` va rieseguito `npx cap sync android`.

## Pubblicazione sul Play Store
1. **Application ID**: `io.github.meruemsudo.lastline` (in `capacitor.config.json` e `android/app/build.gradle`).
   Una volta pubblicato non si può più cambiare: decidilo prima.
2. **Crea la chiave di firma** (una sola volta, conservala: se la perdi non puoi più aggiornare l'app,
   salvo usare Play App Signing che è il default):
   ```
   keytool -genkeypair -v -keystore release.jks -alias lastline -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 release.jks > release.jks.b64
   ```
3. **Secret GitHub** (Settings → Secrets and variables → Actions):
   `KEYSTORE_BASE64` (contenuto di `release.jks.b64`), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
   Da quel momento la CI genera anche `last-line-release-aab` (firmato, `versionCode` = numero della run).
4. **Play Console** (account sviluppatore, 25 $ una tantum): crea l'app, carica l'`.aab`,
   compila scheda store (icona 512×512, feature graphic 1024×500, screenshot), questionario contenuti,
   privacy policy (URL obbligatorio anche se l'app non raccoglie dati), sezione "Sicurezza dei dati".
5. Gli account personali nuovi devono fare un **test chiuso con almeno 12 tester per 14 giorni**
   prima di poter andare in produzione.

## Da fare prima della pubblicazione
- Icona e splash screen personalizzati (ora sono quelli di default di Capacitor):
  `npx @capacitor/assets generate` partendo da `assets/icon.png` 1024×1024.
- Verificare su un telefono reale notch/barra di stato e la sensibilità del trascinamento (`SENS` in `www/game.js`).
