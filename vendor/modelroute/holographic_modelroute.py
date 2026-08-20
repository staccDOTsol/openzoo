"""Route a task to the CHEAPEST model that will probably finish it (MR-3).

THE OBJECTIVE, stated once and obeyed everywhere below
------------------------------------------------------
Not "what topic is this" and not "what is the best model". The decision is:

    pick  argmin  cost(m, task)   subject to   P_success(m | task) >= bar(task)
           m in feasible(task)

    ... and if NOTHING clears the bar, say so and return the highest-P option, labelled as such,
        rather than silently pretending the cheapest one was fine.

Everything else in this file exists to supply one of those four terms:
  feasible()   -- HARD constraints from the request: image input, tool calling, strict JSON, context
                  length. These are metadata facts, never guesses; a model without an image input
                  modality cannot read a screenshot at any price.
  P_success()  -- a PRIOR, honestly labelled. See the next section.
  cost()       -- $/task = price_in * estimated prompt tokens + price_out * estimated completion
                  tokens. "Relative cost" is this number divided by the cheapest feasible candidate's,
                  so the ranking is scale-free.
  bar()        -- an authored policy knob per (class, difficulty). Not measured. Stated, not hidden.

WHERE P_success COMES FROM, AND WHAT IT IS NOT
----------------------------------------------
There is no free API that reports "model m completes task class c with probability p". What exists is
OpenRouter's per-category leaderboard: for 12 categories, the top-20 models BY USAGE. That is REVEALED
PREFERENCE -- thousands of developers repeatedly choosing a model for that kind of work and not
switching away -- which correlates with "it finishes the job", but it is NOT a benchmark. Popularity
tracks price, marketing, and defaults too.

So the prior is built as: leaderboard rank in the categories this task class maps to, shrunk toward a
metadata floor for the ~87% of the catalogue that appears on no leaderboard at all. And then the
important part: `Outcomes` turns the prior into a MEASUREMENT over time. Every real completion can be
recorded with record_outcome(class, model, ok); P_success becomes a Beta posterior whose prior weight
is the leaderboard number and whose data is your own results. Day one it is a proxy and says so
(`evidence: "prior"`); after a few hundred real calls it is yours (`evidence: "measured(n=...)"`).

KEPT NEGATIVE (a trap this design walks around): price is tempting as a capability proxy -- expensive
models are usually stronger. It is deliberately NOT used that way, because cost is the thing being
minimised; letting price raise P_success too would make the objective partly cancel itself and quietly
re-rank toward expensive models for no measured reason. Price appears in cost(), nowhere else.

THE CLASSIFIER (from scratch, no pretrained anything)
-----------------------------------------------------
Text -> hypervector by RANDOM INDEXING (Kanerva): each token deterministically hashes to k sparse +-1
positions in a d-dim space; a request is the bundle of its token atoms over three separately-normalised
channels (words, word bigrams, char 4-grams, so a misspelling degrades a vector instead of erasing a
word), weighted by a hashed IDF table.

Two gradient-free heads produce the SAME artifact shape, a K x d matrix:
  ridge (shipped)  -- closed-form one-vs-rest least squares in the dual, W = X^T (XX^T + lam I)^-1 Y.
                      One 535x535 solve. No epochs, no learning rate, no shuffling, no seed to get
                      lucky with.
  adapthd (kept)   -- perceptron prototypes, the reference the ridge head is checked against.

MEASURED (tools/modelroute/train_router.py --ablate, 10 classes, 400 authored requests + anchors,
held-out split written in a deliberately different register): ridge+IDF+anchors 0.642 held-out /
0.772 5-fold, against a bag-of-words nearest-centroid baseline at 0.333 and majority at 0.100. Every
one of the three choices was measured separately and each earns its place; the whole learned artifact
is 40 KB int8 + a 16 KB IDF table. No token table, no embedding model, no torch. Deterministic under
any PYTHONHASHSEED because every hash is sha256, never Python's salted hash().

But class accuracy is NOT the headline -- see tools/modelroute/routing_regret.py, which measures the
classifier in dollars and failures instead: 5.0% of held-out requests route below the bar their true
class would have demanded, at a median 1.12x the oracle route's cost.

The classifier's OUTPUT IS NOT THE ANSWER -- it sets the bar and picks which leaderboards to trust. The
414-model catalogue is a lookup table, not a softmax, so a model added tomorrow is routable today.
"""
import hashlib
import json
import os
import re

import numpy as np

from holographic.misc.holographic_determinism import argmax_tiebreak

# ---------------------------------------------------------------------------------------------------
# artifact locations (all small, all optional-at-import)
_HERE = os.path.dirname(os.path.abspath(__file__))
_DATA = os.path.abspath(os.path.join(_HERE, "..", "..", "lecore_data", "modelroute"))
CATALOG_PATH = os.path.join(_DATA, "catalog.npz")
ROUTER_PATH = os.path.join(_DATA, "router.npz")
OUTCOMES_PATH = os.path.join(_DATA, "outcomes.json")

MOD_TEXT, MOD_IMAGE, MOD_AUDIO, MOD_FILE = 1, 2, 4, 8

# ---------------------------------------------------------------------------------------------------
# 1. THE ENCODER -- text to hypervector, no model, no vocabulary file
# ---------------------------------------------------------------------------------------------------
_WORD = re.compile(r"[a-z0-9]+")


def _atom_positions(token, dim, k, seed):
    """Deterministic sparse atom for a token: k (index, sign) pairs from one sha256 digest.

    Random indexing, not a lookup table -- so the encoder has NO vocabulary and an unseen word is
    encoded exactly like a seen one (into a near-orthogonal direction) instead of being dropped.
    sha256, never hash(): the engine's determinism rule."""
    h = hashlib.sha256(f"{seed}|{token}".encode()).digest()
    # 8 bytes per (index, sign) pair; a 32-byte digest carries 4 pairs, so re-hash as needed for k>4.
    idx, sgn, buf, salt = [], [], h, 0
    while len(idx) < k:
        for off in range(0, 32, 8):
            if len(idx) >= k:
                break
            chunk = int.from_bytes(buf[off:off + 8], "big")
            idx.append(chunk % dim)
            sgn.append(1.0 if (chunk >> 63) & 1 else -1.0)
        salt += 1
        buf = hashlib.sha256(f"{seed}|{token}|{salt}".encode()).digest()
    return np.array(idx, dtype=np.int64), np.array(sgn, dtype=np.float64)


class TextEncoder:
    """Request text -> unit hypervector. Words + word bigrams + char 4-grams, bundled.

    Char 4-grams are what make the held-out register survivable: 'fucntion' shares most of its 4-grams
    with 'function', so a typo degrades the vector instead of erasing the word. Bigrams carry the small
    amount of order that matters for routing ('unit test', 'json only', 'step by step')."""

    # (words, word-bigrams, char-n-grams). Words carry the topic, bigrams the little order that
    # matters ('unit test', 'json only'), char-grams the robustness to typos and unseen words.
    CHANNEL_W = (1.0, 0.6, 0.45)

    IDF_BUCKETS = 8192            # hashed IDF table size; a table, never a vocabulary

    def __init__(self, dim=4096, k=8, seed=17, char_n=4, use_bigrams=True, cache=True, idf=None):
        self.dim, self.k, self.seed, self.char_n = int(dim), int(k), int(seed), int(char_n)
        self.use_bigrams = bool(use_bigrams)
        self._cache = {} if cache else None
        self.idf = None if idf is None else np.asarray(idf, dtype=np.float64)

    def _idf_bucket(self, tok):
        return int.from_bytes(hashlib.sha256(f"idf|{self.seed}|{tok}".encode()).digest()[:8],
                              "big") % self.IDF_BUCKETS

    def fit_idf(self, texts):
        """Learn HASHED inverse document frequency from the training texts.

        WHY: without it, 'this', 'the', 'i' contribute as much direction as 'docker' or 'translate',
        and since every class's requests are mostly function words the prototypes end up mostly
        parallel. Standard IDF needs a vocabulary file; hashing the token into a fixed 8192-bucket
        table keeps the encoder vocabulary-free (an unseen word still gets a weight -- the average of
        whatever collided into its bucket) at a cost of 32 KB. Collisions are noise, not error: a rare
        word colliding with a common one is merely under-weighted."""
        df = np.zeros(self.IDF_BUCKETS)
        for t in texts:
            for b in {self._idf_bucket(tok) for tok in self.tokens(t)}:
                df[b] += 1.0
        n = max(1, len(texts))
        self.idf = np.log((n + 1.0) / (df + 1.0)) + 1.0
        return self

    def _weight(self, tok):
        return 1.0 if self.idf is None else float(self.idf[self._idf_bucket(tok)])

    def channels(self, text):
        """The three token channels of a request, kept SEPARATE on purpose.

        MEASURED, the hard way: bundling all three into one bag collapses the classifier -- a 60-char
        request has ~10 words but ~57 char-4-grams, so the char channel outvotes the words 6:1 and
        every class prototype drifts toward generic English. Normalising each channel to unit length
        first and then mixing by CHANNEL_W makes the contribution independent of how many tokens the
        channel happens to emit. (Held-out accuracy before the split: 0.18. After: see the report.)"""
        words = _WORD.findall(text.lower())
        bigrams = [f"{a}_{b}" for a, b in zip(words, words[1:])] if self.use_bigrams else []
        flat = " ".join(words)
        n = self.char_n
        chars = [f"#{flat[i:i + n]}" for i in range(max(0, len(flat) - n + 1))]
        return words, bigrams, chars

    def tokens(self, text):
        """Flat token multiset (the union of the channels) -- kept for inspection and tests."""
        w, b, c = self.channels(text)
        return w + b + c

    def _atom(self, tok):
        if self._cache is None:
            return _atom_positions(tok, self.dim, self.k, self.seed)
        got = self._cache.get(tok)
        if got is None:
            got = _atom_positions(tok, self.dim, self.k, self.seed)
            self._cache[tok] = got
        return got

    def _bundle(self, toks):
        v = np.zeros(self.dim, dtype=np.float64)
        for tok in toks:
            idx, sgn = self._atom(tok)
            np.add.at(v, idx, sgn * self._weight(tok))
        n = np.linalg.norm(v)
        return v if n < 1e-12 else v / n

    def encode(self, text):
        """Per-channel unit bundle, then a weighted mix, then unit-normalise. Empty/unparseable text
        -> zero vector (the classifier then abstains rather than picking a class from nothing)."""
        v = np.zeros(self.dim, dtype=np.float64)
        for w, toks in zip(self.CHANNEL_W, self.channels(text)):
            if toks:
                v += w * self._bundle(toks)
        n = np.linalg.norm(v)
        return v if n < 1e-12 else v / n

    def encode_many(self, texts):
        return np.stack([self.encode(t) for t in texts]) if texts else np.zeros((0, self.dim))

    def config(self):
        return dict(dim=self.dim, k=self.k, seed=self.seed, char_n=self.char_n,
                    use_bigrams=self.use_bigrams)


# ---------------------------------------------------------------------------------------------------
# 2. THE CLASSIFIER -- gradient-free HDC prototypes with AdaptHD retraining
# ---------------------------------------------------------------------------------------------------
class TaskClassifier:
    """Nearest-prototype classifier over hypervectors, trained by perceptron-style nudges.

    fit(): bundle each class's examples into a prototype (one-shot centroid), then for `epochs` passes
    over the data, every MISCLASSIFIED example is added to its true class prototype and subtracted from
    the one that wrongly won. No gradients, no optimiser, no learning rate schedule beyond `lr`.

    predict(): cosine against every prototype. Returns (label, confidence, margin) where margin is the
    gap to the runner-up -- the abstention signal. A low margin means the request straddles two classes
    (they often genuinely do), and the router widens its bar instead of committing."""

    def __init__(self, classes, encoder):
        self.classes = list(classes)
        self.enc = encoder
        self.P = np.zeros((len(self.classes), encoder.dim))

    # -- training ------------------------------------------------------------------------------
    def fit(self, texts, labels, method="ridge", **kw):
        """Train the K x dim matrix. Two heads, both gradient-free, both the same artifact shape:

          'ridge'   -- closed-form one-vs-rest least squares in the DUAL form
                       W = X^T (X X^T + lam I)^-1 Y. With n=400 examples that is a 400x400 solve, so
                       'training' is one linear system, not an optimisation. Deterministic by
                       construction: no epochs, no shuffling, no learning rate.
          'adapthd' -- the perceptron prototypes (fit_adapthd below).

        The ridge head is the fast path and adapthd is its REFERENCE (the F22 rule): two independent
        learners over the same features, so a feature bug shows up as both of them failing, not as one
        of them silently compensating."""
        return (self.fit_ridge(texts, labels, **kw) if method == "ridge"
                else self.fit_adapthd(texts, labels, **kw))

    def fit_ridge(self, texts, labels, lam=1.0):
        X = self.enc.encode_many(texts)
        y = np.array([self.classes.index(l) for l in labels])
        Y = -np.ones((len(y), len(self.classes)))              # one-vs-rest targets in {-1, +1}
        Y[np.arange(len(y)), y] = 1.0
        G = X @ X.T
        alpha = np.linalg.solve(G + lam * np.eye(len(X)), Y)   # dual coefficients, n x K
        self.P = self._unit((X.T @ alpha).T)                   # K x dim, unit rows for cosine scoring
        self.train_acc_ = float(np.mean(
            [int(argmax_tiebreak(self.P @ X[i])) == y[i] for i in range(len(X))]))
        return self

    def fit_adapthd(self, texts, labels, epochs=30, lr=0.35, seed=0):
        """THREE things here are load-bearing, each of them learned by getting it wrong first:

        1. UPDATE THE RAW ACCUMULATOR, score with a normalised view. Re-normalising the prototype
           matrix inside the update loop throws away the accumulated evidence every step, so late
           examples overwrite early ones instead of adding to them.
        2. SHUFFLE (seeded). With the corpus in class order and a full-size update, the last class
           processed wins everything: the first run of this collapsed all 120 held-out requests onto
           `advice`, the final class in the file. Seeded permutation = shuffled AND reproducible.
        3. KEEP THE BEST EPOCH. The perceptron does not converge monotonically on data that is not
           linearly separable; the last epoch is not the best one. Snapshot on improvement."""
        X = self.enc.encode_many(texts)
        y = np.array([self.classes.index(l) for l in labels])
        K = len(self.classes)
        A = np.zeros((K, self.enc.dim))                      # raw accumulator, never re-normalised
        for c in range(K):                                   # stage 1: one-shot bundle (the centroid)
            rows = X[y == c]
            if len(rows):
                A[c] = rows.sum(0) / max(1, len(rows))
        rng = np.random.default_rng(seed)
        best, best_acc = self._unit(A).copy(), -1.0
        for _ in range(epochs):
            order = rng.permutation(len(X))
            errs = 0
            for i in order:
                P = self._unit(A)
                pred = int(argmax_tiebreak(P @ X[i]))
                if pred != y[i]:
                    A[y[i]] += lr * X[i]                     # toward the truth
                    A[pred] -= lr * X[i]                     # away from the impostor
                    errs += 1
            acc = 1.0 - errs / max(1, len(X))
            if acc > best_acc:
                best_acc, best = acc, self._unit(A).copy()
            if errs == 0:                                    # separated: further passes are no-ops
                break
        self.P = best
        self.train_acc_ = best_acc
        return self

    @staticmethod
    def _unit(M):
        return M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-12)

    # -- inference -----------------------------------------------------------------------------
    def scores(self, text):
        v = self.enc.encode(text)
        return self.P @ v

    def predict(self, text):
        s = self.scores(text)
        i = int(argmax_tiebreak(s))
        srt = np.sort(s)[::-1]
        margin = float(srt[0] - srt[1]) if len(srt) > 1 else float(srt[0])
        return self.classes[i], float(s[i]), margin

    def predict_batch(self, texts):
        return [self.predict(t)[0] for t in texts]

    # -- persistence ---------------------------------------------------------------------------
    def save(self, path):
        """int8 prototypes + per-row scale. Cosine ranking survives per-row quantisation because a
        positive per-row scale cannot reorder that row's own dot products against a shared query."""
        scale = np.abs(self.P).max(axis=1, keepdims=True) + 1e-12
        q = np.round(self.P / scale * 127.0).astype(np.int8)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        payload = dict(classes=np.array(self.classes), q=q, scale=scale.astype(np.float32),
                       config=np.array([json.dumps(self.enc.config())]))
        if self.enc.idf is not None:
            payload["idf"] = self.enc.idf.astype(np.float16)   # 16 KB; weights, not a vocabulary
        np.savez_compressed(path, **payload)
        return path

    @classmethod
    def load(cls, path=ROUTER_PATH):
        z = np.load(path, allow_pickle=False)
        cfg = json.loads(str(z["config"][0]))
        idf = z["idf"].astype(np.float64) if "idf" in z.files else None
        obj = cls([str(c) for c in z["classes"]], TextEncoder(idf=idf, **cfg))
        obj.P = obj._unit(z["q"].astype(np.float64) * z["scale"].astype(np.float64) / 127.0)
        return obj


# ---------------------------------------------------------------------------------------------------
# 3. HARD CONSTRAINTS -- facts about the request, not opinions about it
# ---------------------------------------------------------------------------------------------------
_IMG_CUE = re.compile(r"\b(image|images|screenshot|screenshots|photo|photos|pic|picture|pictures|"
                      r"scan|scanned|attached|attachment|diagram|chart|graph|x[- ]?ray|mockup|"
                      r"handwrit\w*|snap|frame|logo|infographic)\b")
_TOOL_CUE = re.compile(r"\b(tool call\w*|tool_choice|function call\w*|call the (tool|api|endpoint|"
                       r"function)|use the \w+ tool|invoke the|agent(ic)? loop|orchestrat\w*|"
                       r"tools? (and|then|as needed)|agent that)\b")
# TIGHT on purpose. The first version matched a bare 'json', so "write a function that dumps json" --
# a CODE request whose output format is irrelevant to the model -- silently applied a hard filter and
# removed 49 of 414 models from consideration. A hard constraint must be triggered by a statement
# ABOUT THE MODEL'S OUTPUT, not by the topic. When in doubt the caller passes needs_json=True.
_JSON_CUE = re.compile(r"\b(json (only|schema|output|mode)|(valid|strict|only) json|"
                       r"structured output\w*|json ?schema|response_format|pydantic|"
                       r"machine[ -]readable|no prose|conform\w* to this schema)\b")


def extract_constraints(text, has_image=False, needs_tools=None, needs_json=None,
                        input_tokens=None, output_tokens=None, task_class=None):
    """Turn a request into the HARD facts a candidate must satisfy.

    Cues are read from the text only as a FALLBACK; a caller that actually knows (it is holding an
    image, it is running a tool loop) should pass the flag explicitly, and the explicit value always
    wins. Token counts default to a chars/4 estimate of the prompt plus a per-class output estimate --
    both are estimates and the returned dict says so, because cost() multiplies by them."""
    low = text.lower()
    est_in = int(input_tokens if input_tokens is not None else max(16, len(text) / 4))
    est_out = int(output_tokens if output_tokens is not None else _OUT_TOKENS.get(task_class, 400))
    return dict(
        needs_image=bool(has_image or _IMG_CUE.search(low)),
        needs_tools=bool(_TOOL_CUE.search(low)) if needs_tools is None else bool(needs_tools),
        needs_json=bool(_JSON_CUE.search(low)) if needs_json is None else bool(needs_json),
        est_in=est_in, est_out=est_out,
        min_context=int((est_in + est_out) * 1.25) + 512,     # 25% headroom, then a floor
        estimated=(input_tokens is None, output_tokens is None),
    )


# per-class expected completion length (tokens). Authored, not measured -- but cost is linear in it,
# so it is stated here in one place instead of hiding inside the scorer.
_OUT_TOKENS = {"code": 900, "reasoning": 1200, "longctx": 1000, "vision": 350, "bulk": 60,
               "creative": 900, "translate": 500, "agentic": 250, "chat": 250, "advice": 700}

# task class -> the OpenRouter leaderboards whose revealed preference is evidence for this class,
# with weights. 'vision' and 'bulk' have NO natural leaderboard: vision is decided by a hard modality
# filter, bulk by price among the feasible. Their empty maps are the honest statement of that.
_CLASS_CATEGORIES = {
    "code":      {"programming": 1.0, "technology": 0.5},
    "reasoning": {"science": 1.0, "academia": 0.7, "trivia": 0.2},
    "longctx":   {"academia": 0.8, "legal": 0.5, "technology": 0.4},
    # PROXY, and labelled as one: OpenRouter has no vision leaderboard. With an empty map every
    # vision-capable model sat at the P_UNKNOWN floor, which is below the vision bar, so EVERY image
    # request answered "nothing clears the bar" -- honest but useless. 'technology' is the nearest
    # revealed-preference signal (general working use), and it is weighted below 1.0 to say that it is
    # borrowed evidence. The hard modality filter still does the real work here.
    "vision":    {"technology": 0.6, "trivia": 0.2},
    # DELIBERATELY EMPTY: for bulk work the leaderboards are the wrong evidence -- popularity tracks
    # capability, and this class explicitly does not want capability, it wants the cheapest thing that
    # can hold a label in its head. The bulk bar sits BELOW P_UNKNOWN so the objective degenerates to
    # "cheapest feasible", which is the correct answer for the class rather than a missing one.
    "bulk":      {},
    "creative":  {"roleplay": 1.0, "marketing": 0.7, "marketing/seo": 0.4},
    "translate": {"translation": 1.0},
    "agentic":   {"programming": 0.8, "technology": 0.8},
    "chat":      {"trivia": 1.0, "technology": 0.3},
    "advice":    {"legal": 0.8, "health": 0.8, "finance": 0.8},
}

# the bar: minimum P_success a candidate must clear, by class and difficulty. AUTHORED POLICY, the one
# number a user should tune. High where a wrong answer is expensive (advice, reasoning), low where a
# retry is cheap (bulk, chat).
_BAR = {
    "code":      (0.58, 0.72), "reasoning": (0.65, 0.82), "longctx": (0.60, 0.74),
    "vision":    (0.55, 0.70), "bulk":      (0.40, 0.52), "creative": (0.50, 0.66),
    "translate": (0.52, 0.68), "agentic":   (0.60, 0.76), "chat":     (0.40, 0.52),
    "advice":    (0.68, 0.80),
}

# temperature of the top-2 blend, in cosine units. At gap=0 the two classes weigh 0.5/0.5; at gap
# equal to BLEND_TEMP the runner-up weighs 0.27; by gap=3*BLEND_TEMP it is 0.05 and the hedge is
# effectively off. Measured margins on the held-out split sit around 0.01-0.15, so 0.05 puts the
# transition where the classifier actually gets torn.
BLEND_TEMP = 0.05

# ---------------------------------------------------------------------------------------------------
# BIND-FIRST: the correction that openzoo forces
#
# The first version treated "this is a huge document" as a MODEL-SELECTION problem: filter to models
# with a big context window, pay for the big window. That is how you use openrouter.ai directly, and
# it is NOT how this stack works. openzoo binds a corpus into a leCore context and retrieves against
# it -- which is why the gateway advertises context_length=128,000,000 for a model whose real window
# (max_model_len) is 1,048,576. The 128M is the bind path talking, not the model.
#
# So the right decision for a large input is not "find a bigger model", it is "BIND IT, then route the
# question -- which is now small -- on its own merits". That makes context a preprocessing step
# instead of a routing constraint, and it stops a 300-page document from forcing an expensive
# long-window model when a cheap one will answer the retrieved slice perfectly well.
#
# KEPT NEGATIVE: this is right for openzoo and WRONG for a caller hitting a provider directly with no
# bind path. Hence `bindable` -- default True here because this repo's stack has one, and callers
# without one pass bindable=False and get the old context-window filter.
BIND_ABOVE_TOKENS = 60_000        # above this, binding beats buying a bigger window
BIND_SLICE_TOKENS = 8_000         # what a retrieval against a bound context actually puts on the wire

_HARD_CUE = re.compile(r"\b(prove|proof|derive|rigorous|production|carefully|step by step|"
                       r"complex|subtle|edge case\w*|optimis\w*|optimiz\w*|architect\w*|"
                       r"security|correctness|exactly|strictly|must)\b")


def difficulty(text, margin=1.0, est_in=0):
    """easy|hard for the request. A HEURISTIC, not a learned head -- there are no difficulty labels in
    the corpus, so inventing a trained one would be dressing a guess as a model. Three observable
    signals: explicit rigour cues, a long prompt, and a low classifier margin (the request straddles
    classes, so a weaker model is likelier to pick the wrong reading)."""
    hits = bool(_HARD_CUE.search(text.lower())) + (est_in > 2000) + (margin < 0.05)
    return "hard" if hits >= 1 else "easy"


# ---------------------------------------------------------------------------------------------------
# 4. OUTCOMES -- how the prior becomes a measurement
# ---------------------------------------------------------------------------------------------------
class Outcomes:
    """Per-(class, model) success counts, so P_success stops being a proxy.

    Beta posterior mean with the leaderboard prior as pseudo-counts: p = (a0*p0 + s) / (a0 + n), a0 =
    PRIOR_STRENGTH. With no data this returns the prior exactly; after n real results the prior's pull
    decays like a0/(a0+n). This is the only path in the file by which a number becomes earned."""

    PRIOR_STRENGTH = 6.0

    def __init__(self, path=OUTCOMES_PATH):
        self.path = path
        self.tab = {}
        if path and os.path.exists(path):
            with open(path) as f:
                self.tab = json.load(f)

    @staticmethod
    def _key(task_class, model_id):
        return f"{task_class}|{model_id}"

    def record(self, task_class, model_id, ok):
        k = self._key(task_class, model_id)
        s, n = self.tab.get(k, [0, 0])
        self.tab[k] = [s + (1 if ok else 0), n + 1]
        if self.path:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(self.path, "w") as f:
                json.dump(self.tab, f, indent=0, sort_keys=True)
        return self.tab[k]

    def posterior(self, task_class, model_id, prior):
        s, n = self.tab.get(self._key(task_class, model_id), [0, 0])
        a0 = self.PRIOR_STRENGTH
        p = (a0 * prior + s) / (a0 + n)
        return float(p), int(n)


# ---------------------------------------------------------------------------------------------------
# 5. THE CATALOGUE -- 414 models as columns, and the decision over them
# ---------------------------------------------------------------------------------------------------
class Catalog:
    """The OpenRouter snapshot as numpy columns, plus feasibility, cost, and P_success."""

    # prior mapped from leaderboard rank 1..20; rank 1 -> P_TOP, rank 20 -> P_BOT.
    P_TOP, P_BOT = 0.88, 0.62
    # a model on NO relevant leaderboard: we do not know. This floor is deliberately below every bar
    # except bulk/chat, so an unmeasured model can win cheap high-volume work (where being wrong is
    # cheap) but cannot silently win a proof or a legal question.
    P_UNKNOWN = 0.45
    P_UNKNOWN_TOOLS = 0.05      # + for declaring tools/structured output when the task needs them
    P_UNKNOWN_REASON = 0.06     # + for declaring reasoning support on a reasoning-class task

    def __init__(self, path=CATALOG_PATH):
        z = np.load(path, allow_pickle=False)
        self.ids = [str(s) for s in z["ids"]]
        self.categories = [str(s) for s in z["categories"]]
        self.ctx = z["ctx"]
        self.price_in = z["price_in"].astype(np.float64)      # USD per 1M prompt tokens
        self.price_out = z["price_out"].astype(np.float64)
        self.modality = z["modality"]
        self.tools = z["tools"].astype(bool)
        self.jsonmode = z["jsonmode"].astype(bool)
        self.reasoning = z["reasoning"].astype(bool)
        self.ranks = z["ranks"]                                # M x C, 0 = unranked
        self.stamp = str(z["stamp"][0]) if "stamp" in z.files else "?"
        self._cat_ix = {c: i for i, c in enumerate(self.categories)}

    def __len__(self):
        return len(self.ids)

    # -- the four terms of the objective -------------------------------------------------------
    def feasible(self, cons, allow_free=True):
        """Boolean mask: models that CAN do the job at all. Pure metadata, no scoring.

        allow_free=False drops $0 endpoints. THEY WIN EVERYTHING OTHERWISE -- a free model that clears
        the bar has zero cost, so the objective picks it every time, correctly and uselessly if you
        cannot live with free-tier rate limits and data policies. That is a deployment fact the router
        cannot read from the catalogue, so it is a caller decision, defaulting to the honest reading of
        the objective (free is cheapest)."""
        ok = np.ones(len(self.ids), dtype=bool)
        if not allow_free:
            ok &= (self.price_in > 0) | (self.price_out > 0)
        if cons["needs_image"]:
            ok &= (self.modality & MOD_IMAGE) > 0
        if cons["needs_tools"]:
            ok &= self.tools
        if cons["needs_json"]:
            ok &= self.jsonmode
        ok &= self.ctx >= cons["min_context"]
        # unpriced or NEGATIVELY priced -> uncostable. isfinite alone is NOT enough: a -3 sailed
        # through it once and would have won every route by being "cheaper" than free.
        ok &= np.isfinite(self.price_in) & np.isfinite(self.price_out)
        ok &= (self.price_in >= 0) & (self.price_out >= 0)
        return ok

    def cost(self, cons):
        """USD per task for every model, from the token estimates. Vectorised, no filtering."""
        return self.price_in * cons["est_in"] / 1e6 + self.price_out * cons["est_out"] / 1e6

    def prior(self, task_class, cons):
        """P_success prior for every model. Leaderboard-derived where available, floored where not."""
        weights = _CLASS_CATEGORIES.get(task_class, {})
        p = np.full(len(self.ids), self.P_UNKNOWN)
        if weights:
            num = np.zeros(len(self.ids))
            den = np.zeros(len(self.ids))
            span = self.P_TOP - self.P_BOT
            for cat, w in weights.items():
                j = self._cat_ix.get(cat)
                if j is None:
                    continue
                r = self.ranks[:, j].astype(np.float64)
                seen = r > 0
                pc = self.P_TOP - (r - 1.0) / 19.0 * span
                num[seen] += w * pc[seen]
                den[seen] += w
            hit = den > 0
            p[hit] = num[hit] / den[hit]
        # metadata nudges apply ONLY to the unknowns: a declared capability is weak evidence, and it
        # must never outrank an actual leaderboard placement.
        unknown = p == self.P_UNKNOWN
        if cons["needs_tools"] or cons["needs_json"]:
            p[unknown & self.tools] += self.P_UNKNOWN_TOOLS
        if task_class in ("reasoning", "code"):
            p[unknown & self.reasoning] += self.P_UNKNOWN_REASON
        return np.clip(p, 0.0, 1.0)

    def bar(self, task_class, diff):
        lo, hi = _BAR.get(task_class, (0.55, 0.70))
        return hi if diff == "hard" else lo


def route(text, catalog=None, classifier=None, outcomes=None, k=5, bar_shift=0.0,
          allow_free=True, blend=True, context=None, bindable=True, **cons_kw):
    """The whole decision. Returns a dict: the chosen model, the shortlist, and every input to the
    choice so a human can disagree with a specific number instead of with a vibe.

    bar_shift raises (>0, be pickier) or lowers (<0, be cheaper) the success bar. It is the one knob
    that changes the answer without changing the code."""
    catalog = catalog if catalog is not None else Catalog()
    classifier = classifier if classifier is not None else TaskClassifier.load()
    outcomes = outcomes if outcomes is not None else Outcomes()

    # CLASSIFY on text+context, but SIZE the job from `text`. A live agent turn is usually a fragment
    # ('fix it', 'did this work?') that carries no routable task alone, so the caller passes the
    # conversation so far as `context`; it informs WHAT the task is without inflating the token
    # estimate for THIS call, which the caller should supply via input_tokens when it knows.
    classify_on = f"{context}\n{text}" if context else text
    s = np.atleast_1d(np.asarray(classifier.scores(classify_on), dtype=np.float64))
    order2 = np.argsort(-s)[:2]
    if len(order2) == 1:                                   # a single-class classifier: nothing to hedge
        order2 = np.array([order2[0], order2[0]])
    cls = classifier.classes[int(argmax_tiebreak(s))]
    conf, margin = float(s[order2[0]]), float(s[order2[0]] - s[order2[1]])
    cons = extract_constraints(text, task_class=cls, **cons_kw)

    # BIND-FIRST. Decide this BEFORE feasibility, because it changes what the models are being asked
    # to hold. A bound corpus never reaches the model whole; a retrieved slice does.
    raw_in = cons["est_in"]
    bind_first = bool(bindable and raw_in > BIND_ABOVE_TOKENS)
    if bind_first:
        cons = dict(cons, est_in=BIND_SLICE_TOKENS,
                    min_context=int((BIND_SLICE_TOKENS + cons["est_out"]) * 1.25) + 512)
    cons["bind_first"] = bind_first
    cons["raw_in"] = raw_in

    diff = difficulty(classify_on, margin=margin, est_in=raw_in)

    # BLEND THE TOP TWO CLASSES by their score share. When the classifier is confident the runner-up
    # weight is negligible and this is identical to committing; when it is torn -- which on the
    # held-out split is exactly where it is wrong -- the prior and the bar become the mixture instead
    # of a coin flip. Uncertainty should cost a little money, not a failed task.
    c2 = classifier.classes[int(order2[1])] if len(order2) > 1 else cls
    # Softmax over the top-2 with a COSINE-SCALE temperature. Normalising the raw scores instead
    # (w = s / sum(s)) was the first version and it is wrong: cosines 0.30 vs 0.29 are a confident
    # call, but that formula reports 0.51/0.49 and hedges every single request. The gap is the signal,
    # so the weight has to be a function of the gap, not of the magnitudes.
    gap = float(s[order2[0]] - s[order2[1]])
    w2 = float(np.exp(-max(0.0, gap) / BLEND_TEMP))
    w = np.array([1.0, w2]) / (1.0 + w2)
    if not blend:
        w = np.array([1.0, 0.0])

    feas = catalog.feasible(cons, allow_free=allow_free)
    cost = catalog.cost(cons)
    prior = w[0] * catalog.prior(cls, cons) + w[1] * catalog.prior(c2, cons)
    bar = float(np.clip(w[0] * catalog.bar(cls, diff) + w[1] * catalog.bar(c2, diff) + bar_shift,
                        0.0, 1.0))
    post = np.array([outcomes.posterior(cls, mid, prior[i])[0] for i, mid in enumerate(catalog.ids)])
    nobs = np.array([outcomes.posterior(cls, mid, prior[i])[1] for i, mid in enumerate(catalog.ids)])

    idx = np.flatnonzero(feas)
    if len(idx) == 0:
        # EVERY return from route() carries the same keys. The first version omitted bind_first
        # here, so a caller that always reads r["bind_first"] crashed on exactly the path where it
        # most needed an answer. A test caught it; the contract is now uniform.
        return dict(model=None, task_class=cls, runner_up=c2, bind_first=cons["bind_first"],
                    difficulty=diff, bar=bar, constraints=cons, shortlist=[],
                    reason="no model in the catalogue satisfies the hard constraints",
                    cleared_bar=False, feasible_models=0, catalog_stamp=catalog.stamp)

    clears = idx[post[idx] >= bar]
    cleared = len(clears) > 0
    if cleared:
        # THE OBJECTIVE: cheapest that clears. Ties in cost break by higher P, then by id -- so the
        # answer never depends on catalogue order.
        pool = clears
        order = sorted(pool, key=lambda i: (round(float(cost[i]), 12), -post[i], catalog.ids[i]))
    else:
        # Nothing clears: fall back to the strongest available and SAY SO. Cheapness is not a
        # consolation prize when the task probably will not get done.
        pool = idx
        order = sorted(pool, key=lambda i: (-post[i], round(float(cost[i]), 12), catalog.ids[i]))

    # Relative cost against the cheapest FEASIBLE model, floored at $1-per-million-tasks. Without the
    # floor a free ($0) baseline makes every ratio 1e8-ish nonsense; with it, "37x" against a free
    # model means "37 dollars per million tasks more than free", which is a real thing to know.
    COST_FLOOR = 1e-6
    cheapest_feasible = max(float(np.min(cost[idx])), COST_FLOOR)
    short = []
    for i in order[:k]:
        short.append(dict(
            model=catalog.ids[i],
            p_success=round(float(post[i]), 3),
            evidence=(f"measured(n={int(nobs[i])})" if nobs[i] else "prior"),
            usd_per_task=round(float(cost[i]), 6),
            relative_cost=round(float(cost[i]) / cheapest_feasible, 2) if cheapest_feasible else None,
            context=int(catalog.ctx[i]),
        ))
    top = order[0]
    return dict(
        model=catalog.ids[top], task_class=cls, runner_up=c2, bind_first=cons["bind_first"],
        blend=(round(float(w[0]), 3), round(float(w[1]), 3)),
        class_confidence=round(conf, 3),
        class_margin=round(margin, 3), difficulty=diff, bar=round(bar, 3),
        p_success=round(float(post[top]), 3), usd_per_task=round(float(cost[top]), 6),
        cleared_bar=cleared, feasible_models=int(len(idx)), shortlist=short,
        constraints=cons, catalog_stamp=catalog.stamp,
        reason=(("bind %d tokens to leCore first, then " % cons["raw_in"] if cons["bind_first"]
                 else "")
                + "cheapest of %d feasible models clearing P>=%.2f for a %s %s task"
                % (int((post[idx] >= bar).sum()), bar, diff, cls) if cleared else
                "NO feasible model clears P>=%.2f for a %s %s task; returning highest-P instead"
                % (bar, diff, cls)),
    )


# ---------------------------------------------------------------------------------------------------
def _selftest():
    """Assert the CONTRACTS, not the vibes: determinism of the encoder, that the objective actually
    minimises cost subject to the bar, that hard constraints are hard, and that recorded outcomes move
    P away from the prior. Uses a small synthetic catalogue so it needs no network and no artifact."""
    import tempfile

    # 1) encoder: deterministic, vocabulary-free, typo-tolerant
    enc = TextEncoder(dim=1024, seed=3)
    a, b = enc.encode("write a python function"), enc.encode("write a python function")
    assert np.array_equal(a, b), "encoder must be deterministic"
    assert enc.encode("zzzz qqqq wwww").shape == (1024,), "unseen words must still encode"
    typo = float(enc.encode("write a python fucntion") @ a)
    unrel = float(enc.encode("translate this into japanese") @ a)
    assert typo > unrel + 0.2, (typo, unrel)          # char n-grams carry the misspelling

    # 2) classifier: learns a separable toy task and abstains sensibly on a straddle
    toy_x = ["write a python function", "debug this rust program", "fix the failing test",
             "translate this into french", "how do you say hello in italian",
             "localise these strings for german"]
    toy_y = ["code", "code", "code", "translate", "translate", "translate"]
    # BOTH heads must separate the toy task -- the fast path and its reference (F22). If only one
    # does, the features are fine and the head is broken; if neither does, the features are broken.
    for method, kw in (("ridge", {}), ("adapthd", dict(epochs=20))):
        c = TaskClassifier(["code", "translate"], enc).fit(toy_x, toy_y, method=method, **kw)
        assert c.predict("refactor this function")[0] == "code", method
        assert c.predict("translate this paragraph into spanish")[0] == "translate", method
    clf = TaskClassifier(["code", "translate"], enc).fit(toy_x, toy_y)

    # 3) round-trip through int8 must not change the decision
    fd, p = tempfile.mkstemp(suffix=".npz"); os.close(fd)
    clf.save(p)
    clf2 = TaskClassifier.load(p)
    assert clf2.predict("refactor this function")[0] == "code", "int8 round-trip changed the label"
    os.remove(p)

    # 4) the objective, on a synthetic catalogue: cheap+capable must beat expensive+capable, and a
    #    model that fails a HARD constraint must be unreachable at any price or probability.
    fd, cp = tempfile.mkstemp(suffix=".npz"); os.close(fd)
    ids = ["cheap/good", "pricey/good", "cheap/blind", "cheap/weak"]
    np.savez(cp, ids=np.array(ids), ctx=np.array([200000] * 4), categories=np.array(["programming"]),
             price_in=np.array([0.5, 10.0, 0.4, 0.3], dtype=np.float32),
             price_out=np.array([1.0, 30.0, 0.8, 0.6], dtype=np.float32),
             modality=np.array([MOD_TEXT | MOD_IMAGE, MOD_TEXT | MOD_IMAGE, MOD_TEXT, MOD_TEXT],
                               dtype=np.uint8),
             tools=np.array([True, True, True, False]), jsonmode=np.array([True] * 4),
             reasoning=np.array([True] * 4),
             ranks=np.array([[2], [1], [3], [0]], dtype=np.uint8),
             stamp=np.array(["selftest"]))
    cat = Catalog(cp)
    cons = extract_constraints("write a python function", task_class="code")
    prior = cat.prior("code", cons)
    assert prior[3] == Catalog.P_UNKNOWN + Catalog.P_UNKNOWN_REASON, prior   # unranked -> floor + nudge
    assert prior[1] > prior[0] > prior[2], prior                              # rank order preserved

    clf3 = TaskClassifier(["code"], enc).fit(["write a python function"], ["code"])
    out = Outcomes(path=None)
    r = route("write a python function", catalog=cat, classifier=clf3, outcomes=out)
    assert r["cleared_bar"] is True
    # the contract is the OBJECTIVE itself, computed here independently: among the models clearing the
    # bar, the chosen one is the cheapest -- NOT the highest-P one. pricey/good has the best prior and
    # must lose anyway; that losing is the entire point of the router.
    clearing = [s for s in r["shortlist"] if s["p_success"] >= r["bar"]]
    assert r["model"] == min(clearing, key=lambda s: s["usd_per_task"])["model"], r
    assert r["model"] != "pricey/good", r
    assert r["p_success"] >= r["bar"], r

    rv = route("what is in this screenshot", catalog=cat, classifier=clf3, outcomes=out,
               has_image=True)
    assert all(s["model"] in ("cheap/good", "pricey/good") for s in rv["shortlist"]), rv
    assert rv["feasible_models"] == 2, rv          # the two text-only models are GONE, not demoted

    # 5) a bar nobody clears must be reported, not papered over
    rhard = route("prove this rigorously", catalog=cat, classifier=clf3, outcomes=out, bar_shift=0.5)
    assert rhard["cleared_bar"] is False and "NO feasible model" in rhard["reason"], rhard
    assert rhard["model"] == "pricey/good", rhard  # highest P, explicitly labelled as a fallback

    # 6) outcomes move the number: 12 failures on the cheap model must dethrone it
    out2 = Outcomes(path=None)
    for _ in range(12):
        out2.record("code", "cheap/good", False)
    r2 = route("write a python function", catalog=cat, classifier=clf3, outcomes=out2)
    assert r2["model"] != "cheap/good", r2
    # the demoted model fell OUT of the clearing set entirely, so it is absent from the shortlist --
    # check the mechanism at its source rather than through the survivors.
    p_before = float(cat.prior("code", cons)[ids.index("cheap/good")])
    p_after, n_after = out2.posterior("code", "cheap/good", p_before)
    assert n_after == 12 and p_after < p_before - 0.3, (p_before, p_after, n_after)
    assert "cheap/good" not in [s["model"] for s in r2["shortlist"]], r2
    os.remove(cp)
    print("holographic_modelroute selftest: OK (deterministic encoder; int8 round-trip preserves the "
          "label; cheapest-clearing-the-bar wins; hard constraints remove candidates; an uncleared bar "
          "is reported; recorded outcomes override the prior)")


if __name__ == "__main__":
    _selftest()
