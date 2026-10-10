# upshift

**Move an LLM pipeline off a retiring model, and prove what broke.**

`gpt-4` and `gpt-3.5-turbo` shut down on **Oct 23, 2026**. Swapping the model name is the easy part. Prompts that worked on the old model can quietly fail on the new one. upshift replays your real test cases on the old and new models, finds *which step* and *which prompt line* broke, ships the smallest fix, and re-runs everything to prove the fix worked. A person reviews each change and decides.

| Question | How upshift answers it |
|---|---|
| **Where** did it break? | **Step-finder.** In a multi-step agent, swap the model back one step at a time. If putting the old model on step *k* makes the failures go away, step *k* is causal. |
| **What** broke? | **Line-finder.** Remove or neutralize each prompt line on the new model and re-run. Lines are ranked by their measured effect, not by a guess. |
| **Is it really broken?** | A test case only counts as worse when it fails beyond the old model's own run-to-run noise (3 runs each). |
| **What's the fix?** | A minimal diff to the lines that caused it, not a rewrite of the prompt. Each change is accepted, edited or rejected on its own. |
| **Does the fix hold?** | The full suite re-runs, including test cases the fixer never saw. |

Other tools rewrite the whole prompt and score the app end to end. upshift's claim is narrower: it proves which step and which lines broke, and changes only those.

## What the demo shows

The demo app is a 4-step support agent (`classify → decide → draft → tone`) with fake, deterministic tools, so any difference between runs comes from the models. 56 hand-written test cases in four sets: practice (24), hard (12), holdout (12) and newest (8), 3 runs each, all real recorded model outputs.

- **gpt-5.6-sol as a drop-in** broke the **tone** step: it deleted the "5–7 business days" refund timeline from replies. Putting gpt-4 back on `tone` alone repaired the broken test cases; no other step did. One tone line was the cause, and a one-line edit fixed it.
- **Recommended: the cheapest model that passes each step.** `classify`, `decide` and `draft` on `gpt-5.6-luna`, `tone` on a local `llama3.1:8b`, plus two prompt lines (classify accepts lowercase order IDs; tone keeps the refund timeline; the mix was tested with both). **$39.32 → $0.31 per 1,000 test cases** in API calls, and 0 of 44 test cases got worse after the fix.
- **Caveats:** the newest set is only 8 test cases, so this is encouraging, not proof. The local model's cost is shown as tokens (about 363 per test case), not dollars. Hardware and electricity aren't counted.
- **Safer, costlier fallback:** `gpt-5.6-sol` on every step plus the tone fix, $7.84 per 1,000 test cases, 0 of 36 test cases (24 practice + 12 hard) worse after the fix, 0 of 12 on the holdout set and 0 of 8 on the newest.
- **Step-finder benchmark** (9 planted breaks, 39 localized test cases): 34/39 exact on held-out breaks; 5 partially right (2 missed a step, 3 named an extra one). After a narrowing fix, 37/39 exact. An LLM simply asked "which step failed?" also named a planted step 39/39, so our edge is the proof and multi-step causes, not guessing accuracy. See `reports/agent_bench/RESULTS.md`.

Prices live in `config/prices.yml` (only values read from the pricing page on the date given; unknown prices show tokens instead of dollars).

## Quick start (no API key, no cost)

Everything in `results/` is a cache of real model calls, so these replay offline.

Requirements: Python 3.11+ and Node.js 18+ (the dashboard needs no `npm install`).

```bash
git clone <this repo> upshift && cd upshift
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # only needed for new model calls
```

| Command | What it does |
|---|---|
| `cd dashboard && npm start` | Dashboard at http://localhost:4173: the demo deck, every report, live rows from `results/` |
| `python demo.py --demo` | Offline narrated replay (about 2 minutes) plus the dashboard: step-finder → line-finder → fix → recommendation |
| `python demo_e2e.py --break u3` | The same pipeline on one planted break |
| `python migrate_agent.py --candidate gpt-5.6-sol --candidate-config '{}'` | Full agent migration report, gpt-4 → gpt-5.6-sol |
| `python live_run.py --option cheap --sets fresh3` | **Live, paid**: real model calls (what the dashboard's Run live button starts) |
| `python results_demo.py` | Rebuild `reports/demo/results.json` (the deck's data) from cached runs |
| `python export_bench.py` | Dashboard reports for every planted break |
| `python -m unittest discover tests` | Unit tests (no key, no network) |

New model calls need a key: `set -a; source .env; set +a` (plain `source` doesn't export to subprocesses). Never commit keys.

## The dashboard

`dashboard/` is plain HTML, CSS and JavaScript with no build step.

- **Demo deck (4 slides):** the result, every model tried, the cheapest safe choice with its fixes, and the pull request. Each change in the PR is accepted, edited or rejected separately, and **Create pull request** opens a real PR in the app's own repo (`config/target_repo.yml`) only after you've decided every change. To check it without publishing, send `"dry_run": true` to `open_pr.py`: it clones the repo, applies the changes and prints the diff, and pushes nothing.
- **Migration reports:** a model comparison, the step and line that broke, before/after evidence, and the proposed diff. Agent reports add a pipeline view where you click any test case to see each step's input, output and the step-swap experiments.
- **Run live (costs money):** on slide 1, **Run live** calls the real models for the selected option on the test cases you choose (or one test case from its dialog), after showing a cost estimate. Results fill in on a separate screen as they arrive, next to gpt-4's recorded answers. It needs `OPENAI_API_KEY` in the server's environment (and Ollama for the cheap mix's tone step), stops at a $2 cap per run (`LIVE_MAX_USD`, at most $5), and writes a new `results/agent__live-*.jsonl` file without touching recorded runs.
- **Replay a run** only plays back a saved results file at its recorded pace. It makes no model calls and works offline. The "Live · idle" label in the header just means the page is connected to the local server watching `results/`.

## Other things it can migrate

The same loop works on a single prompt. The NER and text-classification examples from [explosion/spacy-llm](https://github.com/explosion/spacy-llm) (pinned at `spacy-llm==0.7.4`, configs copied unchanged into `upstream/`) are the worked example:

```bash
python record_baseline.py --dry-run          # show the exact prompts, no API calls
python migrate.py --task ner --candidates gpt-5.6-sol gpt-5.6-terra --model-config '{}'
```

`migrate.py` records candidates, ranks them, traces each regression to a prompt component with sentence-level ablation, has an LLM propose a fix, re-runs the suite, and writes `reports/migration_ner/` (`PR.md`, `pr.diff`, `migration.json`). It does **not** open a PR. To replay it offline without billing anything, use a placeholder key and an unreachable API base:

```bash
OPENAI_API_KEY=offline python migrate.py --task ner --candidates gpt-5.6-sol gpt-5.6-terra --model-config '{}' --api-base http://127.0.0.1:9/v1
```

Hard checks (`checks.py`) each enforce one prompt instruction, so a failure points at a line. `compare.py` gives each input one verdict: REGRESSED, IMPROVED, CHANGED (different but not worse; optionally reviewed by the Claude judge in `judge.py`) or SAME. Comparing the baseline against itself finds 0 regressions, so the method doesn't raise false alarms.

## How it works

1. **Replay** the same test cases on the old model and on each candidate, 3 runs each. Every call is cached (`results/`), so re-runs only do missing work.
2. **Score** with hard checks and gold labels (`checks.py`, `compare.py`).
3. **Find the step** (`stepfinder.py`, `stepswap.py`): new model everywhere except step *k*; if it passes again, step *k* is causal. Pairs are tried when no single step explains it.
4. **Find the lines** (`linefinder.py`, `ablation.py`): ablate each line of the guilty prompt on the new model and rank by measured effect.
5. **Fix** only that component (an LLM proposes the edit), then re-run everything, including test cases the fixer never saw.
6. **Choose models per step** (`assign.py`, `model_pool.py`, `mix_retest.py`): the cheapest model that passes each step, then check that the mix still passes end to end.
7. **Write the PR** (`pr_report.py`, `open_pr.py`): where, what, proof, fix, with the old model's noise floor.

## Repo map

| Path | Purpose |
|---|---|
| `support_agent.py` | The 4-step demo agent, its prompts and cached runner |
| `stepfinder.py`, `linefinder.py`, `ablation.py` | Find the step, then the line |
| `migrate_agent.py`, `migrate.py` | Migration reports for the agent and for a single NER prompt |
| `assign.py`, `model_pool.py`, `mix_retest.py`, `model_only.py` | Cheapest-model-per-step search and re-tests |
| `results_demo.py`, `dashboard_export.py`, `export_bench.py` | Build the dashboard's data from cached runs |
| `open_pr.py` | Opens the reviewed changes as a PR in the app repo |
| `inputs/` | Hand-written test cases with expected outcomes |
| `results/` | Cache of real model calls. **Never edit or delete the gpt-4 files.** They can't be regenerated after Oct 23. |
| `reports/` | Generated reports; `reports/SCHEMA.md` documents `migration.json` |
| `dashboard/` | The web UI |
| `tests/` | Unit tests |

## Limits, stated plainly

- Test cases are hand-written. Model behavior is real; the inputs are synthetic.
- 3 runs per test case is enough to show the method, not a noise-robust measurement.
- Small sets (8 test cases) can't establish a recommendation on their own.
- upshift investigates; an engineer decides. Nothing is published without an explicit click.
