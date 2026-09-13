"""
COLONY ingest: real per-epoch holder snapshots for a Robinhood Chain cohort.

Chain 4663. Blocks land about every 0.1 s, so an hour is ~35,363 blocks and the
37 epoch run needs ~1.31M blocks of history per token. The public node serves
that happily as long as a single eth_getLogs response stays under its result
cap, so ranges are split by bisection only when a response comes back full.

Venue note, and this is the one real difference from the Base run: launches on
Robinhood Chain do not happen as Uniswap V2 WETH pairs. They happen on Pons V2
bonding curves quoted in USDG, which is where essentially all new token
activity on this chain lives. Porting the Base rule literally would have
measured a venue nobody uses. The principle is unchanged: every token launched
inside one fixed window, no survivorship filter, dead ones stay in the sample.

The node rejects non-curl user agents, so requests go direct with a curl UA
rather than through the shared proxy client, which rewrites that header.
"""
import json, os, time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

URL = "https://rpc.mainnet.chain.robinhood.com"
UA = {"User-Agent": "curl/8.4.0", "Content-Type": "application/json"}

CHAIN_ID = 4663
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# Pons V2 launch factory and its TokenLaunched topic. topics: [sig, token,
# curve, creator]; data: [metadataId, 0, graduationThresholdUSDG].
FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"
LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
ZERO = "0x0000000000000000000000000000000000000000"
DEAD = "0x000000000000000000000000000000000000dead"

EPOCH_BLOCKS = 35363             # 1 hour at 0.1018 s per block
N_EPOCHS = 37
LAUNCH_WINDOW = EPOCH_BLOCKS     # 1 hour wide launch window
LOG_CAP = 9000                   # split the range if a response comes back this full

CALLS = {"n": 0}


def rpc(method, params, tries=5):
    last = None
    for a in range(tries):
        try:
            r = requests.post(URL, json={"jsonrpc": "2.0", "id": 1, "method": method,
                                         "params": params}, headers=UA, timeout=60)
            CALLS["n"] += 1
            if r.status_code == 200:
                j = r.json()
                if "result" in j:
                    return j["result"]
                last = str(j.get("error", {}).get("message", "?"))[:120]
            else:
                last = f"http {r.status_code}"
        except Exception as e:
            last = str(e)[:100]
        time.sleep(0.6 * (a + 1))
    raise RuntimeError(last)


def get_logs(frm, to, address=None, topics=None, depth=0):
    """One call per range, bisecting only when the node returns a full page."""
    p = {"fromBlock": hex(frm), "toBlock": hex(to)}
    if address:
        p["address"] = address
    if topics:
        p["topics"] = topics
    try:
        res = rpc("eth_getLogs", [p])
    except RuntimeError:
        if frm >= to or depth > 12:
            raise
        res = None
    if res is not None and len(res) < LOG_CAP:
        return res
    if frm >= to:
        return res or []
    mid = (frm + to) // 2
    return (get_logs(frm, mid, address, topics, depth + 1) +
            get_logs(mid + 1, to, address, topics, depth + 1))


def parse_transfers(logs):
    tr = []
    for l in logs:
        tp = l["topics"]
        if len(tp) < 3:
            continue
        d = l.get("data", "0x")
        try:
            v = int(d, 16) if d not in ("0x", "") else 0
        except ValueError:
            continue
        tr.append((int(l["blockNumber"], 16), int(l["logIndex"], 16),
                   "0x" + tp[1][-40:], "0x" + tp[2][-40:], v))
    tr.sort(key=lambda x: (x[0], x[1]))
    return tr


def gini(vals):
    v = sorted(x for x in vals if x > 0)
    n = len(v)
    if n < 2:
        return None
    tot = sum(v)
    if tot == 0:
        return None
    cum = sum(i * x for i, x in enumerate(v, 1))
    return round((2 * cum) / (n * tot) - (n + 1) / n, 4)


def build_snapshots(tr, launch_block, curve):
    excl = {ZERO, DEAD, curve.lower()}
    bal, ever = {}, set()
    snaps, idx = [], 0
    for e in range(N_EPOCHS):
        end = launch_block + (e + 1) * EPOCH_BLOCKS - 1
        new_h = to_lp = cnt = 0
        while idx < len(tr) and tr[idx][0] <= end:
            _, _, f, t, v = tr[idx]
            cnt += 1
            if f != ZERO:
                bal[f] = bal.get(f, 0) - v
            if t == curve.lower():
                to_lp += v
            if t != ZERO:
                prev = bal.get(t, 0)
                bal[t] = prev + v
                if t not in excl and prev <= 0 and bal[t] > 0 and t not in ever:
                    ever.add(t)
                    new_h += 1
            idx += 1
        holders = {a: b for a, b in bal.items() if b > 0 and a not in excl}
        supply = sum(holders.values())
        hc = len(holders)
        hhi = round(sum((b / supply) ** 2 for b in holders.values()) * 10000, 2) if supply > 0 else None
        snaps.append({
            "epoch": e, "block": end, "holder_count": hc, "new_holders": new_h,
            "supply_held": str(supply), "value_to_lp": str(to_lp),
            "hhi": hhi, "gini": gini(holders.values()) if hc >= 2 else None,
            "gini_reliable": bool(hc >= 10), "transfers_in_epoch": cnt,
        })
    return snaps


def one_token(c, span_needed):
    logs = get_logs(c["launch_block"], c["launch_block"] + span_needed,
                    c["token"], [TRANSFER])
    return c, parse_transfers(logs)


def main():
    limit = int(os.environ.get("COLONY_TOKENS", "30"))
    budget = int(os.environ.get("COLONY_BUDGET", "2400"))
    head = int(rpc("eth_blockNumber", []), 16)
    span_needed = N_EPOCHS * EPOCH_BLOCKS
    end = head - span_needed
    start = end - LAUNCH_WINDOW
    print(f"head={head} launch window {start}..{end} "
          f"(epoch={EPOCH_BLOCKS}b, need {span_needed}b per token)", flush=True)

    launches = get_logs(start, end, FACTORY, [LAUNCHED])
    print(f"TokenLaunched: {len(launches)} ({CALLS['n']} calls)", flush=True)

    cands, seen = [], set()
    for l in launches:
        tok = "0x" + l["topics"][1][-40:]
        if tok in seen:
            continue
        seen.add(tok)
        cands.append({"token": tok, "pair": "0x" + l["topics"][2][-40:],
                      "creator": "0x" + l["topics"][3][-40:],
                      "launch_block": int(l["blockNumber"], 16)})
    print(f"distinct launches: {len(cands)}", flush=True)

    lines, tokens = [], []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(one_token, c, span_needed): c for c in cands}
        for f in as_completed(futs):
            c = futs[f]
            if len(tokens) >= limit or time.time() - t0 > budget:
                f.cancel()
                continue
            try:
                c, tr = f.result()
            except Exception as ex_:
                lines.append(f"{c['token']} FAIL {str(ex_)[:120]}")
                continue
            if len(tr) < 20:
                lines.append(f"{c['token']} SKIP {len(tr)} transfers")
                continue
            snaps = build_snapshots(tr, c["launch_block"], c["pair"])
            if max(s["holder_count"] for s in snaps) < 10:
                lines.append(f"{c['token']} SKIP peak holders < 10")
                continue
            tokens.append({"token": c["token"], "pair": c["pair"],
                           "creator": c["creator"],
                           "launch_block": c["launch_block"],
                           "total_transfers": len(tr), "snapshots": snaps})
            ln = (f"{c['token']} tr={len(tr)} h0={snaps[0]['holder_count']} "
                  f"h29={snaps[29]['holder_count']} h36={snaps[36]['holder_count']}")
            lines.append(ln)
            print(f"[{len(tokens)}/{limit}] {ln}", flush=True)

    out = {
        "meta": {
            "chain": "robinhood", "chain_id": CHAIN_ID, "rpc": URL, "head_block": head,
            "cohort_window": {"start_block": start, "end_block": end, "widened": False},
            "blocks_per_epoch": EPOCH_BLOCKS, "epoch_wallclock": "1 hour",
            "n_epochs": N_EPOCHS,
            "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "candidates_found": len(cands), "tokens_selected": len(tokens),
            "rpc_calls": CALLS["n"],
            "venue": {"factory": FACTORY, "kind": "Pons V2 bonding curve", "quote": USDG},
            "selection_rule": ("every token launched on the Pons V2 bonding curve factory "
                               "inside a fixed 1 hour window on Robinhood Chain, requiring at "
                               "least 20 transfers and a peak of 10 holders; no survivorship "
                               "or liveness filter"),
            "epoch_note": ("epochs are 1 hour, which is 35,363 blocks at the chain's ~0.1 s "
                           "block time; the 37 epoch run covers ~1.31M blocks per token"),
            "venue_note": ("Robinhood Chain launches are Pons V2 curves quoted in USDG, not "
                           "Uniswap V2 WETH pairs, so the cohort rule targets that factory"),
        },
        "tokens": tokens,
    }
    os.makedirs("output/colony/data", exist_ok=True)
    json.dump(out, open("output/colony/data/snapshots_rh.json", "w"))
    open("output/colony/data/ingest_log_rh.txt", "w").write("\n".join(lines) + "\n")
    print(f"DONE tokens={len(tokens)} calls={CALLS['n']} wall={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
