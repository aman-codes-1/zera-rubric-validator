# Zera for Feather

AI-powered quality assurance for bug and feature-request rubrics, with documentation-grounded capability checks for feature requests.

**Live app:** [zera-rubric-validator.vercel.app](https://zera-rubric-validator.vercel.app/)

**Agent trajectories:** [View the representative agent trajectories PDF](./Zera-Agent-Trajectories.pdf)

Zera validates complete rubric batches before submission. It combines strict JSON and batch checks with an OpenAI-assisted review that grammar-checks every text field, validates feature-request capabilities against current product documentation, and produces corrected JSON when changes are needed. Bug rubrics receive grammar review only.

## The problem

Rubric authors currently have to check JSON structure, batch composition, tags, reproduction steps, language quality, and product accuracy by hand. That process is slow and inconsistent, and a polished-looking rubric can still describe an unsupported workflow or receive an unjustifiably high quality score.

Zera gives rubric authors one review surface that catches mechanical mistakes immediately and uses current application documentation to evaluate claims that cannot be verified with simple rules. The value is not just faster review; it is preventing false confidence before a rubric batch is submitted.

## Features

- Starts with Application and Batch requirements unselected so every validation begins with an explicit required choice.
- Enables **Validate Rubrics** only when an application, batch, and structurally valid JSON batch are present and all selected batch requirements pass.
- Loads a complete QuickBooks example with the `quickbooks` application and matching batch selected automatically; pasted or typed custom JSON never changes the user's selections.
- Enables **Clear Fields** as soon as the application, batch, or JSON input contains a value, then resets the complete form to its empty state.
- Validates the exact JSON array and rubric object structure.
- Requires every rubric score to be the numeric value `10`; any other value is a **Validation** error and is corrected to `10` in exported JSON.
- Checks Batch A, Batch B, and Batch C count requirements in real time.
- Requires exactly one valid tag—`bug` or `feature request`—per rubric.
- Requires every criterion to follow `Section: description`, with a meaningful capitalized section—for example, `Invoice: The "Edit" action should be enabled.`—and classifies violations as **Validation** errors.
- Verifies that bug reproduction steps form an uninterrupted ordered list beginning at `1`.
- Labels deterministic structure, score, tag, and reproduction-step failures as **Validation**, not Grammar, and renumbers invalid bug steps directly in the corrected rubric.
- Requires feature-request reproduction steps to be exactly `N/A`—case-sensitive, with no leading/trailing whitespace or additional content—and emits a single deterministic replacement only when the value differs.
- Reviews the functional capability described by feature-request criteria, expected behavior, and actual behavior against current application documentation.
- Checks bug rubrics only for objective grammar, spelling, and required prose punctuation, without using documentation to judge their behavior.
- Never treats section names, menus, navigation paths, UI placement, or locations as documentation failures.
- Checks objective grammar across criteria, tags, workflows, reproduction steps, and behavior fields while ignoring stylistic rewrites, sentence-case preferences, and intentional repetition used for specificity.
- Suppresses style-only suggestions such as “slightly awkward,” “more parallel,” or optional consistency rewrites, and displays an AI finding only when a complete changed replacement is available for that field.
- Keeps tag validity and reproduction-step ordering deterministic instead of asking the AI to verify them against documentation.
- Runs documentation-based checks only when official documentation explicitly covers the relevant capability; missing or unclear documentation is reported as skipped and does not fail the rubric.
- Fails feature-request expected behavior that ends with a generic placeholder such as `opens the expert-support workflow`, then replaces it with the concrete user-visible behavior stated by official documentation.
- Uses one shared supported-application registry for the application picker, server validation, full-batch application detection, and AI response contract instead of maintaining separate hardcoded lists.
- Scans the complete rubric JSON for configured application names and aliases. The selected application remains primary, while every different supported application found in the batch is added to the documentation-review scope.
- Researches every application in that validated scope using its own official documentation. For example, selecting Workday for a batch that explicitly contains QuickBooks text reviews Workday and QuickBooks sources separately while still reporting the rubric-to-selection mismatch as an error.
- Ignores unconfigured product names when constructing the application scope, preventing arbitrary text from being treated as a supported application.
- Requires the AI response to return the exact official documentation page title and URL used for each reviewed application, merges those links with Responses API web-search citations, and labels every displayed source by application.
- Detects application mismatches independently of capability-documentation availability—for example, QuickBooks rubric text submitted while Workday is selected—and reports each affected field as an error.
- Reports `Pass`, `Passed with warnings`, or `Needs revision` with findings for every rubric.
- Labels every warning and error as **Grammar** or **Documentation**, and shows both category counts in each affected rubric header so the breakdown remains visible while the card is collapsed.
- Highlights the exact affected word or phrase, line number, and excerpt inside each rubric field—yellow for warnings and red for errors.
- Derives each displayed recommendation from the actual original-to-corrected text difference, keeping its wording and every highlighted line synchronized with the corrected rubric; pre-numbered reproduction steps are shown without duplicate UI numbering.
- Shows every corrected field value in green and applies the visible corrections to both per-rubric JSON and the top-level **Copy corrected JSON** batch action.
- Detects every warning or error whose corrected value is missing or unchanged, requests compact field-level replacements, rejects empty or unchanged patches, and retries only the unresolved fields up to three times without invalidating the completed review.
- Polls background AI reviews until they complete, without a fixed validation deadline.
- Automatically scrolls to the validation summary when the completed review and correction results have rendered, while respecting reduced-motion preferences.

## Use of Codex

Codex was used as the development partner for Zera for Feather. It helped turn product feedback and screenshots into implementation changes across the interface, validation flow, worker, and documentation.

Codex contributed to the project by:

- Translating observed failure cases into specific interface and validation requirements.
- Implementing and refining the Next.js interface, required empty states, searchable application selector, batch controls, loading flow, and report interactions.
- Building deterministic JSON, batch, tag, and reproduction-step checks.
- Integrating and debugging the server-side OpenAI Responses API validation workflow and background polling.
- Refining feature-only documentation review, grammar-only bug review, corrected rubric generation and repair, severity highlighting, and copyable corrected JSON.
- Running production builds after changes and maintaining the improvement changelog and project documentation.

Codex is a development-time tool in this repository; it is not required by people using the deployed validator. At runtime, Zera performs AI review through the OpenAI Responses API from the server-side worker.

## Improvement Changelog

The following progression reflects the changes this project actually made. Evidence comes from the failure cases observed during development and the corresponding implementation changes in the repository.

| Stage | What we tried and why | Evidence | Decision / learning |
| --- | --- | --- | --- |
| Baseline - score-based Rhea reviewer | Started with two text fields and a heuristic quality score so a user could quickly review a prompt and its rubrics. | Entering meaningless one-character content such as `a` still produced a score of **81/100**. The score looked precise but was not evidence that the input was usable. | A generic score was the wrong success signal. The tool needed to validate the real submission format and explain concrete failures. |
| Iteration 1 - input gates | Added required fields, minimum-word checks, a disabled review button, reset behavior, and an example loader to stop empty submissions. | Empty input was blocked, but arbitrary text could still satisfy a word-count rule without becoming a valid rubric. Minimum-word validation also rejected short inputs without explaining the actual structural problem. | Kept blank-state controls and removed minimum-word validation. Input length was not a reliable proxy for quality. |
| Iteration 2 - rubric-batch workflow | Replaced the prompt scorer with a validator for the submitted rubric JSON format and added Batch A, B, and C requirements. | The interface could now distinguish a malformed payload from a valid array and show live totals for rubrics, bugs, feature requests, and valid single tags. | Kept the batch gate. Validation had to start from the artifact people actually submit. |
| Iteration 3 - exact deterministic checks | Added exact object keys, required form fields, one valid tag per rubric, section-prefix rules, ordered bug steps, and `N/A` feature-request steps. | Cases that previously reached review now stop at the relevant rule: malformed JSON receives a format message, an incomplete batch cannot be submitted, and a `19/20` tag count no longer appears complete. | Kept deterministic checks for rules that should never depend on an AI judgment. |
| Iteration 4 - documentation-grounded review | Added the OpenAI Responses API with web search and structured output so the agent could inspect grammar across every field and compare feature-request capabilities with current application documentation. | Reviews now return one structured result per rubric, application sources, documentation status, findings, suggestions, and corrected JSON. Bugs remain grammar-only, and variable section names or UI locations do not become documentation failures. Support expanded from a hardcoded QuickBooks path to selectable QuickBooks and Workday reviews. | Kept AI for language and feature-capability questions, while preserving strict code-based checks for syntax, counts, tags, and reproduction-step ordering. |
| Iteration 5 - local fallback experiment removed | Initially allowed deterministic local results to appear when the AI endpoint failed, so users would still receive partial feedback. | When the API returned a 404, HTML instead of JSON, or an OpenAI credit error, the UI could still show `0 failing rubrics` and green local results. That looked like a successful validation even though documentation and grammar had not been reviewed. | Removed the fallback. Zera now produces no validation report unless the complete API review succeeds. A visible failure is safer than a false pass. |
| Iteration 6 - evidence changes validity | Expanded the report to distinguish errors from warnings and made documentation status part of the rubric result. | A rubric with a red documentation issue was previously still marked valid. It now receives an error, is counted under **Needs fix** and **Errors**, and puts the batch into **Needs revision**. | The report status must follow the evidence, not just the JSON shape. |
| Iteration 7 - asynchronous validation | Moved the OpenAI review to a background response and polled for completion. The earlier fixed polling deadline was removed because documentation research time varies by batch. | Long reviews no longer become invalid merely because they exceed a six-minute client deadline. The loading panel remains visible and polling continues until OpenAI completes the response or returns an explicit error. | Kept background processing with no fixed validation timeout. Completion state should come from the API, not an arbitrary clock. |
| Iteration 8 - correction fidelity and explicit form state | Made Application and Batch requirements empty and required by default, limited automatic selection to the provided QuickBooks example, and unified displayed corrections with copied output. | Custom JSON no longer silently changes the selected batch or application. Affected warning text is yellow, affected error text is red, corrected replacements are green, and the top copy action reapplies every visible corrected field before writing the complete batch to the clipboard. | User choices must remain explicit, and the exported artifact must exactly match the corrections shown in the report. |
| Iteration 9 - verified correction repair without blocking | Added a field-level correction repair contract for completed reviews when any warning or error contains a missing replacement or repeats the original field unchanged. | The earlier repair accepted a response when every rubric index was present, even if individual corrections were still missing. Zera now requests only unresolved fields, validates every returned index, field, and replacement, rejects unchanged values, merges accepted patches into both the finding and corrected JSON, and retries the remaining targets up to three times while preserving the original findings and documentation sources. | Correction fidelity must be an enforced postcondition rather than a prompt-only request. Partial repair responses can be useful, but only verified field replacements should be merged or displayed. |
| Iteration 10 - evidence-only documentation checks | Stopped treating the absence of documentation as proof that a rubric is wrong, while adding a separate application-identity check. | `not found` and `unclear` reviews are now visibly marked as skipped and add no finding or failure. Explicit QuickBooks text under a Workday selection, or Workday text under a QuickBooks selection, produces field-level documentation errors. | Documentation can disprove or refine a claim only when the relevant official evidence was actually found. Product-selection mismatches are a separate input-integrity failure and must still block submission. |
| Iteration 11 - objective grammar only | Removed stylistic feedback from grammar results and added a client-side safeguard for over-eager model findings. | Sentence-case changes in workflow breadcrumbs and removal of repeated, meaning-bearing phrases such as `company name` were incorrectly presented as grammar corrections. Zera now suppresses capitalization, tone, concision, awkwardness, optional repetition, and “for consistency” suggestions while retaining objective spelling, syntax, agreement, article, preposition, tense, punctuation, and accidental adjacent-word errors. | A grammatical validator should identify language errors, not rewrite acceptable prose according to taste. Workflow labels are fragments, and repeated entity names can improve precision. |
| Iteration 12 - actionable documentation corrections | Added a deterministic testability gate for generic expected outcomes and required documentation repair to translate those placeholders into the concrete user-visible behavior stated by an official source. | A feature request such as `The "Contact experts" option should open the expert-support workflow` could previously pass because the broad capability existed. It now receives a Documentation error before model judgment, and correction repair can research official sources when the first review omits a usable replacement. The normal review search budget also scales with the number of feature requests in the batch. | Expected behavior must be observable and testable. Documentation can supply the product-specific replacement, but a generic workflow name is not itself an expected result. |
| Iteration 13 - score enforcement and revision status | Added deterministic score enforcement and aligned error-state wording with the submission workflow. | A numeric score other than `10` previously passed the structural check. It now produces a Validation error, the corrected batch sets the score to `10`, and rubric and batch error states display **Needs revision**. | Required numeric fields should be enforced by code, and an error label should clearly tell the author what state the rubric is in. |
| Iteration 14 - correction display invariant | Added a final report-layer invariant after correction repair and expanded the style-only filter. | Suggestions such as making two date-range labels “more parallel” could appear without a corrected rubric even though they were optional stylistic rewrites. Zera now removes those findings and hides any remaining AI finding whose complete replacement is still missing after repair. | Every displayed AI warning or error must include an actual changed rubric value; otherwise the interface should not present it as an actionable finding. |
| Iteration 15 - completion navigation | Restored automatic navigation from the input/loading area to the completed validation summary. | Long documentation reviews could finish while the user remained positioned near the input and source panels, leaving the results below the fold. Zera now waits for the result DOM to render and scrolls the summary into view, using an instant transition when reduced motion is enabled. | Completion should move the user directly to the outcome without requiring them to search down the page. |
| Iteration 16 - structural finding classification | Separated deterministic validation failures from language findings and simplified rubric metadata. | An interrupted or misnumbered bug-step list was labeled Grammar and could receive an unrelated language rewrite. It now receives a Validation badge, the corrected rubric is renumbered deterministically from `1`, and the redundant Review scope line has been removed. | Ordered-list, score, tag, and schema rules are validation concerns; Grammar should be reserved for actual language errors. |
| Iteration 17 - shared application scope and traceable sources | Replaced separate client and worker application checks with one shared registry, then required source URLs in the structured review. | With Workday selected and QuickBooks named anywhere in the complete rubric JSON, the validated scope becomes Workday as `selected` plus QuickBooks as `detected_in_rubrics`. The agent researches both independently, returns the exact official pages used for each, and the Application knowledge card shows application-labeled titles and complete clickable URLs. Unsupported names do not enter the scope. | Application identity must be decided by code from one allowlist, while documentation discovery remains dynamic. Every reviewed product should have traceable source links instead of only a prose summary. |
| Final - Zera for Feather | Combined strict JSON and batch gating, documentation-grounded review, fail-closed API behavior, detailed per-rubric reports, corrected JSON, and clearer loading and navigation states. | The final flow blocks nonsense and incomplete batches before review, refuses to validate when AI evidence is unavailable, and classifies completed batches as **Pass**, **Passed with warnings**, or **Needs revision** with traceable findings. | The main contribution is a fail-closed evaluator: deterministic rules establish eligibility, while the agent handles only the semantic checks that require product knowledge. |

### Regression evidence

| Observed case | Earlier behavior | Final behavior |
| --- | --- | --- |
| Meaningless input such as `a` | Returned an apparently strong score of 81. | Cannot match the required rubric JSON or batch rules, so no review can run. |
| Malformed or incomplete JSON | Could surface a raw parser message or provide unreliable counts. | Shows a generic syntax explanation or field-specific schema issues and keeps submission disabled. |
| Incomplete batch or missing tag | Requirements did not reliably follow the entered JSON. | Live counters follow the parsed array; the button is enabled only when the selected batch and every single-tag requirement pass. |
| AI endpoint, quota, or response failure | Local findings could still look like a successful result. | Results are cleared and validation is explicitly unavailable; no rubric is marked valid. |
| Documentation not found or too unclear | Missing evidence was treated as evidence against the rubric, causing unsupported failures. | Marks the documentation check as skipped and creates no documentation finding; only independent grammar or deterministic issues affect validity. |
| Selected application does not match rubric | Product-specific rubric text could be reviewed against the wrong vendor documentation. | Adds red, field-level application-mismatch errors even when capability documentation is missing. |
| Selected and rubric applications differ | Only the selected application's context could be shown, or sources from another product could be used without clear attribution. | Builds the scope from the shared supported-application registry, researches the selected and detected applications independently, and labels each official documentation URL with its application. |
| Documentation review has no visible sources | The Application knowledge card could show only a prose summary such as `Selected application: Workday.` | Every new structured review must return the exact official page URLs used; these are merged with tool citations and shown as complete clickable links with titles and application badges. |
| Grammatically correct stylistic variation | Workflow capitalization and intentional phrases such as repeated `company name` could be “corrected” even though they were valid. | Style-only findings are removed; workflow breadcrumbs retain their UI-label casing and precise entity names remain intact. |
| Generic expected outcome | A phrase such as `should open the expert-support workflow` could pass without explaining what the user can observe or do. | The field receives a deterministic Documentation error, and the correction process searches official documentation for a concrete supported action or outcome. |
| Slow documentation review | A fixed polling deadline could end a valid in-progress review. | Polling continues without a fixed deadline until completion or an explicit API failure. |
| Corrected batch export | Corrections visible inside findings could be missing from the top-level copied batch. | The top copy action reapplies every displayed corrected value, so the clipboard output matches the report. |
| Missing or unchanged corrected rubric | A warning or error could repeat the original value as its “correction,” a partial repair could omit an affected field, or the report could be blocked when that mismatch was detected. | Zera requests compact field-level repairs, accepts only requested replacements that differ from the original, merges them into the finding and corrected JSON, and retries only unresolved fields while preserving the completed review and its documentation sources. |
| Custom JSON entry | Entering JSON could unexpectedly change the selected batch. | Only **Load provided example** selects `quickbooks` and its matching batch automatically; custom JSON preserves manual selections. |

### Experiment removed

The most important removed experiment was the local-only success fallback. It improved availability but damaged trust: users could receive a green report after the AI review had failed. Zera now fails closed and withholds all validation results until every rubric has a complete documentation and grammar review. The earlier minimum-word input rule was also removed because length did not measure validity.

### Main failure mode

Feature-request validation depends on the quality and availability of official product documentation. Zera checks a capability only when the retrieved official documentation explicitly covers it. Missing, outdated, generic, or ambiguous documentation is shown as skipped and does not create a documentation finding or fail the rubric. Application mismatches remain errors even when capability documentation is unavailable, and an unavailable AI review produces no report.

### Hot take

**An AI evaluator should never turn missing evidence into a confident failure. Skip claims the documentation cannot verify, but fail fast when the user selected the wrong product context.**

## Supported applications

- QuickBooks
- Workday

`lib/applications.mjs` is the single source of truth for supported application IDs, labels, and aliases. The selector, API validation, whole-JSON detection, and structured AI response schema all use this registry. Add a product there to make it eligible for selection and detection; official documentation URLs are then discovered dynamically during validation rather than hardcoded in the application configuration.

## Using the validator

1. Select a supported application.
2. Select the applicable batch requirements.
3. Paste a complete rubric JSON array.
4. Review the live format and batch checks. **Validate Rubrics** becomes available only after all required inputs and deterministic checks pass.
5. Run validation and review every rubric's highlighted warnings, errors, corrected values, and documentation evidence.
6. Copy an individual corrected rubric or use **Copy corrected JSON** to copy the complete corrected batch.

Alternatively, choose **Load provided example** to populate the sample rubrics and automatically select `quickbooks` and the matching batch. This automatic selection applies only to the provided example; pasted or typed JSON requires manual application and batch choices.

**Clear Fields** becomes available when any application, batch, or JSON value is present and resets all three inputs.

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

1. Zera requires an explicit application and batch selection, then parses the input and checks its exact JSON structure.
2. It checks the selected batch totals, minimum tag counts, and one-valid-tag requirement.
3. Once every required input and deterministic check passes, the app enables validation and submits the batch to the server-side endpoint.
4. The server creates a validated application scope from the shared registry: the selected application first, followed by every other supported application whose configured name or alias appears anywhere in the complete rubric JSON.
5. The OpenAI Responses API searches official documentation separately for every application in scope and grammar-checks every text field. For feature requests only, it uses the matching application's documentation to evaluate the functional capability described in `criterion`, `expected_behavior`, and `actual_behavior`; it ignores section names and UI locations.
6. The structured response must include the official documentation pages used for each application. Zera validates and merges those URLs with web-search citations, labels them by application, and displays their page titles and complete clickable URLs in **Application knowledge**.
7. If any warning or error contains a missing or unchanged replacement, Zera runs a compact correction-only repair flow. Each returned field is verified before merging, and any unresolved fields are retried without re-running documentation research.
8. Zera combines deterministic and AI findings into a detailed report, highlights warnings in yellow and errors in red, shows corrected replacements in green, and produces corrected JSON that matches the displayed corrections.

If the main AI review fails or returns incomplete results, Zera does not produce a validation report. An unchanged correction does not invalidate an otherwise completed review; it triggers the verified field-level correction flow instead.

## Tech stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- shadcn/ui and Base UI
- OpenAI Responses API with web search and structured outputs
- Vercel Functions through a Next.js Route Handler for hosted execution

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

`DEV_HOST` and `DEV_PORT` are used only by the custom local development server. Do not set `DEV_HOST` to the Vercel domain.

### Start the development server

```bash
npm run dev
```

Open [Zera for Feather](https://zera-rubric-validator.vercel.app/).

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Starts Next.js with the local `/api/validate` handler. |
| `npm run build` | Creates the server-capable production Next.js build used by Vercel. |
| `npm run start` | Runs the production Next.js build locally. |
| `npm run lint` | Checks the codebase with Oxlint. |
| `npm run format` | Formats the project with Oxfmt. |

## Vercel deployment

1. Import the GitHub repository into Vercel and keep the detected framework as **Next.js**.
2. Leave the build command as `npm run build`; do not configure the output directory as `out`.
3. Add `OPENAI_API_KEY` in **Project Settings → Environment Variables** for Production and Preview.
4. Optionally add `OPENAI_MODEL`; the server defaults to `gpt-5.4-mini` when it is omitted.
5. Redeploy after saving the environment variables.

The browser calls the same-origin `/api/validate` endpoint. No Vercel domain needs to be registered with OpenAI, and the API key remains available only to the server-side Route Handler.

## Project structure

```text
app/                        Next.js interface
app/api/validate/route.ts   Vercel-compatible validation Route Handler
components/ui/              Reusable interface components
lib/applications.mjs        Supported-application registry, alias detection, and scope resolution
lib/constants.mjs           Shared Zera product naming
scripts/dev-server.mjs      Local Next.js server and validation API bridge
scripts/prepare-sites-output.mjs
                            Legacy Cloudflare static-export preparation
worker/feather-worker.js     Shared OpenAI review logic and Cloudflare adapter
```

## Validation outcomes

- **Pass** — no errors or warnings were found.
- **Passed with warnings** — the batch is valid, but one or more improvements are recommended.
- **Needs revision** — at least one rubric contains an error and must be fixed.
