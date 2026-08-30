# Zera for Feather

AI-powered, documentation-grounded quality assurance for bug and feature-request rubrics.

Zera validates complete rubric batches before submission. It combines strict JSON and batch checks with an OpenAI-assisted semantic review that searches current product documentation, checks grammar and clarity, verifies tags and workflow alignment, and produces corrected JSON when changes are needed.

## The problem

Rubric authors currently have to check JSON structure, batch composition, tags, reproduction steps, language quality, and product accuracy by hand. That process is slow and inconsistent, and a polished-looking rubric can still describe an unsupported workflow or receive an unjustifiably high quality score.

Zera gives rubric authors one review surface that catches mechanical mistakes immediately and uses current application documentation to evaluate claims that cannot be verified with simple rules. The value is not just faster review; it is preventing false confidence before a rubric batch is submitted.

## Features

- Validates the exact JSON array and rubric object structure.
- Checks Batch A, Batch B, and Batch C count requirements in real time.
- Requires exactly one valid tag—`bug` or `feature request`—per rubric.
- Requires criteria to begin with a capitalized section followed by a colon, such as `Home:`.
- Verifies that bug reproduction steps form an uninterrupted ordered list beginning at `1`.
- Requires feature-request reproduction steps to be exactly `N/A`.
- Reviews criteria, workflows, expected behavior, and actual behavior against current application documentation.
- Checks grammar, clarity, specificity, consistency, and tag-to-behavior alignment.
- Treats missing documentation support as an error and unclear support as a warning.
- Reports `Pass`, `Pass with warnings`, or `Failed to pass` with findings for every rubric.
- Generates corrected rubric JSON that can be copied from the report.
- Polls background AI reviews until they complete, without a fixed validation deadline.

## Improvement Changelog

The following progression reflects the changes this project actually made. Evidence comes from the failure cases observed during development and the corresponding implementation changes in the repository.

| Stage | What we tried and why | Evidence | Decision / learning |
| --- | --- | --- | --- |
| Baseline - score-based Rhea reviewer | Started with two text fields and a heuristic quality score so a user could quickly review a prompt and its rubrics. | Entering meaningless one-character content such as `a` still produced a score of **81/100**. The score looked precise but was not evidence that the input was usable. | A generic score was the wrong success signal. The tool needed to validate the real submission format and explain concrete failures. |
| Iteration 1 - input gates | Added required fields, minimum-word checks, a disabled review button, reset behavior, and an example loader to stop empty submissions. | Empty input was blocked, but arbitrary text could still satisfy a word-count rule without becoming a valid rubric. Minimum-word validation also rejected short inputs without explaining the actual structural problem. | Kept blank-state controls and removed minimum-word validation. Input length was not a reliable proxy for quality. |
| Iteration 2 - rubric-batch workflow | Replaced the prompt scorer with a validator for the submitted rubric JSON format and added Batch A, B, and C requirements. | The interface could now distinguish a malformed payload from a valid array and show live totals for rubrics, bugs, feature requests, and valid single tags. | Kept the batch gate. Validation had to start from the artifact people actually submit. |
| Iteration 3 - exact deterministic checks | Added exact object keys, required form fields, one valid tag per rubric, section-prefix rules, ordered bug steps, and `N/A` feature-request steps. | Cases that previously reached review now stop at the relevant rule: malformed JSON receives a format message, an incomplete batch cannot be submitted, and a `19/20` tag count no longer appears complete. | Kept deterministic checks for rules that should never depend on an AI judgment. |
| Iteration 4 - documentation-grounded review | Added the OpenAI Responses API with web search and structured output so the agent could inspect grammar, infer the correct tag, and compare each claim with current application documentation. | Reviews now return one structured result per rubric, application sources, documentation status, section alignment, findings, suggestions, and corrected JSON. Support expanded from a hardcoded QuickBooks path to selectable QuickBooks and Workday reviews. | Kept AI for semantic and documentation questions, while preserving strict code-based checks for syntax and counts. |
| Iteration 5 - local fallback experiment removed | Initially allowed deterministic local results to appear when the AI endpoint failed, so users would still receive partial feedback. | When the API returned a 404, HTML instead of JSON, or an OpenAI credit error, the UI could still show `0 failing rubrics` and green local results. That looked like a successful validation even though documentation and grammar had not been reviewed. | Removed the fallback. Zera now produces no validation report unless the complete API review succeeds. A visible failure is safer than a false pass. |
| Iteration 6 - evidence changes validity | Expanded the report to distinguish errors from warnings and made documentation status part of the rubric result. | A rubric with a red `documentation not found` badge was previously still marked valid. It now receives a documentation error, is counted under **Needs fix** and **Errors**, and makes the batch **Failed to pass**. Unclear documentation becomes a warning instead. | The report status must follow the evidence, not just the JSON shape. Missing support is an error; uncertainty that remains actionable is a warning. |
| Iteration 7 - asynchronous validation | Moved the OpenAI review to a background response and polled for completion. The earlier fixed polling deadline was removed because documentation research time varies by batch. | Long reviews no longer become invalid merely because they exceed a six-minute client deadline. The loading panel remains visible and polling continues until OpenAI completes the response or returns an explicit error. | Kept background processing with no fixed validation timeout. Completion state should come from the API, not an arbitrary clock. |
| Final - Zera for Feather | Combined strict JSON and batch gating, documentation-grounded review, fail-closed API behavior, detailed per-rubric reports, corrected JSON, and clearer loading and navigation states. | The final flow blocks nonsense and incomplete batches before review, refuses to validate when AI evidence is unavailable, and classifies completed batches as **Pass**, **Pass with warnings**, or **Failed to pass** with traceable findings. | The main contribution is a fail-closed evaluator: deterministic rules establish eligibility, while the agent handles only the semantic checks that require product knowledge. |

### Regression evidence

| Observed case | Earlier behavior | Final behavior |
| --- | --- | --- |
| Meaningless input such as `a` | Returned an apparently strong score of 81. | Cannot match the required rubric JSON or batch rules, so no review can run. |
| Malformed or incomplete JSON | Could surface a raw parser message or provide unreliable counts. | Shows a generic syntax explanation or field-specific schema issues and keeps submission disabled. |
| Incomplete batch or missing tag | Requirements did not reliably follow the entered JSON. | Live counters follow the parsed array; the button is enabled only when the selected batch and every single-tag requirement pass. |
| AI endpoint, quota, or response failure | Local findings could still look like a successful result. | Results are cleared and validation is explicitly unavailable; no rubric is marked valid. |
| Documentation not found | A rubric could remain valid despite the red documentation status. | Adds an error, increases **Needs fix**, and fails the batch. |
| Slow documentation review | A fixed polling deadline could end a valid in-progress review. | Polling continues without a fixed deadline until completion or an explicit API failure. |

### Experiment removed

The most important removed experiment was the local-only success fallback. It improved availability but damaged trust: users could receive a green report after the AI review had failed. Zera now fails closed and withholds all validation results until every rubric has a complete documentation and grammar review. The earlier minimum-word input rule was also removed because length did not measure validity.

### Main failure mode

Zera depends on the quality and availability of official product documentation. A real product behavior may be difficult to validate when documentation is missing, outdated, or too generic. The system exposes that limitation instead of hiding it: missing evidence is an error, unclear evidence is a warning, sources are shown, and an unavailable AI review produces no report.

### Hot take

**An AI evaluator is useful only when uncertainty makes it less confident. If the documentation cannot support a rubric—or the agent cannot complete its review—no score is better than a polished false pass.**

## Supported applications

- QuickBooks
- Workday

The application selector is designed so more products can be added later.

## Batch requirements

| Batch | Total rubrics | Minimum bugs | Minimum feature requests |
| --- | ---: | ---: | ---: |
| Batch A | 20 | 5 | 10 |
| Batch B | 20 | 3 | 3 |
| Batch C | 10 | 3 | 3 |

Every rubric in every batch must contain exactly one valid tag.

## Required JSON format

The input must be a non-empty JSON array. Every item must contain only the required fields shown below:

```json
[
  {
    "criterion": "Account Settings: Saving a company name does not update the name in the top bar.",
    "score": 10,
    "tags": ["bug"],
    "forms": {
      "page_or_workflow": "Account Settings > Company info > Name",
      "reproduction_steps": "1. Open Account Settings.\n2. Change the company name.\n3. Save the changes.\n4. Check the company name in the top bar.",
      "expected_behavior": "The top bar displays the updated company name after the changes are saved.",
      "actual_behavior": "The settings save successfully, but the top bar continues to display the previous company name."
    }
  }
]
```

For a feature request, use `"tags": ["feature request"]` and set `"reproduction_steps": "N/A"`.

## How validation works

1. Zera parses the input and checks its exact JSON structure.
2. It checks the selected batch totals, minimum tag counts, and one-valid-tag requirement.
3. Once the batch is eligible, the app submits it to the server-side validation endpoint.
4. The OpenAI Responses API searches relevant product documentation and returns a structured review for every rubric.
5. Zera combines deterministic and AI findings into a detailed report and corrected JSON.

If the AI request fails or returns incomplete results, Zera does not produce a validation report.

## Tech stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- shadcn/ui and Base UI
- OpenAI Responses API with web search and structured outputs
- Cloudflare Workers and static assets for hosted execution

## Local setup

### Prerequisites

- Node.js and npm
- An OpenAI API key with access to the configured model

### Install dependencies

```bash
npm install
```

### Configure environment variables

Copy the example file:

```bash
cp .env.example .env
```

Then update `.env`:

```dotenv
DEV_HOST=localhost
DEV_PORT=3000
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4-mini
```

Keep `OPENAI_API_KEY` private. It is used only by the server-side validation worker and must never be exposed in client-side code.

### Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Starts Next.js with the local `/api/validate` handler. |
| `npm run build` | Creates the production Next.js export and prepares the worker output. |
| `npm run start` | Runs the prepared Cloudflare Worker build locally with Wrangler. |
| `npm run lint` | Checks the codebase with Oxlint. |
| `npm run format` | Formats the project with Oxfmt. |

## Project structure

```text
app/                        Next.js interface and application metadata
components/ui/              Reusable interface components
lib/constants.mjs           Shared Zera product naming
scripts/dev-server.mjs      Local Next.js server and validation API bridge
scripts/prepare-sites-output.mjs
                            Production output preparation
worker/feather-worker.js     OpenAI review and hosted request handling
```

## Validation outcomes

- **Pass** — no errors or warnings were found.
- **Pass with warnings** — the batch is valid, but one or more improvements are recommended.
- **Failed to pass** — at least one rubric contains an error and must be fixed.
