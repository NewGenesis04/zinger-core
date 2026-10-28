"""Split-sample test and capital simulation from two optimiser runs (first half, second half).
Usage: python3 scripts/mm_walkforward_capital.py <dir-with-train-and-test> <full-run-dir>"""
import json, sys
import numpy as np
F, FULL = sys.argv[1], sys.argv[2]
tr = json.load(open(f"{F}/train/param-optimiser.json"))["markets"]
te = json.load(open(f"{F}/test/param-optimiser.json"))["markets"]
full = json.load(open(f"{FULL}/param-optimiser.json"))["markets"]
out = {"walkforward": {}, "uniform": {}, "capital": [], "interaction": []}

for grp in ("deep", "thin"):
    ins = oos = cap = 0.0; n = pos = 0
    for cid, m in tr.items():
        if m.get("group") != grp or cid not in te: continue
        b = m["best"]; t = te[cid]["grid"].get(f"{b['offsetTicks']}:{b['sizeMult']}")
        if not t: continue
        n += 1; ins += b["netUsdPerDay"]; oos += t["netUsdPerDay"]; cap += t["capitalUsd"]; pos += t["netUsdPerDay"] > 0
    agg = {}
    for m in tr.values():
        if m.get("group") != grp: continue
        for k, g in m["grid"].items(): a = agg.setdefault(k, [0, 0]); a[0] += g["netUsdPerDay"]; a[1] += g["capitalUsd"]
    bk = max(agg, key=lambda k: agg[k][0])
    tn = sum(te[c]["grid"][bk]["netUsdPerDay"] for c in te if te[c].get("group") == grp and bk in te[c]["grid"])
    tc = sum(te[c]["grid"][bk]["capitalUsd"] for c in te if te[c].get("group") == grp and bk in te[c]["grid"])
    out["walkforward"][grp] = dict(markets=n, positiveOOS=pos, inSampleNet=ins, outOfSampleNet=oos, capital=cap,
                                   rate=oos / cap * 100 if cap else 0, groupSetting=bk, groupTrainNet=agg[bk][0], groupTestNet=tn, groupTestCap=tc)
    rows = {}
    for k in range(4):
        key = f"{k}:1"; mk = [m for m in full.values() if m.get("group") == grp and key in m["grid"]]
        r = sum(m["grid"][key]["rewardUsdPerDay"] for m in mk); a = sum(m["grid"][key]["adverseUsdPerDay"] for m in mk); c = sum(m["grid"][key]["capitalUsd"] for m in mk)
        f = sum(m["grid"][key]["fillsPerDay"] for m in mk)
        rows[k] = dict(reward=r, adverse=a, net=r + a, rate=(r + a) / c * 100 if c else 0, fills=f, capital=c)
    out["uniform"][grp] = rows

pts = [(g["fillsPerDay"], g["netUsdPerDay"] / g["capitalUsd"] * 100) for m in full.values() if m.get("group") == "deep" for g in m["grid"].values() if g["capitalUsd"] > 0]
for lo, hi, lab in ((0, 0.5, "<0.5"), (0.5, 5, "0.5-5"), (5, 20, "5-20"), (20, 1e9, "20+")):
    s = [v for f, v in pts if lo <= f < hi]
    if s: out["interaction"].append(dict(bin=lab, n=len(s), median=float(np.median(s)), positive=100 * sum(1 for x in s if x > 0) / len(s)))

mk = []
for cid, m in tr.items():
    if m.get("group") != "deep" or cid not in te: continue
    off = m["best"]["offsetTicks"]
    trg = {s: m["grid"].get(f"{off}:{s}") for s in (1, 2, 4)}; teg = {s: te[cid]["grid"].get(f"{off}:{s}") for s in (1, 2, 4)}
    if not all(trg.values()) or not all(teg.values()): continue
    rank = trg[1]["netUsdPerDay"] / trg[1]["capitalUsd"]
    if rank > 0: mk.append((rank, cid, teg))
mk.sort(key=lambda x: -x[0])
for C in (100, 200, 250, 500, 1000, 2500, 5000, 10000, 20000):
    alloc = {}; used = 0.0
    for r, cid, teg in mk:
        if used + teg[1]["capitalUsd"] <= C: alloc[cid] = 1; used += teg[1]["capitalUsd"]
    for mult in (2, 4):
        for r, cid, teg in mk:
            if cid in alloc:
                extra = teg[mult]["capitalUsd"] - teg[alloc[cid]]["capitalUsd"]
                if used + extra <= C: used += extra; alloc[cid] = mult
    net = sum(next(x for x in mk if x[1] == cid)[2][s]["netUsdPerDay"] for cid, s in alloc.items())
    rate = net / used * 100 if used else 0
    out["capital"].append(dict(capital=C, deployed=used, markets=len(alloc), net=net, rate=rate,
                               m30=100 * ((1 + rate / 100) ** 30 - 1), m30usd=used * ((1 + rate / 100) ** 30 - 1)))
out["positiveFirstHalfMarkets"] = len(mk)
json.dump(out, open(f"{F}/results.json", "w"), indent=1)
print(json.dumps({"walkforward": out["walkforward"], "interaction": out["interaction"]}, indent=1))
for r in out["capital"]: print("cap $%6d deployed $%7.0f mkts %2d net $%7.2f/d %+.3f%%/d 30d %+.2f%% ($%+.0f)" % (r["capital"], r["deployed"], r["markets"], r["net"], r["rate"], r["m30"], r["m30usd"]))
for g, rows in out["uniform"].items():
    for k, r in rows.items(): print(g, "off", k, "reward %.2f adverse %+.2f net %+.2f rate %+.3f fills %.0f" % (r["reward"], r["adverse"], r["net"], r["rate"], r["fills"]))
