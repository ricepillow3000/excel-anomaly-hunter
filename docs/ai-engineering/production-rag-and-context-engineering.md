# Production RAG and context engineering: John's notes, checked against our projects

Written 2026-10-15 from John's own notes, as a reference for John and for the AI agents that work on these repos.
Part 1 is what John said, tidied up. Part 2 explains the words. Part 3 checks each idea against the real code of
**Excel Anomaly Hunter** and the **Meleona Portfolio Risk Engine**. A future agent should read Part 3 before adding
anything AI-shaped to either repo.

---

## 1. What John said (tidied, meaning unchanged)

> I run **hybrid search with re-ranking**. I **rewrite the query before it ever hits the index**, and I **measure
> retrieval quality before I trust a single answer**. That's production RAG. Without it you burn tokens and ship chaos.
>
> I **scoped the tools and the control state with LangGraph**, so I know exactly what's happening inside the agent.
>
> I'm learning prompt engineering to become an AI engineer, but the real job is bigger: make sure the model has
> **the right context, the right data, and reliable evaluation.**

The core idea in one line: **the model is only as good as what you put in front of it, and you only know what you
put in front of it if you measure it.**

---

## 2. The words, in plain English

| Term | Plain meaning | Why it matters |
|---|---|---|
| **RAG** (retrieval-augmented generation) | Before the model answers, look up the right pages and paste them into the prompt. | The model answers from your facts, not its memory. |
| **Hybrid search** | Look things up two ways at once: by exact words (keyword / BM25) and by meaning (vectors / embeddings), then merge the lists. | Keyword search finds `ISIN US0378331005`; meaning search finds "Apple's ID code". Each misses what the other catches. |
| **Re-ranking** | A second, slower and smarter pass that re-sorts the top ~50 hits and keeps the best ~5. | The first pass is fast but rough. Re-ranking makes sure the best page lands at the top, inside the token budget. |
| **Query rewriting** | Turn the user's messy question into a clean search before searching ("why's my Q3 off" becomes "Q3 revenue variance vs budget"). | Bad query in, bad pages out, wrong answer out. This is the cheapest fix in the whole pipeline. |
| **Retrieval evaluation** | A fixed set of questions where you already know the right pages. Score the search on it: recall@k ("was the right page in the top k?"), MRR / nDCG ("how high up was it?"). | It tells you whether a bad answer came from the search or from the model, so you fix the right thing. |
| **Answer evaluation** | Same idea for the final answer: a golden set with known-correct answers, scored automatically. | "It looked right in the demo" is not evidence. |
| **Context engineering** | Choosing exactly what goes into the prompt: which data, how much, in what order, with which rules. | It is the bigger job that prompt wording sits inside. |
| **LangGraph** | A library that runs an agent as a graph of explicit steps with a shared, typed state, and gives each step only the tools it needs. | You can see and test every step, and an agent can't wander off and call tools it shouldn't. |

### The pipeline John described

```
user question
   │
   ▼
[1] rewrite the query ──► [2] hybrid search (keyword + vector) ──► [3] re-rank, keep top few
                                                                        │
                                                                        ▼
[6] measure: retrieval scores + answer scores ◄── [5] answer ◄── [4] build the context (right data, in budget)
   └── feeds back into steps 1-4. Nothing ships until step 6 says it's good.
```

---

## 3. Is this relevant to our projects? (checked against the code on 2026-10-15)

**Short answer:** neither project needs a search index (vector RAG). One half of John's idea, **"measure before you
trust"**, is a real and useful gap in Excel Anomaly Hunter. Neither repo uses LangGraph, LangChain, embeddings or a
vector store (checked by searching both repos).

| Idea | Excel Anomaly Hunter | Risk Engine |
|---|---|---|
| Hybrid search + re-ranking | **Not needed.** No document pile to search. | **Not needed.** No LLM in the product at all. |
| Query rewriting | **Not needed.** The query is a row number, not words. | Not applicable. |
| Right context in the prompt | **Already done well** (see 3.1). | Not applicable. |
| Measure before trusting | **Gap: worth building** (see 3.1). | **Already the house style**, for numbers (see 3.2). |
| Scoped tools / control state | **Already done**, without LangGraph (see 3.1). | Not applicable. |

### 3.1 Excel Anomaly Hunter

**Where the AI is:** `backend/anomaly_hunter/ai/client.py`. The model is asked to fix **one flagged row**
(`suggest_fix`) and to spot odd text values (`odd_text`). It goes through Gemini, the invite relay, or Claude.

**Why it needs no search index:** RAG exists for "the answer is somewhere in 10,000 documents and I don't know where".
Here we know *exactly* where the context is: it's the flagged row, its neighbours and its column headers. Fetching
by row number is a perfect lookup (recall = 100%, zero cost). Swapping it for a fuzzy vector search would be slower,
cost tokens, and could miss the very row being fixed.

**Context engineering it already does** (`_fix_prompt`):
- the flagged row, plus 5 rows above and below (`ctx=5`);
- if that's over the size budget (`_fits` / `BUDGET`), only the columns nearest the flagged cell (`keep=nearest[:n]`);
- the row's formulas, so the model fixes inputs instead of overwriting a formula;
- the detector's plain-sentence reason ("why it was flagged");
- long cells are cut, and their addresses recorded (`cut`), so the model can't rewrite a cell it only half saw.

**Scoped tools and control state, already present without LangGraph:**
- answers must match a fixed schema (`FIX_SCHEMA`, pydantic `Fix`);
- writes outside the table are dropped (`_in_table`), so a prompt-injected cell can't steer writes elsewhere;
- a formula may not point at its own cell (`refers_to_itself`);
- one call at a time, a deadline, a cache of answers (never prompts), and the key is never echoed (CLAUDE.md layer 9);
- the user previews every change, and nothing is written until they click Apply.

**The real gap: there is no answer-quality score for the AI fix.** The detectors are measured to the decimal
(`score.py .` gates, `score.py . --blind`, `test_blindspots.py` 279/279). The AI fix is tested only for its *guards*,
using stub answers (`test_fix.py`, `test_ai_load.py`). Nothing measures how often the real model proposes the *right*
fix. That is exactly John's "measure before you trust a single answer".

**Suggested next step (not built yet, John to decide):** a small golden set of synthetic flagged rows (never a real
customer file, per CLAUDE.md), each with its known-correct fix: an x10 typo, a misspelt label, a Qty × Price total,
a 2084 date, and so on. Score the real model on three things: was the right cell changed, was the value right, and
did it stay inside the table. Run it on demand, not in CI, because every run costs tokens. Only once that score
exists is it worth testing a context change. For example, picking context rows that share the flagged row's label
instead of just the 5 nearest by position: change it only if the score goes up.

### 3.2 Meleona Portfolio Risk Engine

**There is no LLM in the product**, and that is deliberate. Its CLAUDE.md, constraint 1: *"No LLM-originated data,
ever. Every market number must come from Yahoo Finance … computed by the engine's own numpy/scipy code."* The page's
"AI" section is the **AI-capex** investment thesis (companies spending on compute), not an AI model.

So RAG, re-ranking and LangGraph don't fit. Adding them would *hurt* the project's main selling point, which is
interview credibility.

**But John's principle is already the engine's backbone, applied to numbers instead of text:**
- `tests/batch_audit.py` re-derives every number a second, independent way and names the paper it is checked against;
- the VaR model is backtested (Kupiec + Christoffersen), not just reported;
- the provenance panel shows exactly where each number came from.

That is "measure before you trust" without a language model. **That's the interview story:** the same discipline
John wants for RAG answers is what this engine already does for risk numbers.

### 3.3 The agents that work on these repos (Claude Code and others)

Each repo's `CLAUDE.md` is already context engineering for the coding agents. It is short and curated, holds the
rules learned the hard way, and is loaded at the start of every session. At this repo size, an agent reading the
right file directly beats any search index. Keep `CLAUDE.md` short and true. That is the agent-side version of
"right context, right data".

---

## 4. Rules for an agent about to add AI to either repo

1. **Know where the context is? Fetch it directly** (by row, key or file). Use search/RAG only when the answer could be
   anywhere in a pile too big for the prompt.
2. **No eval set, no change.** Before changing a prompt, its context or the model, have a golden set with known
   answers and a score. Report the before/after numbers in the commit message, just as detector changes already do.
3. **Tell search failures apart from model failures.** If it uses retrieval, score the retrieval (recall@k) separately
   from the answer.
4. **Give the model only the tools and writes it needs**, and check every write against an allow-list
   (Anomaly Hunter's `_in_table` is the pattern to copy).
5. **Risk Engine: no LLM output may become a market number.** Ever.
