"""Open the migration pull request in the app repo (config/target_repo.yml) with the changes a reviewer kept.

  echo '{"changes": [{"id": "model", "decision": "accepted"}, {"id": "line0", "decision": "accepted"}]}' | python open_pr.py

Called by the dashboard (POST /api/create-pr, slide 4). Change ids match the PR slide: "model" is the per-step
model change, "line<i>" is the i-th prompt edit of the recommended option in reports/demo/results.json. Decisions: "accepted" applies the
change as tested, "edited" applies the reviewer's text (marked untested in the PR), anything else leaves it out.

Clones the repo into a temp folder, checks each prompt line still says what upshift tested, commits on
upshift/<model>-<hash of the applied changes>, pushes and runs `gh pr create`. The branch name depends only on
the applied changes, so asking again for the same changes returns the PR that is already open.
Prints JSON: {"url", "branch", "existed", "applied", "skipped"} or {"error"}.
"""
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).parent
INCLUDED = {"accepted", "edited"}


def sh(*cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(f"{cmd[0]} {cmd[1]} failed: {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout.strip()


OPTIONS = {"cheap": "recommended", "sol": "fallback"}


def plan(changes, demo, option="cheap"):
    """Which changes to apply, with the text to apply. Returns (applied, skipped).
    option: "cheap" (the cheapest model per step) or "sol" (gpt-5.6-sol everywhere + the tone fix)."""
    rec = demo[OPTIONS[option]]
    by_id = {c.get("id"): c for c in changes}
    defs = [{"id": "model", "kind": "model", "old": demo["pair"]["old"], "new": rec["assignment"], "params": rec["params"]}]
    defs += [{"id": f"line{i}", "kind": "line", "step": e["step"], "line_index": e["line_index"],
              "old": e["old"], "new": e["new"]} for i, e in enumerate(rec["edits"])]
    applied, skipped = [], []
    for d in defs:
        c = by_id.get(d["id"], {})
        decision = c.get("decision")
        if decision not in INCLUDED:
            skipped.append({**d, "decision": decision or "pending"})
            continue
        text = d["new"]
        if decision == "edited":
            text = str(c.get("text") or "").strip()
            if d["kind"] == "model":
                # One "<step>: <model>" per line; steps left out keep the tested model.
                found = dict(re.findall(r"^\s*(\w+):\s*([\w.\-:/]+)", text, flags=re.M))
                if not found:
                    raise ValueError("the edited model change needs lines like '<step>: <model>'")
                text = {**d["new"], **{k: v for k, v in found.items() if k in d["new"]}}
            elif not text:
                raise ValueError(f"the edited text for {d['id']} is empty")
        applied.append({**d, "decision": decision, "apply": text})
    return applied, skipped


def set_step_model(text, step, model, keep_temperature):
    """Rewrite steps.<step>.model in config.yml; drop temperature for models that reject it."""
    m = re.search(rf"^  {step}:\n((?:    .*\n?)*)", text, flags=re.M)
    if not m:
        raise RuntimeError(f"config.yml has no steps.{step}")
    block = re.sub(r"^(\s*model:\s*).*$", rf"\g<1>{model}", m.group(1), flags=re.M)
    if not keep_temperature:
        block = re.sub(r"^\s*temperature:.*\n?", "", block, flags=re.M)
    return text[:m.start(1)] + block + text[m.end(1):]


def apply(repo_dir, target, applied):
    for ch in applied:
        if ch["kind"] == "model":
            path = repo_dir / target["config_file"]
            text = path.read_text()
            for step, model in ch["apply"].items():
                if not re.search(rf"^  {step}:\n(?:    .*\n)*?    model: {re.escape(ch['old'])}\b", text, flags=re.M):
                    raise RuntimeError(f"{target['config_file']} steps.{step} no longer uses {ch['old']}; nothing to migrate")
                text = set_step_model(text, step, model, "temperature" in ch["params"].get(step, {}))
            path.write_text(text)
        else:
            path = repo_dir / target["prompts_dir"] / f"{ch['step']}.txt"
            lines = path.read_text().split("\n")
            i = ch["line_index"]
            if i >= len(lines) or lines[i] != ch["old"]:
                raise RuntimeError(f"{path.name} line {i + 1} has changed since upshift tested it; re-run upshift first")
            lines[i] = ch["apply"]
            path.write_text("\n".join(lines))


def body(data, target, applied, skipped, option="cheap"):
    demo = data["demo"]
    if option == "sol":
        return body_sol(data, target, applied, skipped)
    rec, old = demo["recommended"], demo["pair"]["old"]
    r = demo["pool"]["retest"]
    total = r["dev"]["of"] + r["holdout2_seen"]["of"] + r["fresh3"]["mix"]["of"]
    worse = r["dev"]["regressed"] + r["holdout2_seen"]["regressed"] + r["fresh3"]["mix"]["regressed"]
    first_try = demo["pool"]["mix"]["holdout2"]["regressed"]
    rows = []
    for ch in applied:
        if ch["kind"] == "model":
            moves = ", ".join(f"`{s}` → `{m}`" for s, m in ch["apply"].items())
            what = f"Models: {moves} (was `{old}` on every step; `temperature: 0` removed where the new model rejects it)"
        else:
            what = f"`{target['prompts_dir']}/{ch['step']}.txt` line {ch['line_index'] + 1}"
        note = " **Edited by the reviewer; not re-tested.** Re-run upshift before merging." if ch["decision"] == "edited" else ""
        rows.append(f"- {what}.{note}")
        if ch["kind"] == "line":
            rows.append(f"  ```diff\n  - {ch['old']}\n  + {ch['apply']}\n  ```")
    left_out = "".join(f"\n- Not included ({ch['decision']}): {ch['id']}" for ch in skipped)
    local = ", ".join(f"`{s}`" for s in rec["self_hosted_steps"])
    return f"""## Why
`{old}` shuts down on Oct 23, 2026. This moves each step of the agent to the cheapest model that passed it.

## What changes
{chr(10).join(rows)}{left_out}

## What upshift found
- Each step was tested alone against `{old}`; the cheapest model that passed it was kept.
- The first combined run had {len(first_try)} test case get worse ({', '.join(first_try)}): the classify step dropped an order ID typed in lowercase ("a1005"). The classify line above fixes it.
- {local} runs on a local open-source model, so it needs Ollama (or equivalent) where the agent runs.

## Evidence
- Test cases that got worse after the fix: {worse} of {total} (24 practice, 12 held-out, {r['fresh3']['mix']['of']} fresh; 3 runs each). The fresh set is small, so treat this as encouraging, not proof.
- Model cost per 1,000 test cases: ${demo['totals_usd_per_1k']['all_old']:.2f} → ${rec['usd_per_1k']:.2f} in API calls, plus about {round(rec['self_hosted_tokens_per_ticket'])} tokens per test case on your own computer (not priced).
- Safer, costlier fallback: `gpt-5.6-sol` on every step plus a tone-line fix, ${demo['fallback']['usd_per_1k']:.2f} per 1,000 test cases.
- The test cases are hand-written; the model outputs are real recorded runs.

Opened by upshift from the reviewer's decisions on the dashboard.
"""


def body_sol(data, target, applied, skipped):
    demo = data["demo"]
    c, p, t, old = demo["confidence"], demo["patch"], demo["totals_usd_per_1k"], demo["pair"]["old"]
    after = data["candidates"][0]["summary"]["verdict_counts_after_fix"]["REGRESSED"]
    rows = []
    for ch in applied:
        if ch["kind"] == "model":
            moves = ", ".join(f"`{s}` → `{m}`" for s, m in ch["apply"].items())
            what = f"Models: {moves} (was `{old}` on every step; `temperature: 0` removed: the new model rejects it)"
        else:
            what = f"`{target['prompts_dir']}/{ch['step']}.txt` line {ch['line_index'] + 1}"
        note = " **Edited by the reviewer; not re-tested.** Re-run upshift before merging." if ch["decision"] == "edited" else ""
        rows.append(f"- {what}.{note}")
        if ch["kind"] == "line":
            rows.append(f"  ```diff\n  - {ch['old']}\n  + {ch['apply']}\n  ```")
    left_out = "".join(f"\n- Not included ({ch['decision']}): {ch['id']}" for ch in skipped)
    repaired = next(s["repair"]["n"] for s in demo["per_step"] if s["guilty"])
    return f"""## Why
`{old}` shuts down on Oct 23, 2026. This moves the agent to `{demo['pair']['new']}`.

## What changes
{chr(10).join(rows)}{left_out}

## What upshift found
- Switching only the model, the **tone** step started deleting the "5–7 business days" refund timeline from replies.
- Putting `{old}` back at the tone step alone fixes {repaired}/{c['regressed_dev']} broken test cases; no other step fixes any.
- Removing tone line {p['edits'][0]['line_index'] + 1} alone fixes them too; the prompt change above rewrites that line.

## Evidence
- Test cases that got worse: {c['regressed_dev'] + c['regressed_heldout_before']} → {after} of {c['dev_tickets'] + c['heldout_tickets']} ({c['runs_per_ticket']} runs each), including {p['heldout_before']['REGRESSED']} → {p['heldout_after']['REGRESSED']} on {c['heldout_tickets']} test cases the fix never saw.
- Replies passing every check: {demo['quality']['old']['passed_all']:.1%} before, {demo['quality']['new_fixed']['passed_all']:.1%} after.
- Model cost per 1,000 test cases: ${t['all_old']:.2f} → ${demo['fallback']['usd_per_1k']:.2f}.
- The test cases are hand-written; the model outputs are real recorded runs.

Opened by upshift from the reviewer's decisions on the dashboard.
"""


def main():
    req = json.load(sys.stdin)
    target = yaml.safe_load((HERE / "config" / "target_repo.yml").read_text())
    data = json.loads((HERE / "reports" / "demo" / "results.json").read_text())
    demo = data["demo"]
    option = req.get("option") or "cheap"
    if option not in OPTIONS:
        raise ValueError(f"unknown option {option!r}")
    applied, skipped = plan(req.get("changes") or [], demo, option)
    if not applied:
        raise ValueError("accept or edit at least one change first")
    digest = hashlib.sha256(json.dumps([[c["id"], c["apply"]] for c in applied]).encode()).hexdigest()[:8]
    branch = f"upshift/{'cheaper-models' if option == 'cheap' else demo['pair']['new']}-{digest}"
    repo = target["repo"]
    out = {"branch": branch, "repo": repo, "applied": [c["id"] for c in applied], "skipped": [c["id"] for c in skipped]}

    existing = json.loads(sh("gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url") or "[]")
    if existing:
        print(json.dumps({**out, "url": existing[0]["url"], "existed": True}))
        return
    with tempfile.TemporaryDirectory(prefix="upshift-pr-") as tmp:
        d = Path(tmp) / "repo"
        sh("gh", "repo", "clone", repo, str(d), "--", "--depth", "1", "--branch", target["base"])
        sh("git", "checkout", "-b", branch, cwd=d)
        apply(d, target, applied)
        sh("git", "add", "-A", cwd=d)
        sh("git", "commit", "-m", f"Move the support agent off {demo['pair']['old']} to {'cheaper models' if option == 'cheap' else demo['pair']['new']}", cwd=d)
        # upshift/* branches belong to upshift: overwrite one left behind by a closed PR.
        sh("git", "push", "--force", "-u", "origin", branch, cwd=d)
        has_line = any(c["kind"] == "line" for c in applied)
        title = (f"Move the support agent to cheaper models" + ("; keep lowercase order IDs working" if has_line else "") if option == "cheap"
                 else f"Move the support agent to {demo['pair']['new']}" + ("; keep the refund timeline in the tone check" if has_line else ""))
        bf = Path(tmp) / "body.md"
        bf.write_text(body(data, target, applied, skipped, option))
        url = sh("gh", "pr", "create", "--repo", repo, "--base", target["base"], "--head", branch,
                 "--title", title, "--body-file", str(bf), cwd=d).splitlines()[-1]
    print(json.dumps({**out, "url": url, "existed": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # the dashboard shows this message
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
