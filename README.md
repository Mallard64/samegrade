# upshift

**Switch your AI app to a newer model without breaking it, and get proof of what changed.**

🎥 **Demo video (2–3 min): https://streamable.com/osodhd**

## What it is

AI apps run on a specific model, like GPT-4. Those models get retired. OpenAI is shutting down `gpt-4` and `gpt-3.5-turbo` on **Oct 23, 2026**, so every app that uses them has to move to a newer model.

The risky part: the instructions you wrote for the old model can quietly work worse on the new one. Nothing crashes. Answers just get a little wrong, and nobody notices.

upshift checks for that. It runs the same test cases on the old and new model, finds exactly what got worse, fixes only that, and shows the before and after. A person reviews every change before anything is applied.

## Who it's for

Teams that built something on an AI model that is being retired, and need to move to a new one safely. If you'd otherwise be switching the model and hoping nothing broke, this is for you.

## How it works

Many AI apps work in steps, like an assembly line. Our demo is a customer support assistant with four: sort the customer request, decide what to do, write the reply, check the tone.

1. **Compare.** Run the same test test cases through the old and the new model, three times each, so normal ups and downs don't look like problems.
2. **Find the step.** Put the old model back on one step at a time. If the problem disappears, that step is the culprit.
3. **Find the line.** Inside that step's instructions, remove one line at a time to see which line caused it.
4. **Fix just that.** Suggest the smallest possible edit, then re-run everything to check it worked.
5. **Hand it to a person.** A report shows what broke, where, the proof, and the fix. You accept, edit or reject each change.

Other tools rewrite your whole set of instructions and hope for the best. upshift changes only the part that broke, and shows why.

## What we found in the demo

We tested the support assistant on 36 sample test cases, three runs each, using real recorded model answers.

- The new model, `gpt-5.6-sol`, dropped the "5–7 business days" refund timeline from replies. It was the final tone-checking step, and one line in its instructions. A one-line edit fixed it.
- Picking the cheapest model that works for each step cut the cost from **$39.32 to $0.33 per 1,000 test cases**, with no test case handled worse than before.
- To test the "find the step" part, we planted 9 known problems. upshift named the right step every time it named one (34 of 39 exactly right). Details are in `reports/agent_bench/RESULTS.md`.

## Try it (free, no account needed)

Every model answer we used is saved in `results/`, so everything replays offline. You need Python 3.11+ and Node 18+.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd dashboard && npm start          # opens the dashboard at http://localhost:4173
python demo.py --demo              # a 2-minute narrated replay
```

Running new model calls needs an OpenAI key in `.env` (it ships blank). Never commit your key.

## Where things are

| Path | What's there |
|---|---|
| `dashboard/` | The web app: slides, reports, live runs |
| `support_agent.py` | The demo support assistant |
| `stepfinder.py`, `linefinder.py` | Find the step, then the line |
| `migrate_agent.py`, `migrate.py` | Build the report (also works on a single-prompt example from [spacy-llm](https://github.com/explosion/spacy-llm)) |
| `results/` | Saved model answers. **Don't delete the gpt-4 files**: they can't be recreated after Oct 23. |
| `reports/` | Generated reports |

## Honest limits

- The test test cases are hand-written. The model answers are real.
- Three runs per test case shows the method works; it isn't a large-scale study.
- upshift investigates. An engineer makes the final decision.
