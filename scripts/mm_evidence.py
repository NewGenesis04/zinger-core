"""Out-of-sample evidence for the MM live gate (src/research/mm/live/gate.ts).

Replays each recorded day (scripts/mm-reward-projection.mts output) under ONE configuration fixed
in advance: both sides, $50 and 200 shares per market, competition floor 10,000, $5 market stop.
Only days whose recording started after FIXED_AT count, so no day that was used to pick these
settings can be evidence for them. Days shorter than MIN_MINUTES are listed but not counted.

    python3 scripts/mm_evidence.py [--root tmp/commercial-evidence/mm-reward-projection] [--out tmp/mm-live/evidence.json]

Writes the file the gate reads (positiveOutOfSampleDays, portfolioNetUsdPerDay) plus every day's
detail. A replay of public trades checked once a minute: fills, the stop exit and inventory marks
are approximations of the live runner, which quotes one tick behind the touch.
"""
import argparse, bisect, collections, datetime, json, os, sys

FIXED_AT = "2026-10-28T12:00:00Z"  # settings chosen from the 18-27 Oct replay (docs/MM_CONTROLS_2026-10-28.md)
CONFIG = {"capShares": 200, "marketUsd": 50, "minCompetition": 10_000, "marketStopUsd": 5, "sides": "both"}
MIN_MINUTES = 1380  # a day missing more than an hour does not count


def side_score(price, mid, v, size):
    s = abs(price - mid)
    return size * ((v - s) / v) ** 2 if s <= v else 0.0


def load_day(path):
    meta = {m["id"]: m for m in json.load(open(os.path.join(path, "markets.json")))}
    rows = collections.defaultdict(dict)
    for line in open(os.path.join(path, "samples.jsonl")):
        o = json.loads(line)
        if "market" in o:
            rows[o["market"]][o["at"]] = o
    mids = collections.defaultdict(dict)
    for line in open(os.path.join(path, "snapshots.jsonl")):
        o = json.loads(line)
        m = o.get("mid")
        if m is None and o.get("bids") and o.get("asks"):
            m = (max(x["price"] for x in o["bids"]) + min(x["price"] for x in o["asks"])) / 2
        if m is not None:
            mids[o["market"]][o["at"]] = m
    ats = sorted({a for r in rows.values() for a in r})
    fills = collections.defaultdict(list)
    fills_path = os.path.join(path, "fills.jsonl")
    for line in open(fills_path) if os.path.exists(fills_path) else []:
        f = json.loads(line)
        i = bisect.bisect_right(ats, f["at"]) - 1
        if i >= 0:
            fills[f["market"]].append((i, 1 if f["side"] == "BUY" else -1, f["price"], f["shares"]))
    markets = {}
    for mk, r in rows.items():
        pool = meta.get(mk, {}).get("dailyPool", 0)
        seq, last_mid = [], None
        for a in ats:
            o = r.get(a, {})
            mid = mids[mk].get(a, o.get("mid", last_mid))
            if mid is not None:
                last_mid = mid
            rec = None
            if o.get("share") is not None:
                v, size = o["maxSpread"], o["minSize"]
                sb, sa = side_score(o["bestBid"], o["mid"], v, size), side_score(o["bestAsk"], o["mid"], v, size)
                rec = (o["bestBid"], o["bestAsk"], min(o["competitionBid"], o["competitionAsk"]),
                       (sb / (sb + o["competitionBid"]) if sb else 0) * pool / 1440,
                       (sa / (sa + o["competitionAsk"]) if sa else 0) * pool / 1440)
            seq.append((mid, rec))
        markets[mk] = {"q": meta.get(mk, {}).get("question", ""), "seq": seq, "fills": sorted(fills.get(mk, []))}
    return len(ats), markets


def replay(minutes, markets, c=CONFIG):
    """Same rules as the 28 Oct sweep: quote both sides while reward-scored, cap inventory, stop and flatten at the touch."""
    reward = inventory = 0.0
    per = []
    for mk, m in markets.items():
        seq, fl = m["seq"], m["fills"]
        pos = cash = rew = 0.0
        stopped, fi, quoted = False, 0, [None] * len(seq)
        for i, (mid, rec) in enumerate(seq):
            q = (False, False)
            if mid is not None and not stopped and rec is not None and rec[2] >= c["minCompetition"]:
                bb, ba, _, rb, ra = rec
                qb = pos < min(c["capShares"], c["marketUsd"] / max(bb, 0.01)) - 1e-9
                qa = pos > -min(c["capShares"], c["marketUsd"] / max(1 - ba, 0.01)) + 1e-9
                q = (qb, qa)
                if qb and qa:
                    rew += min(rb, ra)
                elif qb or qa:
                    rew += (rb if qb else ra) / 3 if 0.1 <= mid <= 0.9 else 0.0
            quoted[i] = q
            while fi < len(fl) and fl[fi][0] <= i:
                j, sgn, px, sh = fl[fi]; fi += 1
                qb, qa = quoted[j] or (False, False)
                if (sgn > 0 and not qb) or (sgn < 0 and not qa):
                    continue
                lim = min(c["capShares"], c["marketUsd"] / max(px if pos + sgn * sh > 0 else 1 - px, 0.01))
                new = max(-lim, min(lim, pos + sgn * sh))
                cash -= (new - pos) * px; pos = new
            if mid is not None and not stopped and cash + pos * mid + rew < -c["marketStopUsd"]:
                bb, ba = (rec[0], rec[1]) if rec else (mid, mid)
                cash += pos * (bb if pos > 0 else ba); pos = 0.0; stopped = True
        last = next((s[0] for s in reversed(seq) if s[0] is not None), 0)
        inv = cash + pos * last
        reward += rew; inventory += inv
        if rew or inv or stopped:
            per.append({"market": m["q"][:80], "rewardUsd": round(rew, 4), "inventoryUsd": round(inv, 4), "stopped": stopped})
    per.sort(key=lambda x: x["rewardUsd"] + x["inventoryUsd"])
    scale = 1440 / max(minutes, 1)
    quoted_markets = len(per)
    return {"rewardUsd": round(reward, 4), "inventoryUsd": round(inventory, 4), "netUsd": round(reward + inventory, 4),
            "netUsdPerDay": round((reward + inventory) * scale, 4), "marketsTraded": quoted_markets,
            "stops": sum(1 for p in per if p["stopped"]), "worst": per[:3], "best": per[-3:][::-1]}


def run_started_at(run_id):
    try:
        return datetime.datetime.strptime(run_id[:19], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="tmp/commercial-evidence/mm-reward-projection")
    ap.add_argument("--out", default="tmp/mm-live/evidence.json")
    a = ap.parse_args()
    fixed = datetime.datetime.fromisoformat(FIXED_AT.replace("Z", "+00:00"))
    days = []
    for run_id in sorted(os.listdir(a.root)):
        path, started = os.path.join(a.root, run_id), run_started_at(run_id)
        if started is None or not os.path.exists(os.path.join(path, "snapshots.jsonl")) or started < fixed:
            continue
        minutes, markets = load_day(path)
        r = replay(minutes, markets)
        counts = minutes >= MIN_MINUTES
        days.append({"run": run_id, "minutes": minutes, "counts": counts, **r})
        print(f"{run_id}: {minutes} min {'counts' if counts else 'too short, listed only'} | reward {r['rewardUsd']:.2f} inventory {r['inventoryUsd']:.2f} net/day {r['netUsdPerDay']:.2f} stops {r['stops']}", file=sys.stderr)
    counted = [d for d in days if d["counts"]]
    evidence = {
        "positiveOutOfSampleDays": sum(1 for d in counted if d["netUsdPerDay"] > 0),
        "negativeOutOfSampleDays": sum(1 for d in counted if d["netUsdPerDay"] <= 0),
        "portfolioNetUsdPerDay": round(sum(d["netUsdPerDay"] for d in counted) / len(counted), 4) if counted else 0.0,
        "fixedAt": FIXED_AT, "config": CONFIG, "minMinutes": MIN_MINUTES,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "method": "replay of public-trade fills at the touch, one-minute samples; see scripts/mm_evidence.py",
        "days": days,
    }
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(evidence, fh, indent=1)
    print(json.dumps({k: evidence[k] for k in ["positiveOutOfSampleDays", "negativeOutOfSampleDays", "portfolioNetUsdPerDay", "fixedAt"]}))


if __name__ == "__main__":
    main()
