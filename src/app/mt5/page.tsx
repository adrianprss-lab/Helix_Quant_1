import Link from "next/link";
import { headers } from "next/headers";
import { KNOWN_ALIASES } from "@/lib/exec/symbolMap";
import { UNIVERSE } from "@/lib/quant/data";

export const dynamic = "force-dynamic";
export const metadata = { title: "MT5 Integration — HELIX QUANT" };

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="border-l border-slate-800 pl-4">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-emerald-400">{n}</span>
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-slate-200">{title}</h3>
      </div>
      <div className="mt-1.5 space-y-2 text-[12px] leading-relaxed text-slate-400">{children}</div>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
      {children}
    </pre>
  );
}

export default async function Mt5Page() {
  const h = await headers();
  const host = h.get("host") ?? "YOUR-HELIX-HOST";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

  return (
    <main className="min-h-screen bg-[#05070d] px-5 py-8 text-slate-300">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-end gap-3 border-b border-slate-800 pb-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-emerald-500">integration reference</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-100">Connecting MetaTrader 5</h1>
          </div>
          <Link
            href="/"
            className="ml-auto rounded border border-slate-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400"
          >
            ← back to terminal
          </Link>
        </header>

        <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-[12px] leading-relaxed text-amber-200/90">
          <strong className="font-mono uppercase tracking-wider">Read this first.</strong> This wiring sends real orders
          to a real broker account. MetaQuotes does not publish a retail REST API, and no backend can legally reach your
          MT5 terminal directly — so HELIX uses an <em>agent</em>: an Expert Advisor running inside your terminal polls
          this server and executes. That means the terminal must stay running (a VPS is the normal answer), and it means
          you — not this software — are responsible for the outcome. Test on a demo account until you have watched the
          full loop behave correctly several times. Trading leveraged instruments can lose more than you deposit.
        </section>

        {/* ------------------------------------------------------ architecture */}
        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Architecture</h2>
          <Code>{`┌────────────────────────────┐         ┌──────────────────────────────┐
│  HELIX OMS (this server)   │         │  Your machine / VPS          │
│                            │         │                              │
│  research pipeline         │         │  MetaTrader 5 terminal       │
│   ├─ 13 alpha models       │         │   └─ HelixBridgeEA.mq5       │
│   ├─ meta-labelling        │  HTTPS  │        ├─ polls /bridge/poll │
│   ├─ risk guard  ──────────┼────────►│        ├─ CTrade execution   │
│   ├─ sizing + lot step     │  line   │        ├─ local SL/TP/trail  │
│   └─ order queue (PG)      │ protocol│        └─ reports fills/book │
│                            │◄────────┼──────────────────────────────│
│  execution_orders          │   ack   │        your broker server    │
│  execution_positions       │         └──────────────────────────────┘
│  execution_events (audit)  │
└────────────────────────────┘`}</Code>
          <ul className="mt-3 space-y-1.5 text-[12px] leading-relaxed text-slate-400">
            <li>
              <span className="text-emerald-400">▸</span> All intelligence stays server-side: alpha ensemble,
              meta-labelling, the risk guard, position sizing and lot-step rounding. The EA is deliberately dumb.
            </li>
            <li>
              <span className="text-emerald-400">▸</span> Every order is written to PostgreSQL first, then dispatched.
              The EA acknowledges with the broker retcode, fill price, volume and slippage, so the queue is a complete
              audit trail.
            </li>
            <li>
              <span className="text-emerald-400">▸</span> Orders carry a TTL. If the agent does not acknowledge in time
              the order expires instead of executing stale — a disconnected terminal cannot come back and fire an
              hour-old signal.
            </li>
            <li>
              <span className="text-emerald-400">▸</span> Stop loss and take profit are attached at order time, and the
              EA additionally runs its own breakeven/ATR-trail/partial logic. If this server dies mid-trade, your
              position is still protected by the terminal.
            </li>
          </ul>
        </section>

        <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/[0.06] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-300">
            Weg A — Python-Bridge (empfohlen): vier Handgriffe, kein MetaEditor
          </h2>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-300">
            Der offizielle MetaQuotes-Weg: ein Python-Process auf deinem Rechner spricht lokal mit dem Terminal
            (MetaTrader5-Paket) und per HTTPS mit dem OMS. Kein Expert Advisor, kein Kompilieren, keine
            WebRequest-Freigabeliste, kein Chart-Zustand — und der Agent-Token registriert sich beim ersten Start
            selbst, statt per Copy & Paste durch sechs Dialoge zu wandern.
          </p>
          <div className="mt-3 space-y-2 text-[12px] text-slate-400">
            <p>
              <span className="font-mono text-emerald-400">1</span> Python von python.org installieren, Haken bei „Add
              python.exe to PATH".
            </p>
            <p>
              <span className="font-mono text-emerald-400">2</span>{" "}
              <a href="/mt5/start_bridge.bat" download className="text-emerald-400 underline decoration-dotted">start_bridge.bat</a>{" "}
              und{" "}
              <a href="/mt5/helix_bridge.py" download className="text-emerald-400 underline decoration-dotted">helix_bridge.py</a>{" "}
              in einen gemeinsamen Ordner legen.
            </p>
            <p>
              <span className="font-mono text-emerald-400">3</span> Doppelklick auf start_bridge.bat. Erster Start:
              einmal die aktuelle OMS-URL einfügen (Execution-Tab, blaues Feld) — Token und Konfiguration legt die
              Bridge selbst in <code className="text-slate-200">helix_config.ini</code> ab.
            </p>
            <p>
              <span className="font-mono text-emerald-400">4</span> MT5-Terminal eingeloggt offen lassen. Dry Run ist
              Standard; echte Orders erst mit <code className="text-slate-200">--live</code>.
            </p>
          </div>
          <Code>{`C:\Users\DU\Desktop\helix> start_bridge.bat
  HELIX QUANT Bridge - pruefe Pakete ...
  [OK] Agent automatisch registriert als 'pc-DEINNAME'.
  [OK] MT5 verbunden: Login 113938266 @ MetaQuotes-Demo
  [OK] Server erreichbar, Token gueltig.
  [OK] 5 Broker-Symbole an den Server gemeldet: EURUSD, XAUUSD, ...
  [HINWEIS] DRY RUN aktiv: es wird NICHTS an den Broker gesendet.

# Selbsttest jederzeit:   python helix_bridge.py --test
# Echtbetrieb (Demo!):    start_bridge.bat --live`}</Code>
          <p className="mt-2 text-[11px] text-slate-500">
            Der EA-Weg weiter unten bleibt als Fallback bestehen — identische Order-Queue, identischer Risk Guard,
            nur mehr bewegliche Teile auf deinem Rechner.
          </p>
        </section>

        {/* ---------------------------------------------------------- the steps */}
        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Setup</h2>
          <ol className="space-y-5">
            <Step n="01" title="Register an execution agent">
              <p>
                Open the <Link href="/" className="text-emerald-400 underline decoration-dotted">terminal → “Live
                execution / MT5” tab</Link>, enter an agent name and press <strong>register agent</strong>. You get a
                token like <code className="text-slate-200">hxb_…</code>, shown exactly once. Only a SHA-256 hash is
                stored — if you lose it, rotate and re-issue.
              </p>
            </Step>

            <Step n="02" title="Install the Expert Advisor">
              <p>
                Download{" "}
                <a href="/mt5/HelixBridgeEA.mq5" download className="text-emerald-400 underline decoration-dotted">
                  HelixBridgeEA.mq5
                </a>{" "}
                and place it in your MT5 data folder:
              </p>
              <Code>{`MT5 → File → Open Data Folder → MQL5 → Experts → HelixBridgeEA.mq5
MetaEditor (F4) → open the file → Compile (F7)   # 0 errors, 0 warnings`}</Code>
            </Step>

            <Step n="03" title="Allow the WebRequest URL">
              <p>
                MT5 blocks outbound HTTP from EAs unless the host is explicitly allow-listed. This is the single most
                common cause of a silent EA.
              </p>
              <Code>{`Tools → Options → Expert Advisors
  ☑ Allow Algo Trading
  ☑ Allow WebRequest for listed URL:
      ${origin}`}</Code>
            </Step>

            <Step n="04" title="Attach and configure">
              <p>Drag the EA onto any chart of the account you want to trade, then set:</p>
              <Code>{`InpServerUrl       = "${origin}"
InpAgentToken      = "hxb_PASTE_THE_TOKEN_FROM_STEP_1"
InpMagic           = 990011        # unique per strategy/account
InpPollSeconds     = 3
InpRespectServerLot= true          # server sizes the position
InpManageExits     = true          # local SL/TP/trail protection
InpDryRun          = true          # ← START HERE`}</Code>
              <p>
                With <code className="text-slate-200">InpDryRun=true</code> the EA logs exactly what it would have sent
                and reports a REJECTED ack with “dry run” — you validate the whole loop without risking a cent.
              </p>
              <p>
                Version 1.03 performs a transport-only <code className="text-slate-200">/api/health</code> check when it
                starts. In MT5 → Toolbox → Experts, look for <code className="text-emerald-400">HELIX DIAGNOSTIC: transport OK (HTTP 200)</code>.
                If it fails, that line prints the exact WebRequest error and attempted URL; send that line rather than
                guessing at the token or broker settings.
              </p>
            </Step>

            <Step n="05" title="Verify the handshake">
              <p>
                Within one poll interval the Execution tab should show the bridge <strong>ONLINE</strong> with your
                login, server, account mode (hedging/netting), equity and free margin. On the first tick the EA also
                publishes your broker's real contract specifications into the symbol map:
              </p>
              <Code>{`digits · point · contract size · lot min/max/step · stops level · freeze level · trade mode · spread · tick value`}</Code>
              <p>
                Those numbers drive sizing and stop-distance compliance, so they must come from the broker rather than
                being guessed. Check the mapping below matches your instrument names.
              </p>
            </Step>

            <Step n="06" title="Arm, in manual confirm mode">
              <p>
                In the risk guard panel set <strong>Adapter mode = bridge</strong> and leave{" "}
                <strong>Confirm mode = manual</strong>. Press <strong>ARM</strong>. Now “scan signals → queue orders”
                runs the live research engine and writes orders into the queue, but each one waits for you to press{" "}
                <strong>approve</strong>. Watch the state walk PENDING → DISPATCHED → FILLED with the retcode and
                slippage recorded.
              </p>
            </Step>

            <Step n="07" title="Only then go automatic">
              <p>
                After several clean manual cycles: set the EA's <code className="text-slate-200">InpDryRun=false</code>,
                flip <strong>Confirm mode = auto</strong>, and keep the kill switch within reach. Start with one symbol,
                a small lot multiplier and tight daily limits.
              </p>
            </Step>
          </ol>
        </section>

        {/* ------------------------------------------------- symbol mapping */}
        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
            Symbol mapping — broker spellings
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">
            Every broker renames the same instrument. These aliases are recognised automatically; anything else is
            mapped by prefix or left unmapped (and therefore never traded) until you add it in the Execution tab.
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {UNIVERSE.map((u) => (
              <div key={u.ticker} className="rounded border border-slate-800 bg-slate-950/50 p-2.5">
                <div className="font-mono text-[11px] text-slate-200">
                  {u.ticker} <span className="text-slate-600">· {u.assetClass}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(KNOWN_ALIASES[u.ticker] ?? [u.ticker]).map((a) => (
                    <span key={a} className="rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[9px] text-emerald-400/80">
                      {a}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
            Feste URL — warum sie hier wechselt und wie du sie ein für alle Mal einfrierst
          </h2>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
            Diese Vorschau läuft in einer Build-Sandbox: jeder neue Build bekommt von der Plattform einen neuen
            Hostnamen. Das ist Plattformverhalten und nicht abschaltbar. Permanent wird die Adresse erst, wenn HELIX
            auf <em>deiner</em> Infrastruktur läuft — das Deploy-Kit liegt bereits im Projekt (Dockerfile,
            docker-compose.yml, Caddyfile). Drei Wege, aufsteigend nach Kontrolle:
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-emerald-400">Weg 1 · kostenlos, kein Server</h3>
              <p className="mt-1 text-[11px]">
                <a href="/api/dev/bundle" className="text-emerald-400 underline decoration-dotted">
                  Komplett-Quellcode als ZIP laden
                </a>{" "}
                (Schritt 0 für Weg 1 und 2)
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                Projekt auf GitHub pushen, auf <strong className="text-slate-200">render.com</strong> als Web Service
                anlegen, Datenbank von <strong className="text-slate-200">neon.tech</strong> (free) als DATABASE_URL
                eintragen. Ergebnis: feste URL wie{" "}
                <code className="text-slate-200">helix-quant.onrender.com</code> — ändert sich nie, schläft aber nach
                Inaktivität kurz ein.
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-emerald-400">Weg 2 · Heim-PC, gratis</h3>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                Server lokal laufen lassen (<code className="text-slate-200">npm run build && npm run start</code> +
                Postgres) und per{" "}
                <strong className="text-slate-200">Tailscale Funnel</strong> oder einem ngrok-Static-Domain-Account
                exponieren. Feste Adresse z. B. <code className="text-slate-200">dein-pc.ts.net</code> oder{" "}
                <code className="text-slate-200">xyz.ngrok-free.app</code>. Läuft nur, solange der PC an ist.
              </p>
            </div>
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/[0.06] p-3">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-emerald-300">Weg 3 · eigener VPS (empfohlen)</h3>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                Hetzner/Netcup-VPS (~4 €/Monat). Projektordner hochladen, dann zwei Befehle — fertig ist die für immer
                gleiche Adresse <code className="text-slate-200">http://DEINE-VPS-IP:3000</code> bzw. mit Domain +
                Caddy automatisch HTTPS.
              </p>
              <pre className="mt-2 overflow-x-auto rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-300">{`scp -r ./* root@VPS-IP:/opt/helix
ssh root@VPS-IP
cd /opt/helix
docker compose up -d --build
# optional Domain+HTTPS:
#   Caddyfile editieren, dann:
#   docker compose --profile tls up -d`}</pre>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Nach dem Deploy: die neue, feste Adresse einmal in der Bridge setzen (Menü [2]) und in die
            WebRequest-Freigabeliste — danach nie wieder. Tokens, Konfiguration und Historie wandern mit, weil alles in
            deiner Datenbank liegt. Bis dahin bleibt der Sandbox-Wechsel; die Bridge fängt ihn dank Nachfrage und
            Selbst-Registrierung bereits automatisch ab.
          </p>
        </section>

        {/* ---------------------------------------------------- troubleshooting */}
        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Troubleshooting</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="font-mono text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="py-1.5 text-left">symptom</th>
                  <th className="text-left">cause</th>
                  <th className="text-left">fix</th>
                </tr>
              </thead>
              <tbody className="text-slate-400">
                {[
                  ["EA logs “WebRequest blocked”, error 4014", "host not allow-listed", "add the exact URL from step 03 to Tools → Options → Expert Advisors"],
                  ["Bridge stays OFFLINE", "wrong base URL or trailing slash mismatch", "use the origin shown on this page, no trailing /"],
                  ["Browser test shows ok=1 but EA says unreachable", "MT5 WebRequest allow list (error 4014)", "v1.05 pops up an Alert with the exact line to add under Tools → Options → Expert Advisors"],
                  ["Browser test shows ok=0 / invalid token", "token rotated or deleted server-side", "Execution tab → rotate token → new value into InpAgentToken"],
                  ["Browser test does not load at all", "InpServerUrl is an old sandbox address", "copy the CURRENT address from the Execution tab into InpServerUrl and the allow list"],
                  ["Bridge ONLINE but nothing executes", "Algo Trading disabled, or engine not ARMED, or kill switch on", "check the banner state and the EA toolbar button"],
                  ["“symbol not available on this terminal”", "your broker spells it differently", "add the broker symbol to InpSymbolList and let it publish, or map it manually"],
                  ["REJECTED with retcode 10016 / 10019", "stop too close or no money", "the OMS already enforces stops level; reduce size or increase the stop distance"],
                  ["REJECTED with retcode 10021", "no position to close/partial", "reconcile the book: the mirror is stale until the next report cycle"],
                  ["Orders EXPIRE before filling", "agent poll slower than the order TTL", "lower InpPollSeconds or raise Order TTL in the risk guard"],
                  ["Duplicate positions after a restart", "—", "cannot happen: the EA scans open positions and 3 days of deal history for the HX-&lt;id&gt; marker before executing"],
                ].map(([a, b, c2]) => (
                  <tr key={a} className="border-b border-slate-900/70 align-top">
                    <td className="py-1.5 pr-3 font-mono text-slate-300">{a}</td>
                    <td className="pr-3">{b}</td>
                    <td className="text-slate-500">{c2}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* -------------------------------------------------------- safety */}
        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Go-live checklist</h2>
          <ul className="mt-3 space-y-1.5 text-[12px] text-slate-400">
            {[
              "Demo account first. Same broker, same symbol suffixes, same spread behaviour.",
              "Dry-run the EA for at least a session and read every log line it produced.",
              "Manual confirm mode for the first N fills; only then switch to auto.",
              "Daily loss limit and max daily orders set to something you would actually accept losing.",
              "Kill switch tested at least once — press it and confirm positions flatten.",
              "Unique magic number per strategy so you can always tell HELIX trades from manual ones.",
              "Terminal on a VPS with auto-restart; a laptop that sleeps will strand open positions.",
              "Re-run the backtest on fresh data before increasing size. The edge decays; the audit tab exists to show you when.",
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <span className="text-emerald-500">☐</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------- wire protocol */}
        <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Wire protocol reference</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">
            MQL5 has no JSON parser in its standard library, so the agent channel is a newline-delimited{" "}
            <code className="text-slate-200">key=value</code> protocol. Boring on purpose: it is diffable in a terminal
            and cannot be mis-parsed the way hand-rolled JSON in MQL5 can.
          </p>
          <Code>{`GET  /api/bridge/poll?fmt=ea&token=hxb_…     # agent pulls work
POST /api/bridge/heartbeat                   # account state + specs
POST /api/bridge/ack                         # fill / reject report
POST /api/bridge/positions                   # broker book mirror
POST /api/bridge/instruments                 # contract specification
POST /api/bridge/register                    # issue / rotate a token
GET  /api/exec/status                        # full OMS snapshot (JSON)
POST /api/exec/control                       # arm|disarm|kill|update|approve|cancel|dispatch|manual

# poll response
ok=1
armed=1
killswitch=0
lotmul=1
maxspread=30
orders=1
order=42|OPEN|EURUSD|BUY|0.07000000|1.08550|1.08120|1.08990|HX-42|1.600|0.500|0.500|1.000|90

# agent ack
type=ack
token=hxb_…
order=42
state=FILLED
retcode=10009
price=1.08552
volume=0.07
slippage=0.2
position=118273645`}</Code>
        </section>

        <p className="pb-6 text-center font-mono text-[10px] leading-relaxed text-slate-600">
          HELIX QUANT · research and execution plumbing · not investment advice ·
          <br />
          you are solely responsible for orders placed on your broker account
        </p>
      </div>
    </main>
  );
}
