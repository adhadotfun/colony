"""
COLONY ingest v3: liquid mid-cap universe on Base, last 48 hours.

Why the universe changed. v1 and v2 both sampled NEW Uniswap V2 WETH pairs. That
population is 98% stillborn: across 89 launches in a fixed 6 hour window, 88 had
a ceiling of 77 transfers and 23 holders in their first three hours. Inputs and
outcome were both constant, so no model of any kind could score better than
noise. That is a selection failure, not a mapping failure.

So the question changes from "which new launches die" (unanswerable on free data)
to "among tokens that genuinely trade, does holder distribution predict holder
growth". Same engine, a universe that actually varies.

Universe rule: CoinGecko base-ecosystem tokens, excluding stablecoins and wrapped
majors, market cap 10M..600M, 24h volume above 1M. These are mid-caps: real
holder churn, transfer counts small enough to replay from public logs.

Leakage structure is unchanged and still strict:
    epochs 0..29    scoring window, the worm reads these
    epochs 3..43    forward outcomes, k = 3, 7, 14 measured from each scored epoch
No forward information reaches any input. Every score at epoch e uses only
epochs <= e.

Known bias, stated plainly: this universe is chosen on CURRENT liquidity, so it
is survivorship-selected relative to "all tokens that ever launched". It is the
right universe for the growth question and the wrong universe for a death
prediction question. The v1 cohort was the reverse. Neither is free.
"""
import json, os, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from core.http_client import proxied_post

H = {"SC-CALLER-ID": "chat:4897"}
URL = "https://mainnet.base.org"
PAGE = 1800
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x0000000000000000000000000000000000000000"
DEAD = "0x000000000000000000000000000000000000dead"

EPOCH_BLOCKS = 1800      # 1 hour on Base
N_EPOCHS = 48            # 48 hours of history
SCORE_EPOCHS = 30        # epochs 0..29 are scored
MAX_TOKENS = 36
MAX_LOGS_PER_PAGE = 9000  # a page this full means the token is bridge-scale, skip it

# universe filter
MCAP_MIN, MCAP_MAX = 10_000_000, 600_000_000
VOL_MIN = 1_000_000
EXCLUDE_SYMBOLS = {
    "WETH", "USDC", "USDT", "DAI", "USDS", "EURC", "AUSD", "CRVUSD", "USDE",
    "WBTC", "TBTC", "CBETH", "JITOSOL", "WSTETH", "WEETH", "RETH", "MSETH",
    "LINK", "ICP", "TAO", "CHZ", "SAND", "COMP", "CRV", "ZEN",
}

CALLS = {"n": 0, "429": 0}


def rpc(method, params, tries=6):
    last = None
    for a in range(tries):
        try:
            r = proxied_post(URL, json={"jsonrpc": "2.0", "id": 1, "method": method,
                                        "params": params}, headers=H, timeout=45)
            CALLS["n"] += 1
            if r.status_code == 200:
                j = r.json()
                if "result" in j:
                    return j["result"]
                last = j.get("error", {}).get("message", "?")
                if "limit" in str(last).lower() or "many" in str(last).lower():
                    raise OversizedToken(last)
            elif r.status_code == 429:
                CALLS["429"] += 1
                time.sleep(3 * (2 ** a))
                continue
            else:
                last = f"http {r.status_code}"
        except OversizedToken:
            raise
        except Exception as e:
            last = str(e)[:100]
        time.sleep(0.8 * (a + 1))
    raise RuntimeError(last)


class OversizedToken(Exception):
    pass


def paged_logs(frm, to, address, workers=3):
    pages = [(b, min(b + PAGE - 1, to)) for b in range(frm, to + 1, PAGE)]

    def one(rng):
        res = rpc("eth_getLogs", [{"fromBlock": hex(rng[0]), "toBlock": hex(rng[1]),
                                   "address": address, "topics": [TRANSFER]}])
        if len(res) > MAX_LOGS_PER_PAGE:
            raise OversizedToken(f"{len(res)} logs in one hour")
        return res

    out = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(one, r) for r in pages]
        for f in as_completed(futs):
            out.extend(f.result())
    return out


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


def replay(tr, start_block, n_epochs):
    """Opening balances are unknown (we only see the 48h window), so holder_count
    here means ACTIVE holders: addresses with a positive net position accumulated
    within the window. new_holders means first-time-seen buyers. Both are
    window-relative and that is stated in the output meta."""
    excl = {ZERO, DEAD}
    bal, ever = {}, set()
    snaps, idx = [], 0
    for e in range(n_epochs):
        end = start_block + (e + 1) * EPOCH_BLOCKS - 1
        new_h = cnt = 0
        sells = buys = 0
        while idx < len(tr) and tr[idx][0] <= end:
            _, _, f, t, v = tr[idx]
            cnt += 1
            if f != ZERO:
                prev_f = bal.get(f, 0)
                bal[f] = prev_f - v
                if prev_f > 0 and bal[f] <= 0:
                    sells += 1
            if t != ZERO:
                prev = bal.get(t, 0)
                bal[t] = prev + v
                if t not in excl and prev <= 0 and bal[t] > 0:
                    buys += 1
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
            "exits": sells, "entries": buys,
            "supply_held": str(supply),
            "hhi": hhi, "gini": gini(holders.values()) if hc >= 2 else None,
            "gini_reliable": bool(hc >= 10), "transfers_in_epoch": cnt,
        })
    return snaps


def main():
    uni = json.load(open("output/colony/data/base_universe.json"))
    picks = [u for u in uni
             if u["symbol"] not in EXCLUDE_SYMBOLS
             and MCAP_MIN <= u["mcap"] <= MCAP_MAX
             and u["vol"] >= VOL_MIN][:MAX_TOKENS]
    print(f"universe {len(uni)} -> mid-cap picks {len(picks)}", flush=True)
    for p in picks:
        print(f"   {p['symbol']:>10} vol=${p['vol']:>12,.0f} mcap=${p['mcap']:>12,.0f}", flush=True)

    head = int(rpc("eth_blockNumber", []), 16)
    start = head - N_EPOCHS * EPOCH_BLOCKS
    print(f"\nhead={head} window {start}..{head} ({N_EPOCHS}h)\n", flush=True)

    tokens, lines, skipped = [], [], []
    t0 = time.time()
    for i, p in enumerate(picks):
        if time.time() - t0 > 1500:
            lines.append("TRUNCATED on time budget")
            break
        try:
            ts = time.time()
            logs = paged_logs(start, head, p["contract"])
            tr = parse_transfers(logs)
            if len(tr) < 200:
                skipped.append(f"{p['symbol']} too quiet ({len(tr)} transfers)")
                print(f"  skip {p['symbol']}: only {len(tr)} transfers", flush=True)
                continue
            snaps = replay(tr, start, N_EPOCHS)
            tokens.append({
                "token": p["contract"], "symbol": p["symbol"], "cg_id": p["id"],
                "market_cap": p["mcap"], "volume_24h": p["vol"],
                "start_block": start, "total_transfers": len(tr), "snapshots": snaps,
            })
            hc = [s["holder_count"] for s in snaps]
            ln = (f"{p['symbol']:>10} tr={len(tr):>6} {time.time()-ts:>4.0f}s "
                  f"active_holders {hc[0]}->{hc[29]}->{hc[47]} "
                  f"hhi {snaps[0]['hhi']}->{snaps[29]['hhi']}")
            lines.append(ln)
            print(f"[{len(tokens)}] {ln}", flush=True)
        except OversizedToken as ex:
            skipped.append(f"{p['symbol']} oversized: {str(ex)[:70]}")
            print(f"  skip {p['symbol']}: oversized ({str(ex)[:60]})", flush=True)
        except Exception as ex:
            skipped.append(f"{p['symbol']} FAIL {str(ex)[:90]}")
            print(f"  fail {p['symbol']}: {str(ex)[:80]}", flush=True)

    out = {
        "meta": {
            "chain": "base", "chain_id": 8453, "rpc": URL, "head_block": head,
            "window": {"start_block": start, "end_block": head},
            "blocks_per_epoch": EPOCH_BLOCKS, "epoch_wallclock": "1 hour",
            "n_epochs": N_EPOCHS, "score_epochs": SCORE_EPOCHS,
            "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "tokens_selected": len(tokens), "rpc_calls": CALLS["n"],
            "universe_rule": (
                f"CoinGecko base-ecosystem tokens with a Base contract, excluding stablecoins "
                f"and wrapped majors, market cap {MCAP_MIN/1e6:.0f}M..{MCAP_MAX/1e6:.0f}M and "
                f"24h volume above {VOL_MIN/1e6:.0f}M, then any token whose hourly transfer "
                f"volume is bridge-scale is dropped as unreplayable."),
            "holder_definition": (
                "window-relative. Opening balances before the 48h window are not visible in "
                "logs, so holder_count means addresses holding a positive net position "
                "ACCUMULATED INSIDE the window, and new_holders means first seen buying here. "
                "This measures marginal holder flow, not the token's total holder base."),
            "known_bias": (
                "the universe is selected on CURRENT liquidity, so it is survivorship-selected "
                "against all tokens ever launched. Correct universe for a growth question, "
                "wrong one for a death-prediction question."),
        },
        "skipped": skipped,
        "tokens": tokens,
    }
    os.makedirs("output/colony/data", exist_ok=True)
    json.dump(out, open("output/colony/data/snapshots_v3.json", "w"))
    open("output/colony/data/ingest_log_v3.txt", "w").write(
        "\n".join(lines + ["", "--- skipped ---"] + skipped) + "\n")
    print(f"\nDONE tokens={len(tokens)} skipped={len(skipped)} calls={CALLS['n']} "
          f"429s={CALLS['429']} wall={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
