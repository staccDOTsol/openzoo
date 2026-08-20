# modelroute → openzoo: integration handoff

You are plugging a **task router** into the openzoo stack. Given a request, it picks the cheapest
model that will probably finish it, out of the whole gateway catalogue. Pure NumPy, 51 KB of
artifacts, no torch, no pretrained model, no network at decision time, ~2 ms per call.

---

## 1. The one thing to understand before you read code

The objective is **not** "which model is best". It is:

```
argmin  cost(m, task)   subject to   P_success(m | task) >= bar(task),   m in feasible(task)
```

If nothing clears the bar, `route()` returns the strongest option **and flags it** (`cleared_bar:
False`). Do not silently treat that as a normal answer — it means "this probably will not get done".

Consequences worth internalising:

- **Price is used in `cost()` and nowhere else.** It is never a capability proxy. If you "improve"
  the scorer by letting expensive models look stronger, the objective partly cancels itself.
- **The classifier is not the product.** It picks the bar and which leaderboards to trust. The
  414-model catalogue is a lookup table, so a model added to the gateway tomorrow is routable
  after a catalogue refresh with no retraining.
- **`P_success` is a Beta posterior**, prior = OpenRouter usage rank, data = your recorded outcomes.
  It reports `evidence: "prior"` until you feed it results, then `measured(n=...)`.

---

## 2. Integration surface

### The one call

```python
from holographic.semantic_router.holographic_modelroute import route

r = route(
    "summarise this contract and list the obligations",
    allow_free=False,        # exclude $0 tiers (rate limits / data policy)
    bindable=True,           # openzoo has a leCore bind path -> True
    input_tokens=180_000,    # pass it if you know it; otherwise estimated from text length
    has_image=False, needs_tools=False, needs_json=False,   # pass what you KNOW
    context=prior_turns,     # conversation so far, for fragment requests like "fix it"
)
r["model"]         # -> "deepseek/deepseek-v4-flash"  (a gateway model id)
r["p_success"]     # -> 0.83
r["usd_per_task"]  # -> 0.000161
r["bind_first"]    # -> True if the input should be bound to leCore before asking
r["cleared_bar"]   # -> False means "nothing was good enough; this is a fallback"
r["shortlist"]     # -> ranked alternatives with cost + evidence, for a fallback chain
```

Every return carries the same keys, including the no-feasible-model path. Loading is cheap but not
free — hold `Catalog()`, `TaskClassifier.load()` and `Outcomes()` as singletons and pass them in:

```python
from holographic.semantic_router.holographic_modelroute import Catalog, TaskClassifier, Outcomes
CAT, CLF, OUT = Catalog(), TaskClassifier.load(), Outcomes()
r = route(text, catalog=CAT, classifier=CLF, outcomes=OUT)
```

### Closing the loop (this is the part that matters)

```python
OUT.record(r["task_class"], r["model"], ok=True)   # or False
```

Without this the router can never beat its prior. With it, every real call sharpens the next
decision. `Outcomes` is a plain JSON file of `{"class|model": [successes, attempts]}` — trivially
mergeable across machines; sum the pairs.

### Suggested openzoo shapes

1. **A virtual model id.** `openzoo/auto` → proxy sees it, calls `route()` on the last user message
   (plus prior turns as `context`), rewrites the upstream model id, records the outcome on
   completion. Users get routing by typing one model name.
2. **A sidecar endpoint.** `POST /route {text, constraints} -> {model, p, cost, shortlist}` for
   anything that wants to decide for itself.
3. **A fallback chain.** On a 429/5xx from the chosen model, walk `r["shortlist"]` — it is already
   sorted cheapest-first among those clearing the bar.

**Bind-first:** when `r["bind_first"]` is true, the input is bigger than `BIND_ABOVE_TOKENS`
(60k). Bind it to leCore and ask against the retrieved slice; do **not** go shopping for a
million-token model. The gateway advertises `context_length: 128000000` because the bind path backs
it — that number is not a model window, and using it as a routing constraint makes every context
filter a lie. `max_model_len` is the real window and is what the catalogue stores.

---

## 3. Files

| path | role |
|---|---|
| `holographic/semantic_router/holographic_modelroute.py` | the runtime — encoder, classifier, catalogue, `route()` |
| `lecore_data/modelroute/catalog.npz` | 414 gateway-callable models: price, real window, capabilities, leaderboard ranks (11 KB) |
| `lecore_data/modelroute/router.npz` | trained classifier, int8 + IDF table (40 KB) |
| `lecore_data/modelroute/outcomes.json` | your measured success counts — **gitignored, machine-local** |
| `tools/modelroute/fetch_catalog.py` | rebuild the catalogue (gateway prices + OpenRouter capabilities/leaderboards) |
| `tools/modelroute/train_router.py` | train + measure the classifier against baselines |
| `tools/modelroute/bench_openzoo.py` | measure real models on real tasks → `outcomes.json` |
| `tools/modelroute/suite_hard.py` | the generated, key-verified probe suite |
| `tools/modelroute/ask.py` | end-to-end CLI: route → run on openzoo → record |
| `tools/modelroute/routing_regret.py` | evaluates routing in dollars and failures, not accuracy |
| `tests/test_modelroute.py` | 22 contract tests |

### Rebuild / operate

```bash
python3 tools/modelroute/fetch_catalog.py                       # refresh catalogue (do this weekly)
python3 tools/modelroute/train_router.py --ablate --export      # retrain the classifier
python3 tools/modelroute/suite_hard.py --verify                 # prove every answer key
python3 tools/modelroute/bench_openzoo.py --suite hard --per-provider 2 --run --exec --resume
python3 tools/modelroute/bench_watch.py                         # live dashboard for a run
python3 -m pytest tests/test_modelroute.py
```

The catalogue goes stale. Prices and models change; refresh it on a schedule and the router follows
automatically — nothing is retrained for a new model.

---

## 4. Landmines — every one of these shipped plausible wrong numbers, not an error

1. **Negative prices.** OpenRouter meta-routers (`openrouter/auto`, `fusion`, …) price at `-1`
   ("varies"); the gateway's 3× markup makes it `-3`. `isfinite()` accepts that, so they look
   *cheaper than free* and win every cheapest-first route. Unknown must never read as free.
2. **`max_tokens` starves reasoning models.** Thinking tokens bill against the same budget, so a
   tight cap returns `{"city": "Tokyo` — truncated mid-answer. Always capture `finish_reason` and
   never score a `length`-truncated reply as a wrong answer.
3. **Grading brevity instead of correctness.** Any grader that requires short replies will mark
   every reasoning model wrong for showing its work. Score the *final* answer.
4. **Hand-written answer keys are wrong.** Two of mine were. `suite_hard.py` computes every key and
   `--verify` proves a reference answer passes and a wrong one fails before a cent is spent.
5. **Shared-backoff livelock.** A fleet-wide pause penalised per failed call means 24 workers file
   24 penalties for one rate-limit wave, pushing the pause ahead of real time — the process looks
   alive and does nothing. Penalise once per pause window, cap it.
6. **`x and y` returns the operand, not a bool.** An empty reply made a grader return `[]`, which
   exploded three layers later in the tally.
7. **macOS:** `RLIMIT_AS` is not settable (raises `ValueError`) and `setsid` does not exist. Use
   `RLIMIT_CPU` in a `try/except` and `subprocess.Popen(..., start_new_session=True)`.
8. **zsh does not word-split unquoted vars** — `cmd $flags` passes ONE argument. This silently
   produced two wrong benchmark tables that looked completely reasonable.

**The design decision that saved all of this:** the benchmark ledger stores the *full reply* of every
call, so grading is replayable offline (`--regrade`) at zero cost. Bugs 2, 3, 4 and 6 were all found
and corrected after the money was spent, without spending it again. Keep the raw evidence.

---

## 5. What I would do first if I were picking this up

1. Wire `OUT.record(...)` into wherever openzoo completes a call. Everything else is already built;
   this is the step that turns a borrowed prior into your own measurement.
2. Put the catalogue refresh on a cron.
3. Read `CURRENT_STATE.md` for what is measured, what is authored, and what is still weak — several
   numbers in this system are policy, not evidence, and they are all in one place so you can argue
   with them.
