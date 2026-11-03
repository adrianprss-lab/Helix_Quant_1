//+------------------------------------------------------------------+
//|                                                HelixDiagnose.mq5 |
//|  Standalone connectivity diagnosis for the HELIX QUANT bridge.   |
//|                                                                  |
//|  How to use:                                                     |
//|    1. Save into MQL5/Scripts/  (data folder, NOT MQL5/Experts)   |
//|    2. MetaEditor: open it, press F7 (compile), close MetaEditor  |
//|    3. In the MT5 TERMINAL: Ctrl+N (Navigator) -> node "Scripts"  |
//|       right-click -> Refresh, then DOUBLE-CLICK "HelixDiagnose"  |
//|       (scripts cannot be started from MetaEditor, only compiled) |
//|    4. The inputs window opens: paste the CURRENT OMS URL, OK     |
//|    5. Read the "Experts" tab (Ctrl+T) and send the printed block |
//|       between the === lines to your HELIX operator.              |
//|                                                                  |
//|  Needs NO chart, NO EA and NO token. It only answers one         |
//|  question: can this terminal reach the OMS over HTTPS, and if    |
//|  not, which layer blocks it.                                     |
//+------------------------------------------------------------------+
#property copyright "HELIX QUANT"
#property version   "1.01"
#property script_show_inputs

input string InpServerUrl = "https://3000-izhe5sk5d9s71ojfzo12n.e2b.app"; // OMS base URL (no trailing slash)
input string InpTestPath  = "/api/health";                                 // endpoint to probe
input int    InpTimeout   = 10000;                                         // timeout ms

void OnStart()
  {
   string verdict = "";
   Print("=========================================================");
   Print("HELIX DIAGNOSE v1.00 — ", TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS));
   Print("---------------------------------------------------------");

   // 1) terminal online?
   bool connected = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   PrintFormat("[1] terminal internet connection : %s", connected ? "YES" : "NO  <-- MT5 itself is offline!");

   // 2) algo trading state (informational only, does not affect WebRequest)
   bool algo = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   PrintFormat("[2] algo trading allowed         : %s", algo ? "yes" : "no (does not block WebRequest)");

   // 3) build info
   PrintFormat("[3] terminal build               : %I64d", TerminalInfoInteger(TERMINAL_BUILD));

   // 4) the actual probe
   string url = InpServerUrl;
   while(StringLen(url) > 0 && StringGetCharacter(url, StringLen(url) - 1) == '/')
      url = StringSubstr(url, 0, StringLen(url) - 1);
   string full = url + InpTestPath;
   PrintFormat("[4] probing                      : %s", full);

   uchar  req[];
   uchar  res[];
   string resHeaders = "";
   ArrayResize(req, 0);
   ResetLastError();
   int code = WebRequest("GET", full, "", InpTimeout, req, res, resHeaders);
   int err = GetLastError();

   if(code == -1)
     {
      PrintFormat("[4] result                       : TRANSPORT FAILURE (WebRequest returned -1), GetLastError=%d", err);
      if(err == 4014)
        {
         verdict = "MT5 BLOCKS the request (error 4014). Add this exact line to Tools > Options > Expert Advisors > WebRequest list: " + url;
         Print("[!] VERDICT: MT5 blocked the request (error 4014).");
         Print("[!] FIX    : Tools -> Options -> Expert Advisors");
         Print("[!]          tick 'Allow WebRequest for the following URL'");
         Print("[!]          and add EXACTLY this line (https:// included, no trailing slash):");
         PrintFormat("[!]              %s", url);
        }
      else if(err == 5200 || err == 5201 || err == 5202)
        {
         verdict = "Internet/DNS/TLS layer failed (error " + IntegerToString(err) + "). Proxy, antivirus or DNS is intercepting HTTPS.";
         Print("[!] VERDICT: internet/DNS/TLS layer failed (", err, "). Check the machine's internet, DNS and that no proxy/AV intercepts HTTPS.");
        }
      else if(err == 4008 || err == 4009)
        {
         verdict = "Timeout/connection reset (error " + IntegerToString(err) + "). A firewall drops the connection on the way.";
         Print("[!] VERDICT: timeout / connection reset (", err, "). Server unreachable from this network, or a firewall drops it.");
        }
      else
        {
         verdict = "Unknown transport error " + IntegerToString(err) + " - send the whole Experts block to the HELIX operator.";
         Print("[!] VERDICT: unknown transport error ", err, " — send this whole block to the HELIX operator.");
        }
     }
   else
     {
      string body = "";
      int n = ArraySize(res);
      while(n > 0 && res[n - 1] == 0) n--;
      body = n > 0 ? CharArrayToString(res, 0, n, CP_UTF8) : "";
      PrintFormat("[4] result                       : HTTP %d, body: %s", code, body);
      if(code == 200)
        {
         verdict = "TRANSPORT OK (HTTP 200). The terminal reaches the server - the remaining problem is the agent token or an old URL inside the EA inputs.";
         Print("[!] VERDICT: transport is FINE. The terminal reaches the OMS.");
         Print("[!]          If the EA still reports no connection, the problem is");
         Print("[!]          the agent token (InpAgentToken) or an old URL inside the EA inputs.");
        }
      else
        {
         verdict = "Server answered with HTTP " + IntegerToString(code) + " - send this to the HELIX operator.";
         PrintFormat("[!] VERDICT: server answered but with HTTP %d — send this to the HELIX operator.", code);
        }
     }

   Print("=========================================================");
   Print("HELIX DIAGNOSE finished. Copy everything between the === lines.");

   // Unmissable: pop the verdict into a modal dialog as well.
   Alert("HELIX DIAGNOSE v1.01\n\n", verdict, "\n\n(target: ", full, ")");
  }
//+------------------------------------------------------------------+
