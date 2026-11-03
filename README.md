# HELIX QUANT

Institutionelle Alpha-Research-Plattform mit Live-Execution nach MetaTrader 5:
16 Alpha-Modelle, Meta-Labelling, Differential-Evolution-Optimierung,
Walk-Forward-, CSCV- und Monte-Carlo-Validation, OMS mit Risk-Guard und
Python-/EA-Bridge.

## Lokaler Betrieb

```bash
npm install
npm run build
npm start            # braucht DATABASE_URL (Postgres)
```

Schema-Push: `npx drizzle-kit push`

## Deploy auf Render (feste URL, kostenlos)

1. Projekt als ZIP laden: `GET /api/dev/bundle` der laufenden Instanz, entpacken.
2. GitHub-Repo anlegen, Code pushen:
   ```bash
   git init && git add -A && git commit -m "helix quant"
   git branch -M main
   git remote add origin https://github.com/<DEIN-NAME>/helix-quant.git
   git push -u origin main
   ```
3. Neon (neon.tech): kostenloses Postgres-Projekt anlegen, Connection String kopieren.
4. Render: New → Blueprint → Repo wählen (liest `render.yaml`) →
   `DATABASE_URL` einfügen → Deploy.
5. Feste URL `https://helix-quant.onrender.com` einmal in der Bridge setzen
   (Menü [2]) — danach nie wieder.

## Deploy auf eigenem VPS

```bash
docker compose up -d --build          # http://VPS-IP:3000
docker compose --profile tls up -d    # optional: Domain + HTTPS via Caddy
```

## MT5-Anbindung

- `public/mt5/start_bridge.bat` + `public/mt5/helix_bridge.py` (Python-Weg, empfohlen)
- `public/mt5/HelixBridgeEA.mq5` (EA-Fallback)
- Anleitung in der App unter `/mt5`
