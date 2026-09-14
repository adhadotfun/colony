"""
COLONY incremental ingest for Robinhood Chain (4663).

The original ingest rebuilt every token from its launch block on every run,
which costs ~1.31M blocks of eth_getLogs per token. That is fine once and
hopeless on a cron. This module keeps the fold state (per address balance,
the ever seen set, the read cursor) on disk, so a scheduled run only has to
read the blocks that landed since the last one.

State lives in data/ingest_state.json and is the authority for what has been
counted. snapshots_v3.json is a derived artifact: epochs are appended to it,
never recomputed, so a published epoch can not silently change.

Two invariants the cron depends on:
  - an epoch is only emitted once its final block is at least CONFIRMATIONS
    behind head, so a reorg near the tip can not rewrite a published row
  - the fold is strictly append only; if the cursor and the snapshot disagree
    the run aborts rather than guessing
"""
import json, os, time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

URL = "https://rpc.mainnet.chain.robinhood.com"
UA = {"User-Agent": "curl/8.4.0", "Content-Type": "application/json"}

CHAIN_ID = 4663
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x0000000000000000000000000000000000000000"
DEAD = "0x000000000000000000000000000000000000dead"

EPOCH_BLOCKS = 35363          # 1 hour at ~0.1018 s per block
LOG_CAP = 9000                # bisect a range when the node returns a full page
CONFIRMATIONS = 600           # ~1 min of blocks held back from publication

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


def head_block():
    return int(rpc("eth_blockNumber", []), 16)


def get_logs(frm, to, address=None, topics=None, depth=0):
    p = {"fromBlock": hex(frm), "toBlock": hex(to)}
    if address:
        p["address"] = address
    if topics:
        p["topics"] = topics
    try:
        res = rpc("eth_getLogs", [p])
    except RuntimeError:
        if frm >= to or depth > 14:
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


def fold(tr, state, curve, launch_block, first_epoch, last_epoch):
    """Fold transfers into the running balance state, emitting one row per epoch.

    state carries bal (address -> int) and ever (set of addresses that have ever
    held a positive balance). Both are mutated in place; the caller persists them.
    """
    excl = {ZERO, DEAD, curve.lower()}
    bal, ever = state["bal"], state["ever"]
    snaps, idx = [], 0
    for e in range(first_epoch, last_epoch + 1):
        end = launch_block + (e + 1) * EPOCH_BLOCKS - 1
        new_h = to_lp = cnt = entries = exits = 0
        while idx < len(tr) and tr[idx][0] <= end:
            _, _, f, t, v = tr[idx]
            cnt += 1
            if f != ZERO:
                prev_f = bal.get(f, 0)
                bal[f] = prev_f - v
                if f not in excl and prev_f > 0 and bal[f] <= 0:
                    exits += 1
            if t == curve.lower():
                to_lp += v
            if t != ZERO:
                prev = bal.get(t, 0)
                bal[t] = prev + v
                if t not in excl and prev <= 0 and bal[t] > 0:
                    entries += 1
                    if t not in ever:
                        ever.add(t)
                        new_h += 1
            idx += 1
        holders = {a: b for a, b in bal.items() if b > 0 and a not in excl}
        supply = sum(holders.values())
        hc = len(holders)
        hhi = round(sum((b / supply) ** 2 for b in holders.values()) * 10000, 2) if supply > 0 else None
        snaps.append({
            "epoch": e, "block": end, "holder_count": hc, "new_holders": new_h,
            "entries": entries, "exits": exits,
            "supply_held": str(supply), "value_to_lp": str(to_lp),
            "hhi": hhi, "gini": gini(holders.values()) if hc >= 2 else None,
            "gini_reliable": bool(hc >= 10), "transfers_in_epoch": cnt,
        })
    return snaps


def epochs_available(launch_block, safe_head):
    """How many whole epochs have closed at least CONFIRMATIONS behind head."""
    if safe_head < launch_block:
        return 0
    return max(0, (safe_head - launch_block + 1) // EPOCH_BLOCKS)


def advance_token(tok, state, safe_head, max_new_epochs):
    """Read the blocks this token still owes and append the epochs they close."""
    launch = tok["launch_block"]
    have = state["epochs"]
    want = min(epochs_available(launch, safe_head), have + max_new_epochs)
    if want <= have:
        return [], 0
    frm = launch + have * EPOCH_BLOCKS
    to = launch + want * EPOCH_BLOCKS - 1
    tr = parse_transfers(get_logs(frm, to, tok["token"], [TRANSFER]))
    snaps = fold(tr, state, tok["pair"], launch, have, want - 1)
    state["epochs"] = want
    state["cursor"] = to
    return snaps, len(tr)


def load_state(path):
    if not os.path.exists(path):
        return {}
    raw = json.load(open(path))
    out = {}
    for k, v in raw.items():
        out[k] = {"bal": {a: int(b) for a, b in v["bal"].items()},
                  "ever": set(v["ever"]), "epochs": v["epochs"], "cursor": v["cursor"]}
    return out


def save_state(path, states):
    # only non zero balances are persisted; a zeroed address is recoverable from
    # ever, and dropping them keeps the file small on a disk that is near full
    out = {}
    for k, v in states.items():
        out[k] = {"bal": {a: str(b) for a, b in v["bal"].items() if b != 0},
                  "ever": sorted(v["ever"]), "epochs": v["epochs"], "cursor": v["cursor"]}
    tmp = path + ".tmp"
    json.dump(out, open(tmp, "w"))
    os.replace(tmp, path)
