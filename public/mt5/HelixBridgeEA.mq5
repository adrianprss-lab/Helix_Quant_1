//+------------------------------------------------------------------+
//|                                              HelixBridgeEA.mq5   |
//|        HELIX QUANT — MT5 execution bridge agent (v1.0.0)         |
//|                                                                  |
//|  This Expert Advisor is the *executor* half of the HELIX stack.  |
//|  All intelligence (alpha ensemble, meta-labelling, risk guard,   |
//|  sizing) lives on the server. This agent only:                   |
//|    1. polls the order queue over HTTPS                           |
//|    2. executes with a legal lot size / stop distance             |
//|    3. reports fills, rejects and the live book back              |
//|    4. protects every open position locally (SL/TP/trailing) so   |
//|       a dead backend can never leave a position unguarded        |
//+------------------------------------------------------------------+
#property copyright "HELIX QUANT"
#property link      "https://helix.quant"
#property version   "1.07"
#property description "HELIX QUANT execution bridge. Polls the OMS, executes, protects, reports."

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\SymbolInfo.mqh>

CTrade         trade;
CPositionInfo  posInfo;
CSymbolInfo    symInfo;

//--- connection ------------------------------------------------------------
input string   InpServerUrl        = "https://YOUR-HELIX-HOST";  // OMS base URL (no trailing slash)
input string   InpAgentToken       = "hxb_PASTE_YOUR_TOKEN";     // agent token from the Execution tab
input int      InpPollSeconds      = 3;                          // order poll interval
input int      InpManageSeconds    = 5;                          // position management interval
input int      InpWebRequestTimeout= 10000;                      // WebRequest timeout (ms)

//--- identity / execution --------------------------------------------------
input long     InpMagic            = 990011;                     // magic number
input int      InpMaxSlippage      = 20;                         // max slippage (points)
input double   InpLotMultiplier    = 1.0;                        // local volume multiplier
input bool     InpRespectServerLot = true;                       // use server volume (false = local risk sizing)
input double   InpLocalRiskPct     = 0.75;                       // local risk % if server lot ignored
input bool     InpDryRun           = false;                      // log only, never send an order
input bool     InpSingleInstance   = true;                       // refuse a second EA copy with the same magic

//--- local protective exits (defence in depth) -----------------------------
input bool     InpManageExits      = true;                       // manage SL/TP locally
input bool     InpTrailAtr         = true;                       // ATR trailing stop
input int      InpAtrPeriod        = 14;                         // ATR period
input double   InpTrailAtrMult     = 1.6;                        // trailing distance in ATR
input double   InpBreakevenAtR     = 0.5;                        // move to BE after this many R
input double   InpPartialAtR       = 1.0;                        // partial scale-out at this many R
input double   InpPartialFraction  = 0.5;                        // fraction of position to scale out
input bool     InpCloseOnKillSwitch= true;                       // flatten on server kill switch

//--- symbol reporting ------------------------------------------------------
input bool     InpReportSymbols    = true;                       // publish broker contract specs
input string   InpSymbolList       = "EURUSD,XAUUSD,BTCUSD,US500"; // comma separated (empty = Market Watch)

//--- state -----------------------------------------------------------------
string   g_base          = "";
string   g_token         = "";
datetime g_lastPoll      = 0;
datetime g_lastManage    = 0;
datetime g_lastHeartbeat = 0;
int      g_failStreak    = 0;
int      g_lastErr       = 0;
string   g_lastUrl       = "";
int      g_authFails     = 0;
datetime g_lastAuthWarn  = 0;
bool     g_alertedBlock  = false;
bool     g_alertedNet    = false;
bool     g_alertedAuth   = false;
string   g_instKey       = "";
bool     g_instanceOwner = false;
bool     g_killSwitch    = false;
bool     g_armed         = false;
long     g_executed      = 0;
long     g_rejected      = 0;
string   g_version       = "1.07";

// ATR handle cache (max 32 symbols)
string   g_atrSym[32];
int      g_atrHandle[32];
int      g_atrCount = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   g_base  = TrimUrl(InpServerUrl);
   g_token = InpAgentToken;
   StringTrimLeft(g_token);
   StringTrimRight(g_token);
   // Chat windows wrap long tokens; a pasted line break or space would make an
   // otherwise correct key invalid. Tokens are base64url: whitespace is never
   // legitimate, so strip every occurrence.
   StringReplace(g_token, "\n", "");
   StringReplace(g_token, "\r", "");
   StringReplace(g_token, " ", "");
   StringReplace(g_token, "\t", "");

   if(StringLen(g_token) < 12 || StringFind(g_token, "PASTE_YOUR") >= 0)
     {
      Alert("HELIX: paste your agent token into InpAgentToken first.");
      Print("HELIX: missing agent token — EA disabled.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(StringLen(g_base) < 8)
     {
      Alert("HELIX: set InpServerUrl to your OMS base URL.");
      return(INIT_PARAMETERS_INCORRECT);
     }

   if(InpSingleInstance)
     {
      g_instKey = "HELIX_EA_ALIVE_" + IntegerToString(InpMagic);
      if(GlobalVariableCheck(g_instKey))
        {
         double lastSeen = GlobalVariableGet(g_instKey);
         if((double)TimeCurrent() - lastSeen < 20)
           {
            Alert("HELIX: another EA instance with magic ", InpMagic,
                  " is already running on this terminal.\nCheck ALL open charts and remove the duplicate before starting this one.");
            Print("HELIX: refused to start - duplicate instance detected (", g_instKey, ").");
            return(INIT_FAILED);
           }
        }
      GlobalVariableSet(g_instKey, (double)TimeCurrent());
      g_instanceOwner = true;
     }

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpMaxSlippage);
   trade.SetAsyncMode(false);

   EventSetTimer(1);
   PrintFormat("HELIX bridge v%s online -> %s (magic %I64d, poll %ds, dryrun=%s)",
               g_version, g_base, InpMagic, InpPollSeconds, InpDryRun ? "YES" : "no");
   Comment("HELIX QUANT bridge - testing backend connection...");

   // Transport-only diagnostic. This unauthenticated endpoint distinguishes
   // URL / DNS / TLS / WebRequest allow-list problems from an agent-token issue.
   string healthBody = "";
   int healthCode = HttpRequest("GET", g_base + "/api/health", "", healthBody);
   if(healthCode == 200)
      PrintFormat("HELIX DIAGNOSTIC: transport OK (HTTP 200), health response: %s", healthBody);
   else if(healthCode > 0)
      PrintFormat("HELIX DIAGNOSTIC: server reached, but health returned HTTP %d: %s", healthCode, healthBody);
   else
      PrintFormat("HELIX DIAGNOSTIC: no HTTP response. Last error=%d; attempted URL=%s", g_lastErr, g_lastUrl);

   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_instanceOwner && StringLen(g_instKey) > 0 && GlobalVariableCheck(g_instKey))
      GlobalVariableDel(g_instKey);
   for(int i = 0; i < g_atrCount; i++)
      if(g_atrHandle[i] != INVALID_HANDLE) IndicatorRelease(g_atrHandle[i]);
   Comment("");
   PrintFormat("HELIX bridge offline (reason %d). executed=%I64d rejected=%I64d", reason, g_executed, g_rejected);
  }

//+------------------------------------------------------------------+
//| Main timer: heartbeat -> poll -> manage                           |
//+------------------------------------------------------------------+
void OnTimer()
  {
   datetime now = TimeCurrent();
   if(g_instanceOwner)
      GlobalVariableSet(g_instKey, (double)now);

   if(now - g_lastHeartbeat >= InpPollSeconds)
     {
      g_lastHeartbeat = now;
      SendHeartbeat();
     }

   if(now - g_lastPoll >= InpPollSeconds)
     {
      g_lastPoll = now;
      PollOrders();
     }

   if(now - g_lastManage >= InpManageSeconds)
     {
      g_lastManage = now;
      if(InpManageExits) ManagePositions();
      ReportPositions();
     }

   UpdateComment();
  }

//+------------------------------------------------------------------+
//| HTTP helpers (line protocol, no JSON parser required)             |
//+------------------------------------------------------------------+
string TrimUrl(string u)
  {
   string s = u;
   while(StringLen(s) > 0 && StringGetCharacter(s, StringLen(s) - 1) == '/')
      s = StringSubstr(s, 0, StringLen(s) - 1);
   return(s);
  }

// Returns HTTP status (>0) or -1 on transport failure.
int HttpRequest(const string method, const string url, const string payload, string &response)
  {
   response = "";
   uchar  data[];
   uchar  result[];
   string resultHeaders = "";
   int    copied = 0;

   // Encode the line protocol as UTF-8 bytes. MQL5 builds expose uchar[] in
   // the WebRequest signature (not char[]), so keep the exact built-in type.
   if(StringLen(payload) > 0)
     {
      copied = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
      if(copied > 0 && data[copied - 1] == 0)
         ArrayResize(data, copied - 1); // exclude the C string terminator from HTTP body
     }
   else
      ArrayResize(data, 0);

   ResetLastError();
   // built-in overload: (method, url, headers, timeout, const uchar&[], uchar&[], headers)
   int res = WebRequest(method, url, "", InpWebRequestTimeout, data, result, resultHeaders);
   if(res == -1)
     {
      int err = GetLastError();
      g_lastErr = err;
      g_lastUrl = url;
      if(err == 4014)
        {
         PrintFormat("HELIX: WebRequest BLOCKED (error 4014). Open Tools -> Options -> Expert Advisors and add exactly this URL to the allow list: %s", g_base);
         if(!g_alertedBlock)
           {
            g_alertedBlock = true;
            Alert("HELIX: MT5 blocks the connection (error 4014).\n\nOpen:  Tools -> Options -> Expert Advisors\nTick:  Allow WebRequest for the following URL\nDelete old entries, then Add EXACTLY this line:\n\n",
                  g_base,
                  "\n\nhttps:// included, no trailing slash, nothing else.");
           }
        }
      else
        {
         PrintFormat("HELIX: WebRequest failed, error %d, target: %s", err, url);
         if(!g_alertedNet)
           {
            g_alertedNet = true;
            Alert("HELIX: cannot reach the server (error ", err, ").\nTarget: ", url,
                  "\n\nThe OMS address changes whenever the sandbox restarts.\nOpen the Execution tab in the browser and copy the CURRENT address into InpServerUrl AND the WebRequest allow list.");
           }
        }
      return(-1);
     }
   g_lastErr = 0;
   g_alertedBlock = false;
   g_alertedNet = false;

   int rlen = ArraySize(result);
   while(rlen > 0 && result[rlen - 1] == 0) rlen--;
   response = rlen > 0 ? CharArrayToString(result, 0, rlen, CP_UTF8) : "";
   return(res);
  }

string KvGet(const string body, const string key, const string dflt = "")
  {
   string lines[];
   int n = StringSplit(body, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      string line = lines[i];
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringFind(line, key + "=") == 0)
         return(StringSubstr(line, StringLen(key) + 1));
     }
   return(dflt);
  }

string AuthUrl(const string path)
  {
   return(g_base + path + (StringFind(path, "?") >= 0 ? "&" : "?") + "token=" + g_token);
  }

string BuildBody(const string &parts[])
  {
   string out = "";
   for(int i = 0; i < ArraySize(parts); i++)
      out += parts[i] + "\n";
   return(out);
  }

//+------------------------------------------------------------------+
//| Heartbeat: account state + bridge health                          |
//+------------------------------------------------------------------+
void SendHeartbeat()
  {
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double balance= AccountInfoDouble(ACCOUNT_BALANCE);
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   double free   = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double mlevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   string mode   = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) ? "hedging" : "netting";
   int    open   = CountOwnPositions();

   string parts[];
   ArrayResize(parts, 0);
   AddKv(parts, "type", "heartbeat");
   AddKv(parts, "token", g_token);
   AddKv(parts, "version", g_version);
   AddKv(parts, "login", IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)));
   AddKv(parts, "server", AccountInfoString(ACCOUNT_SERVER));
   AddKv(parts, "build", IntegerToString((long)TerminalInfoInteger(TERMINAL_BUILD)));
   AddKv(parts, "mode", mode);
   AddKv(parts, "currency", AccountInfoString(ACCOUNT_CURRENCY));
   AddKv(parts, "equity", DoubleToString(equity, 2));
   AddKv(parts, "balance", DoubleToString(balance, 2));
   AddKv(parts, "margin", DoubleToString(margin, 2));
   AddKv(parts, "free", DoubleToString(free, 2));
   AddKv(parts, "marginlevel", DoubleToString(mlevel, 2));
   AddKv(parts, "positions", IntegerToString(open));
   AddKv(parts, "dryrun", InpDryRun ? "1" : "0");
   AddKv(parts, "eaversion", g_version);
   AddKv(parts, "capabilities", "OPEN,CLOSE,MODIFY,PARTIAL,TRAIL,SYNCSPEC");

   string resp = "";
   int status = HttpRequest("POST", g_base + "/api/bridge/heartbeat", BuildBody(parts), resp);
   if(status == 401 || status == 403)
     {
      g_authFails++;
      if(TimeCurrent() - g_lastAuthWarn >= 30)
        {
         g_lastAuthWarn = TimeCurrent();
         PrintFormat("HELIX: server rejected the agent token (HTTP %d). The token was rotated or deleted server-side. Open the Execution tab, press rotate token, and paste the new token into InpAgentToken.", status);
         if(!g_alertedAuth)
           {
            g_alertedAuth = true;
            Alert("HELIX: server rejected the agent token (HTTP ", status, ").\nThe token is invalid - it was rotated or deleted server-side.\nExecution tab -> rotate token -> paste the new hxb_... value into InpAgentToken.");
           }
        }
      return;
     }
   if(status <= 0) { g_failStreak++; return; }
   g_failStreak = 0;

   bool ks  = (KvGet(resp, "killswitch", "0") == "1");
   bool arm = (KvGet(resp, "armed", "0") == "1");
   if(ks != g_killSwitch)
      PrintFormat("HELIX: kill switch %s", ks ? "ENGAGED" : "released");
   if(ks && !g_killSwitch && InpCloseOnKillSwitch) FlattenAll("server kill switch");
   g_killSwitch = ks;
   g_armed = arm;
  }

void AddKv(string &parts[], const string k, const string v)
  {
   int n = ArraySize(parts);
   ArrayResize(parts, n + 1);
   parts[n] = k + "=" + v;
  }

int CountOwnPositions()
  {
   int c = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != InpMagic) continue;
      c++;
     }
   return(c);
  }

//+------------------------------------------------------------------+
//| Poll the order queue                                              |
//+------------------------------------------------------------------+
void PollOrders()
  {
   string resp = "";
   int status = HttpRequest("GET", AuthUrl("/api/bridge/poll?fmt=ea"), "", resp);
   if(status == 401 || status == 403) { g_authFails++; return; }
   if(status <= 0) return;
   if(KvGet(resp, "ok", "0") != "1") return;

   g_killSwitch = (KvGet(resp, "killswitch", "0") == "1");
   g_armed      = (KvGet(resp, "armed", "0") == "1");
   double lotMul   = StringToDouble(KvGet(resp, "lotmul", "1"));
   double maxSpread= StringToDouble(KvGet(resp, "maxspread", "999999"));

   int n = (int)StringToInteger(KvGet(resp, "orders", "0"));
   if(n <= 0) return;

   string lines[];
   int lc = StringSplit(resp, '\n', lines);
   int done = 0;
   for(int i = 0; i < lc && done < n; i++)
     {
      string line = lines[i];
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringFind(line, "order=") != 0) continue;
      done++;
      ExecuteOrderLine(StringSubstr(line, 6), lotMul, maxSpread);
     }
  }

//+------------------------------------------------------------------+
//| Execute a single pipe-delimited order                             |
//| id|action|symbol|SIDE|volume|price|sl|tp|comment|trail|beR|pF|pR|ttl
//+------------------------------------------------------------------+
void ExecuteOrderLine(const string line, const double lotMul, const double maxSpread)
  {
   string f[];
   int c = StringSplit(line, '|', f);
   if(c < 10) { Print("HELIX: malformed order line: ", line); return; }

   long   orderId = StringToInteger(f[0]);
   string action  = f[1];
   string symbol  = f[2];
   string side    = f[3];
   double volume  = StringToDouble(f[4]);
   double price   = StringToDouble(f[5]);
   double sl      = StringToDouble(f[6]);
   double tp      = StringToDouble(f[7]);
   string comment = f[8];
   double trailAtr= c > 10 ? StringToDouble(f[10]) : InpTrailAtrMult;
   double beAtR   = c > 11 ? StringToDouble(f[11]) : InpBreakevenAtR;

   if(!SymbolSelect(symbol, true))
     {
      ReportAck(orderId, "REJECTED", 0, "symbol not available on this terminal", 0, 0, 0, "", "");
      return;
     }
   if(g_killSwitch && action == "OPEN")
     {
      ReportAck(orderId, "REJECTED", 0, "kill switch engaged", 0, 0, 0, "", "");
      return;
     }

   // Idempotency: never execute the same order id twice (reconnect safety).
   // If a previous ack was lost in transit the server will requeue the order;
   // in that case reconcile by reporting the existing position as the fill.
   if(AlreadyExecuted(orderId))
     {
      string ticket = FindPositionTicket(symbol, comment);
      double recPx = 0.0;
      double recVol = 0.0;
      if(StringLen(ticket) > 0)
        {
         for(int i = PositionsTotal() - 1; i >= 0; i--)
           {
            if(!posInfo.SelectByIndex(i)) continue;
            if(IntegerToString((long)posInfo.Ticket()) != ticket) continue;
            recPx  = posInfo.PriceOpen();
            recVol = posInfo.Volume();
            break;
           }
        }
      PrintFormat("HELIX: order #%I64d was already executed earlier - sending reconciliation ack (ticket=%s)", orderId, ticket);
      ReportAck(orderId, "FILLED", 10009,
                recVol > 0 ? "reconciled after missed ack" : "executed earlier, position no longer open",
                recPx, recVol, 0, ticket, "");
      return;
     }

   if(action == "CLOSE")  { CloseByOrder(orderId, symbol, comment);  return; }
   if(action == "MODIFY") { ModifyByOrder(orderId, symbol, sl, tp);  return; }
   if(action == "PARTIAL"){ PartialByOrder(orderId, symbol, volume); return; }

   // ---- OPEN -------------------------------------------------------------
   int    digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double ask    = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid    = SymbolInfoDouble(symbol, SYMBOL_BID);
   long   spread = SymbolInfoInteger(symbol, SYMBOL_SPREAD);

   if(spread > maxSpread)
     {
      ReportAck(orderId, "REJECTED", 0, StringFormat("spread %I64d > max %.0f", spread, maxSpread), 0, 0, 0, "", "");
      return;
     }

   bool   isBuy  = (side == "BUY");
   double refPx  = isBuy ? ask : bid;
   double lots   = NormaliseVolume(symbol, InpRespectServerLot ? volume * lotMul * InpLotMultiplier
                                                               : LocalRiskLots(symbol, refPx, sl, isBuy));
   if(lots <= 0)
     {
      ReportAck(orderId, "REJECTED", 0, "volume rounds to zero at broker lot step", 0, 0, 0, "", "");
      return;
     }

   // Enforce the broker's minimum stop distance.
   double minDist = StopDistance(symbol);
   double useSl = sl, useTp = tp;
   if(isBuy)
     {
      if(useSl <= 0 || refPx - useSl < minDist) useSl = refPx - MathMax(minDist, MathAbs(refPx - (sl > 0 ? sl : refPx - minDist)));
      if(useTp > 0 && useTp - refPx < minDist)  useTp = refPx + minDist;
     }
   else
     {
      if(useSl <= 0 || useSl - refPx < minDist) useSl = refPx + MathMax(minDist, MathAbs((sl > 0 ? sl : refPx + minDist) - refPx));
      if(useTp > 0 && refPx - useTp < minDist)  useTp = refPx - minDist;
     }
   useSl = NormalizeDouble(useSl, digits);
   useTp = NormalizeDouble(useTp, digits);

   if(InpDryRun)
     {
      PrintFormat("HELIX DRYRUN #%I64d %s %s %.2f lots @%.5f SL=%.5f TP=%.5f (%s)",
                  orderId, side, symbol, lots, refPx, useSl, useTp, comment);
      ReportAck(orderId, "REJECTED", 0, "dry run — no order sent", 0, 0, 0, "", "");
      return;
     }

   trade.SetTypeFillingBySymbol(symbol);
   bool sent = isBuy ? trade.Buy(lots, symbol, 0.0, useSl, useTp, comment)
                     : trade.Sell(lots, symbol, 0.0, useSl, useTp, comment);
   uint   rc     = trade.ResultRetcode();
   double retcode= (double)rc;
   bool   ok     = sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL);
   string posId  = IntegerToString((long)trade.ResultDeal());
   string dealId = posId;
   string orderTicket = IntegerToString((long)trade.ResultOrder());
   double fillPx = trade.ResultPrice() > 0 ? trade.ResultPrice() : refPx;
   double fillVol= trade.ResultVolume() > 0 ? trade.ResultVolume() : lots;
   double slip   = point > 0 ? MathAbs(fillPx - refPx) / point : 0;

   if(ok) g_executed++; else g_rejected++;
   PrintFormat("HELIX #%I64d %s %s %.2f -> %s rc=%u px=%.5f vol=%.2f slip=%.1fpt ticket=%s trail=%.2f beR=%.2f %s",
               orderId, side, symbol, lots, ok ? "FILLED" : "REJECTED", rc, fillPx, fillVol, slip,
               orderTicket, trailAtr, beAtR, ok ? "" : trade.ResultRetcodeDescription());

   ReportAck(orderId,
             ok ? "FILLED" : "REJECTED",
             retcode,
             ok ? "done" : trade.ResultRetcodeDescription(),
             fillPx, fillVol, slip,
             ok ? FindPositionTicket(symbol, comment) : "",
             dealId);
  }

//+------------------------------------------------------------------+
void CloseByOrder(const long orderId, const string symbol, const string comment)
  {
   if(InpDryRun) { ReportAck(orderId, "REJECTED", 0, "dry run", 0, 0, 0, "", ""); return; }
   ulong ticket = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != symbol) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      ticket = posInfo.Ticket();
      break;
     }
   if(ticket == 0)
     {
      ReportAck(orderId, "REJECTED", 0, "no matching open position", 0, 0, 0, "", "");
      return;
     }
   trade.SetTypeFillingBySymbol(symbol);
   bool ok = trade.PositionClose(ticket);
   uint rc = trade.ResultRetcode();
   ok = ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED);
   if(ok) g_executed++; else g_rejected++;
   PrintFormat("HELIX: close %s ticket=%I64u (%s)", symbol, ticket, comment);
   ReportAck(orderId, ok ? "FILLED" : "REJECTED", (double)rc,
             ok ? "closed" : trade.ResultRetcodeDescription(),
             trade.ResultPrice(), trade.ResultVolume(), 0, IntegerToString((long)ticket), "");
  }

void ModifyByOrder(const long orderId, const string symbol, const double sl, const double tp)
  {
   ulong ticket = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != symbol) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      ticket = posInfo.Ticket(); break;
     }
   if(ticket == 0) { ReportAck(orderId, "REJECTED", 0, "no position", 0, 0, 0, "", ""); return; }
   if(InpDryRun)   { ReportAck(orderId, "REJECTED", 0, "dry run", 0, 0, 0, "", ""); return; }
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   bool ok = trade.PositionModify(ticket, NormalizeDouble(sl, digits), NormalizeDouble(tp, digits));
   uint rc = trade.ResultRetcode();
   ReportAck(orderId, ok ? "ACKED" : "REJECTED", (double)rc, ok ? "modified" : trade.ResultRetcodeDescription(), 0, 0, 0, "", "");
  }

void PartialByOrder(const long orderId, const string symbol, const double volume)
  {
   ulong ticket = 0;
   double cur = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != symbol) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      ticket = posInfo.Ticket(); cur = posInfo.Volume(); break;
     }
   if(ticket == 0) { ReportAck(orderId, "REJECTED", 0, "no position", 0, 0, 0, "", ""); return; }
   double lots = NormaliseVolume(symbol, MathMin(volume, cur));
   if(lots <= 0 || lots >= cur) { ReportAck(orderId, "REJECTED", 0, "invalid partial volume", 0, 0, 0, "", ""); return; }
   if(InpDryRun) { ReportAck(orderId, "REJECTED", 0, "dry run", 0, 0, 0, "", ""); return; }
   bool ok = trade.PositionClosePartial(ticket, lots);
   uint rc = trade.ResultRetcode();
   ReportAck(orderId, ok ? "ACKED" : "REJECTED", (double)rc, ok ? "partial close" : trade.ResultRetcodeDescription(),
             trade.ResultPrice(), lots, 0, IntegerToString((long)ticket), "");
  }

//+------------------------------------------------------------------+
//| Ack back to the OMS                                               |
//+------------------------------------------------------------------+
void ReportAck(const long orderId, const string state, const double retcode, const string text,
               const double fillPx, const double fillVol, const double slip,
               const string position, const string deal)
  {
   string parts[];
   ArrayResize(parts, 0);
   AddKv(parts, "type", "ack");
   AddKv(parts, "token", g_token);
   AddKv(parts, "order", IntegerToString(orderId));
   AddKv(parts, "state", state);
   AddKv(parts, "retcode", DoubleToString(retcode, 0));
   AddKv(parts, "text", Sanitise(text));
   AddKv(parts, "price", DoubleToString(fillPx, 8));
   AddKv(parts, "volume", DoubleToString(fillVol, 8));
   AddKv(parts, "slippage", DoubleToString(slip, 1));
   AddKv(parts, "position", position);
   AddKv(parts, "deal", deal);
   string resp = "";
   HttpRequest("POST", g_base + "/api/bridge/ack", BuildBody(parts), resp);
  }

string Sanitise(const string s)
  {
   string out = s;
   StringReplace(out, "\n", " ");
   StringReplace(out, "\r", " ");
   StringReplace(out, "|", "/");
   return(out);
  }

//+------------------------------------------------------------------+
//| Report the live book so the OMS mirror stays truthful             |
//+------------------------------------------------------------------+
void ReportPositions()
  {
   string body = "type=positions\ntoken=" + g_token + "\n";
   int n = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      string sym = posInfo.Symbol();
      double cur = SymbolInfoDouble(sym, posInfo.PositionType() == POSITION_TYPE_BUY ? SYMBOL_BID : SYMBOL_ASK);
      body += StringFormat("p=%s|%s|%s|%.8f|%.8f|%.8f|%.8f|%.8f|%.2f|%.2f|%.2f|%I64d|%s|%I64d\n",
                           IntegerToString((long)posInfo.Ticket()),
                           sym,
                           posInfo.PositionType() == POSITION_TYPE_BUY ? "buy" : "sell",
                           posInfo.Volume(),
                           posInfo.PriceOpen(),
                           cur,
                           posInfo.StopLoss(),
                           posInfo.TakeProfit(),
                           posInfo.Profit(),
                           posInfo.Swap(),
                           posInfo.Commission(),
                           posInfo.Magic(),
                           Sanitise(posInfo.Comment()),
                           (long)posInfo.Time());
      n++;
     }
   body += "count=" + IntegerToString(n) + "\n";
   string resp = "";
   HttpRequest("POST", g_base + "/api/bridge/positions", body, resp);
  }

//+------------------------------------------------------------------+
//| Publish broker contract specs (symbol mapping is data-driven)     |
//+------------------------------------------------------------------+
void ReportSymbols()
  {
   string syms[];
   int total = 0;
   if(StringLen(InpSymbolList) > 0)
      total = StringSplit(InpSymbolList, ',', syms);
   else
     {
      total = SymbolsTotal(true);
      ArrayResize(syms, total);
      for(int i = 0; i < total; i++) syms[i] = SymbolName(i, true);
     }

   string body = "type=symbols\ntoken=" + g_token + "\n";
   int sent = 0;
   for(int i = 0; i < total && sent < 60; i++)
     {
      string s = syms[i];
      StringTrimLeft(s); StringTrimRight(s);
      if(StringLen(s) == 0) continue;
      if(!SymbolSelect(s, true)) continue;
      body += StringFormat("s=%s|%.8f|%.8f|%.8f|%.8f|%.8f|%d|%d|%d|%d|%.1f|%s|%.8f\n",
                           s,
                           SymbolInfoDouble(s, SYMBOL_POINT),
                           SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE),
                           SymbolInfoDouble(s, SYMBOL_VOLUME_MIN),
                           SymbolInfoDouble(s, SYMBOL_VOLUME_MAX),
                           SymbolInfoDouble(s, SYMBOL_VOLUME_STEP),
                           (int)SymbolInfoInteger(s, SYMBOL_DIGITS),
                           (int)SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL),
                           (int)SymbolInfoInteger(s, SYMBOL_TRADE_FREEZE_LEVEL),
                           (int)SymbolInfoInteger(s, SYMBOL_TRADE_MODE),
                           (double)SymbolInfoInteger(s, SYMBOL_SPREAD),
                           SymbolInfoString(s, SYMBOL_CURRENCY_MARGIN),
                           SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE));
      sent++;
     }
   body += "count=" + IntegerToString(sent) + "\n";
   string resp = "";
   HttpRequest("POST", g_base + "/api/bridge/instruments", body, resp);
   PrintFormat("HELIX: published %d contract specifications", sent);
  }

//+------------------------------------------------------------------+
//| Local exit management — always on, even if the server dies        |
//+------------------------------------------------------------------+
void ManagePositions()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      string sym    = posInfo.Symbol();
      int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
      bool   isBuy  = (posInfo.PositionType() == POSITION_TYPE_BUY);
      double openPx = posInfo.PriceOpen();
      double curSl  = posInfo.StopLoss();
      double curTp  = posInfo.TakeProfit();
      double vol    = posInfo.Volume();
      double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
      double mark   = isBuy ? bid : ask;
      double minD   = StopDistance(sym);

      // risk unit: derive R from the original SL when present
      double riskUnit = MathAbs(openPx - (curSl > 0 ? curSl : openPx));
      if(riskUnit <= 0) riskUnit = point * 100;
      double rNow = isBuy ? (mark - openPx) / riskUnit : (openPx - mark) / riskUnit;

      double newSl = curSl;
      double newTp = curTp;
      bool   changed = false;

      // 1. breakeven ratchet
      if(InpBreakevenAtR > 0 && rNow >= InpBreakevenAtR)
        {
         double be = isBuy ? openPx + point : openPx - point;
         if(isBuy ? (curSl < be) : (curSl > be || curSl <= 0)) { newSl = be; changed = true; }
        }

      // 2. ATR trailing
      if(InpTrailAtr)
        {
         double atr = AtrValue(sym);
         if(atr > 0)
           {
            double trail = isBuy ? mark - InpTrailAtrMult * atr : mark + InpTrailAtrMult * atr;
            if(isBuy ? (trail > newSl && mark - trail >= minD) : (trail < newSl && trail - mark >= minD))
              { newSl = trail; changed = true; }
           }
        }

      // 3. partial scale-out
      if(InpPartialFraction > 0 && InpPartialAtR > 0 && rNow >= InpPartialAtR && vol > 0)
        {
         if(!WasPartialDone(posInfo.Ticket()))
           {
            double cut = NormaliseVolume(sym, vol * InpPartialFraction);
            if(cut > 0 && cut < vol)
              {
               if(InpDryRun) PrintFormat("HELIX DRYRUN partial %I64u %.2f lots", posInfo.Ticket(), cut);
               else if(trade.PositionClosePartial(posInfo.Ticket(), cut))
                    PrintFormat("HELIX: partial scale-out %I64u %.2f lots at R=%.2f", posInfo.Ticket(), cut, rNow);
               changed = false; // volume changed; re-evaluate next tick
              }
           }
        }

      if(changed)
        {
         newSl = NormalizeDouble(newSl, digits);
         newTp = NormalizeDouble(newTp, digits);
         if(InpDryRun) { PrintFormat("HELIX DRYRUN modify %s SL %.5f -> %.5f", sym, curSl, newSl); continue; }
         if(trade.PositionModify(posInfo.Ticket(), newSl, newTp))
            PrintFormat("HELIX: %s SL %.5f → %.5f (R=%.2f)", sym, curSl, newSl, rNow);
        }
     }
  }

bool WasPartialDone(const ulong ticket)
  {
   // coarse guard: only one partial per position per management cycle window
   static ulong lastTicket = 0;
   static datetime lastTime = 0;
   datetime now = TimeCurrent();
   if(lastTicket == ticket && now - lastTime < 60) return(true);
   lastTicket = ticket;
   lastTime = now;
   return(false);
  }

void FlattenAll(const string reason)
  {
   PrintFormat("HELIX: FLATTEN — %s", reason);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      if(InpDryRun) { PrintFormat("HELIX DRYRUN flatten %s", posInfo.Symbol()); continue; }
      trade.PositionClose(posInfo.Ticket());
     }
  }

//+------------------------------------------------------------------+
//| Volume / stop helpers                                             |
//+------------------------------------------------------------------+
double NormaliseVolume(const string symbol, double lots)
  {
   double minV = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxV = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   double v = MathFloor(lots / step + 1e-9) * step;
   v = MathMax(minV, MathMin(maxV, v));
   if(lots < minV) return(0.0);           // never inflate a sub-minimal order
   return(NormalizeDouble(v, 8));
  }

double StopDistance(const string symbol)
  {
   long   stops  = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   long   freeze = SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double point  = SymbolInfoDouble(symbol, SYMBOL_POINT);
   return((double)MathMax(stops, freeze) * point + point * 2.0);
  }

double LocalRiskLots(const string symbol, const double refPx, const double sl, const bool isBuy)
  {
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double risk   = equity * InpLocalRiskPct / 100.0;
   double dist   = MathAbs(refPx - (sl > 0 ? sl : refPx - StopDistance(symbol)));
   if(dist <= 0) dist = StopDistance(symbol);
   double cs     = SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double tv     = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double ts     = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double lossPerLot = (tv > 0 && ts > 0) ? (dist / ts) * tv : dist * cs;
   if(lossPerLot <= 0) return(0.0);
   return(risk / lossPerLot);
  }

double AtrValue(const string symbol)
  {
   int handle = INVALID_HANDLE;
   for(int i = 0; i < g_atrCount; i++)
      if(g_atrSym[i] == symbol) { handle = g_atrHandle[i]; break; }
   if(handle == INVALID_HANDLE)
     {
      handle = iATR(symbol, PERIOD_CURRENT, InpAtrPeriod);
      if(handle == INVALID_HANDLE) return(0.0);
      if(g_atrCount < 32) { g_atrSym[g_atrCount] = symbol; g_atrHandle[g_atrCount] = handle; g_atrCount++; }
     }
   double buf[];
   if(CopyBuffer(handle, 0, 0, 1, buf) != 1) return(0.0);
   return(buf[0]);
  }

string FindPositionTicket(const string symbol, const string comment)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != symbol) continue;
      if(InpMagic != 0 && posInfo.Magic() != InpMagic) continue;
      if(StringLen(comment) > 0 && posInfo.Comment() != comment) continue;
      return(IntegerToString((long)posInfo.Ticket()));
     }
   return("");
  }

bool AlreadyExecuted(const long orderId)
  {
   string needle = "HX-" + IntegerToString(orderId);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!posInfo.SelectByIndex(i)) continue;
      if(StringFind(posInfo.Comment(), needle) >= 0) return(true);
     }
   // also scan recent history so a restart cannot double-fire
   HistorySelect(TimeCurrent() - 86400 * 3, TimeCurrent() + 60);
   int deals = HistoryDealsTotal();
   for(int i = deals - 1; i >= 0 && i > deals - 400; i--)
     {
      ulong t = HistoryDealGetTicket(i);
      if(t == 0) continue;
      if(HistoryDealGetInteger(t, DEAL_MAGIC) != InpMagic) continue;
      string c = HistoryDealGetString(t, DEAL_COMMENT);
      if(StringFind(c, needle) >= 0) return(true);
     }
   return(false);
  }

//+------------------------------------------------------------------+
void UpdateComment()
  {
   string s = StringFormat(
      "HELIX QUANT BRIDGE v%s\n"
      "OMS      : %s\n"
      "state    : %s%s\n"
      "account  : %I64d @ %s (%s)\n"
      "equity   : %.2f %s   free margin: %.2f\n"
      "positions: %d owned by magic %I64d\n"
      "executed : %I64d   rejected: %I64d   fails: %d\n"
      "last poll: %s\n%s",
      g_version, g_base,
      g_killSwitch ? "KILL SWITCH" : (g_armed ? "ARMED" : "DISARMED"),
      InpDryRun ? " · DRY RUN" : "",
      (long)AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER),
      AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING ? "hedging" : "netting",
      AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      CountOwnPositions(), InpMagic,
      g_executed, g_rejected, g_failStreak,
      TimeToString(g_lastPoll, TIME_DATE | TIME_SECONDS),
      g_authFails > 0 && g_failStreak == 0 ? "⚠ TOKEN REJECTED by server - token was rotated or deleted. Execution tab -> rotate token -> new value into InpAgentToken."
      : g_failStreak > 0 ? StringFormat("⚠ BACKEND UNREACHABLE - error %d\n   target: %s\n   4014 = WebRequest allow list missing | anything else = wrong/old InpServerUrl or no internet", g_lastErr, g_lastUrl) : "");
   Comment(s);
  }

//+------------------------------------------------------------------+
//| One-shot symbol publication on the first tick                     |
//+------------------------------------------------------------------+
void OnTick()
  {
   static bool published = false;
   if(!published && InpReportSymbols)
     {
      published = true;
      ReportSymbols();
     }
  }
//+------------------------------------------------------------------+
