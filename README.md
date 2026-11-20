# Simulatore Esame Patente B (Motorizzazione Civile) — Self-Hosted

Web App leggera e blindata per simulare l'esame teorico ufficiale della **Patente B italiana** (30 domande Vero/Falso, 20 minuti, max 3 errori) con modalità **anti-cheat** e **pannello Genitore / Admin** protetto da password.

## Funzionalità Principali
- **Listato Ministeriale Ufficiale:** 7.139 domande Vero/Falso con 413 immagini di segnali e incroci (`data/quizPatenteB2023.json` + `public/img_sign/`).
- **3 Schede Fisse Bilanciate:** Test 1, Test 2 e Test 3 da 30 domande ciascuno (90 domande distinte, distribuite su tutti i 25 capitoli ministeriali). Rigenerabili dal pannello `/admin` senza perdere lo storico dei tentativi precedenti.
- **Terminale Motorizzazione Civile:** griglia rapida 1–30, immagine a sinistra, testo e grandi pulsanti **V (Vero)** / **F (Falso)** a destra, timer 20:00 con invio automatico allo scadere.
- **Anti-Cheat:**
  - Fullscreen obbligatorio per avviare la prova; overlay oscurante se il candidato esce dal Fullscreen.
  - Monitoraggio `visibilitychange` + `window.onblur`: alla 1ª uscita mostra avviso, alla **2ª violazione** invalida automaticamente l'esame (`ESAME ANNULLATO PER USCITA DALLA SCHERMATA`).
  - Blocco tasto destro, selezione testo, drag immagini e scorciatoie (`F12`, `Ctrl+Shift+I`, `Ctrl+U`, `Ctrl+C/V`, ecc.).
- **Pannello `/admin`:** protetto da password in `.env` (cookie `HttpOnly` firmato HMAC + rate limiting), storico tentativi filtrabile, log anti-cheat cronologico, revisione dettagliata delle domande sbagliate con immagine e risposta corretta.

## Avvio Rapido su VPS Ubuntu (Docker Compose)

```bash
cp .env.example .env
nano .env   # Imposta ADMIN_PASSWORD, SESSION_SECRET e COOKIE_SECURE=true se dietro HTTPS

mkdir -p db
docker compose up -d --build
```

L'app espone `127.0.0.1:3080` pronta per essere messa dietro reverse proxy **Nginx** o **Caddy**.

### Esempio Caddyfile (HTTPS automatico)
```caddy
patente.tuodominio.it {
    reverse_proxy 127.0.0.1:3080
}
```

### Alternativa senza Docker (Node.js + PM2)
```bash
cp .env.example .env
nano .env
npm ci --omit=dev
npx pm2 start ecosystem.config.js
npx pm2 save
```
