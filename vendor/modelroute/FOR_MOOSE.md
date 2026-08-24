# The auto-router, for Moose

*How `openzoo/auto` picks a model — a VSA classifier trained closed-form, 40KB,
no torch, no embeddings, no pretrained anything. Your math, our objective.*

## The objective (this is the part that isn't a classifier)

Routing is not "what topic is this" and not "what's the best model":

```
pick  argmin  cost(m, task)   subject to   P_success(m | task) >= bar(task)
       m ∈ feasible(task)
```

If nothing clears the bar, say so and return the highest-P option **labelled as
such** — never silently pretend the cheapest one was fine. Four terms, four
sources:

- **feasible()** — hard metadata facts only (image input, tool calling, strict
  JSON, context length). A model without an image modality can't read a
  screenshot at any price. Never guessed.
- **cost()** — `price_in × est. prompt tokens + price_out × est. completion
  tokens`, divided by the cheapest feasible candidate's, so ranking is
  scale-free.
- **bar()** — an authored policy knob per (class, difficulty). Stated, not
  hidden, not measured.
- **P_success()** — the interesting one, below.

**A trap we deliberately walked around:** price is tempting as a capability
proxy (expensive ≈ stronger). It is NOT used that way, because cost is the
thing being minimised — letting price raise P_success would make the objective
partly cancel itself and quietly re-rank toward expensive models for no
measured reason. Price appears in cost(), nowhere else.

## The classifier — random indexing, two gradient-free heads

Text → hypervector by **Kanerva random indexing**: each token deterministically
hashes (sha256, never Python's salted `hash()` — deterministic under any
`PYTHONHASHSEED`) to k sparse ±1 positions in d=4096. A request is the bundle
of its token atoms over **three separately-normalised channels** — words, word
bigrams, char 4-grams — so a misspelling degrades a vector instead of erasing a
word. Channel atoms are weighted by a hashed IDF table (16KB).

Two heads produce the **same artifact shape** (K×d matrix, K=10 classes:
code / reasoning / longctx / vision / bulk / creative / translate / agentic /
chat / advice):

- **ridge (shipped)** — closed-form one-vs-rest least squares in the dual:
  `W = Xᵀ(XXᵀ + λI)⁻¹Y`. One 535×535 solve. No epochs, no learning rate, no
  shuffling, no lucky seed.
- **adapthd (kept)** — perceptron prototypes; the reference the ridge head is
  checked against.

Shipped artifact: **40KB int8 matrix + 16KB IDF**. Inference is a dot product.
`router.json` carries `{classes, q_b64 (int8), q_shape [10,4096], scale, idf}`.

## Measured, with ablations (train_router.py --ablate)

10 classes, 400 authored requests + anchors, held-out split written in a
deliberately different register:

| configuration | held-out | 5-fold |
|---|---|---|
| ridge + IDF + anchors | **0.642** | **0.772** |
| bag-of-words nearest centroid | 0.333 | — |
| majority class | 0.100 | — |

Each of the three choices (ridge, IDF, anchors) was ablated separately and each
earns its place.

**But class accuracy is not the headline.** `routing_regret.py` measures the
classifier in dollars and failures instead: **5.0% of held-out requests route
below the bar their true class would have demanded, at a median 1.12× the
oracle route's cost.** A misclassification that lands on an adequate cheaper
model is not an error that matters.

## P_success — a prior that becomes a measurement

No API reports "model m completes class c with probability p". What exists is
OpenRouter's per-category leaderboards: top-20 **by usage** — revealed
preference, not benchmark (popularity tracks price, marketing, defaults too,
and it's labelled as such).

So: prior = leaderboard rank in the categories the class maps to, shrunk toward
a metadata floor for the ~87% of the 414-model catalogue on no leaderboard at
all. Then `record_outcome(class, model, ok)` turns it into a **Beta posterior**
whose prior weight is the leaderboard number and whose data is our own
completions. Day one it answers `evidence: "prior"`; after real traffic it
answers `evidence: "measured(n=…)"`. As of today `outcomes.json` holds **391
(class, model) pairs of live measurements**.

The classifier's output is never the answer — it sets the bar and picks which
leaderboards to trust. The catalogue is a lookup table, not a softmax, so a
model added tomorrow is routable today with zero retraining.

## Serving

Gateway (`x402-tokens/src/auto.ts`): `openzoo/auto` → `route(text)` → shortlist
→ **first-2-of-5 race** over the shortlist (RACE_X=2, RACE_Y=5, min score 6);
tool-bearing bodies race a tool-capable pool, never a bare flash. If the router
artifacts are missing it degrades to a static cheap pool — routing is an
enhancement, never a dependency. Named models are never rerouted.

Files: `holographic_modelroute.py` (the whole thing, heavily commented),
`router.json` / `outcomes.json` / `catalog.json` (artifacts),
`tools/modelroute/train_router.py` (training + ablations),
`tools/modelroute/routing_regret.py` (the dollars-and-failures metric).

*Live result on X right now: @openzoobot answers tweet-sized questions at
$0.00001–0.007 via this router, receipts printed per reply.*
