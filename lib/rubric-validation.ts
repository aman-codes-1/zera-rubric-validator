import { getSupportedApplication } from './applications.mjs';

export type BatchKey = 'Batch A' | 'Batch B' | 'Batch C';
type IssueSeverity = 'error' | 'warning';
export type IssueKind = 'grammar' | 'documentation' | 'validation';

export type RubricRecord = {
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

export type Issue = {
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

export type BatchSummary = {
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

export type AiReview = {
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

export type AiResponse = {
  applicationBrief: string;
  applicationsReviewed: Array<{
    id: string;
    name: string;
    role: 'selected' | 'detected_in_rubrics';
    officialDomains: string[];
    documentationSources: Array<{ title: string; url: string }>;
  }>;
  rubricReviews: AiReview[];
  sources: Array<{
    title: string;
    url: string;
    application?: string | null;
  }>;
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

export const BATCHES: Record<
  BatchKey,
  { label: string; total: number; bugs: number; features: number }
> = {
  'Batch A': {
    label: 'Batch A · 20 rubrics (5 + 10 + 5)',
    total: 20,
    bugs: 5,
    features: 10,
  },
  'Batch B': {
    label: 'Batch B · 20 rubrics (3 + 3 + 14)',
    total: 20,
    bugs: 3,
    features: 3,
  },
  'Batch C': {
    label: 'Batch C · 10 rubrics (3 + 3 + 4)',
    total: 10,
    bugs: 3,
    features: 3,
  },
};

const VALID_TAGS = new Set(['bug', 'feature request']);
const DOCUMENTATION_AI_FIELDS = new Set([
  'criterion',
  'expected_behavior',
  'actual_behavior',
]);
export const MAX_CORRECTION_REPAIR_ATTEMPTS = 3;
const RUBRIC_KEYS = ['criterion', 'score', 'tags', 'forms'] as const;
const FORM_KEYS = [
  'page_or_workflow',
  'reproduction_steps',
  'expected_behavior',
  'actual_behavior',
] as const;

export class JsonFormatError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super('The JSON does not match the required rubric format.');
    this.name = 'JsonFormatError';
    this.issues = issues;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
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

  if (
    'criterion' in value &&
    (typeof value.criterion !== 'string' || !value.criterion.trim())
  ) {
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
          (typeof forms[key] !== 'string' ||
            (key !== 'reproduction_steps' && !forms[key].trim()))
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

export function normalizeRubric(value: unknown): RubricRecord {
  const record =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const formsValue =
    record.forms && typeof record.forms === 'object'
      ? (record.forms as Record<string, unknown>)
      : {};
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
    : [];

  return {
    criterion: readString(record.criterion),
    score:
      typeof record.score === 'number' && Number.isFinite(record.score)
        ? record.score
        : null,
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

export function validateRubric(rubric: RubricRecord): Issue[] {
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
      suggestion:
        'Start with the relevant section and a colon, for example: “Invoice: The "Edit" action should be enabled.”',
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
      suggestion:
        'Use “bug” for bugs or “feature request” for feature requests.',
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

  if (
    tag === 'bug' &&
    rubric.forms.reproduction_steps &&
    !validateOrderedSteps(rubric.forms.reproduction_steps)
  ) {
    const invalidStep = firstInvalidOrderedStep(
      rubric.forms.reproduction_steps,
    );
    issues.push({
      kind: 'validation',
      field: 'reproduction_steps',
      severity: 'error',
      message:
        'Bug reproduction steps must be an uninterrupted ordered list starting at 1.',
      suggestion:
        'Use 1., 2., 3. and continue without skipped or repeated numbers.',
      correctedText: correctedOrderedSteps(rubric.forms.reproduction_steps),
      excerpt: invalidStep?.excerpt || rubric.forms.reproduction_steps,
      lineNumber: invalidStep?.lineNumber || 1,
    });
  }

  if (tag === 'feature request' && rubric.forms.reproduction_steps !== 'N/A') {
    issues.push({
      kind: 'validation',
      field: 'reproduction_steps',
      severity: 'error',
      message:
        'Feature-request reproduction steps must be exactly “N/A” (case-sensitive, with no extra whitespace or content).',
      suggestion: 'Set reproduction_steps to exactly “N/A”.',
      correctedText: 'N/A',
      excerpt: rubric.forms.reproduction_steps,
      lineNumber: 1,
    });
  }

  const genericExpectedOutcome =
    tag === 'feature request'
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
      message:
        'Expected behavior ends with a generic workflow description instead of a specific, user-observable result.',
      suggestion:
        'Replace the generic workflow phrase with the concrete action or outcome stated in the selected application’s official documentation.',
      excerpt: genericExpectedOutcome[0],
      lineNumber: 1,
    });
  }

  return issues;
}

export function buildBatchSummary(
  rubrics: RubricRecord[],
  key: BatchKey,
): BatchSummary {
  const requirement = BATCHES[key];
  const bugs = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === 'bug',
  ).length;
  const features = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 &&
      rubric.tags[0].toLowerCase() === 'feature request',
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

export function parseInput(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new JsonFormatError([
      'The JSON array or object syntax is incorrect. Check brackets, braces, commas, and quotation marks.',
    ]);
  }

  return parseRubrics(parsed);
}

function parseRubrics(parsed: unknown) {
  if (!Array.isArray(parsed)) {
    throw new JsonFormatError([
      'The top-level JSON value must be an array of rubric objects.',
    ]);
  }
  if (parsed.length === 0) {
    throw new JsonFormatError([
      'The top-level array must contain at least one rubric object.',
    ]);
  }

  const issues = parsed.flatMap(validateRubricFormat);
  if (issues.length) {
    const shownIssues = issues.slice(0, 15);
    if (issues.length > shownIssues.length) {
      shownIssues.push(
        `${issues.length - shownIssues.length} additional format issue(s) were found.`,
      );
    }
    throw new JsonFormatError(shownIssues);
  }

  return parsed.map(normalizeRubric);
}

export function rubricFieldValue(
  rubric: RubricRecord | undefined,
  field: string,
) {
  if (!rubric) return '';
  if (field === 'criterion') return rubric.criterion;
  if (field === 'score')
    return rubric.score === null ? '' : String(rubric.score);
  if (field === 'tag') return rubric.tags.join(', ');
  if (field === 'page_or_workflow') return rubric.forms.page_or_workflow;
  if (field === 'reproduction_steps') return rubric.forms.reproduction_steps;
  if (field === 'expected_behavior') return rubric.forms.expected_behavior;
  if (field === 'actual_behavior') return rubric.forms.actual_behavior;
  return '';
}

export function correctedTextForFinding(
  finding: Issue,
  originalRubric: RubricRecord,
  correctedRubric: RubricRecord | undefined,
) {
  const originalText = rubricFieldValue(originalRubric, finding.field);
  const findingCorrection = finding.correctedText?.trim() || '';
  if (findingCorrection && findingCorrection !== originalText) {
    return findingCorrection;
  }

  const rubricCorrection = rubricFieldValue(
    correctedRubric,
    finding.field,
  ).trim();
  return rubricCorrection && rubricCorrection !== originalText
    ? rubricCorrection
    : '';
}

export function applyFindingCorrections(
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
    if (finding.field === 'page_or_workflow')
      nextRubric.forms.page_or_workflow = correctedText;
    if (finding.field === 'reproduction_steps')
      nextRubric.forms.reproduction_steps = correctedText;
    if (finding.field === 'expected_behavior')
      nextRubric.forms.expected_behavior = correctedText;
    if (finding.field === 'actual_behavior')
      nextRubric.forms.actual_behavior = correctedText;
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
  if (field === 'reproduction_steps')
    nextRubric.forms.reproduction_steps = value;
  if (field === 'expected_behavior') nextRubric.forms.expected_behavior = value;
  if (field === 'actual_behavior') nextRubric.forms.actual_behavior = value;

  return nextRubric;
}

export function collectCorrectionTargets(
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

export function mergeCorrectionPatches(
  payload: AiResponse,
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
    rubricReviews: payload.rubricReviews.map((review) => {
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

export function isFeatureRequest(rubric: RubricRecord) {
  return (
    rubric.tags.length === 1 &&
    rubric.tags[0].toLowerCase() === 'feature request'
  );
}

function isObjectiveGrammarFinding(finding: Issue, rubric: RubricRecord) {
  const description = `${finding.message} ${finding.suggestion}`.toLowerCase();
  const fieldValue = rubricFieldValue(rubric, finding.field);
  const hasAdjacentDuplicateWord = /\b([a-z]+)\s+\1\b/i.test(fieldValue);

  if (
    /\b(repetitive|repetition|repeats?|redundant|wordy|wordiness)\b/.test(
      description,
    )
  ) {
    return hasAdjacentDuplicateWord;
  }

  if (
    /\b(sentence case|capitalization|capitalisation|stylistic|style|tone|formal|informal|contraction|concise|shorten|simplify|streamline|awkward|parallel|parallelism|natural phrasing|more natural|clearer|clarity|consistency|unnecessarily|wording improvement)\b/.test(
      description,
    )
  ) {
    return false;
  }

  if (
    finding.field === 'page_or_workflow' &&
    /\b(fragment|complete sentence|terminal punctuation|sentence punctuation)\b/.test(
      description,
    )
  ) {
    return false;
  }

  return true;
}

export function isAllowedAiFinding(
  finding: Issue,
  rubric: RubricRecord,
  documentationStatus?: AiReview['documentationStatus'],
) {
  if (isFeatureRequest(rubric) && finding.field === 'reproduction_steps') {
    return false;
  }
  if (finding.kind === 'grammar') {
    return (
      finding.field !== 'documentation' &&
      isObjectiveGrammarFinding(finding, rubric)
    );
  }
  if (finding.kind === 'documentation') {
    if (documentationStatus === 'application_mismatch') return true;
    return (
      documentationStatus === 'supported' &&
      isFeatureRequest(rubric) &&
      DOCUMENTATION_AI_FIELDS.has(finding.field)
    );
  }
  return false;
}

export type ValidationInput = {
  application: string;
  batch: BatchKey;
  rubrics: RubricRecord[];
};

export function prepareValidationInput(value: unknown): ValidationInput {
  if (!isObject(value)) throw new Error('Provide a validation batch.');

  const application =
    typeof value.application === 'string' ? value.application.trim() : '';
  if (!getSupportedApplication(application))
    throw new Error('Select a valid application.');

  const batch = value.batch;
  if (typeof batch !== 'string' || !Object.hasOwn(BATCHES, batch)) {
    throw new Error('Select valid batch requirements.');
  }

  const rubrics = parseRubrics(value.rubrics);
  const selectedBatch = batch as BatchKey;
  if (
    !buildBatchSummary(rubrics, selectedBatch).checks.every(
      (check) => check.pass,
    )
  ) {
    throw new Error(
      'The submitted rubrics do not meet the batch requirements.',
    );
  }
  return { application, batch: selectedBatch, rubrics };
}

const CORRECTION_FIELDS = new Set(['criterion', 'tag', ...FORM_KEYS]);
const DOCUMENTATION_STATUSES = new Set([
  'supported',
  'unclear',
  'not_found',
  'not_applicable',
  'application_mismatch',
]);

function isReviewFinding(value: unknown): value is Issue {
  return (
    isObject(value) &&
    (value.kind === 'grammar' || value.kind === 'documentation') &&
    (value.severity === 'error' || value.severity === 'warning') &&
    typeof value.field === 'string' &&
    CORRECTION_FIELDS.has(value.field) &&
    typeof value.message === 'string' &&
    typeof value.suggestion === 'string' &&
    typeof value.excerpt === 'string' &&
    typeof value.correctedText === 'string' &&
    (value.lineNumber === null || Number.isInteger(value.lineNumber))
  );
}

function isReviewedRubric(value: unknown): value is RubricRecord {
  if (!isObject(value) || !isObject(value.forms)) return false;
  const forms = value.forms;
  return (
    typeof value.criterion === 'string' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    FORM_KEYS.every((key) => typeof forms[key] === 'string')
  );
}

export function isCompleteReview(
  value: unknown,
  rubricCount: number,
): value is AiResponse {
  if (
    !isObject(value) ||
    typeof value.applicationBrief !== 'string' ||
    !Array.isArray(value.applicationsReviewed) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.rubricReviews) ||
    value.rubricReviews.length !== rubricCount
  )
    return false;

  const indices = new Set<unknown>();
  for (const review of value.rubricReviews) {
    if (
      !isObject(review) ||
      typeof review.index !== 'number' ||
      !Number.isInteger(review.index) ||
      review.index < 0 ||
      review.index >= rubricCount ||
      indices.has(review.index) ||
      typeof review.criterionSection !== 'string' ||
      typeof review.documentationStatus !== 'string' ||
      !DOCUMENTATION_STATUSES.has(review.documentationStatus) ||
      typeof review.documentationSummary !== 'string' ||
      !Array.isArray(review.findings) ||
      !review.findings.every(isReviewFinding) ||
      !isReviewedRubric(review.correctedRubric)
    )
      return false;
    indices.add(review.index);
  }
  return true;
}

export function readCorrectionPatches(
  value: unknown,
): CorrectionPatch[] | null {
  if (!isObject(value) || !Array.isArray(value.corrections)) return null;

  const patches = [];
  for (const patch of value.corrections) {
    if (
      isObject(patch) &&
      typeof patch.index === 'number' &&
      Number.isInteger(patch.index) &&
      typeof patch.field === 'string' &&
      CORRECTION_FIELDS.has(patch.field) &&
      typeof patch.correctedText === 'string'
    ) {
      patches.push({
        index: patch.index,
        field: patch.field,
        correctedText: patch.correctedText,
      });
    }
  }
  return patches;
}
