# Stato Attuale del Progetto — Simulatore Esame Patente B

**Repository:** `aturrisi-2/Patente_Privatist`  
**Stato:** Completo, testato end-to-end e pronto per il deploy su VPS Ubuntu 24.04.

---

## 1. Riepilogo di quanto realizzato

### Dataset Ufficiale Ministeriale
- **Domande:** 7.139 domande Vero/Falso distribuite su tutti i 25 capitoli ufficiali (`data/quizPatenteB2023.json`).
- **Immagini:** 413 immagini PNG ufficiali dei segnali e degli incroci (`public/img_sign/`), tutte validate (0 file mancanti).

### Backend & Database (`src/`)
- **Stack:** Node.js + Express + SQLite (`better-sqlite3` in modalità WAL) + `helmet`.
- **`src/db.js`:** inizializzazione automatica dello schema SQLite (`questions`, `tests`, `test_questions`, `attempts`, `attempt_answers`, `anticheat_logs`) e import automatico delle 7.139 domande al primo avvio.
- **`src/generator.js`:** generazione bilanciata di **3 schede fisse e distinte** (`Test 1`, `Test 2`, `Test 3`), 30 domande ciascuna (90 domande uniche) con pesi ministeriali sui 25 capitoli. La rigenerazione crea una nuova versione preservando lo storico dei tentativi precedenti.
- **`src/auth.js`:** protezione `/admin` con password da `.env` (`crypto.timingSafeEqual`), cookie di sessione `HttpOnly` + `SameSite=Strict` firmato HMAC-SHA256 e rate-limiting anti brute-force sul login.
- **`src/server.js`:** API REST con valutazione risposte **esclusivamente lato server** (le soluzioni non vengono mai inviate al client), timer 20 minuti (1200s), soglia ministeriale ≤ 3 errori (non risposte = errore) e invalidazione automatica server-side alla 2ª violazione.

### Frontend (`public/`)
- **Terminale Esame (`public/index.html`, `public/css/exam.css`, `public/js/exam.js`):**
  - Interfaccia stile terminale Motorizzazione Civile: griglia rapida `1–30`, immagine a sinistra, domanda e pulsanti **V (Vero)** / **F (Falso)** a destra, countdown visibile con auto-invio allo scadere e modale di conferma consegna.
  - **Modalità Anti-Cheat:**
    - Avvio consentito solo in `Fullscreen API`; overlay oscurante all'uscita dal Fullscreen con registrazione evento.
    - Monitoraggio `visibilitychange` + `window.onblur`: 1ª violazione → avviso, 2ª violazione → `ESAME ANNULLATO PER USCITA DALLA SCHERMATA`.
    - Blocco tasto destro, selezione testo, drag immagini e scorciatoie (`F12`, `Ctrl+Shift+I`, `Ctrl+U`, `Ctrl+C/V`, `Alt+Tab`), euristica DevTools e invio `sendBeacon` alla chiusura pagina.
- **Pannello Genitore / Admin (`public/admin.html`, `public/css/admin.css`, `public/js/admin.js`):**
  - Accesso protetto su `/admin`, KPI, filtri per scheda ed esito, ispezione del **Log Anti-Cheat**, revisione dettagliata delle **domande sbagliate** (con immagine, risposta data e risposta ufficiale) e pulsante per **rigenerare le 3 schede**.

### Verifica Eseguita
- Test end-to-end superati su tutte le API (`/api/health`, `/api/tests`, `/api/attempts/start`, `/api/attempts/:id/event`, `/api/attempts/:id/submit`, `/api/admin/*`), verifica immagini HTTP 200 PNG, invalidazione anti-cheat alla 2ª violazione e rigenerazione test v2.

---

## 2. Ambiente VPS di Destinazione

- **Provider:** IONOS (Europa)
- **Sistema Operativo:** Ubuntu 24.04
- **Risorse:** 6 vCore · 8 GB RAM · 240 GB NVMe
- **Indirizzo IPv4:** `87.106.30.193`
- **Accesso SSH:**
  ```bash
  ssh luca@87.106.30.193
  ```
- **Firewall IONOS (`My firewall policy`):** assicurarsi che siano aperte in ingresso le porte TCP `22` (SSH), `80` (HTTP) e `443` (HTTPS).

---

## 3. Procedura di Deploy e Gestione sul VPS

### Prima installazione (Docker + Caddy)
Collegarsi con `ssh luca@87.106.30.193` ed eseguire:

```bash
# 1. Installa dipendenze base, Docker e Caddy
sudo apt update && sudo apt install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker luca

sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# 2. Clona il progetto in /opt/patente
sudo mkdir -p /opt/patente
sudo chown -R luca:luca /opt/patente
git clone https://github.com/aturrisi-2/Patente_Privatist.git /opt/patente
cd /opt/patente

# 3. Configura .env
cp .env.example .env
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
nano .env
# Imposta ADMIN_PASSWORD (e COOKIE_SECURE=true se usi HTTPS con dominio)

# 4. Avvia l'applicazione
mkdir -p /opt/patente/db
sudo docker compose up -d --build
curl http://127.0.0.1:3080/api/health
```

### Configurazione Reverse Proxy (Caddy)
Per accesso diretto via IP (`http://87.106.30.193`):
```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
:80 {
    reverse_proxy 127.0.0.1:3080
}
EOF
sudo systemctl reload caddy
```

Per accesso con dominio + HTTPS automatico (dopo aver puntato il DNS A verso `87.106.30.193` e impostato `COOKIE_SECURE=true` in `.env`):
```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
patente.tuodominio.it {
    reverse_proxy 127.0.0.1:3080
}
EOF
sudo systemctl reload caddy
```

### Comandi Rapidi di Manutenzione
```bash
# Aggiornare l'app dal repository Git
cd /opt/patente && git pull && sudo docker compose up -d --build

# Vedere i log in tempo reale
cd /opt/patente && sudo docker compose logs -f

# Backup del database SQLite (tentativi + log anti-cheat)
cp /opt/patente/db/patente.sqlite /opt/patente/db/patente_backup_$(date +%F).sqlite
```
