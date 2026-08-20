# modelroute — current state

_Snapshot: 2026-08-20. Read `HANDOFF.md` for how to integrate; this file is what is true, what is
guessed, and what is unfinished._

---

## Status at a glance

| part | state |
|---|---|
| Router runtime (`route()`) | **working**, 22 contract tests + module selftest green |
| Catalogue (414 gateway-callable models) | **working**, rebuilt from the gateway, 11 KB |
| Task classifier (10 classes) | **working**, 0.642 held-out / 0.772 5-fold, 40 KB |
| End-to-end CLI (`ask.py`) | **working** — routes, calls openzoo, records outcome |
| `P_success` measured on real models | **in progress** — hard-suite run ~20% done |
| Base-suite outcomes | **discarded** (saturated, low-n) — kept at `outcomes.base.json.bak` |
| Vision / creative / advice classes | **never measured** — no objective grader, prior only |

The router works today on priors. It works *better* the moment the hard-suite run lands and every
time you record a real outcome.

---

## What is measured vs. what is authored

This distinction is the whole point of the design. Do not blur it.

### MEASURED (evidence)

- **Classifier accuracy.** 0.642 on a register-shifted held-out split, against a bag-of-words
  baseline at 0.333 and majority at 0.100. Ablated: ridge head +0.12 over perceptron, hashed IDF
  +0.09, anchor gazetteer +0.075. Caveat: anchors were written *after* inspecting held-out errors,
  so 0.642 is optimistically biased. The 5-fold number (0.772) is clean.
- **Routing regret.** 5.0% of held-out requests route below the bar their true class demands, at a
  median 1.12× the oracle route's cost. The top-2 hedge causes that: hedge off gives 13.3% under-bar
  at 1.00× cost. Ability bought with money, as the objective asks.
- **Model success rates.** In progress. See below.

### AUTHORED (policy, not evidence — argue with these)

- **`_BAR`** — the required `P_success` per (class, difficulty). The single most important knob.
- **`_OUT_TOKENS`** — expected completion length per class. Cost is linear in it.
- **`_CLASS_CATEGORIES`** — which OpenRouter leaderboards count as evidence for which task class.
  `vision` uses `technology` as an explicit *proxy* (there is no vision leaderboard); `bulk` maps to
  nothing on purpose, so its objective degenerates to "cheapest feasible", which is correct for it.
- **`P_TOP/P_BOT/P_UNKNOWN`** — how a leaderboard rank becomes a probability, and what an unranked
  model is assumed to be worth (0.45, deliberately below every bar except bulk/chat).
- **`BIND_ABOVE_TOKENS` (60k), `BIND_SLICE_TOKENS` (8k)** — when to bind instead of buying context.
- **`difficulty()`** — a 3-signal heuristic (rigour cues, long input, low classifier margin). There
  are no difficulty labels in the corpus, so a trained head here would be a guess in a lab coat.

---

## The measurement run

**Hard suite** (`suite_hard.py`): 64 tasks, every answer key **computed by the generator** and
verified before spending — a reference answer must pass the real grader and a wrong answer must fail
it. 5 classes: reasoning (24), agentic (12), longctx (10), bulk (10), code (8).

It discriminates, which the base suite did not:

| class | pass rate across models so far |
|---|---|
| agentic | 0.96 |
| longctx | 0.88 |
| code | 0.79 |
| reasoning | 0.67 |
| bulk | 0.54 |

Model spread so far runs 0.60 → 0.95 (vs. the base suite, where 30 of 124 models tied at a perfect
1.00 and it could not rank anything above the floor).

**Run state:** ~1,200 of 6,336 calls, 20 of 99 models, ~$5 spent, ~4 calls/s, ETA well under an hour.
Restart with the same command and `--resume` — it skips completed calls and *retries* errored ones.

### Why 99 models, not 414

409 models is not 409 pieces of information. `gpt-5.6-luna/sol/terra` scored identically; so did the
`deepseek-v4-flash` and `gemini-3.x-flash` families. A fixed budget is models × tasks, and redundant
variants buy nothing while every per-class estimate stays at n≈4 — a 95% CI **0.5 wide**, wider than
the entire range the router cares about. `--per-provider 2` takes each provider's flagship (by
leaderboard placement, then capability) plus its cheapest option. Same money, 10× the depth.

### Statistical power, plainly

| tasks per model | 95% CI width at p≈0.9 |
|---|---|
| 5 | 0.59 |
| 10 | 0.39 |
| 30 | 0.22 |
| 64 (hard suite) | ~0.18 overall, but only ~n=10–24 *per class* |

**Per-class estimates are still thin.** Overall model quality is now solidly measured; a
per-(class, model) number at n=10 still leans on the prior. If you need per-class confidence, add
tasks to that class in `suite_hard.py` — the generators make that cheap and key-safe.

---

## Known weaknesses (ranked by how much they should bother you)

1. **Three classes are never measured.** `creative`, `advice` and `vision` have no objective grader
   (`vision` also needs image fixtures). They run on the leaderboard prior and always will until
   someone decides what "good" means for them. An LLM judge was rejected: it is a second opinion, not
   a measurement, and it would poison the same table the benchmark fills with real results.
2. **`code` is the worst classifier class** (0.25 on the register-shifted held-out split). Requests
   like "the linter hates everything I write" share no vocabulary with the training split. The
   anchor gazetteer helps; more real examples would help more.
3. **The corpus is one person's idea of what requests look like** — 400 authored sentences. Your
   actual traffic is the real distribution. Drop a JSONL at
   `lecore_data/modelroute/eval_real.jsonl` (`{"text":…, "label":…}`) and `train_router.py` will
   report against it automatically.
4. **21% of gateway calls return 429.** It is a per-account limit, not a concurrency problem —
   dropping from 48 to 16 workers made it *worse*. The shared throttle handles it; it costs
   wall-clock, not money or correctness.
5. **Real prompts are fragments.** In a live agent session most turns are "fix it" / "did this
   work?", which carry no routable task alone. Pass the conversation as `context=`; the router will
   otherwise hedge (correctly) and route as if the task were hard, which costs money.

---

## What I would build next, in order

1. **Wire outcome recording into the openzoo call path.** Everything else exists. This is the step
   that makes `P_success` yours instead of borrowed.
2. **Grow `suite_hard.py` per class** until per-class n ≥ 30, using the generators (keys stay
   correct by construction).
3. **Decide what "good" means for creative/advice**, or accept them as prior-only forever and say so
   in the UI.
4. **Thompson sampling for exploration.** Right now the cheapest clearing model always wins, so the
   alternatives never get observed and the table can only improve where you already route. A small
   exploration budget would fix that; the Beta posteriors needed for it are already there.
