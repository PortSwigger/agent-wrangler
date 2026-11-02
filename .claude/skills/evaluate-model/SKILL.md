---
name: evaluate-model
description: Use when checking benchmark freshness, adding a measured model or effort, or refreshing the Pareto-front data after a board, vendor effort result or list-price change.
---

# Evaluate a model for the Pareto front

Core owns `public/model-front-data.json`: `{read, credit, benchmarks, models}`.
Each model/effort row is `[quality, usd, minutes]` per benchmark task. The
standalone evaluator reports the front for both agents, Claude alone and Codex
alone. UI, presets and defaults belong to their callers.

## Sources

| Key | Source | Licence | Gives |
| --- | --- | --- | --- |
| `board` | [Terminal-Bench leaderboard](https://github.com/harbor-framework/terminal-bench/tree/main/leaderboard/submissions) | Apache-2.0 | Max-effort accuracy, tokens and trial time in each vendor's harness |
| `anthropic` | [Opus](https://www.anthropic.com/claude-opus-5-5), [Sonnet](https://www.anthropic.com/claude-sonnet-5-5), [Haiku](https://www.anthropic.com/claude-haiku-5-5) | Published results, cited | Terminal-Bench accuracy/cost CSVs by effort |
| `openai` | [Terra launch](https://openai.com/index/introducing-gpt-6-1-terra/), [Sol launch](https://openai.com/index/introducing-gpt-6-1-sol/) | Published results, read by hand and cited | Accuracy by effort; costs are null |
| `prices` | [LiteLLM catalog](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json), bundled in `server/price-catalog.snapshot.json` | MIT, list-price facts | `cacheWrite5m`, `cacheRead`, `output` per million tokens |

Never fetch OpenAI posts programmatically. Carry sweeps from the newest committed
inputs forward, preserving their source and any `unconfirmed` note. Read a post
by hand when the reader flags a catalog model without a sweep or a new OpenAI
board run. Confirm the numbers and remove only resolved manual flags. No
Artificial Analysis data is used. Review terms before adding any source.

## Read and compare

1. Run `npm run gen:catalog` for fresh prices using core's existing mechanism.
2. Run `node scripts/read-front-sources.mjs`. It uses the newest **committed**
   inputs as its base, reads the board version from `leaderboard.yaml` via GitHub
   API, selects the newest max run in Claude Code/Codex, and reads only the
   Anthropic chart titled with that benchmark version. It writes
   `.claude/skills/evaluate-model/inputs-<today>.json`. `--base FILE` and
   `--out FILE` allow an explicit baseline and scratch output.
3. Run `node .claude/skills/evaluate-model/evaluate.js --diff FRESH BASE`.
   Exit 0 means no numerical or manual-flag change: discard the fresh reading.
   Exit 1 prints CHANGED/NEW/GONE lines: rescore. Exit 2 means the benchmark
   major/minor scale changed: manually re-read every vendor sweep before
   rescoring; never mix versions. Exit 3 means malformed inputs or another
   error: fix the source reading first. Patch versions keep the scale.
4. Run `node .claude/skills/evaluate-model/evaluate.js FRESH --write` to report
   sources, anchors, rows and all three fronts and generate the JSON file.
   Without `--write`, the evaluator only prints a report. Keep the dated inputs.
5. Run `npm test`. The tests prove committed rows and credit reproduce from
   committed inputs. When refreshing, keep this expectation on the newest file.

An unreadable permitted source fails the reader (exit 3) without writing inputs.
A board major/minor change also fails it until every vendor sweep is manually
read at the new scale. A missing board run is removed, never retained silently;
a model still needs its own board row or vendor max, plus a valid donor chain.

The weekly/manual `refresh-model-front` workflow runs the catalog generator
first. No-change exits without a PR. Changed data generates and tests the JSON,
then opens/updates `automation/refresh-model-front` using idcat. The PR includes
the diff, source flags and all agent-set fronts. Errors fail the workflow;
Slack notices are conditional on `SLACK_WEBHOOK_URL`. No auto-merge.

## Inputs and derivation

`inputs-<date>.json` records `sources` (name, by, licence, url, gives), `credit`,
`benchmarks` (name, version, weight), `models`, and optional `manual` source flags.
A model has `price: {write, read, output}`, optional sibling `like`, and each
benchmark's `board` and/or `sweep: {source, efforts: {effort: [accuracy, usd|null]}}`.
Board fields are copied verbatim from metrics; `uncached_input_tokens` counts
all input, including the cached share. Total must equal input plus output.

The evaluator preserves the established derivation:

- Anchor max quality on board accuracy; cost on board tokens per trial at list
  prices (input less cached at cache-write, cached at cache-read, plus output);
  time on mean trial minutes.
- Without a board run, use the model's own vendor max plus its agent's median
  board-minus-vendor quality gap; vendor cost times the median board/vendor cost
  factor. Without vendor cost, price a donor's board tokens at its own prices.
  Time comes from the first board row in the `like` chain.
- Ladder down by vendor accuracy/max and cost/max. Interpolate missing efforts;
  below the lowest measurement borrow a donor ladder scaled to meet it.
- Each row is `Q*p(e), C*r(e), T*(0.25 + 0.75*r(e))`. Average benchmarks by weight,
  round once with ties to even: integer quality, 2dp dollars, 1dp minutes.
- A front point is unbeaten on quality, cost and time together. Reports are
  cheapest first and do not rely on the later public maths/API.

No borrowed quality, Auto rows, unmeasured `minimal`/`ultra` efforts, review
multiplier, preset or programme enters core's data. Superseded models stay
excluded; `sonnet[1m]` shares Sonnet's measurements.
