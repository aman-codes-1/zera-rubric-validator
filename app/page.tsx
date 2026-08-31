'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { PRODUCT_NAME, PRODUCT_TITLE } from '@/lib/constants.mjs';

type BatchKey = 'Batch A' | 'Batch B' | 'Batch C';
const APPLICATIONS = ['quickbooks', 'workday'] as const;
type Application = (typeof APPLICATIONS)[number];
type IssueSeverity = 'error' | 'warning';
type IssueKind = 'grammar' | 'documentation' | 'validation';
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
  code?: 'application_mismatch' | 'non_testable_expected_behavior';
  kind?: IssueKind;
  field: string;
  severity: IssueSeverity;
  message: string;
  suggestion: string;
  lineNumber?: number | null;
  excerpt?: string;
  correctedText?: string;
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
  criterionSection: string;
  documentationStatus:
    | 'supported'
    | 'unclear'
    | 'not_found'
    | 'not_applicable'
    | 'application_mismatch';
  documentationSummary: string;
  findings: Issue[];
  correctedRubric: RubricRecord;
};

type AiResponse = {
  applicationBrief: string;
  rubricReviews: AiReview[];
  sources: Array<{ title: string; url: string }>;
};

type CorrectionTarget = {
  index: number;
  field: string;
  originalText: string;
  messages: string[];
  suggestions: string[];
  kinds: IssueKind[];
  documentationSummary: string;
};

type CorrectionPatch = {
  index: number;
  field: string;
  correctedText: string;
};

type ValidationApiPayload = Partial<AiResponse> & {
  error?: string;
  responseId?: string;
  responseType?: 'correction_repair';
  status?: 'queued' | 'in_progress';
  corrections?: CorrectionPatch[];
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
const APPLICATION_METADATA: Record<
  Application,
  { label: string; pattern: string }
> = {
  quickbooks: {
    label: 'QuickBooks',
    pattern: '\\bQuickBooks(?:\\s+Online)?\\b',
  },
  workday: {
    label: 'Workday',
    pattern: '\\bWorkday\\b',
  },
};
const DOCUMENTATION_AI_FIELDS = new Set([
  'criterion',
  'expected_behavior',
  'actual_behavior',
]);
const VALIDATION_POLL_INTERVAL_MS = 2000;
const MAX_CORRECTION_REPAIR_ATTEMPTS = 3;
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
          (
            typeof forms[key] !== 'string' ||
            (key !== 'reproduction_steps' && !forms[key].trim())
          )
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

function readExactString(value: unknown) {
  return typeof value === 'string' ? value : '';
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
      reproduction_steps: readExactString(formsValue.reproduction_steps),
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

function correctedOrderedSteps(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const stepText = line.replace(/^\d+[.)]\s*/, '').trim();
      return `${index + 1}. ${stepText}`;
    })
    .join('\n');
}

function firstInvalidOrderedStep(value: string) {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const index = lines.findIndex((line, lineIndex) => {
    const match = line.match(/^(\d+)[.)]\s+\S/);
    return !match || Number(match[1]) !== lineIndex + 1;
  });

  return index < 0 ? null : { lineNumber: index + 1, excerpt: lines[index] };
}

function validateRubric(rubric: RubricRecord): Issue[] {
  const issues: Issue[] = [];
  const tag = rubric.tags[0]?.toLowerCase();

  if (!rubric.criterion) {
    issues.push({
      kind: 'validation',
      field: 'criterion',
      severity: 'error',
      message: 'Criterion is missing.',
      suggestion: 'Add a specific, observable criterion.',
    });
  } else if (!/^[A-Z][A-Za-z0-9 &/()'’-]{1,79}:\s+\S/.test(rubric.criterion)) {
    issues.push({
      kind: 'validation',
      field: 'criterion',
      severity: 'error',
      message: 'Criterion must follow the “Section: description” format.',
      suggestion: 'Start with the relevant section and a colon, for example: “Invoice: The \"Edit\" action should be enabled.”',
      excerpt: rubric.criterion,
      lineNumber: 1,
    });
  }

  if (rubric.score !== 10) {
    issues.push({
      kind: 'validation',
      field: 'score',
      severity: 'error',
      message: 'Score must be the number 10.',
      suggestion: 'Set score to 10.',
      correctedText: '10',
      excerpt: rubric.score === null ? '' : String(rubric.score),
      lineNumber: 1,
    });
  }

  if (rubric.tags.length !== 1) {
    issues.push({
      kind: 'validation',
      field: 'tags',
      severity: 'error',
      message: 'Every rubric must have exactly one tag.',
      suggestion: 'Use either ["bug"] or ["feature request"].',
    });
  } else if (!VALID_TAGS.has(tag)) {
    issues.push({
      kind: 'validation',
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
    const hasExactFeatureRequestRule =
      tag === 'feature request' && field === 'reproduction_steps';
    if (!rubric.forms[field] && !hasExactFeatureRequestRule) {
      issues.push({
        kind: 'validation',
        field,
        severity: 'error',
        message: label + ' is missing.',
        suggestion: 'Add a specific value for ' + label.toLowerCase() + '.',
      });
    }
  });

  if (tag === 'bug' && rubric.forms.reproduction_steps && !validateOrderedSteps(rubric.forms.reproduction_steps)) {
    const invalidStep = firstInvalidOrderedStep(rubric.forms.reproduction_steps);
    issues.push({
      kind: 'validation',
      field: 'reproduction_steps',
      severity: 'error',
      message: 'Bug reproduction steps must be an uninterrupted ordered list starting at 1.',
      suggestion: 'Use 1., 2., 3. and continue without skipped or repeated numbers.',
      correctedText: correctedOrderedSteps(rubric.forms.reproduction_steps),
      excerpt: invalidStep?.excerpt || rubric.forms.reproduction_steps,
      lineNumber: invalidStep?.lineNumber || 1,
    });
  }

  if (
    tag === 'feature request' &&
    rubric.forms.reproduction_steps !== 'N/A'
  ) {
    issues.push({
      kind: 'validation',
      field: 'reproduction_steps',
      severity: 'error',
      message: 'Feature-request reproduction steps must be exactly “N/A” (case-sensitive, with no extra whitespace or content).',
      suggestion: 'Set reproduction_steps to exactly “N/A”.',
      correctedText: 'N/A',
      excerpt: rubric.forms.reproduction_steps,
      lineNumber: 1,
    });
  }

  const genericExpectedOutcome = tag === 'feature request'
    ? /\b(?:open|launch|start|begin|enter)\s+(?:the\s+|an?\s+)?(?:[a-z0-9-]+\s+){0,5}(?:workflow|flow|process|experience)\b(?=\s*[.!?]?$)/i.exec(
        rubric.forms.expected_behavior,
      )
    : null;

  if (genericExpectedOutcome) {
    issues.push({
      code: 'non_testable_expected_behavior',
      kind: 'documentation',
      field: 'expected_behavior',
      severity: 'error',
      message: 'Expected behavior ends with a generic workflow description instead of a specific, user-observable result.',
      suggestion: 'Replace the generic workflow phrase with the concrete action or outcome stated in the selected application’s official documentation.',
      excerpt: genericExpectedOutcome[0],
      lineNumber: 1,
    });
  }

  return issues;
}

function validateApplicationMatch(
  rubric: RubricRecord,
  selectedApplication: Application,
): Issue[] {
  const selectedLabel = APPLICATION_METADATA[selectedApplication].label;
  const fields = [
    ['criterion', rubric.criterion],
    ['page_or_workflow', rubric.forms.page_or_workflow],
    ['reproduction_steps', rubric.forms.reproduction_steps],
    ['expected_behavior', rubric.forms.expected_behavior],
    ['actual_behavior', rubric.forms.actual_behavior],
  ] as const;

  return APPLICATIONS.filter(
    (applicationName) => applicationName !== selectedApplication,
  ).flatMap((applicationName) => {
    const mismatchedApplication = APPLICATION_METADATA[applicationName];

    return fields.flatMap(([field, value]) => {
      const matcher = new RegExp(mismatchedApplication.pattern, 'i');
      const match = matcher.exec(value);
      if (!match || typeof match.index !== 'number') return [];

      const lineNumber = value.slice(0, match.index).split('\n').length;
      const correctedText = value.replace(
        new RegExp(mismatchedApplication.pattern, 'gi'),
        selectedLabel,
      );

      return [{
        code: 'application_mismatch' as const,
        kind: 'documentation' as const,
        field,
        severity: 'error' as const,
        message: `This field references ${mismatchedApplication.label}, but ${selectedLabel} is the selected application.`,
        suggestion: `Select ${mismatchedApplication.label} as the application, or update this field to target ${selectedLabel}.`,
        lineNumber,
        excerpt: match[0],
        correctedText,
      }];
    });
  });
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

function inferBatchKeyFromJson(value: string): BatchKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isObject)) {
    return null;
  }

  const rubrics = parsed.map(normalizeRubric);
  const candidates = (Object.keys(BATCHES) as BatchKey[]).filter(
    (key) => BATCHES[key].total === rubrics.length,
  );

  if (candidates.length === 0) return null;

  const bugs = rubrics.filter(
    (rubric) => rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === 'bug',
  ).length;
  const features = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === 'feature request',
  ).length;

  const rankedCandidates = candidates.sort((leftKey, rightKey) => {
    const left = BATCHES[leftKey];
    const right = BATCHES[rightKey];
    const leftPasses = bugs >= left.bugs && features >= left.features;
    const rightPasses = bugs >= right.bugs && features >= right.features;

    if (leftPasses !== rightPasses) return leftPasses ? -1 : 1;

    const leftDeficit = Math.max(0, left.bugs - bugs) + Math.max(0, left.features - features);
    const rightDeficit =
      Math.max(0, right.bugs - bugs) + Math.max(0, right.features - features);

    if (leftDeficit !== rightDeficit) return leftDeficit - rightDeficit;

    return right.bugs + right.features - (left.bugs + left.features);
  });

  return rankedCandidates[0];
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
  if (status === 'application_mismatch') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  if (status === 'not_applicable') return 'border-white/10 bg-white/[0.04] text-zinc-400';
  return 'border-white/10 bg-white/[0.04] text-zinc-400';
}

function docsStatusLabel(status: AiReview['documentationStatus']) {
  if (status === 'not_found') return 'not found · skipped';
  if (status === 'unclear') return 'unclear · skipped';
  return status.replaceAll('_', ' ');
}

function rubricFieldValue(rubric: RubricRecord | undefined, field: string) {
  if (!rubric) return '';
  if (field === 'criterion') return rubric.criterion;
  if (field === 'score') return rubric.score === null ? '' : String(rubric.score);
  if (field === 'tag') return rubric.tags.join(', ');
  if (field === 'page_or_workflow') return rubric.forms.page_or_workflow;
  if (field === 'reproduction_steps') return rubric.forms.reproduction_steps;
  if (field === 'expected_behavior') return rubric.forms.expected_behavior;
  if (field === 'actual_behavior') return rubric.forms.actual_behavior;
  return '';
}

function correctedTextForFinding(
  finding: Issue,
  originalRubric: RubricRecord,
  correctedRubric: RubricRecord | undefined,
) {
  const originalText = rubricFieldValue(originalRubric, finding.field);
  const findingCorrection = finding.correctedText?.trim() || '';
  if (findingCorrection && findingCorrection !== originalText) {
    return findingCorrection;
  }

  const rubricCorrection = rubricFieldValue(correctedRubric, finding.field).trim();
  return rubricCorrection && rubricCorrection !== originalText
    ? rubricCorrection
    : '';
}

function applyFindingCorrections(
  originalRubric: RubricRecord,
  correctedRubric: RubricRecord | undefined,
  findings: Issue[],
) {
  const nextRubric: RubricRecord = {
    ...originalRubric,
    tags: [...originalRubric.tags],
    forms: { ...originalRubric.forms },
  };

  findings.forEach((finding) => {
    const correctedText = correctedTextForFinding(
      finding,
      originalRubric,
      correctedRubric,
    );
    if (!correctedText) return;

    if (finding.field === 'criterion') nextRubric.criterion = correctedText;
    if (finding.field === 'score') nextRubric.score = Number(correctedText);
    if (finding.field === 'tag') nextRubric.tags = [correctedText];
    if (finding.field === 'page_or_workflow') nextRubric.forms.page_or_workflow = correctedText;
    if (finding.field === 'reproduction_steps') nextRubric.forms.reproduction_steps = correctedText;
    if (finding.field === 'expected_behavior') nextRubric.forms.expected_behavior = correctedText;
    if (finding.field === 'actual_behavior') nextRubric.forms.actual_behavior = correctedText;
  });

  return nextRubric;
}

function setRubricFieldValue(
  rubric: RubricRecord,
  field: string,
  value: string,
) {
  const nextRubric: RubricRecord = {
    ...rubric,
    tags: [...rubric.tags],
    forms: { ...rubric.forms },
  };

  if (field === 'criterion') nextRubric.criterion = value;
  if (field === 'score') nextRubric.score = Number(value);
  if (field === 'tag') nextRubric.tags = [value];
  if (field === 'page_or_workflow') nextRubric.forms.page_or_workflow = value;
  if (field === 'reproduction_steps') nextRubric.forms.reproduction_steps = value;
  if (field === 'expected_behavior') nextRubric.forms.expected_behavior = value;
  if (field === 'actual_behavior') nextRubric.forms.actual_behavior = value;

  return nextRubric;
}

function rubricHasChanges(original: RubricRecord, corrected: RubricRecord | undefined) {
  return Boolean(corrected) && JSON.stringify(original) !== JSON.stringify(corrected);
}

function collectCorrectionTargets(
  rubrics: RubricRecord[],
  reviews: AiReview[],
) {
  const targets = new Map<string, CorrectionTarget>();

  rubrics.forEach((rubric, index) => {
    const review = reviews.find((candidate) => candidate.index === index);
    if (!review) return;

    const findings = [
      ...validateRubric(rubric),
      ...review.findings.filter((finding) =>
        isAllowedAiFinding(finding, rubric, review.documentationStatus),
      ),
    ];

    findings.forEach((finding) => {
      const originalText = rubricFieldValue(rubric, finding.field).trim();
      if (
        !originalText ||
        correctedTextForFinding(finding, rubric, review.correctedRubric)
      ) {
        return;
      }

      const key = `${index}:${finding.field}`;
      const existing = targets.get(key);
      if (existing) {
        if (!existing.messages.includes(finding.message)) {
          existing.messages.push(finding.message);
        }
        if (!existing.suggestions.includes(finding.suggestion)) {
          existing.suggestions.push(finding.suggestion);
        }
        const kind = finding.kind || 'grammar';
        if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
        return;
      }

      targets.set(key, {
        index,
        field: finding.field,
        originalText,
        messages: [finding.message],
        suggestions: [finding.suggestion],
        kinds: [finding.kind || 'grammar'],
        documentationSummary: review.documentationSummary,
      });
    });
  });

  return [...targets.values()];
}

function mergeCorrectionPatches(
  payload: ValidationApiPayload,
  targets: CorrectionTarget[],
  corrections: CorrectionPatch[],
) {
  const requestedTargets = new Map(
    targets.map((target) => [`${target.index}:${target.field}`, target]),
  );
  const acceptedCorrections = new Map<string, string>();

  corrections.forEach((correction) => {
    const key = `${correction.index}:${correction.field}`;
    const target = requestedTargets.get(key);
    const correctedText = correction.correctedText?.trim() || '';
    if (
      !target ||
      !correctedText ||
      correctedText === target.originalText.trim()
    ) {
      return;
    }
    acceptedCorrections.set(key, correctedText);
  });

  return {
    ...payload,
    rubricReviews: (payload.rubricReviews || []).map((review) => {
      let correctedRubric = review.correctedRubric;
      const findings = review.findings.map((finding) => {
        const correction = acceptedCorrections.get(
          `${review.index}:${finding.field}`,
        );
        if (!correction) return finding;
        correctedRubric = setRubricFieldValue(
          correctedRubric,
          finding.field,
          correction,
        );
        return { ...finding, correctedText: correction };
      });

      acceptedCorrections.forEach((correction, key) => {
        const [indexText, field] = key.split(':');
        if (Number(indexText) === review.index) {
          correctedRubric = setRubricFieldValue(
            correctedRubric,
            field,
            correction,
          );
        }
      });

      return { ...review, findings, correctedRubric };
    }),
  };
}

function changedTextRange(original: string, corrected: string): [number, number] | null {
  if (!original || original === corrected) return null;

  let start = 0;
  while (start < original.length && start < corrected.length && original[start] === corrected[start]) {
    start += 1;
  }

  let originalEnd = original.length;
  let correctedEnd = corrected.length;
  while (
    originalEnd > start &&
    correctedEnd > start &&
    original[originalEnd - 1] === corrected[correctedEnd - 1]
  ) {
    originalEnd -= 1;
    correctedEnd -= 1;
  }

  if (originalEnd === start) {
    const followingWord = original.slice(start).match(/^\s*\S+/)?.[0];
    if (followingWord) return [start, start + followingWord.length];

    const previousWord = original.slice(0, start).match(/\S+\s*$/)?.[0];
    if (previousWord) return [start - previousWord.length, start];
  }

  return [start, originalEnd];
}

function exactRecommendedChange(
  finding: Issue,
  rubric: RubricRecord,
  correctedRubric: RubricRecord | undefined,
) {
  const completeOriginalText = rubricFieldValue(rubric, finding.field);
  const completeCorrectedText = correctedTextForFinding(
    finding,
    rubric,
    correctedRubric,
  );
  if (
    !completeOriginalText ||
    !completeCorrectedText ||
    completeOriginalText === completeCorrectedText
  ) {
    return finding.suggestion;
  }

  const describeChange = (
    originalText: string,
    correctedText: string,
    lineNumber?: number,
  ) => {
    let start = 0;
    while (
      start < originalText.length &&
      start < correctedText.length &&
      originalText[start] === correctedText[start]
    ) {
      start += 1;
    }

    let originalEnd = originalText.length;
    let correctedEnd = correctedText.length;
    while (
      originalEnd > start &&
      correctedEnd > start &&
      originalText[originalEnd - 1] === correctedText[correctedEnd - 1]
    ) {
      originalEnd -= 1;
      correctedEnd -= 1;
    }

    const originalFragment = originalText.slice(start, originalEnd);
    const correctedFragment = correctedText.slice(start, correctedEnd);
    if (originalFragment.length > 180 || correctedFragment.length > 180) {
      return '';
    }

    const location = lineNumber ? `On line ${lineNumber}, ` : '';
    if (originalFragment && correctedFragment) {
      return `${location}${lineNumber ? 'replace' : 'Replace'} ${JSON.stringify(originalFragment)} with ${JSON.stringify(correctedFragment)}.`;
    }
    if (!originalFragment && correctedFragment) {
      return `${location}${lineNumber ? 'insert' : 'Insert'} ${JSON.stringify(correctedFragment)} at the highlighted location.`;
    }
    if (originalFragment && !correctedFragment) {
      return `${location}${lineNumber ? 'remove' : 'Remove'} ${JSON.stringify(originalFragment)} from the highlighted location.`;
    }
    return '';
  };

  const originalLines = completeOriginalText.split('\n');
  const correctedLines = completeCorrectedText.split('\n');
  if (originalLines.length > 1 && originalLines.length === correctedLines.length) {
    const lineChanges = originalLines.flatMap((originalLine, index) => {
      const correctedLine = correctedLines[index];
      if (originalLine === correctedLine) return [];
      const instruction = describeChange(originalLine, correctedLine, index + 1);
      return instruction ? [instruction] : [];
    });
    if (lineChanges.length > 0) return lineChanges.join(' ');
  }

  const completeInstruction = describeChange(
    completeOriginalText,
    completeCorrectedText,
  );
  if (completeInstruction) return completeInstruction;

  return 'Replace the highlighted text with the complete corrected rubric shown below.';
}

function locateFinding(
  finding: Issue,
  rubric: RubricRecord,
  correctedRubric: RubricRecord | undefined,
): Issue {
  const originalValue = rubricFieldValue(rubric, finding.field);
  if (!originalValue) return finding;

  const correctedValue = rubricFieldValue(correctedRubric, finding.field);
  const originalLines = originalValue.split('\n');
  const correctedLines = correctedValue.split('\n');
  let lineNumber = finding.lineNumber;
  const changedLine = originalLines.findIndex(
    (line, index) => line !== (correctedLines[index] ?? line),
  );

  if (changedLine >= 0) {
    lineNumber = changedLine + 1;
  } else if (
    typeof lineNumber !== 'number' ||
    lineNumber < 1 ||
    lineNumber > originalLines.length
  ) {
    const excerpt = finding.excerpt?.trim().toLowerCase();
    const excerptLine = excerpt
      ? originalLines.findIndex((line) => line.toLowerCase().includes(excerpt))
      : -1;

    lineNumber = excerptLine >= 0
      ? excerptLine + 1
      : originalLines.length === 1
          ? 1
          : null;
  }

  let excerpt = finding.excerpt?.trim() || '';
  if (typeof lineNumber === 'number') {
    const originalLine = originalLines[lineNumber - 1] || '';
    const correctedLine = correctedLines[lineNumber - 1] ?? originalLine;
    const range = changedTextRange(originalLine, correctedLine);
    if (range) {
      excerpt = originalLine.slice(range[0], range[1]).trim();
    } else if (!excerpt) {
      excerpt = originalLine.trim();
    }
  }

  const correctedText = finding.correctedText?.trim() ||
    (correctedValue && correctedValue !== originalValue ? correctedValue : '');

  return { ...finding, lineNumber, excerpt, correctedText };
}

function HighlightedFieldValue({
  value,
  correctedValue,
  field,
  findings,
  className,
}: {
  value: string;
  correctedValue?: string;
  field: string;
  findings: Issue[];
  className: string;
}) {
  const lines = value.split('\n');
  const correctedLines = correctedValue?.split('\n') || [];
  const fieldFindings = findings.filter((finding) => finding.field === field);

  return (
    <div className={className}>
      {lines.map((line, lineIndex) => {
        const lineNumber = lineIndex + 1;
        const hasEmbeddedLineNumber = /^\s*\d+[.)]\s+/.test(line);
        const lineFindings = fieldFindings.filter((finding) => {
          if (typeof finding.lineNumber === 'number') {
            return finding.lineNumber === lineNumber;
          }

          const excerpt = finding.excerpt?.trim().toLowerCase();
          if (excerpt) {
            return line.toLowerCase().includes(excerpt);
          }

          return lines.length === 1 || fieldFindings.length > 0;
        });
        const exactExcerpt = lineFindings
          .map((finding) => finding.excerpt?.trim())
          .find((excerpt) => excerpt && line.toLowerCase().includes(excerpt.toLowerCase()));
        const excerptStart = exactExcerpt
          ? line.toLowerCase().indexOf(exactExcerpt.toLowerCase())
          : -1;
        const excerptRange: [number, number] | null = excerptStart >= 0 && exactExcerpt
          ? [excerptStart, excerptStart + exactExcerpt.length]
          : null;
        const correctedLine = correctedLines[lineIndex] ?? line;
        const diffRange = changedTextRange(line, correctedLine);
        const severityFindings = lineFindings.length > 0
          ? lineFindings
          : diffRange
            ? fieldFindings
            : [];
        const hasError = severityFindings.some((finding) => finding.severity === 'error');
        const hasWarning = severityFindings.some((finding) => finding.severity === 'warning');
        const highlightRange = severityFindings.length === 0
          ? null
          : diffRange || excerptRange;
        const highlightClass = hasError
          ? 'rounded bg-rose-500/25 px-0.5 text-rose-100 ring-1 ring-inset ring-rose-400/35'
          : 'rounded bg-amber-500/25 px-0.5 text-amber-100 ring-1 ring-inset ring-amber-400/35';

        return (
          <span
            key={`${field}-${lineNumber}`}
            className={
              'block rounded-md px-2 py-1 [overflow-wrap:anywhere] ' +
              (!highlightRange && hasError
                ? 'bg-rose-500/15 text-rose-100 ring-1 ring-inset ring-rose-500/25'
                : !highlightRange && hasWarning
                  ? 'bg-amber-500/15 text-amber-100 ring-1 ring-inset ring-amber-500/25'
                  : '')
            }
          >
            {lines.length > 1 && !hasEmbeddedLineNumber && (
              <span className="mr-2 select-none font-mono text-[10px] text-zinc-600">
                {lineNumber}
              </span>
            )}
            {highlightRange ? (
              <>
                {line.slice(0, highlightRange[0])}
                <mark className={highlightClass}>
                  {line.slice(highlightRange[0], highlightRange[1]) || ' '}
                </mark>
                {line.slice(highlightRange[1])}
              </>
            ) : line || ' '}
          </span>
        );
      })}
    </div>
  );
}

function isFeatureRequest(rubric: RubricRecord) {
  return rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === 'feature request';
}

function isObjectiveGrammarFinding(finding: Issue, rubric: RubricRecord) {
  const description = `${finding.message} ${finding.suggestion}`.toLowerCase();
  const fieldValue = rubricFieldValue(rubric, finding.field);
  const hasAdjacentDuplicateWord = /\b([a-z]+)\s+\1\b/i.test(fieldValue);

  if (
    /\b(repetitive|repetition|repeats?|redundant|wordy|wordiness)\b/.test(description)
  ) {
    return hasAdjacentDuplicateWord;
  }

  if (
    /\b(sentence case|capitalization|capitalisation|stylistic|style|tone|formal|informal|contraction|concise|shorten|simplify|streamline|awkward|parallel|parallelism|natural phrasing|more natural|clearer|clarity|consistency|unnecessarily|wording improvement)\b/.test(description)
  ) {
    return false;
  }

  if (
    finding.field === 'page_or_workflow' &&
    /\b(fragment|complete sentence|terminal punctuation|sentence punctuation)\b/.test(description)
  ) {
    return false;
  }

  return true;
}

function isAllowedAiFinding(
  finding: Issue,
  rubric: RubricRecord,
  documentationStatus?: AiReview['documentationStatus'],
) {
  if (isFeatureRequest(rubric) && finding.field === 'reproduction_steps') {
    return false;
  }
  if (finding.kind === 'grammar') {
    return finding.field !== 'documentation' &&
      isObjectiveGrammarFinding(finding, rubric);
  }
  if (finding.kind === 'documentation') {
    if (documentationStatus === 'application_mismatch') return true;
    return documentationStatus === 'supported' &&
      isFeatureRequest(rubric) &&
      DOCUMENTATION_AI_FIELDS.has(finding.field);
  }
  return false;
}

async function readValidationPayload(response: Response): Promise<ValidationApiPayload> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('AI documentation review is temporarily unavailable. Please try again.');
  }

  try {
    return (await response.json()) as ValidationApiPayload;
  } catch {
    throw new Error('AI documentation review is temporarily unavailable. Please try again.');
  }
}

function waitForNextValidationPoll() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, VALIDATION_POLL_INTERVAL_MS);
  });
}

async function waitForCompletedValidation(initialResponse: Response) {
  let response = initialResponse;
  let payload = await readValidationPayload(response);
  const responseType = payload.responseType;

  while (response.status === 202) {
    if (!payload.responseId) {
      throw new Error('The AI review did not return a response ID. Validation was not completed.');
    }

    await waitForNextValidationPoll();
    const searchParams = new URLSearchParams({ responseId: payload.responseId });
    if (responseType) searchParams.set('responseType', responseType);
    response = await fetch(`/api/validate?${searchParams.toString()}`, {
      cache: 'no-store',
    });
    payload = await readValidationPayload(response);
  }

  return { response, payload };
}

export default function Home() {
  const applicationComboboxAnchor = useComboboxAnchor();
  const [application, setApplication] = useState<Application | null>(null);
  const [batchKey, setBatchKey] = useState<BatchKey | null>(null);
  const [jsonInput, setJsonInput] = useState('');
  const [results, setResults] = useState<RubricResult[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle');
  const [aiResponse, setAiResponse] = useState<AiResponse | null>(null);
  const [aiError, setAiError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedRubricIndex, setCopiedRubricIndex] = useState<number | null>(null);

  useEffect(() => {
    if (aiStatus !== 'ready' || !aiResponse || results.length === 0) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        document.getElementById('validation-results')?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
          block: 'start',
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [aiStatus, aiResponse, results.length]);

  const reviewedResults = useMemo(
    () =>
      results.map((result) => {
        const responseReview = aiResponse?.rubricReviews.find((review) => review.index === result.index);
        const deterministicMismatchFindings = result.issues.filter(
          (finding) => finding.code === 'application_mismatch',
        );
        const normalizedReview = responseReview && deterministicMismatchFindings.length > 0
          ? {
              ...responseReview,
              documentationStatus: 'application_mismatch' as const,
              documentationSummary: deterministicMismatchFindings[0].message,
            }
          : responseReview &&
              !isFeatureRequest(result.rubric) &&
              responseReview.documentationStatus !== 'application_mismatch'
            ? {
                ...responseReview,
                documentationStatus: 'not_applicable' as const,
                documentationSummary: 'Documentation review is not applicable to bug rubrics. Grammar review only.',
              }
            : responseReview;
        const aiFindings = (normalizedReview?.findings || [])
          .filter((finding) =>
            isAllowedAiFinding(
              finding,
              result.rubric,
              normalizedReview?.documentationStatus,
            ),
          )
          .filter((finding) =>
            finding.kind !== 'documentation' ||
            deterministicMismatchFindings.length === 0,
          )
          .map((finding) =>
            normalizedReview?.documentationStatus === 'application_mismatch' &&
            finding.kind === 'documentation'
              ? {
                  ...finding,
                  code: 'application_mismatch' as const,
                  severity: 'error' as const,
                }
              : finding,
          )
          .filter((finding) =>
            Boolean(
              correctedTextForFinding(
                finding,
                result.rubric,
                normalizedReview?.correctedRubric,
              ),
            ),
          );
        const reviewFindings = [...result.issues, ...aiFindings];
        const correctedRubric = applyFindingCorrections(
          result.rubric,
          normalizedReview?.correctedRubric,
          reviewFindings,
        );
        const aiReview = normalizedReview
          ? { ...normalizedReview, correctedRubric }
          : undefined;
        const findings = reviewFindings.map((finding) =>
          locateFinding(finding, result.rubric, correctedRubric),
        );
        const hasDocumentationFinding = reviewFindings.some(
          (finding) => finding.kind === 'documentation',
        );
        const statusErrorCount = aiReview?.documentationStatus === 'application_mismatch' &&
          !hasDocumentationFinding
          ? 1
          : 0;
        const grammarCount = findings.filter(
          (finding) => finding.kind !== 'documentation' && finding.kind !== 'validation',
        ).length;
        const documentationCount =
          findings.filter((finding) => finding.kind === 'documentation').length +
          statusErrorCount;
        const validationCount = findings.filter(
          (finding) => finding.kind === 'validation',
        ).length;
        return {
          ...result,
          aiReview,
          findings,
          grammarCount,
          documentationCount,
          validationCount,
          errorCount:
            findings.filter((finding) => finding.severity === 'error').length + statusErrorCount,
          warningCount: findings.filter((finding) => finding.severity === 'warning').length,
        };
      }),
    [aiResponse, results],
  );
  const validationMetrics = useMemo(
    () => {
      const errors = reviewedResults.reduce((total, result) => total + result.errorCount, 0);
      const warnings = reviewedResults.reduce((total, result) => total + result.warningCount, 0);
      const needFix = reviewedResults.filter(
        (result) => result.errorCount > 0 || result.warningCount > 0,
      ).length;

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
          label: 'Needs revision',
          submission: 'Not ready to submit',
          description: `This batch contains ${validationMetrics.errors} error${validationMetrics.errors === 1 ? '' : 's'} that must be fixed before submission. Review the affected rubrics below.`,
          badgeClass: 'border-rose-500/25 bg-rose-500/12 text-rose-300',
          submissionClass: 'border-rose-500/20 bg-rose-500/8 text-rose-200',
        }
      : validationMetrics.outcome === 'warning'
        ? {
            label: 'Passed with warnings',
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
  const selectedBatch = batchKey ? BATCHES[batchKey] : null;
  const hasInput = Boolean(jsonInput.trim());
  const hasFormValue = Boolean(application || batchKey || hasInput);
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
    () => (batchKey ? buildBatchSummary(liveInput.rubrics, batchKey) : null),
    [batchKey, liveInput.rubrics],
  );
  const failedBatchChecks =
    liveBatchSummary?.checks.filter((check) => !check.pass) ?? [];
  const batchRequirementsMet = Boolean(
    batchKey && liveBatchSummary?.checks.every((check) => check.pass),
  );
  const canValidate = Boolean(
    application &&
      batchKey &&
      hasInput &&
      liveInput.formatErrors.length === 0 &&
      batchRequirementsMet &&
      !isRunning,
  );

  function updateJsonInput(value: string) {
    setJsonInput(value);
    setResults([]);
    setAiResponse(null);
    setAiStatus('idle');
    setAiError('');
  }

  async function loadProvidedExample() {
    const response = await fetch('/sample-rubrics.json');
    const text = await response.text();
    updateJsonInput(text);
    setApplication('quickbooks');

    const inferredBatchKey = inferBatchKeyFromJson(text);
    if (inferredBatchKey) setBatchKey(inferredBatchKey);
  }

  function reset() {
    setApplication(null);
    setBatchKey(null);
    setJsonInput('');
    setResults([]);
    setAiResponse(null);
    setAiStatus('idle');
    setAiError('');
  }

  async function runValidation() {
    setAiError('');
    setAiResponse(null);

    if (!application || !batchKey) return;

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
    window.requestAnimationFrame(() => {
      const loadingPanel = document.getElementById('validation-progress');
      loadingPanel?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      });
    });

    try {
      const initialResponse = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          application,
          batch: batchKey,
          rubrics,
        }),
      });
      const completedValidation = await waitForCompletedValidation(initialResponse);
      const response = completedValidation.response;
      let payload = completedValidation.payload;

      if (!response.ok) {
        throw new Error(payload.error || 'AI documentation review is unavailable.');
      }

      const rubricReviews = payload.rubricReviews;
      if (
        !Array.isArray(rubricReviews) ||
        rubrics.some((_, index) => !rubricReviews.some((review) => review.index === index))
      ) {
        throw new Error('The AI review returned incomplete results. Validation was not completed.');
      }

      let correctionTargets = collectCorrectionTargets(rubrics, rubricReviews);
      let correctionRepairAttempt = 0;

      while (
        correctionTargets.length > 0 &&
        correctionRepairAttempt < MAX_CORRECTION_REPAIR_ATTEMPTS
      ) {
        correctionRepairAttempt += 1;
        const repairInitialResponse = await fetch('/api/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'repair_corrections',
            application,
            batch: batchKey,
            rubrics,
            targets: correctionTargets,
          }),
        });
        const repairResult = await waitForCompletedValidation(repairInitialResponse);
        if (!repairResult.response.ok) break;

        const corrections = repairResult.payload.corrections;
        if (!Array.isArray(corrections)) break;

        payload = mergeCorrectionPatches(
          payload,
          correctionTargets,
          corrections,
        );
        correctionTargets = collectCorrectionTargets(
          rubrics,
          payload.rubricReviews || [],
        );
      }

      const validatedResults = rubrics.map((rubric, index) => ({
        index,
        rubric,
        issues: [
          ...validateRubric(rubric),
          ...validateApplicationMatch(rubric, application),
        ],
      }));

      setResults(validatedResults);
      setAiResponse(payload as AiResponse);
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
    const correctedRubrics = reviewedResults.map((result) =>
      applyFindingCorrections(
        result.rubric,
        result.aiReview?.correctedRubric,
        result.findings,
      ),
    );
    await navigator.clipboard.writeText(JSON.stringify(correctedRubrics, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function copyCorrectedRubric(index: number, rubric: RubricRecord) {
    await navigator.clipboard.writeText(JSON.stringify(rubric, null, 2));
    setCopiedRubricIndex(index);
    window.setTimeout(() => {
      setCopiedRubricIndex((currentIndex) => currentIndex === index ? null : currentIndex);
    }, 1800);
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
              <strong className="block text-sm tracking-tight">{PRODUCT_TITLE}</strong>
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
            className="cursor-default rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-[#06251a] hover:bg-emerald-400 active:bg-emerald-400"
          >
            Validate Rubrics
          </button>
        </nav>

        <section className="mt-8 max-w-3xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">
            Feather Rubric QA
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            Validate feather rubrics
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
            Check batch requirements, JSON structure, tags, section prefixes, and reproduction steps.
            Grammar-review every field, then validate only feature-request capabilities against current documentation.
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
                    Feature requests are checked for documented capabilities, while bugs receive grammar review only.
                    Section names, UI placement, and locations are never validated against documentation.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-300">
                  Application <span className="text-rose-400">*</span>
                </span>
                <Combobox
                  items={APPLICATIONS}
                  value={application}
                  onValueChange={(value) => {
                    const nextApplication =
                      value && APPLICATIONS.includes(value as Application)
                        ? (value as Application)
                        : null;
                    setApplication(nextApplication);
                    setResults([]);
                    setAiResponse(null);
                    setAiStatus('idle');
                    setAiError('');
                  }}
                >
                  <div ref={applicationComboboxAnchor} className="w-full">
                    <ComboboxInput
                      aria-label="Search supported applications"
                      aria-required="true"
                      required
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
                <span className="mb-2 block text-xs font-medium text-zinc-300">
                  Batch requirements <span className="text-rose-400">*</span>
                </span>
                <Select
                  value={batchKey}
                  onValueChange={(value) => {
                    const nextBatchKey =
                      value && value in BATCHES ? (value as BatchKey) : null;
                    setBatchKey(nextBatchKey);
                    setResults([]);
                    setAiResponse(null);
                    setAiStatus('idle');
                    setAiError('');
                  }}
                >
                  <SelectTrigger
                    aria-label="Batch requirements"
                    aria-required="true"
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
                  {selectedBatch
                    ? `${selectedBatch.bugs} bugs minimum · ${selectedBatch.features} feature requests minimum`
                    : 'Select a batch or paste JSON to detect it automatically'}
                </span>
              </label>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0d1013]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">
                    Rubrics JSON array <span className="text-rose-400">*</span>
                  </p>
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
                aria-required="true"
                required
                value={jsonInput}
                onChange={(event) => updateJsonInput(event.target.value)}
                placeholder={'[\n  {\n    "criterion": "Home: observable issue",\n    "score": 10,\n    "tags": ["bug"],\n    "forms": { ... }\n  }\n]'}
                spellCheck={false}
                className="h-[430px] min-h-[430px] max-h-[430px] resize-none overflow-y-auto rounded-none border-0 bg-transparent p-5 font-mono text-[12px] leading-6 text-zinc-300 shadow-none focus-visible:ring-0"
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

            {hasInput && liveBatchSummary && !batchRequirementsMet && (
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
                disabled={isRunning || !hasFormValue}
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
                  <p className="mt-1 text-xs text-zinc-500">
                    {selectedBatch?.label ?? 'No batch selected'}
                  </p>
                </div>
                {hasInput && selectedBatch && (
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
                {liveBatchSummary ? liveBatchSummary.checks.map((check) => (
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
                )) : (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-zinc-600">
                    Select a batch or paste a complete JSON array to view its requirements.
                  </div>
                )}
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
                      className="flex min-w-0 max-w-full items-start gap-2 overflow-hidden text-xs leading-5 text-indigo-300 hover:text-indigo-200"
                    >
                      <ExternalLink className="mt-0.5 size-3 shrink-0" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {source.title || source.url}
                      </span>
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </aside>
        </div>

        {isRunning && (
          <section
            id="validation-progress"
            role="status"
            aria-live="polite"
            aria-busy="true"
            className="mt-10 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-white/8 bg-[#090b0e] px-6 py-12 text-center"
          >
            <Loader2 aria-hidden="true" className="size-14 animate-spin text-indigo-400" strokeWidth={2.25} />
            <h2 className="mt-7 text-xl font-semibold tracking-tight text-zinc-100 sm:text-2xl">
              {PRODUCT_NAME} is validating {application} rubrics…
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 sm:text-base">
              Grammar review and feature-capability documentation checks may take several minutes.
            </p>
          </section>
        )}

        {aiStatus === 'ready' && aiResponse && application && liveBatchSummary && results.length > 0 && (
          <section
            id="validation-results"
            className="mt-10 scroll-mt-6 border-t border-white/8 pt-8"
          >
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
                  ? 'Needs revision'
                  : hasWarnings
                    ? 'Passed with warnings'
                    : 'Valid';
                const statusClass = hasErrors
                  ? 'border-rose-500/25 bg-rose-500/10 text-rose-300'
                  : hasWarnings
                    ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                    : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
                const declaredTag = result.rubric.tags[0]?.toLowerCase() || 'untagged';
                const tagClass = declaredTag === 'bug'
                  ? 'border-orange-400/25 bg-orange-400/10 text-orange-200'
                  : 'border-indigo-400/20 bg-indigo-400/[0.08] text-indigo-200';
                const criterionSection =
                  result.aiReview?.criterionSection || result.rubric.criterion.split(':')[0] || 'Unknown';
                const hasCorrectedRubric = rubricHasChanges(
                  result.rubric,
                  result.aiReview?.correctedRubric,
                );

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
                            <Badge className={'border text-[10px] ' + tagClass}>{declaredTag}</Badge>
                            <span className="text-xs text-zinc-600">
                              {result.errorCount} errors · {result.warningCount} warnings
                            </span>
                            {(hasErrors || hasWarnings) && (
                              <>
                                <Badge className="border border-sky-400/20 bg-sky-400/10 text-[10px] text-sky-200">
                                  Grammar {result.grammarCount}
                                </Badge>
                                <Badge className="border border-indigo-400/20 bg-indigo-400/10 text-[10px] text-indigo-200">
                                  Documentation {result.documentationCount}
                                </Badge>
                                <Badge className="border border-violet-400/20 bg-violet-400/10 text-[10px] text-violet-200">
                                  Validation {result.validationCount}
                                </Badge>
                              </>
                            )}
                          </div>
                          <p className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-zinc-200">
                            {result.rubric.criterion || 'Missing criterion'}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-4">
                        <div className="hidden text-right md:block">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Criterion section</p>
                          <p
                            className="mt-1 text-xs font-medium text-zinc-300"
                          >
                            {criterionSection}
                          </p>
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
                        <HighlightedFieldValue
                          value={result.rubric.criterion}
                          correctedValue={result.aiReview?.correctedRubric.criterion}
                          field="criterion"
                          findings={result.findings}
                          className="mt-2 text-sm leading-6 text-zinc-200"
                        />
                        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs text-zinc-500">
                          <p>Declared tag: <strong className="text-zinc-300">{result.rubric.tags.join(', ') || 'missing'}</strong></p>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Page or workflow</p>
                          <HighlightedFieldValue
                            value={result.rubric.forms.page_or_workflow}
                            correctedValue={result.aiReview?.correctedRubric.forms.page_or_workflow}
                            field="page_or_workflow"
                            findings={result.findings}
                            className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                          />
                        </div>
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Reproduction steps</p>
                          <HighlightedFieldValue
                            value={result.rubric.forms.reproduction_steps}
                            correctedValue={result.aiReview?.correctedRubric.forms.reproduction_steps}
                            field="reproduction_steps"
                            findings={result.findings}
                            className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                          />
                        </div>
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Expected behavior</p>
                          <HighlightedFieldValue
                            value={result.rubric.forms.expected_behavior}
                            correctedValue={result.aiReview?.correctedRubric.forms.expected_behavior}
                            field="expected_behavior"
                            findings={result.findings}
                            className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                          />
                        </div>
                        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Actual behavior</p>
                          <HighlightedFieldValue
                            value={result.rubric.forms.actual_behavior}
                            correctedValue={result.aiReview?.correctedRubric.forms.actual_behavior}
                            field="actual_behavior"
                            findings={result.findings}
                            className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Documentation review</p>
                          {result.aiReview && (
                            <Badge className={docsBadge(result.aiReview.documentationStatus)}>
                              {docsStatusLabel(result.aiReview.documentationStatus)}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-3 rounded-xl border border-white/7 bg-white/[0.02] p-4 text-xs leading-5 text-zinc-400">
                          {result.aiReview?.documentationSummary}
                        </p>
                      </div>

                      {result.findings.length > 0 ? (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Findings and corrections</p>
                          <div className="mt-3 space-y-2">
                            {result.findings.map((finding, findingIndex) => {
                              const correctedText = correctedTextForFinding(
                                finding,
                                result.rubric,
                                result.aiReview?.correctedRubric,
                              );
                              const recommendedChange = exactRecommendedChange(
                                finding,
                                result.rubric,
                                result.aiReview?.correctedRubric,
                              );

                              return (
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
                                  <Badge
                                    className={
                                      finding.kind === 'documentation'
                                        ? 'border border-indigo-400/20 bg-indigo-400/10 text-indigo-200'
                                        : finding.kind === 'validation'
                                          ? 'border border-violet-400/20 bg-violet-400/10 text-violet-200'
                                        : 'border border-sky-400/20 bg-sky-400/10 text-sky-200'
                                    }
                                  >
                                    {finding.kind === 'documentation'
                                      ? 'Documentation'
                                      : finding.kind === 'validation'
                                        ? 'Validation'
                                        : 'Grammar'}
                                  </Badge>
                                  <Badge className="bg-white/5 font-mono text-[10px] text-zinc-400">{finding.field}</Badge>
                                  {typeof finding.lineNumber === 'number' && (
                                    <Badge className="bg-white/5 font-mono text-[10px] text-zinc-400">
                                      line {finding.lineNumber}
                                    </Badge>
                                  )}
                                  <strong className={finding.severity === 'error' ? 'text-xs text-rose-100' : 'text-xs text-amber-100'}>
                                    {finding.message}
                                  </strong>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-zinc-400">
                                  <span className="font-medium text-zinc-300">Recommended change:</span> {recommendedChange}
                                </p>
                                {correctedText && (
                                  <div className="mt-3 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-2">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/80">
                                      Corrected rubric
                                    </p>
                                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-emerald-100">
                                      {correctedText}
                                    </p>
                                  </div>
                                )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : !hasErrors && !hasWarnings ? (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Findings and corrections</p>
                          <div className="mt-3 flex gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 text-sm text-emerald-300">
                            <CheckCircle2 className="size-4 shrink-0" />
                            No changes requested for this rubric.
                          </div>
                        </div>
                      ) : null}

                      {result.findings.length > 0 && hasCorrectedRubric && result.aiReview?.correctedRubric && (
                        <details className="relative rounded-xl border border-indigo-400/15 bg-indigo-400/[0.035]">
                          <summary className="cursor-pointer list-none py-3 pr-36 pl-4 text-xs font-medium text-indigo-200">
                            View corrected JSON preview
                          </summary>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Copy corrected JSON for rubric ${result.index + 1}`}
                            onClick={() => copyCorrectedRubric(result.index, result.aiReview!.correctedRubric)}
                            className="absolute top-1.5 right-2 h-8 text-xs text-indigo-300 hover:bg-indigo-400/10 hover:text-indigo-200"
                          >
                            {copiedRubricIndex === result.index ? <Check /> : <Copy />}
                            {copiedRubricIndex === result.index ? 'Copied' : 'Copy JSON'}
                          </Button>
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
