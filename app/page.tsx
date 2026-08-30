'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  BookOpen,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  FileJson2,
  Loader2,
  Play,
  RefreshCcw,
  Search,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type BatchKey = 'a' | 'b' | 'c';
type IssueSeverity = 'error' | 'warning';
type AiStatus = 'idle' | 'researching' | 'ready' | 'unavailable';

type RubricRecord = {
  criterion: string;
  score: number | null;
  tags: string[];
  forms: {
    page_or_workflow: string;
    reproduction_steps: string;
    expected_behavior: string;
    actual_behavior: string;
  };
};

type Issue = {
  field: string;
  severity: IssueSeverity;
  message: string;
  suggestion: string;
};

type RubricResult = {
  index: number;
  rubric: RubricRecord;
  issues: Issue[];
};

type BatchSummary = {
  total: number;
  bugs: number;
  features: number;
  rest: number;
  validSingleTags: number;
  checks: Array<{
    label: string;
    current: number;
    target: number;
    pass: boolean;
    detail: string;
  }>;
};

type AiReview = {
  index: number;
  documentationStatus: 'supported' | 'unclear' | 'not_found';
  documentationSummary: string;
  grammarIssues: string[];
  suggestions: string[];
};

type AiResponse = {
  applicationBrief: string;
  rubricReviews: AiReview[];
  sources: Array<{ title: string; url: string }>;
};

const BATCHES: Record<
  BatchKey,
  { label: string; total: number; bugs: number; features: number; rest: number }
> = {
  a: { label: 'Batch A · 20 rubrics', total: 20, bugs: 5, features: 10, rest: 5 },
  b: { label: 'Batch B · 20 rubrics', total: 20, bugs: 3, features: 3, rest: 14 },
  c: { label: 'Batch C · 10 rubrics', total: 10, bugs: 3, features: 3, rest: 4 },
};

const VALID_TAGS = new Set(['bug', 'feature request']);
const RUBRIC_KEYS = ['criterion', 'score', 'tags', 'forms'] as const;
const FORM_KEYS = [
  'page_or_workflow',
  'reproduction_steps',
  'expected_behavior',
  'actual_behavior',
] as const;

class JsonFormatError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super('The JSON does not match the required rubric format.');
    this.name = 'JsonFormatError';
    this.issues = issues;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keyIssues(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
) {
  const actualKeys = Object.keys(record);
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));

  return [
    ...missing.map((key) => `${path} is missing required field “${key}”.`),
    ...unexpected.map((key) => `${path} contains unexpected field “${key}”.`),
  ];
}

function validateRubricFormat(value: unknown, index: number) {
  const path = `Rubric ${index + 1}`;
  if (!isObject(value)) return [`${path} must be a JSON object.`];

  const issues = keyIssues(value, RUBRIC_KEYS, path);

  if ('criterion' in value && (typeof value.criterion !== 'string' || !value.criterion.trim())) {
    issues.push(`${path} → criterion must be a non-empty string.`);
  }

  if (
    'score' in value &&
    (typeof value.score !== 'number' || !Number.isFinite(value.score))
  ) {
    issues.push(`${path} → score must be a finite number.`);
  }

  if ('tags' in value) {
    if (!Array.isArray(value.tags)) {
      issues.push(`${path} → tags must be an array, for example [“bug”].`);
    } else if (
      value.tags.length !== 1 ||
      typeof value.tags[0] !== 'string' ||
      !value.tags[0].trim()
    ) {
      issues.push(`${path} → tags must contain exactly one non-empty string.`);
    }
  }

  if ('forms' in value) {
    if (!isObject(value.forms)) {
      issues.push(`${path} → forms must be a JSON object.`);
    } else {
      const forms = value.forms;
      issues.push(...keyIssues(forms, FORM_KEYS, `${path} → forms`));
      FORM_KEYS.forEach((key) => {
        if (
          key in forms &&
          (typeof forms[key] !== 'string' || !forms[key].trim())
        ) {
          issues.push(`${path} → forms.${key} must be a non-empty string.`);
        }
      });
    }
  }

  return issues;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
function normalizeRubric(value: unknown): RubricRecord {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const formsValue =
    record.forms && typeof record.forms === 'object'
      ? (record.forms as Record<string, unknown>)
      : {};
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim())
    : [];

  return {
    criterion: readString(record.criterion),
    score: typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : null,
    tags,
    forms: {
      page_or_workflow: readString(formsValue.page_or_workflow),
      reproduction_steps: readString(formsValue.reproduction_steps),
      expected_behavior: readString(formsValue.expected_behavior),
      actual_behavior: readString(formsValue.actual_behavior),
    },
  };
}

function validateOrderedSteps(value: string) {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return false;

  return lines.every((line, index) => {
    const match = line.match(/^(\d+)[.)]\s+\S/);
    return Boolean(match) && Number(match?.[1]) === index + 1;
  });
}

function validateRubric(rubric: RubricRecord): Issue[] {
  const issues: Issue[] = [];
  const tag = rubric.tags[0]?.toLowerCase();

  if (!rubric.criterion) {
    issues.push({
      field: 'criterion',
      severity: 'error',
      message: 'Criterion is missing.',
      suggestion: 'Add a specific, observable criterion.',
    });
  } else if (!/^[A-Z][^:\n]{0,80}:\s+\S/.test(rubric.criterion)) {
    issues.push({
      field: 'criterion',
      severity: 'error',
      message: 'Criterion must start with a capitalized section followed by a colon.',
      suggestion: 'Use a prefix such as “Home:” or “Account Settings:”.',
    });
  }

  if (rubric.score === null) {
    issues.push({
      field: 'score',
      severity: 'warning',
      message: 'Score is missing or is not numeric.',
      suggestion: 'Provide a numeric score for this rubric.',
    });
  }

  if (rubric.tags.length !== 1) {
    issues.push({
      field: 'tags',
      severity: 'error',
      message: 'Every rubric must have exactly one tag.',
      suggestion: 'Use either ["bug"] or ["feature request"].',
    });
  } else if (!VALID_TAGS.has(tag)) {
    issues.push({
      field: 'tags',
      severity: 'error',
      message: 'The tag is not valid.',
      suggestion: 'Use “bug” for bugs or “feature request” for feature requests.',
    });
  }

  const requiredFields: Array<[keyof RubricRecord['forms'], string]> = [
    ['page_or_workflow', 'Page or workflow'],
    ['reproduction_steps', 'Reproduction steps'],
    ['expected_behavior', 'Expected behavior'],
    ['actual_behavior', 'Actual behavior'],
  ];

  requiredFields.forEach(([field, label]) => {
    if (!rubric.forms[field]) {
      issues.push({
        field,
        severity: 'error',
        message: label + ' is missing.',
        suggestion: 'Add a specific value for ' + label.toLowerCase() + '.',
      });
    }
  });

  if (tag === 'bug' && rubric.forms.reproduction_steps && !validateOrderedSteps(rubric.forms.reproduction_steps)) {
    issues.push({
      field: 'reproduction_steps',
      severity: 'error',
      message: 'Bug reproduction steps must be an uninterrupted ordered list starting at 1.',
      suggestion: 'Use 1., 2., 3. and continue without skipped or repeated numbers.',
    });
  }

  if (
    tag === 'feature request' &&
    rubric.forms.reproduction_steps &&
    rubric.forms.reproduction_steps.toUpperCase() !== 'N/A'
  ) {
    issues.push({
      field: 'reproduction_steps',
      severity: 'error',
      message: 'Feature-request reproduction steps must be N/A.',
      suggestion: 'Set reproduction_steps to exactly “N/A”.',
    });
  }

  if (rubric.forms.expected_behavior && rubric.forms.expected_behavior.length < 28) {
    issues.push({
      field: 'expected_behavior',
      severity: 'warning',
      message: 'Expected behavior may be too generic.',
      suggestion: 'Describe the user action, the expected system response, and the observable outcome.',
    });
  }

  if (rubric.forms.actual_behavior && rubric.forms.actual_behavior.length < 28) {
    issues.push({
      field: 'actual_behavior',
      severity: 'warning',
      message: 'Actual behavior may be too generic.',
      suggestion: 'Describe what actually happens and how it differs from the expectation.',
    });
  }

  return issues;
}

function buildBatchSummary(rubrics: RubricRecord[], key: BatchKey): BatchSummary {
  const requirement = BATCHES[key];
  const bugs = rubrics.filter(
    (rubric) => rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === 'bug',
  ).length;
  const features = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === 'feature request',
  ).length;
  const validSingleTags = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 && VALID_TAGS.has(rubric.tags[0].toLowerCase()),
  ).length;
  const rest = Math.max(
    0,
    validSingleTags - Math.min(bugs, requirement.bugs) - Math.min(features, requirement.features),
  );

  return {
    total: rubrics.length,
    bugs,
    features,
    rest,
    validSingleTags,
    checks: [
      {
        label: 'Rubrics',
        current: rubrics.length,
        target: requirement.total,
        pass: rubrics.length === requirement.total,
        detail: 'Exactly ' + requirement.total + ' required',
      },
      {
        label: 'Bugs',
        current: bugs,
        target: requirement.bugs,
        pass: bugs >= requirement.bugs,
        detail: requirement.bugs + ' minimum',
      },
      {
        label: 'Feature requests',
        current: features,
        target: requirement.features,
        pass: features >= requirement.features,
        detail: requirement.features + ' minimum',
      },
      {
        label: 'Rest bugs or features',
        current: rest,
        target: requirement.rest,
        pass: rest >= requirement.rest,
        detail: requirement.rest + ' minimum',
      },
      {
        label: 'Valid single tags',
        current: validSingleTags,
        target: rubrics.length,
        pass: validSingleTags === rubrics.length,
        detail: 'One valid tag per rubric',
      },
    ],
  };
}

function batchFailureMessage(check: BatchSummary['checks'][number]) {
  if (check.label === 'Rubrics') {
    const difference = check.target - check.current;
    return difference > 0
      ? `Rubrics: ${check.current}/${check.target}. Add ${difference}.`
      : `Rubrics: ${check.current}/${check.target}. Remove ${Math.abs(difference)}.`;
  }

  if (check.label === 'Valid single tags') {
    return `Valid single tags: ${check.current}/${check.target}. Every rubric must have exactly one valid tag.`;
  }

  return `${check.label}: ${check.current}/${check.target} minimum. Add ${Math.max(0, check.target - check.current)}.`;
}

function parseInput(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The JSON syntax is invalid.';
    throw new JsonFormatError([`Invalid JSON syntax: ${detail}`]);
  }

  if (!Array.isArray(parsed)) {
    throw new JsonFormatError(['The top-level JSON value must be an array of rubric objects.']);
  }
  if (parsed.length === 0) {
    throw new JsonFormatError(['The top-level array must contain at least one rubric object.']);
  }

  const issues = parsed.flatMap(validateRubricFormat);
  if (issues.length) {
    const shownIssues = issues.slice(0, 15);
    if (issues.length > shownIssues.length) {
      shownIssues.push(`${issues.length - shownIssues.length} additional format issue(s) were found.`);
    }
    throw new JsonFormatError(shownIssues);
  }

  return parsed.map(normalizeRubric);
}

function docsBadge(status: AiReview['documentationStatus']) {
  if (status === 'supported') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (status === 'not_found') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
}

export default function Home() {
  const [application, setApplication] = useState('quickbooks-angular');
  const [batchKey, setBatchKey] = useState<BatchKey>('a');
  const [jsonInput, setJsonInput] = useState('');
  const [results, setResults] = useState<RubricResult[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle');
  const [aiResponse, setAiResponse] = useState<AiResponse | null>(null);
  const [aiError, setAiError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const issueCount = useMemo(
    () => results.reduce((total, result) => total + result.issues.length, 0),
    [results],
  );
  const failingRubrics = useMemo(
    () => results.filter((result) => result.issues.some((issue) => issue.severity === 'error')).length,
    [results],
  );
  const selectedBatch = BATCHES[batchKey];
  const hasInput = Boolean(jsonInput.trim());
  const liveInput = useMemo(() => {
    if (!jsonInput.trim()) {
      return { rubrics: [] as RubricRecord[], formatErrors: [] as string[] };
    }

    try {
      return { rubrics: parseInput(jsonInput), formatErrors: [] as string[] };
    } catch (error) {
      let partialRubrics: RubricRecord[] = [];
      try {
        const parsed: unknown = JSON.parse(jsonInput);
        if (Array.isArray(parsed)) {
          partialRubrics = parsed.filter(isObject).map(normalizeRubric);
        }
      } catch {
        // Syntax errors cannot provide reliable live batch counts.
      }

      return {
        rubrics: partialRubrics,
        formatErrors:
          error instanceof JsonFormatError
            ? error.issues
            : [error instanceof Error ? error.message : 'The JSON could not be parsed.'],
      };
    }
  }, [jsonInput]);
  const liveBatchSummary = useMemo(
    () => buildBatchSummary(liveInput.rubrics, batchKey),
    [batchKey, liveInput.rubrics],
  );
  const failedBatchChecks = liveBatchSummary.checks.filter((check) => !check.pass);
  const batchRequirementsMet = failedBatchChecks.length === 0;
  const canValidate = Boolean(
    application &&
      hasInput &&
      liveInput.formatErrors.length === 0 &&
      batchRequirementsMet &&
      !isRunning,
  );

  async function loadProvidedExample() {
    const response = await fetch('/sample-rubrics.json');
    const text = await response.text();
    setJsonInput(text);
    setResults([]);
    setAiResponse(null);
    setAiStatus('idle');
    setAiError('');
  }

  function reset() {
    setJsonInput('');
    setResults([]);
    setAiResponse(null);
    setAiStatus('idle');
    setAiError('');
  }

  async function runValidation() {
    setAiError('');
    setAiResponse(null);

    let rubrics: RubricRecord[];
    try {
      rubrics = parseInput(jsonInput);
    } catch {
      setResults([]);
      setAiStatus('idle');
      return;
    }

    const submittedBatchSummary = buildBatchSummary(rubrics, batchKey);
    if (!submittedBatchSummary.checks.every((check) => check.pass)) return;

    const localResults = rubrics.map((rubric, index) => ({
      index,
      rubric,
      issues: validateRubric(rubric),
    }));

    setResults(localResults);
    setIsRunning(true);
    setAiStatus('researching');

    try {
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          application,
          batch: batchKey,
          rubrics,
        }),
      });
      const payload = (await response.json()) as AiResponse & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || 'AI documentation review is unavailable.');
      }

      setAiResponse(payload);
      setAiStatus('ready');
    } catch (error) {
      setAiStatus('unavailable');
      setAiError(
        error instanceof Error
          ? error.message
          : 'AI documentation review is unavailable. Local validation still completed.',
      );
    } finally {
      setIsRunning(false);
    }
  }

  async function copyReport() {
    const report = JSON.stringify(
      {
        application,
        batch: batchKey,
        batchSummary: liveBatchSummary,
        localResults: results,
        aiReview: aiResponse,
      },
      null,
      2,
    );
    await navigator.clipboard.writeText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="min-h-screen bg-[#07090b] text-[#f5f7f6]">
      <header className="border-b border-white/8 bg-[#090b0d]/95">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-emerald-400 text-[#06251a] shadow-[0_0_28px_rgba(52,211,153,0.24)]">
              <Braces className="size-[18px]" />
            </span>
            <div>
              <strong className="block text-sm tracking-tight">Zera Feather</strong>
              <span className="block text-xs text-zinc-500">Documentation-grounded rubric QA</span>
            </div>
          </div>
          <Badge className="border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <Sparkles className="size-3" /> OpenAI assisted
          </Badge>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-12">
        <nav className="inline-flex flex-wrap rounded-xl border border-white/10 bg-white/[0.025] p-1 text-xs text-zinc-500">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Coming soon"
            className="cursor-not-allowed rounded-lg px-4 py-2 opacity-45"
          >
            Validate Prompt & Rubrics
          </button>
          <button
            type="button"
            aria-current="page"
            onClick={() => document.getElementById('rubrics-json')?.focus()}
            className="rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-[#06251a] transition hover:bg-emerald-300"
          >
            Validate Rubrics
          </button>
        </nav>

        <section className="mt-8 max-w-3xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">
            Nexus / CheckSet
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            Validate feather rubrics
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
            Check batch requirements, JSON structure, tags, section prefixes, reproduction steps,
            grammar, specificity, and alignment with current QuickBooks documentation.
          </p>
        </section>

        <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(390px,0.75fr)]">
          <section className="space-y-5">
            <div className="rounded-2xl border border-indigo-400/20 bg-indigo-400/[0.045] p-4">
              <div className="flex gap-3">
                <BookOpen className="mt-0.5 size-4 shrink-0 text-indigo-300" />
                <div>
                  <p className="text-sm font-medium text-indigo-100">
                    Documentation context is prepared before every AI review.
                  </p>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">
                    Zera retrieves current product documentation at review time. It does not retrain
                    the model or store a new model.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-300">Application</span>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
                  <select
                    value={application}
                    onChange={(event) => setApplication(event.target.value)}
                    className="h-11 w-full appearance-none rounded-xl border border-white/10 bg-[#101317] pr-9 pl-10 text-sm outline-none transition focus:border-emerald-400/50 focus:ring-3 focus:ring-emerald-400/10"
                  >
                    <option value="quickbooks-angular">quickbooks-angular</option>
                  </select>
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-zinc-500">⌄</span>
                </div>
                <span className="mt-2 block text-xs text-zinc-600">1 supported application</span>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-300">Batch requirements</span>
                <div className="relative">
                  <ShieldCheck className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
                  <select
                    value={batchKey}
                    onChange={(event) => {
                      setBatchKey(event.target.value as BatchKey);
                      setResults([]);
                      setAiResponse(null);
                      setAiStatus('idle');
                      setAiError('');
                    }}
                    className="h-11 w-full appearance-none rounded-xl border border-white/10 bg-[#101317] pr-9 pl-10 text-sm outline-none transition focus:border-emerald-400/50 focus:ring-3 focus:ring-emerald-400/10"
                  >
                    {Object.entries(BATCHES).map(([key, batch]) => (
                      <option key={key} value={key}>
                        {batch.label}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-zinc-500">⌄</span>
                </div>
                <span className="mt-2 block text-xs text-zinc-600">
                  {selectedBatch.bugs} bugs · {selectedBatch.features} features · {selectedBatch.rest} rest
                </span>
              </label>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0d1013]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Rubrics JSON array</p>
                  <p className="mt-0.5 text-xs text-zinc-500">Paste the full batch as a JSON array.</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadProvidedExample}
                    className="border-white/10 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white"
                  >
                    <FileJson2 /> Load provided example
                  </Button>
                </div>
              </div>
              <Textarea
                id="rubrics-json"
                value={jsonInput}
                onChange={(event) => {
                  setJsonInput(event.target.value);
                  setResults([]);
                  setAiResponse(null);
                  setAiStatus('idle');
                  setAiError('');
                }}
                placeholder={'[\n  {\n    "criterion": "Home: observable issue",\n    "score": 10,\n    "tags": ["bug"],\n    "forms": { ... }\n  }\n]'}
                spellCheck={false}
                className="min-h-[430px] resize-y rounded-none border-0 bg-transparent p-5 font-mono text-[12px] leading-6 text-zinc-300 shadow-none focus-visible:ring-0"
              />
            </div>

            {liveInput.formatErrors.length > 0 && (
              <div
                role="alert"
                className="flex gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <strong>JSON format is invalid</strong>
                  <p className="mt-1 text-xs leading-5 text-rose-200/75">
                    Match the structure of the provided rubric JSON file and fix the following:
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-rose-100/90">
                    {liveInput.formatErrors.map((issue, index) => (
                      <li key={`${issue}-${index}`}>{issue}</li>
                    ))}
                  </ul>
                  <div className="mt-3 rounded-lg border border-rose-200/10 bg-black/20 p-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-rose-100/70">
                      Required JSON format
                    </p>
                    <pre className="overflow-x-auto font-mono text-[11px] leading-5 text-rose-50/80">{`[
  {
    "criterion": "Section: observable issue",
    "score": 10,
    "tags": ["bug"],
    "forms": {
      "page_or_workflow": "...",
      "reproduction_steps": "1. ...",
      "expected_behavior": "...",
      "actual_behavior": "..."
    }
  }
]`}</pre>
                  </div>
                </div>
              </div>
            )}

            {hasInput && !batchRequirementsMet && (
              <div
                role="alert"
                className="flex gap-3 rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-sm text-rose-200"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <strong>Batch requirements are not met</strong>
                  <div className="mt-2 grid gap-x-8 gap-y-1 text-xs leading-5 text-rose-100/90 sm:grid-cols-2">
                    {failedBatchChecks.map((check) => (
                      <p key={check.label}>{batchFailureMessage(check)}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                onClick={runValidation}
                disabled={!canValidate}
                className="h-11 bg-emerald-400 px-5 font-semibold text-[#06251a] hover:bg-emerald-300 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {isRunning ? <Loader2 className="animate-spin" /> : <Play />}
                Validate Rubrics
              </Button>
              <Button
                variant="outline"
                onClick={reset}
                disabled={isRunning}
                className="h-11 border-white/10 bg-transparent px-5 text-zinc-300 hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCcw /> Clear Fields
              </Button>
            </div>
          </section>

          <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
            <div className="rounded-2xl border border-white/10 bg-[#0d1013] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Batch requirements</p>
                  <p className="mt-1 text-xs text-zinc-500">{selectedBatch.label}</p>
                </div>
                {hasInput && (
                  <Badge
                    className={
                      batchRequirementsMet
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : 'bg-rose-400/10 text-rose-300'
                    }
                  >
                    {batchRequirementsMet ? 'Passed' : 'Needs work'}
                  </Badge>
                )}
              </div>

              <div className="mt-4 space-y-2">
                {liveBatchSummary.checks.map((check) => (
                  <div
                    key={check.label}
                    className="flex items-center justify-between gap-4 rounded-xl border border-white/7 bg-white/[0.02] px-3.5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-zinc-300">{check.label}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-600">{check.detail}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-zinc-400">
                        {check.current}/{check.target}
                      </span>
                      {hasInput &&
                        (check.pass ? (
                          <CheckCircle2 className="size-4 text-emerald-400" />
                        ) : (
                          <XCircle className="size-4 text-rose-400" />
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0d1013] p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-indigo-400/10 text-indigo-300">
                  {aiStatus === 'researching' ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                </span>
                <div>
                  <p className="text-sm font-medium">Application knowledge</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {aiStatus === 'idle' && 'Waiting for a batch'}
                    {aiStatus === 'researching' && 'Searching product documentation'}
                    {aiStatus === 'ready' && 'Documentation context ready'}
                    {aiStatus === 'unavailable' && 'AI review unavailable'}
                  </p>
                </div>
              </div>

              {aiResponse?.applicationBrief && (
                <p className="mt-4 text-xs leading-5 text-zinc-400">{aiResponse.applicationBrief}</p>
              )}

              {aiError && (
                <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-xs leading-5 text-amber-200">
                  {aiError}
                </div>
              )}

              {aiResponse?.sources.length ? (
                <div className="mt-4 space-y-2 border-t border-white/8 pt-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                    Documentation sources
                  </p>
                  {aiResponse.sources.slice(0, 5).map((source) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-start gap-2 text-xs leading-5 text-indigo-300 hover:text-indigo-200"
                    >
                      <ExternalLink className="mt-0.5 size-3 shrink-0" />
                      {source.title || source.url}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </aside>
        </div>

        {results.length > 0 && (
          <section className="mt-10 border-t border-white/8 pt-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-600">Validation report</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  {failingRubrics} failing rubrics · {issueCount} local findings
                </h2>
                <p className="mt-2 text-sm text-zinc-500">
                  Deterministic checks are shown immediately; documentation and grammar findings appear when AI review is available.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={copyReport}
                className="border-white/10 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white"
              >
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy report'}
              </Button>
            </div>

            <div className="mt-6 space-y-3">
              {results.map((result) => {
                const aiReview = aiResponse?.rubricReviews.find((review) => review.index === result.index);
                const hasErrors = result.issues.some((issue) => issue.severity === 'error');
                const aiIssueCount =
                  (aiReview?.grammarIssues.length || 0) + (aiReview?.suggestions.length || 0);

                return (
                  <details
                    key={result.index}
                    className="group overflow-hidden rounded-2xl border border-white/10 bg-[#0d1013]"
                    open={result.index === 0}
                  >
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4">
                      <div className="flex min-w-0 gap-3">
                        <span
                          className={
                            'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ' +
                            (hasErrors
                              ? 'bg-rose-500/10 text-rose-300'
                              : 'bg-emerald-500/10 text-emerald-300')
                          }
                        >
                          {hasErrors ? <AlertTriangle className="size-4" /> : <BadgeCheck className="size-4" />}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-zinc-600">#{result.index + 1}</span>
                            {result.rubric.tags.map((tag) => (
                              <Badge key={tag} className="border border-white/10 bg-white/5 text-zinc-300">
                                {tag}
                              </Badge>
                            ))}
                            <span className="text-xs text-zinc-600">
                              {result.issues.length + aiIssueCount} findings
                            </span>
                          </div>
                          <p className="mt-2 line-clamp-2 text-sm leading-5 text-zinc-200">
                            {result.rubric.criterion || 'Missing criterion'}
                          </p>
                        </div>
                      </div>
                      <span className="text-zinc-600 transition group-open:rotate-180">⌄</span>
                    </summary>

                    <div className="grid gap-5 border-t border-white/8 px-5 py-5 lg:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-600">
                          Structural checks
                        </p>
                        <div className="mt-3 space-y-2">
                          {result.issues.length ? (
                            result.issues.map((issue, issueIndex) => (
                              <div
                                key={issue.field + issueIndex}
                                className={
                                  'rounded-xl border p-3 ' +
                                  (issue.severity === 'error'
                                    ? 'border-rose-500/20 bg-rose-500/[0.06]'
                                    : 'border-amber-500/20 bg-amber-500/[0.06]')
                                }
                              >
                                <div className="flex items-center gap-2">
                                  <Badge className="bg-white/5 font-mono text-[10px] text-zinc-400">
                                    {issue.field}
                                  </Badge>
                                  <span
                                    className={
                                      'text-xs font-medium ' +
                                      (issue.severity === 'error' ? 'text-rose-200' : 'text-amber-200')
                                    }
                                  >
                                    {issue.message}
                                  </span>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-zinc-500">{issue.suggestion}</p>
                              </div>
                            ))
                          ) : (
                            <div className="flex gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3 text-xs text-emerald-200">
                              <CheckCircle2 className="size-4 shrink-0" />
                              All deterministic checks passed.
                            </div>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-600">
                            Docs & grammar review
                          </p>
                          {aiReview && (
                            <Badge className={docsBadge(aiReview.documentationStatus)}>
                              {aiReview.documentationStatus.replace('_', ' ')}
                            </Badge>
                          )}
                        </div>

                        {aiStatus === 'researching' && (
                          <div className="mt-3 flex items-center gap-2 rounded-xl border border-indigo-400/15 bg-indigo-400/[0.04] p-3 text-xs text-indigo-200">
                            <Loader2 className="size-4 animate-spin" /> Reviewing against documentation…
                          </div>
                        )}

                        {aiReview ? (
                          <div className="mt-3 space-y-3">
                            <p className="rounded-xl border border-white/7 bg-white/[0.02] p-3 text-xs leading-5 text-zinc-400">
                              {aiReview.documentationSummary}
                            </p>
                            {aiReview.grammarIssues.map((issue, index) => (
                              <div key={'grammar' + index} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs leading-5 text-amber-100">
                                <strong>Grammar:</strong> {issue}
                              </div>
                            ))}
                            {aiReview.suggestions.map((suggestion, index) => (
                              <div key={'suggestion' + index} className="rounded-xl border border-indigo-400/20 bg-indigo-400/[0.05] p-3 text-xs leading-5 text-indigo-100">
                                <strong>Suggestion:</strong> {suggestion}
                              </div>
                            ))}
                          </div>
                        ) : aiStatus === 'unavailable' ? (
                          <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs leading-5 text-amber-200">
                            Local validation completed. Connect an OpenAI API key to enable documentation and grammar review.
                          </div>
                        ) : aiStatus !== 'researching' ? (
                          <div className="mt-3 rounded-xl border border-white/7 bg-white/[0.02] p-3 text-xs text-zinc-600">
                            Run validation to start the documentation review.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
