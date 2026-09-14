"""
One time bootstrap for the incremental ingest.

Replays every cohort token from its launch block to the current safe head,
which is the same work the original ingest did, and writes two things:

  data/ingest_state.json   the fold state the cron continues from
  data/snapshots_v3.json   the existing 37 epochs plus every epoch that has
                           closed since, appended

The replay recomputes the original 37 epochs as a side effect, so it is also
a regression test: if a recomputed row does not match the published row byte
for byte on the fields that matter, the run aborts and writes nothing. That
guarantees the state the cron inherits produces the numbers already public.
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from colony_incremental import (  # noqa: E402
    CALLS, CONFIRMATIONS, EPOCH_BLOCKS, TRANSFER, epochs_available, fold,
    get_logs, head_block, parse_transfers, save_state,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
SNAPS = os.path.join(DATA, "snapshots_v3.json")
STATE = os.path.join(DATA, "ingest_state.json")

CHECK_FIELDS = ("epoch", "block", "holder_count", "new_holders", "entries",
                "exits", "supply_held", "hhi")


def one(tok, want_epochs):
    launch = tok["launch_block"]
    to = launch + want_epochs * EPOCH_BLOCKS - 1
    tr = parse_transfers(get_logs(launch, to, tok["token"], [TRANSFER]))
    state = {"bal": {}, "ever": set(), "epochs": 0, "cursor": to}
    snaps = fold(tr, state, tok["pair"], launch, 0, want_epochs - 1)
    state["epochs"] = want_epochs
    return tok, state, snaps, len(tr)


def main():
    max_workers = int(os.environ.get("COLONY_WORKERS", "4"))
    cap = int(os.environ.get("COLONY_MAX_EPOCHS", "0"))  # 0 = as many as closed

    ds = json.load(open(SNAPS))
    toks = ds["tokens"]
    head = head_block()
    safe = head - CONFIRMATIONS
    print(f"head={head} safe={safe} tokens={len(toks)}", flush=True)

    plan = {}
    for t in toks:
        avail = epochs_available(t["launch_block"], safe)
        if cap:
            avail = min(avail, cap)
        plan[t["token"]] = max(avail, len(t["snapshots"]))
    print(f"epochs per token: min={min(plan.values())} max={max(plan.values())} "
          f"(published now {len(toks[0]['snapshots'])})", flush=True)

    states, newsnaps, t0 = {}, {}, time.time()
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(one, t, plan[t["token"]]): t for t in toks}
        for i, f in enumerate(as_completed(futs), 1):
            t = futs[f]
            tok, state, snaps, ntr = f.result()
            # regression gate against what is already published
            for old in t["snapshots"]:
                new = snaps[old["epoch"]]
                for k in CHECK_FIELDS:
                    if k in old and old[k] != new[k]:
                        raise SystemExit(
                            f"MISMATCH {tok['token']} epoch {old['epoch']} {k}: "
                            f"published {old[k]} recomputed {new[k]}")
            states[tok["token"]] = state
            newsnaps[tok["token"]] = snaps
            print(f"[{i}/{len(toks)}] {tok['token']} tr={ntr} epochs={len(snaps)} "
                  f"h_last={snaps[-1]['holder_count']} calls={CALLS['n']}", flush=True)

    for t in toks:
        t["snapshots"] = newsnaps[t["token"]]
    n = min(len(t["snapshots"]) for t in toks)
    ds["meta"]["head_block"] = head
    ds["meta"]["safe_head"] = safe
    ds["meta"]["n_epochs"] = n
    ds["meta"]["confirmations"] = CONFIRMATIONS
    ds["meta"]["generated_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ds["meta"]["ingest_mode"] = "incremental"

    tmp = SNAPS + ".tmp"
    json.dump(ds, open(tmp, "w"))
    os.replace(tmp, SNAPS)
    save_state(STATE, states)
    print(f"DONE epochs={n} calls={CALLS['n']} wall={time.time()-t0:.0f}s "
          f"state={os.path.getsize(STATE)//1024}KB snaps={os.path.getsize(SNAPS)//1024}KB",
          flush=True)


if __name__ == "__main__":
    main()
