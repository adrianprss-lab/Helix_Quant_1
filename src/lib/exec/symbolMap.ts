import { UNIVERSE } from "@/lib/quant/data";

/**
 * MT5 symbol -> internal ticker resolution.
 *
 * Every broker spells the same instrument differently (EURUSD, EURUSD.pro,
 * EURUSDm, EU.m; BTCUSD, BTCUSDm, BITCOIN; US500, SPX500, US500CASH). The EA
 * reports what the broker actually calls it and this table collapses it back
 * onto the research universe. Anything unmatched can still be mapped manually
 * from the Execution tab.
 */
const ALIASES: Record<string, string[]> = {
  EURUSD: ["EURUSD", "EURUSDm", "EURUSDpro", "EURUSDRAW", "EU", "EURUSDa", "EURUSDc"],
  XAUUSD: ["XAUUSD", "GOLD", "XAUUSDm", "XAUUSDpro", "XAU", "GOLDm", "GOLDa"],
  SPX500: ["US500", "SPX500", "SPX", "USX500", "SP500", "US500CASH", "SPX500m", "USA500", "SPXm"],
  NDX100: ["US100", "NDX100", "NAS100", "USTEC", "NDX", "US100CASH", "NAS100m", "USA100", "TEC100"],
  BTCUSDT: ["BTCUSD", "BTCUSDT", "BTCUSDm", "BITCOIN", "BTC", "BTCUSDpro", "BTCUSDa"],
  ETHUSDT: ["ETHUSD", "ETHUSDT", "ETHUSDm", "ETHEREUM", "ETH", "ETHUSDpro"],
  SOLUSDT: ["SOLUSD", "SOLUSDT", "SOLUSDm", "SOLANA", "SOL"],
  BNBUSDT: ["BNBUSD", "BNBUSDT", "BNBUSDm", "BNB"],
};

const REVERSE: Record<string, string> = {};
for (const [ticker, aliases] of Object.entries(ALIASES)) {
  for (const a of aliases) REVERSE[normalise(a)] = ticker;
}
for (const u of UNIVERSE) REVERSE[normalise(u.ticker)] = u.ticker;

function normalise(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const CRYPTO_BASES = ["BTC", "ETH", "SOL", "BNB"];

export interface SymbolMatch {
  ticker: string | null;
  confidence: "exact" | "alias" | "prefix" | "none";
}

export function matchTicker(symbol: string): SymbolMatch {
  const ns = normalise(symbol);
  if (!ns) return { ticker: null, confidence: "none" };
  if (REVERSE[ns]) {
    return { ticker: REVERSE[ns], confidence: UNIVERSE.some((u) => u.ticker === ns) ? "exact" : "alias" };
  }
  // strip a trailing broker suffix letter (EURUSDm / EURUSDa / EURUSDc)
  const stripped = ns.replace(/(M|A|C|PRO|RAW|ECN|ZERO|PLUS)$/i, "");
  if (REVERSE[stripped]) return { ticker: REVERSE[stripped], confidence: "alias" };
  // crypto base asset, e.g. BTCUSD / BTCUSDC / BTC
  for (const base of CRYPTO_BASES) {
    if (ns.startsWith(base)) {
      const hit = UNIVERSE.find((u) => u.ticker.startsWith(base));
      if (hit) return { ticker: hit.ticker, confidence: "prefix" };
    }
  }
  // generic prefix against the universe
  for (const u of UNIVERSE) {
    const nu = normalise(u.ticker);
    if (ns.startsWith(nu) || nu.startsWith(ns)) return { ticker: u.ticker, confidence: "prefix" };
  }
  return { ticker: null, confidence: "none" };
}

/** Best-guess MT5 symbol for an internal ticker on a given broker. */
export function suggestSymbol(ticker: string, knownSymbols: string[]): string {
  const exact = knownSymbols.find((s) => normalise(s) === normalise(ticker));
  if (exact) return exact;
  const alias = (ALIASES[ticker] ?? []).find((a) => knownSymbols.some((s) => normalise(s) === normalise(a)));
  if (alias) return knownSymbols.find((s) => normalise(s) === normalise(alias)) ?? alias;
  const crypto = CRYPTO_BASES.find((b) => ticker.startsWith(b));
  if (crypto) {
    const hit = knownSymbols.find((s) => normalise(s).startsWith(crypto));
    if (hit) return hit;
  }
  return ticker;
}

export const KNOWN_ALIASES = ALIASES;
