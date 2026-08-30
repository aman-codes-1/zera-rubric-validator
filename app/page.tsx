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
  ChevronDown,
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
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from '@/components/ui/combobox';
import { InputGroupAddon } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type BatchKey = 'Batch A' | 'Batch B' | 'Batch C';
const APPLICATIONS = ['quickbooks', 'workday'] as const;
type Application = (typeof APPLICATIONS)[number];
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
  inferredTag: 'bug' | 'feature request' | 'unclear';
  criterionSection: string;
  sectionMatch: 'match' | 'mismatch' | 'unclear';
  documentationStatus: 'supported' | 'unclear' | 'not_found';
  documentationSummary: string;
  findings: Issue[];
  correctedRubric: RubricRecord;
};

type AiResponse = {
  applicationBrief: string;
  rubricReviews: AiReview[];
  sources: Array<{ title: string; url: string }>;
};

const BATCHES: Record<
  BatchKey,
  { label: string; total: number; bugs: number; features: number }
> = {
  'Batch A': { label: 'Batch A · 20 rubrics (5 + 10 + 5)', total: 20, bugs: 5, features: 10 },
  'Batch B': { label: 'Batch B · 20 rubrics (3 + 3 + 14)', total: 20, bugs: 3, features: 3 },
  'Batch C': { label: 'Batch C · 10 rubrics (3 + 3 + 4)', total: 10, bugs: 3, features: 3 },
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
  return {
    total: rubrics.length,
    bugs,
    features,
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
        label: 'Valid single tags',
        current: validSingleTags,
        target: requirement.total,
        pass: validSingleTags === requirement.total,
        detail: 'One valid tag per rubric',
      },
    ],
  };
}

function batchFailureMessage(
  check: BatchSummary['checks'][number],
  summary: BatchSummary,
) {
  if (check.label === 'Rubrics') {
    const difference = check.target - check.current;
    return difference > 0
      ? `Rubrics: ${check.current}/${check.target}. Add ${difference}.`
      : `Rubrics: ${check.current}/${check.target}. Remove ${Math.abs(difference)}.`;
  }

  if (check.label === 'Valid single tags') {
    const rubricsCheck = summary.checks.find((item) => item.label === 'Rubrics');
    if (rubricsCheck && !rubricsCheck.pass) {
      return `Valid single tags: ${check.current}/${check.target}.`;
    }
    return `Valid single tags: ${check.current}/${check.target}. Add 1.`;
  }

  return `${check.label}: ${check.current}/${check.target} minimum. Add ${Math.max(0, check.target - check.current)}.`;
}

function parseInput(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new JsonFormatError([
      'The JSON array or object syntax is incorrect. Check brackets, braces, commas, and quotation marks.',
    ]);
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
  const applicationComboboxAnchor = useComboboxAnchor();
  const [application, setApplication] = useState<Application>(APPLICATIONS[0]);
  const [batchKey, setBatchKey] = useState<BatchKey>('Batch A');
  const [jsonInput, setJsonInput] = useState('');
  const [results, setResults] = useState<RubricResult[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle');
  const [aiResponse, setAiResponse] = useState<AiResponse | null>(null);
  const [aiError, setAiError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const reviewedResults = useMemo(
    () =>
      results.map((result) => {
        const aiReview = aiResponse?.rubricReviews.find((review) => review.index === result.index);
        const findings = [...result.issues, ...(aiReview?.findings || [])];
        return {
          ...result,
          aiReview,
          findings,
          errorCount: findings.filter((finding) => finding.severity === 'error').length,
          warningCount: findings.filter((finding) => finding.severity === 'warning').length,
        };
      }),
    [aiResponse, results],
  );
  const validationMetrics = useMemo(
    () => {
      const errors = reviewedResults.reduce((total, result) => total + result.errorCount, 0);
      const warnings = reviewedResults.reduce((total, result) => total + result.warningCount, 0);
      const needFix = reviewedResults.filter((result) => result.findings.length > 0).length;

      return {
        errors,
        warnings,
        needFix,
        valid: reviewedResults.length - needFix,
        outcome: errors > 0 ? 'failed' : warnings > 0 ? 'warning' : 'pass',
      } as const;
    },
    [reviewedResults],
  );
  const outcomePresentation =
    validationMetrics.outcome === 'failed'
      ? {
          label: 'Failed to pass',
          submission: 'Not ready to submit',
          description: `This batch contains ${validationMetrics.errors} error${validationMetrics.errors === 1 ? '' : 's'} that must be fixed before submission. Review the affected rubrics below.`,
          badgeClass: 'border-rose-500/25 bg-rose-500/12 text-rose-300',
          submissionClass: 'border-rose-500/20 bg-rose-500/8 text-rose-200',
        }
      : validationMetrics.outcome === 'warning'
        ? {
            label: 'Pass with warnings',
            submission: 'Review before submit',
            description: `This batch passes the required rules, but has ${validationMetrics.warnings} warning${validationMetrics.warnings === 1 ? '' : 's'} to review before submission.`,
            badgeClass: 'border-amber-500/25 bg-amber-500/12 text-amber-300',
            submissionClass: 'border-amber-500/20 bg-amber-500/8 text-amber-200',
          }
        : {
            label: 'Pass',
            submission: 'Ready to submit',
            description: `This batch meets the required rubric rules for ${application}. No changes are required before submission.`,
            badgeClass: 'border-emerald-500/25 bg-emerald-500/12 text-emerald-300',
            submissionClass: 'border-emerald-500/20 bg-emerald-500/8 text-emerald-200',
          };
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

    setResults([]);
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
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('AI documentation review is temporarily unavailable. Please try again.');
      }

      let payload: AiResponse & { error?: string };
      try {
        payload = (await response.json()) as AiResponse & { error?: string };
      } catch {
        throw new Error('AI documentation review is temporarily unavailable. Please try again.');
      }

      if (!response.ok) {
        throw new Error(payload.error || 'AI documentation review is unavailable.');
      }

      if (
        !Array.isArray(payload.rubricReviews) ||
        rubrics.some((_, index) => !payload.rubricReviews.some((review) => review.index === index))
      ) {
        throw new Error('The AI review returned incomplete results. Validation was not completed.');
      }

      const validatedResults = rubrics.map((rubric, index) => ({
        index,
        rubric,
        issues: validateRubric(rubric),
      }));

      setResults(validatedResults);
      setAiResponse(payload);
      setAiStatus('ready');
    } catch (error) {
      setResults([]);
      setAiResponse(null);
      setAiStatus('unavailable');
      setAiError(
        error instanceof Error
          ? error.message
          : 'AI documentation review is unavailable. Validation was not completed.',
      );
    } finally {
      setIsRunning(false);
    }
  }

  async function copyCorrectedJson() {
    const correctedRubrics = reviewedResults.map(
      (result) => result.aiReview?.correctedRubric || result.rubric,
    );
    await navigator.clipboard.writeText(JSON.stringify(correctedRubrics, null, 2));
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
            grammar, specificity, and alignment with current documentation for the selected application.
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
                <Combobox
                  items={APPLICATIONS}
                  value={application}
                  onValueChange={(value) => {
                    if (value) {
                      setApplication(value as Application);
                      setResults([]);
                      setAiResponse(null);
                      setAiStatus('idle');
                      setAiError('');
                    }
                  }}
                >
                  <div ref={applicationComboboxAnchor} className="w-full">
                    <ComboboxInput
                      aria-label="Search supported applications"
                      placeholder="Search supported apps..."
                      className="h-11 w-full rounded-xl border-white/10 bg-[#101317] shadow-none transition has-[[data-slot=input-group-control]:focus-visible]:border-indigo-400/70 has-[[data-slot=input-group-control]:focus-visible]:ring-1 has-[[data-slot=input-group-control]:focus-visible]:ring-indigo-400/30 [&_input]:h-full [&_input]:font-mono [&_input]:text-zinc-100 [&_input]:placeholder:text-zinc-600"
                    >
                      <InputGroupAddon align="inline-start" className="pl-3 pr-0 text-zinc-500">
                        <Search aria-hidden="true" className="size-4" />
                      </InputGroupAddon>
                    </ComboboxInput>
                  </div>
                  <ComboboxContent
                    anchor={applicationComboboxAnchor}
                    className="border border-white/10 bg-[#101317] p-1 text-zinc-100 shadow-2xl ring-0"
                  >
                    <ComboboxEmpty className="py-3 text-zinc-500">No application found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: Application) => (
                        <ComboboxItem
                          key={item}
                          value={item}
                          className="min-h-9 px-3 font-mono data-highlighted:bg-indigo-400/15 data-highlighted:text-indigo-100"
                        >
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <span className="mt-2 block text-xs text-zinc-600">
                  {APPLICATIONS.length} supported applications
                </span>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-300">Batch requirements</span>
                <Select
                  value={batchKey}
                  onValueChange={(value) => {
                    if (value) {
                      setBatchKey(value as BatchKey);
                      setResults([]);
                      setAiResponse(null);
                      setAiStatus('idle');
                      setAiError('');
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label="Batch requirements"
                    className="h-11 w-full rounded-xl border-white/10 bg-[#101317] px-3 text-zinc-100 shadow-none hover:bg-[#13171b] focus-visible:border-emerald-400/50 focus-visible:ring-emerald-400/10 data-[size=default]:h-11"
                  >
                    <ShieldCheck aria-hidden="true" className="size-4 text-zinc-500" />
                    <SelectValue>
                      {(value: BatchKey | null) =>
                        value ? BATCHES[value].label : 'Select batch requirements'
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    align="start"
                    alignItemWithTrigger={false}
                    sideOffset={6}
                    className="border border-white/10 bg-[#101317] p-1 text-zinc-100 shadow-2xl ring-0"
                  >
                    {Object.entries(BATCHES).map(([key, batch]) => (
                      <SelectItem
                        key={key}
                        value={key}
                        className="min-h-9 px-3 font-mono focus:bg-indigo-400/15 focus:text-indigo-100"
                      >
                        {batch.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="mt-2 block text-xs text-zinc-600">
                  {selectedBatch.bugs} bugs minimum · {selectedBatch.features} feature requests minimum
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
                      <p key={check.label}>{batchFailureMessage(check, liveBatchSummary)}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                onClick={runValidation}
                disabled={!canValidate}
                aria-busy={isRunning}
                className="h-11 min-w-40 bg-emerald-400 px-5 font-semibold text-[#06251a] hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {isRunning ? <Loader2 className="animate-spin" /> : <Play />}
                {isRunning ? 'Validating' : 'Validate Rubrics'}
              </Button>
              <Button
                variant="outline"
                onClick={reset}
                disabled={isRunning || !hasInput}
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

        {isRunning && (
          <section
            role="status"
            aria-live="polite"
            aria-busy="true"
            className="mt-10 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-white/8 bg-[#090b0e] px-6 py-12 text-center"
          >
            <Loader2 aria-hidden="true" className="size-14 animate-spin text-indigo-400" strokeWidth={2.25} />
            <h2 className="mt-7 text-xl font-semibold tracking-tight text-zinc-100 sm:text-2xl">
              Zera is validating {application} rubrics…
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 sm:text-base">
              The documentation-grounded semantic and grammar review may take several minutes.
              Keep this page open while validation is in progress.
            </p>
          </section>
        )}

        {aiStatus === 'ready' && aiResponse && results.length > 0 && (
          <section className="mt-10 border-t border-white/8 pt-8">
            <div className="rounded-2xl border border-white/10 bg-[#0d1013] p-5 sm:p-6">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={'border px-3 py-1 text-xs font-semibold uppercase tracking-wide ' + outcomePresentation.badgeClass}>
                      {outcomePresentation.label}
                    </Badge>
                    <Badge className={'border px-3 py-1 text-xs ' + outcomePresentation.submissionClass}>
                      {outcomePresentation.submission}
                    </Badge>
                    <Badge className="border border-indigo-400/20 bg-indigo-400/10 px-3 py-1 font-mono text-xs text-indigo-300">
                      {application}
                    </Badge>
                  </div>
                  <p className="mt-4 max-w-4xl text-base font-medium leading-7 text-zinc-200">
                    {outcomePresentation.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={copyCorrectedJson}
                  className="shrink-0 border-indigo-400/35 bg-transparent text-indigo-300 hover:bg-indigo-400/10 hover:text-indigo-200"
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Corrected JSON copied' : 'Copy corrected JSON'}
                </Button>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
              {[
                { label: 'Rubrics', value: liveBatchSummary.total, color: 'text-zinc-100' },
                { label: 'Bugs', value: liveBatchSummary.bugs, color: 'text-rose-300' },
                { label: 'Feature requests', value: liveBatchSummary.features, color: 'text-indigo-300' },
                { label: 'Valid', value: validationMetrics.valid, color: 'text-emerald-300' },
                { label: 'Need fix', value: validationMetrics.needFix, color: 'text-amber-300' },
                { label: 'Errors', value: validationMetrics.errors, color: 'text-rose-300' },
                { label: 'Warnings', value: validationMetrics.warnings, color: 'text-amber-300' },
              ].map((metric) => (
                <div
                  key={metric.label}
                  className="rounded-2xl border border-white/10 bg-[#0d1013] px-4 py-5 text-center"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                    {metric.label}
                  </p>
                  <p className={'mt-2 text-3xl font-semibold tabular-nums ' + metric.color}>{metric.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-600">Validation report</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">Rubric results</h2>
              </div>
              <p className="hidden text-xs text-zinc-600 sm:block">Select a rubric to inspect every check</p>
            </div>

            <div className="mt-5 space-y-3">
              {reviewedResults.map((result) => {
                const hasErrors = result.errorCount > 0;
                const hasWarnings = result.warningCount > 0;
                const statusLabel = hasErrors
                  ? 'Failed to pass'
                  : hasWarnings
                    ? 'Pass with warnings'
                    : 'Valid';
                const statusClass = hasErrors
                  ? 'border-rose-500/25 bg-rose-500/10 text-rose-300'
                  : hasWarnings
                    ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                    : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
                const criterionSection =
                  result.aiReview?.criterionSection || result.rubric.criterion.split(':')[0] || 'Unknown';

                return (
                  <details
                    key={result.index}
                    className="group overflow-hidden rounded-2xl border border-white/10 bg-[#0d1013]"
                    open={result.index === 0}
                  >
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-5">
                      <div className="flex min-w-0 gap-3">
                        <span
                          className={
                            'mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl ' +
                            (hasErrors
                              ? 'bg-rose-500/10 text-rose-300'
                              : hasWarnings
                                ? 'bg-amber-500/10 text-amber-300'
                                : 'bg-emerald-500/10 text-emerald-300')
                          }
                        >
                          {hasErrors ? (
                            <XCircle className="size-[18px]" />
                          ) : hasWarnings ? (
                            <AlertTriangle className="size-[18px]" />
                          ) : (
                            <BadgeCheck className="size-[18px]" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-zinc-500">#{result.index + 1}</span>
                            <Badge className={'border text-[10px] ' + statusClass}>{statusLabel}</Badge>
                            <span className="text-xs text-zinc-600">
                              {result.errorCount} errors · {result.warningCount} warnings
                            </span>
                          </div>
                          <p className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-zinc-200">
                            {result.rubric.criterion || 'Missing criterion'}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-4">
                        <div className="hidden text-right md:block">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Criterion section</p>
                          <p className="mt-1 text-xs font-medium text-emerald-300">{criterionSection}</p>
                        </div>
                        <ChevronDown
                          aria-hidden="true"
                          className="size-4 text-zinc-600 transition group-open:rotate-180"
                        />
                      </div>
                    </summary>

                    <div className="space-y-6 border-t border-white/8 px-5 py-5">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Criterion</p>
                        <p className="mt-2 text-sm leading-6 text-zinc-200">{result.rubric.criterion}</p>
                        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs text-zinc-500">
                          <p>Declared tag: <strong className="text-zinc-300">{result.rubric.tags.join(', ') || 'missing'}</strong></p>
                          <p>Inferred tag: <strong className="text-indigo-300">{result.aiReview?.inferredTag || 'unclear'}</strong></p>
                          <p>Section match: <strong className="text-zinc-300">{result.aiReview?.sectionMatch || 'unclear'}</strong></p>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Page or workflow</p>
                          <p className="mt-2 text-xs leading-5 text-zinc-300">{result.rubric.forms.page_or_workflow}</p>
                        </div>
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Reproduction steps</p>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{result.rubric.forms.reproduction_steps}</p>
                        </div>
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Expected behavior</p>
                          <p className="mt-2 text-xs leading-5 text-zinc-300">{result.rubric.forms.expected_behavior}</p>
                        </div>
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Actual behavior</p>
                          <p className="mt-2 text-xs leading-5 text-zinc-300">{result.rubric.forms.actual_behavior}</p>
                        </div>
                      </div>

                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Documentation review</p>
                          {result.aiReview && (
                            <Badge className={docsBadge(result.aiReview.documentationStatus)}>
                              {result.aiReview.documentationStatus.replace('_', ' ')}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-3 rounded-xl border border-white/7 bg-white/[0.02] p-4 text-xs leading-5 text-zinc-400">
                          {result.aiReview?.documentationSummary}
                        </p>
                      </div>

                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Findings and corrections</p>
                        {result.findings.length > 0 ? (
                          <div className="mt-3 space-y-2">
                            {result.findings.map((finding, findingIndex) => (
                              <div
                                key={`${finding.field}-${findingIndex}`}
                                className={
                                  'rounded-xl border p-4 ' +
                                  (finding.severity === 'error'
                                    ? 'border-rose-500/20 bg-rose-500/[0.06]'
                                    : 'border-amber-500/20 bg-amber-500/[0.06]')
                                }
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge className={finding.severity === 'error' ? 'bg-rose-500/15 text-rose-200' : 'bg-amber-500/15 text-amber-200'}>
                                    {finding.severity}
                                  </Badge>
                                  <Badge className="bg-white/5 font-mono text-[10px] text-zinc-400">{finding.field}</Badge>
                                  <strong className={finding.severity === 'error' ? 'text-xs text-rose-100' : 'text-xs text-amber-100'}>
                                    {finding.message}
                                  </strong>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-zinc-400">
                                  <span className="font-medium text-zinc-300">Recommended change:</span> {finding.suggestion}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-3 flex gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 text-sm text-emerald-300">
                            <CheckCircle2 className="size-4 shrink-0" />
                            No changes requested for this rubric.
                          </div>
                        )}
                      </div>

                      {result.findings.length > 0 && result.aiReview?.correctedRubric && (
                        <details className="rounded-xl border border-indigo-400/15 bg-indigo-400/[0.035]">
                          <summary className="cursor-pointer list-none px-4 py-3 text-xs font-medium text-indigo-200">
                            View corrected JSON preview
                          </summary>
                          <pre className="overflow-x-auto border-t border-indigo-400/10 p-4 font-mono text-[11px] leading-5 text-zinc-400">
                            {JSON.stringify(result.aiReview.correctedRubric, null, 2)}
                          </pre>
                        </details>
                      )}
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
