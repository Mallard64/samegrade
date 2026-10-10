"""Run a recommended option live, on real test cases, and print one JSON line per finished (test case, run).

  python live_run.py --option cheap --sets fresh3 --runs 1 --max-usd 1     # luna x3 + local llama tone, both fixes
  python live_run.py --option sol --cases t21,t36 --runs 3                 # gpt-5.6-sol everywhere + the tone fix

Unlike every other script here this does NOT replay: it sets LLM_NO_CACHE so each call goes to the model (and is
paid). Nothing is read from or written to results/llm_calls.jsonl, and rows go to a new file
results/agent__live-<option>-<utc time>.jsonl, so no recorded baseline or report is touched. The dashboard's
"Run live" button starts this and shows the rows as they arrive.

Stdout is JSON lines: {"event": "start"|"row"|"done"|"error", ...}. The run stops by itself once it has spent --max-usd.
"""
import argparse
import json
import os
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

os.environ["LLM_NO_CACHE"] = "1"
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import support_agent as A  # noqa: E402
from assign import new_prompts  # noqa: E402
from stepfinder import plan_of, spec  # noqa: E402

SETS = {"dev": "agent", "hard": "agent_hard", "holdout2": "agent_holdout2", "fresh3": "agent_fresh3", "fresh4": "agent_fresh4"}
FIX_LINE = 3  # classify: "Extract the order ID ..."
FIXED = ("Extract the order ID if the ticket gives one: the letter A followed by 4 digits (e.g. A1234). Customers "
         "may type it in lowercase or with a #; return it in uppercase without the # (a1234 -> A1234). "
         "Use null if there is none.")


def emit(**ev):
    print(json.dumps(ev, ensure_ascii=False), flush=True)


def build(option):
    """The exact setups the reports tested (mix_retest.py for 'cheap', assign.py's new_prompts for 'sol')."""
    prompts, _patch, _tag = new_prompts()
    if option == "sol":
        return plan_of(spec("gpt-5.6-sol", {}, prompts), {}), "gpt-5.6-sol + tone fix"
    classify = list(A.PROMPTS["classify"])
    assert classify[FIX_LINE].startswith("Extract the order ID"), classify[FIX_LINE]
    classify[FIX_LINE] = FIXED
    mix = {**prompts, "classify": classify}
    luna = spec("gpt-5.6-luna", {}, mix)
    llama = spec("ollama/llama3.1:8b", {"temperature": 0.0}, mix)
    return plan_of(luna, {"tone": llama}), "cheapest mix + classify and tone fixes"


def preflight(plan):
    models = {p["model"] for p in plan.values()}
    if any(not m.startswith("ollama/") for m in models) and not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY isn't set where the dashboard server runs. Start it with the key set (npm start).")
    if any(m.startswith("ollama/") for m in models):
        base = os.environ.get("OLLAMA_BASE", "http://localhost:11434")
        try:
            urllib.request.urlopen(base + "/api/tags", timeout=3).read()
        except Exception:
            raise SystemExit(f"The tone step runs on a local model, but Ollama isn't answering at {base}. Start Ollama.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--option", choices=["cheap", "sol"], required=True)
    ap.add_argument("--sets", default="", help="comma list of: " + ", ".join(SETS) + ", all")
    ap.add_argument("--cases", default="", help="comma list of test case ids (instead of --sets)")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--max-usd", type=float, default=2.0)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    try:
        names = list(SETS) if args.sets == "all" else [x for x in args.sets.split(",") if x]
        bad = [n for n in names if n not in SETS]
        if bad:
            raise SystemExit(f"unknown set(s) {bad}")
        cases = A.load_tickets(sets=tuple(SETS[n] for n in names)) if names else A.load_tickets(sets="all")
        if args.cases:
            want = set(args.cases.split(","))
            cases = [t for t in cases if t["id"] in want]
        elif not names:
            raise SystemExit("choose --sets or --cases")
        if not cases:
            raise SystemExit("no test cases matched")
        if not 1 <= args.runs <= 3:
            raise SystemExit("--runs must be 1 to 3")
        plan, label = build(args.option)
        preflight(plan)
    except SystemExit as e:
        emit(event="error", message=str(e))
        sys.exit(1)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = HERE / "results" / f"agent__live-{args.option}-{stamp}.jsonl"
    jobs = [(t, r) for r in range(1, args.runs + 1) for t in cases]
    emit(event="start", option=args.option, label=label, total=len(jobs), ids=[t["id"] for t in cases], runs=args.runs,
         file=out.name, max_usd=args.max_usd, models={s: p["model"] for s, p in plan.items()})
    lock, spent, stop = threading.Lock(), [0.0], threading.Event()

    def work(t, r):
        if stop.is_set():
            return None
        row = A.record_row(t, r, plan, f"live-{args.option}")
        usd = sum((s.get("cost_usd") or 0) for s in row.get("steps") or [])
        with lock:
            spent[0] += usd
            with open(out, "a") as f:
                f.write(json.dumps(row) + "\n")
            if spent[0] >= args.max_usd:
                stop.set()
        d = row.get("decision") or {}
        return {"event": "row", "id": t["id"], "run": r, "text": t["text"], "error": row.get("error"),
                "output": None if row.get("error") else f"[{row.get('category')} / {d.get('action')}]\n{row.get('final_reply') or ''}".strip(),
                "passed": bool(row.get("passed_all")) if not row.get("error") else None,
                "failed": sorted(k for k, v in (row.get("checks") or {}).items() if v is False),
                "cost_usd": round(usd, 6), "spent_usd": round(spent[0], 6),
                "latency_s": round(sum((s.get("latency_s") or 0) for s in row.get("steps") or []), 2)}

    n = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for fut in as_completed([pool.submit(work, t, r) for t, r in jobs]):
            ev = fut.result()
            if ev:
                n += 1
                emit(**ev)
    emit(event="done", rows=n, total=len(jobs), spent_usd=round(spent[0], 6), stopped_on_budget=stop.is_set() and n < len(jobs), file=out.name)


if __name__ == "__main__":
    main()
