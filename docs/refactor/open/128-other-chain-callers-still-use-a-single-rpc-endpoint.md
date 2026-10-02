> Open item 128 — filed 2026-10-02.

### 128. Other chain callers still use a single RPC endpoint

Item 127 gave the readiness client a fallback list. These still read `POLY.polygonRpc` alone: `server.ts:111`, `trade.ts:25`, `swap.ts:8`, `deposits.ts:9`, `api/pilotLedger.ts:16`. One overloaded endpoint can still fail them. Fix: build their clients from `POLY.polygonRpcUrls` the same way, ideally via one shared client factory so there is a single owner. Not done; `trade.ts` is the live order path (see item 32), so it needs care.
