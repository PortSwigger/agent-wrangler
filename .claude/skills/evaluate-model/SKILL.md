---
name: evaluate-model
description: Use when checking benchmark freshness, adding a measured model or effort, or refreshing the Pareto-front data after a board, vendor effort result or list-price change.
---

# Evaluate a model for the Pareto front

Core owns `public/model-front-data.json`: `{read, credit, benchmarks, models}`.
Each model/effort row is `[quality, usd, minutes]` per benchmark task. The
standalone evaluator reports the front for all agents together, Claude alone,
Codex alone and Gemini (agy) alone. UI, presets and defaults belong to their
callers.

## Sources

| Key | Source | Licence | Gives |
| --- | --- | --- | --- |
| `board` | [Terminal-Bench leaderboard](https://github.com/harbor-framework/terminal-bench/tree/main/leaderboard/submissions) | Apache-2.0 | Accuracy, tokens and trial time in each vendor's harness (Claude Code and Codex at max, Antigravity CLI at the model's own effort), on the newest Terminal-Bench version run for each model |
| `hub` | [tbench.ai](https://www.tbench.ai/) (Harbor Hub leaderboard the page embeds) | Published by the board's maintainers, cited | Accuracy on the newest Terminal-Bench version for max runs the GitHub board has only at an older version, re-scored on the same trajectories |
| `anthropic` | [Opus](https://www.anthropic.com/claude-opus-5-5), [Sonnet](https://www.anthropic.com/claude-sonnet-5-5), [Haiku](https://www.anthropic.com/claude-haiku-5-5) | Published results, cited | Terminal-Bench accuracy/cost CSVs by effort |
| `anthropic-card` | [Fable 5.2 system card](https://assets.claude.com/27d60918d218125e7504bc7354c4b4626ec56b11.pdf), section 8.5 | Published results, read by hand and cited | Fable 5.2 accuracy at max only; cost, other efforts and minutes come from `like` |
| `openai` | [Terra launch](https://openai.com/index/introducing-gpt-6-1-terra/), [Sol launch](https://openai.com/index/introducing-gpt-6-1-sol/) | Published results, read by hand and cited | Accuracy by effort; costs are null |
| `google` | [Gemini 4 Hydrogen launch](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/) | Published results, read by hand and cited | Hydrogen's Terminal-Bench 4.0 accuracy/cost chart by effort, measured from its pixels; Gemini 3.8 Flash's Terminal-Bench 4.1 accuracy from the text |
| `prices` | [LiteLLM catalog](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json), bundled in `server/price-catalog.snapshot.json` | MIT, list-price facts | `cacheWrite5m` (`input` for Gemini), `cacheRead`, `output` per million tokens |

Never fetch OpenAI posts programmatically. Carry sweeps from the newest committed
inputs forward, preserving their source and any `unconfirmed` note. Read a post
by hand when the reader flags a catalog model without a sweep or a new OpenAI
board run. A Claude model with no Terminal-Bench chart of its own (Fable 5.2)
keeps its hand-read system-card max until Anthropic charts it or the board runs
it. Google's posts chart by image, so read them by hand too when the reader flags
a new Google board run; Google takes most of its Terminal-Bench figures from
Artificial Analysis, and those are not used. Confirm the numbers and remove only
resolved manual flags. No Artificial Analysis data is used. Review terms before
adding any source.

## Read and compare

1. Run `npm run gen:catalog` for fresh prices using core's existing mechanism.
2. Run `node scripts/read-front-sources.mjs`. It uses the newest **committed**
   inputs as its base. Through the GitHub API it selects, for each model, the max
   run in Claude Code/Codex on the newest Terminal-Bench version the board has
   run it on (the version in `leaderboard.yaml`, or `4-1-0` in a submission name),
   then the newest by date. When tbench.ai's leaderboard (the Harbor Hub data its
   home page embeds) is on a newer version and lists the same model at max in the
   same harness with the same tokens, it is a re-score of that run: accuracy comes
   from the Hub row (`hub_row`), tokens and minutes from the GitHub run. Other
   tokens mean another run, so the reader flags it for a person instead. It reads the Anthropic chart titled with the newest
   version the page charts. It writes
   `.claude/skills/evaluate-model/inputs-<today>.json`. `--base FILE` and
   `--out FILE` allow an explicit baseline and scratch output.
3. Run `node .claude/skills/evaluate-model/evaluate.js --diff FRESH BASE`.
   Exit 0 means no numerical or manual-flag change: discard the fresh reading.
   Exit 1 prints CHANGED/NEW/GONE lines: rescore. Exit 2 means a model moved to
   a newer major/minor version: check every vendor for sweeps charted at it by
   hand, then rescore. Exit 3 means malformed inputs or another error: fix the
   source reading first. Patch versions keep the scale.
4. Run `node .claude/skills/evaluate-model/evaluate.js FRESH --write` to report
   sources, anchors, rows and all three fronts and generate the JSON file.
   Without `--write`, the evaluator only prints a report. Keep the dated inputs.
5. Run `npm test`. The tests prove committed rows and credit reproduce from
   committed inputs. When refreshing, keep this expectation on the newest file.

An unreadable permitted source fails the reader (exit 3) without writing inputs.
Each model uses the newest version wherever the board or its vendor has one, so
one front can mix versions; the credit names them. A missing board run is
removed, never retained silently;
a model still needs its own board row or vendor max, plus a valid donor chain.

The weekly/manual `refresh-model-front` workflow runs the catalog generator
first. No-change exits without a PR. Changed data generates and tests the JSON,
then opens/updates `automation/refresh-model-front` using idcat. The PR includes
the diff, source flags and all agent-set fronts. Errors fail the workflow;
Slack notices are conditional on `SLACK_WEBHOOK_URL`. No auto-merge.

## Inputs and derivation

`inputs-<date>.json` records `sources` (name, by, licence, url, gives), `credit`,
`benchmarks` (name, version, weight), `models`, and optional `manual` source flags.
A model has `price: {write, read, output}`, optional sibling `like`, optional
`supersededBy`, optional `efforts` (the ascending efforts it takes, all five when
absent; agy's models stop at high or xhigh, matching `server/agents/agy.js`), and
each benchmark's `board` and/or
`sweep: {source, version, efforts: {effort: [accuracy, usd|null]}}`. A model's
vendor max is the sweep at its top effort.
Board fields are copied verbatim from metrics, plus the run's `version` and, when
it is not max, its `effort`;
`uncached_input_tokens` counts all input, including the cached share. Total must
equal input plus output. A `-regrade` run re-scores an earlier run's trajectories
against newer tests, so its trial time is the regrading's: `minutes_file` names
the newest original run, whose `avg_trial_duration_sec` it takes instead. A
`hub_row` names the tbench.ai row whose accuracy and `version` replace the GitHub
run's; every other field is still the GitHub run's.

The evaluator preserves the established derivation:

- Anchor quality at the board run's effort (max unless it names another) on
  board accuracy; cost on board tokens per trial at list prices (input less
  cached at cache-write, cached at cache-read, plus output); time on mean trial
  minutes. Gemini has no cache-write premium, so agy's `write` is LiteLLM's
  `input`, which reproduces the board's own `total_cost_usd`.
- Without a board run, use the model's own vendor max quality as published;
  vendor cost times the median board/vendor cost factor. Without vendor cost,
  price a donor's board tokens at its own prices. Time comes from the first
  board row in the `like` chain.
- Ladder by vendor accuracy and cost as shares of the anchor effort's. Interpolate
  missing efforts; below the lowest measurement borrow a donor ladder scaled to
  meet it. Rows cover only the efforts the model takes.
- Each row is `Q*p(e), C*r(e), T*(0.25 + 0.75*r(e))`. Average benchmarks by weight,
  round once with ties to even: integer quality, 2dp dollars, 1dp minutes.
- A front point is unbeaten on quality, cost and time together. Reports are
  cheapest first and do not rely on the later public maths/API.

No borrowed quality, Auto rows, unmeasured `minimal`/`ultra` efforts, review
multiplier, preset or programme enters core's data. A superseded model stays
in the inputs with `supersededBy` only as its successor's `like` donor for the
ladder or minutes; it has no rows. `sonnet[1m]` shares Sonnet's measurements.
