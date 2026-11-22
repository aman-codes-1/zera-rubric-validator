"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { InputGroupAddon } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PRODUCT_NAME, PRODUCT_TITLE } from "@/lib/constants.mjs";
import {
  SUPPORTED_APPLICATION_IDS,
  SUPPORTED_APPLICATIONS,
  detectSupportedApplications,
  getSupportedApplication,
} from "@/lib/applications.mjs";

import {
  BATCHES,
  JsonFormatError,
  applyFindingCorrections,
  buildBatchSummary,
  correctedTextForFinding,
  isAllowedAiFinding,
  isFeatureRequest,
  isObject,
  normalizeRubric,
  parseInput,
  rubricFieldValue,
  validateRubric,
  type AiResponse,
  type AiReview,
  type BatchKey,
  type BatchSummary,
  type Issue,
  type RubricRecord,
} from "@/lib/rubric-validation";

import {
  createValidationJobClient,
  initialValidationJobState,
  isActiveJob,
} from "@/lib/validation-job-client";

type Application = string;

type RubricResult = {
  index: number;
  rubric: RubricRecord;
  issues: Issue[];
};

function inferBatchKeyFromJson(value: string): BatchKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isObject)
  ) {
    return null;
  }

  const rubrics = parsed.map(normalizeRubric);
  const candidates = (Object.keys(BATCHES) as BatchKey[]).filter(
    (key) => BATCHES[key].total === rubrics.length,
  );

  if (candidates.length === 0) return null;

  const bugs = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 && rubric.tags[0].toLowerCase() === "bug",
  ).length;
  const features = rubrics.filter(
    (rubric) =>
      rubric.tags.length === 1 &&
      rubric.tags[0].toLowerCase() === "feature request",
  ).length;

  const rankedCandidates = candidates.sort((leftKey, rightKey) => {
    const left = BATCHES[leftKey];
    const right = BATCHES[rightKey];
    const leftPasses = bugs >= left.bugs && features >= left.features;
    const rightPasses = bugs >= right.bugs && features >= right.features;

    if (leftPasses !== rightPasses) return leftPasses ? -1 : 1;

    const leftDeficit =
      Math.max(0, left.bugs - bugs) + Math.max(0, left.features - features);
    const rightDeficit =
      Math.max(0, right.bugs - bugs) + Math.max(0, right.features - features);

    if (leftDeficit !== rightDeficit) return leftDeficit - rightDeficit;

    return right.bugs + right.features - (left.bugs + left.features);
  });

  return rankedCandidates[0];
}

function batchFailureMessage(
  check: BatchSummary["checks"][number],
  summary: BatchSummary,
) {
  if (check.label === "Rubrics") {
    const difference = check.target - check.current;
    return difference > 0
      ? `Rubrics: ${check.current}/${check.target}. Add ${difference}.`
      : `Rubrics: ${check.current}/${check.target}. Remove ${Math.abs(difference)}.`;
  }

  if (check.label === "Valid single tags") {
    const rubricsCheck = summary.checks.find(
      (item) => item.label === "Rubrics",
    );
    if (rubricsCheck && !rubricsCheck.pass) {
      return `Valid single tags: ${check.current}/${check.target}.`;
    }
    return `Valid single tags: ${check.current}/${check.target}. Add 1.`;
  }

  return `${check.label}: ${check.current}/${check.target} minimum. Add ${Math.max(0, check.target - check.current)}.`;
}


function docsBadge(status: AiReview["documentationStatus"]) {
  if (status === "supported")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "application_mismatch")
    return "border-rose-500/30 bg-rose-500/10 text-rose-300";
  if (status === "not_applicable")
    return "border-white/10 bg-white/[0.04] text-zinc-400";
  return "border-white/10 bg-white/[0.04] text-zinc-400";
}

function docsStatusLabel(status: AiReview["documentationStatus"]) {
  if (status === "not_found") return "not found · skipped";
  if (status === "unclear") return "unclear · skipped";
  return status.replaceAll("_", " ");
}

function messageWithReferenceLinks(message: string) {
  const references: Array<{ title: string; url: string }> = [];
  const addReference = (title: string, url: string) => {
    if (!references.some((reference) => reference.url === url)) {
      references.push({ title, url });
    }
  };
  const text = message
    .replace(
      /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g,
      (_match, title: string, url: string) => {
        addReference(title, url);
        return "";
      },
    )
    .replace(/https?:\/\/[^\s<>"']+/g, (rawUrl) => {
      const url = rawUrl.replace(/[),.;!?]+$/g, "");
      let title = "Reference document";
      try {
        title = new URL(url).hostname;
      } catch {
        return rawUrl;
      }
      addReference(title, url);
      return rawUrl.slice(url.length);
    })
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { text, references };
}

function fallbackDocumentationReferences(
  rubric: RubricRecord,
  findingMessage: string,
  selectedApplicationId: string,
  documentationStatus: AiReview["documentationStatus"] | undefined,
  response: AiResponse | null,
) {
  if (!response) return [];

  const selectedApplication = getSupportedApplication(selectedApplicationId);
  const detectedApplications = detectSupportedApplications([
    findingMessage,
    rubric,
  ]);
  const referencedApplication =
    documentationStatus === "application_mismatch"
      ? detectedApplications.find(
          (candidate) => candidate.id !== selectedApplication?.id,
        )
      : detectedApplications.find(
          (candidate) => candidate.id === selectedApplication?.id,
        ) || detectedApplications[0];
  const targetApplication = referencedApplication || selectedApplication;
  if (!targetApplication) return [];

  const reviewedApplication = response.applicationsReviewed.find(
    (candidate) => candidate.id === targetApplication.id,
  );
  const attributedSources = response.sources.filter((source) => {
    if (source.application === targetApplication.label) return true;
    try {
      const hostname = new URL(source.url).hostname.toLowerCase();
      return (reviewedApplication?.officialDomains || []).some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
    } catch {
      return false;
    }
  });
  const sources = [
    ...(reviewedApplication?.documentationSources || []),
    ...attributedSources,
  ];
  const source = sources.find(
    (candidate, index) =>
      candidate.url &&
      sources.findIndex((item) => item.url === candidate.url) === index,
  ) || (response.applicationsReviewed.length === 1 ? response.sources[0] : null);

  return source ? [{ title: source.title, url: source.url }] : [];
}

function displayedDocumentationSources(
  sources: AiResponse["sources"],
  applicationsReviewed: AiResponse["applicationsReviewed"],
) {
  const selected: AiResponse["sources"] = [];
  const seen = new Set<string>();

  for (const application of applicationsReviewed) {
    const source = sources.find(
      (candidate) =>
        candidate.application === application.name && !seen.has(candidate.url),
    );
    if (source) {
      selected.push(source);
      seen.add(source.url);
    }
  }

  for (const source of sources) {
    if (selected.length >= 8) break;
    if (!seen.has(source.url)) {
      selected.push(source);
      seen.add(source.url);
    }
  }

  return selected;
}

function rubricHasChanges(
  original: RubricRecord,
  corrected: RubricRecord | undefined,
) {
  return (
    Boolean(corrected) && JSON.stringify(original) !== JSON.stringify(corrected)
  );
}


function changedTextRange(
  original: string,
  corrected: string,
): [number, number] | null {
  if (!original || original === corrected) return null;

  let start = 0;
  while (
    start < original.length &&
    start < corrected.length &&
    original[start] === corrected[start]
  ) {
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
      return "";
    }

    const location = lineNumber ? `On line ${lineNumber}, ` : "";
    if (originalFragment && correctedFragment) {
      return `${location}${lineNumber ? "replace" : "Replace"} ${JSON.stringify(originalFragment)} with ${JSON.stringify(correctedFragment)}.`;
    }
    if (!originalFragment && correctedFragment) {
      return `${location}${lineNumber ? "insert" : "Insert"} ${JSON.stringify(correctedFragment)} at the highlighted location.`;
    }
    if (originalFragment && !correctedFragment) {
      return `${location}${lineNumber ? "remove" : "Remove"} ${JSON.stringify(originalFragment)} from the highlighted location.`;
    }
    return "";
  };

  const originalLines = completeOriginalText.split("\n");
  const correctedLines = completeCorrectedText.split("\n");
  if (
    originalLines.length > 1 &&
    originalLines.length === correctedLines.length
  ) {
    const lineChanges = originalLines.flatMap((originalLine, index) => {
      const correctedLine = correctedLines[index];
      if (originalLine === correctedLine) return [];
      const instruction = describeChange(
        originalLine,
        correctedLine,
        index + 1,
      );
      return instruction ? [instruction] : [];
    });
    if (lineChanges.length > 0) return lineChanges.join(" ");
  }

  const completeInstruction = describeChange(
    completeOriginalText,
    completeCorrectedText,
  );
  if (completeInstruction) return completeInstruction;

  return "Replace the highlighted text with the complete corrected rubric shown below.";
}

function locateFinding(
  finding: Issue,
  rubric: RubricRecord,
  correctedRubric: RubricRecord | undefined,
): Issue {
  const originalValue = rubricFieldValue(rubric, finding.field);
  if (!originalValue) return finding;

  const correctedValue = rubricFieldValue(correctedRubric, finding.field);
  const originalLines = originalValue.split("\n");
  const correctedLines = correctedValue.split("\n");
  let lineNumber = finding.lineNumber;
  const changedLine = originalLines.findIndex(
    (line, index) => line !== (correctedLines[index] ?? line),
  );

  if (changedLine >= 0) {
    lineNumber = changedLine + 1;
  } else if (
    typeof lineNumber !== "number" ||
    lineNumber < 1 ||
    lineNumber > originalLines.length
  ) {
    const excerpt = finding.excerpt?.trim().toLowerCase();
    const excerptLine = excerpt
      ? originalLines.findIndex((line) => line.toLowerCase().includes(excerpt))
      : -1;

    lineNumber =
      excerptLine >= 0
        ? excerptLine + 1
        : originalLines.length === 1
          ? 1
          : null;
  }

  let excerpt = finding.excerpt?.trim() || "";
  if (typeof lineNumber === "number") {
    const originalLine = originalLines[lineNumber - 1] || "";
    const correctedLine = correctedLines[lineNumber - 1] ?? originalLine;
    const range = changedTextRange(originalLine, correctedLine);
    if (range) {
      excerpt = originalLine.slice(range[0], range[1]).trim();
    } else if (!excerpt) {
      excerpt = originalLine.trim();
    }
  }

  const correctedText =
    finding.correctedText?.trim() ||
    (correctedValue && correctedValue !== originalValue ? correctedValue : "");

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
  const lines = value.split("\n");
  const correctedLines = correctedValue?.split("\n") || [];
  const fieldFindings = findings.filter((finding) => finding.field === field);

  return (
    <div className={className}>
      {lines.map((line, lineIndex) => {
        const lineNumber = lineIndex + 1;
        const hasEmbeddedLineNumber = /^\s*\d+[.)]\s+/.test(line);
        const lineFindings = fieldFindings.filter((finding) => {
          if (typeof finding.lineNumber === "number") {
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
          .find(
            (excerpt) =>
              excerpt && line.toLowerCase().includes(excerpt.toLowerCase()),
          );
        const excerptStart = exactExcerpt
          ? line.toLowerCase().indexOf(exactExcerpt.toLowerCase())
          : -1;
        const excerptRange: [number, number] | null =
          excerptStart >= 0 && exactExcerpt
            ? [excerptStart, excerptStart + exactExcerpt.length]
            : null;
        const correctedLine = correctedLines[lineIndex] ?? line;
        const diffRange = changedTextRange(line, correctedLine);
        const severityFindings =
          lineFindings.length > 0
            ? lineFindings
            : diffRange
              ? fieldFindings
              : [];
        const hasError = severityFindings.some(
          (finding) => finding.severity === "error",
        );
        const hasWarning = severityFindings.some(
          (finding) => finding.severity === "warning",
        );
        const highlightRange =
          severityFindings.length === 0 ? null : diffRange || excerptRange;
        const highlightClass = hasError
          ? "rounded bg-rose-500/25 px-0.5 text-rose-100 ring-1 ring-inset ring-rose-400/35"
          : "rounded bg-amber-500/25 px-0.5 text-amber-100 ring-1 ring-inset ring-amber-400/35";

        return (
          <span
            key={`${field}-${lineNumber}`}
            className={
              "block rounded-md px-2 py-1 [overflow-wrap:anywhere] " +
              (!highlightRange && hasError
                ? "bg-rose-500/15 text-rose-100 ring-1 ring-inset ring-rose-500/25"
                : !highlightRange && hasWarning
                  ? "bg-amber-500/15 text-amber-100 ring-1 ring-inset ring-amber-500/25"
                  : "")
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
                  {line.slice(highlightRange[0], highlightRange[1]) || " "}
                </mark>
                {line.slice(highlightRange[1])}
              </>
            ) : (
              line || " "
            )}
          </span>
        );
      })}
    </div>
  );
}

export default function Home() {
  const applicationComboboxAnchor = useComboboxAnchor();
  const [application, setApplication] = useState<Application | null>(null);
  const [batchKey, setBatchKey] = useState<BatchKey | null>(null);
  const [jsonInput, setJsonInput] = useState("");
  const client = useRef<ReturnType<typeof createValidationJobClient> | null>(null);
  const [validation, setValidation] = useState(initialValidationJobState);
  const job = validation.job;
  const input = job?.input;
  const isRunning = Boolean(validation.command || isActiveJob(job));
  const isRepairing = isActiveJob(job) && job.phase === "repair";
  const isCancelling = validation.command === "cancel";
  const successfulJob = job?.status === "completed" ? job : null;
  const aiResponse = successfulJob?.result ?? null;
  const aiError = validation.error || (job?.status === "failed" ? job.error : "");
  const aiStatus = isRunning ? "researching" : job?.status ?? "idle";
  const results = useMemo<RubricResult[]>(() =>
    successfulJob?.input.rubrics.map((rubric, index) => ({
      index, rubric, issues: validateRubric(rubric),
    })) ?? [], [successfulJob]);
  const [copied, setCopied] = useState(false);
  const [copiedRubricIndex, setCopiedRubricIndex] = useState<number | null>(
    null,
  );

  useEffect(() => {
    const connection = createValidationJobClient(setValidation);
    client.current = connection;
    connection.connect();
    return () => {
      connection.disconnect();
      client.current = null;
    };
  }, []);

  useEffect(() => {
    if (!input) return;
    setApplication(input.application);
    setBatchKey(input.batch);
    setJsonInput(JSON.stringify(input.rubrics, null, 2));
  }, [input]);

  useEffect(() => {
    if (aiStatus !== "completed" || !aiResponse || results.length === 0) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        document.getElementById("validation-results")?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "start",
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
        const responseReview = aiResponse?.rubricReviews.find(
          (review) => review.index === result.index,
        );
        const normalizedReview =
          responseReview &&
          !isFeatureRequest(result.rubric) &&
          responseReview.documentationStatus !== "application_mismatch"
            ? {
                ...responseReview,
                documentationStatus: "not_applicable" as const,
                documentationSummary:
                  "Documentation review is not applicable to bug rubrics. Grammar review only.",
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
          .map((finding) =>
            normalizedReview?.documentationStatus === "application_mismatch" &&
            finding.kind === "documentation"
              ? {
                  ...finding,
                  code: "application_mismatch" as const,
                  severity: "error" as const,
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
          (finding) => finding.kind === "documentation",
        );
        const statusErrorCount =
          aiReview?.documentationStatus === "application_mismatch" &&
          !hasDocumentationFinding
            ? 1
            : 0;
        const grammarCount = findings.filter(
          (finding) =>
            finding.kind !== "documentation" && finding.kind !== "validation",
        ).length;
        const documentationCount =
          findings.filter((finding) => finding.kind === "documentation")
            .length + statusErrorCount;
        const validationCount = findings.filter(
          (finding) => finding.kind === "validation",
        ).length;
        return {
          ...result,
          aiReview,
          findings,
          grammarCount,
          documentationCount,
          validationCount,
          errorCount:
            findings.filter((finding) => finding.severity === "error").length +
            statusErrorCount,
          warningCount: findings.filter(
            (finding) => finding.severity === "warning",
          ).length,
        };
      }),
    [aiResponse, results],
  );
  const validationMetrics = useMemo(() => {
    const errors = reviewedResults.reduce(
      (total, result) => total + result.errorCount,
      0,
    );
    const warnings = reviewedResults.reduce(
      (total, result) => total + result.warningCount,
      0,
    );
    const needFix = reviewedResults.filter(
      (result) => result.errorCount > 0 || result.warningCount > 0,
    ).length;

    return {
      errors,
      warnings,
      needFix,
      valid: reviewedResults.length - needFix,
      outcome: errors > 0 ? "failed" : warnings > 0 ? "warning" : "pass",
    } as const;
  }, [reviewedResults]);
  const outcomePresentation =
    validationMetrics.outcome === "failed"
      ? {
          label: "Needs revision",
          submission: "Not ready to submit",
          description: `This batch contains ${validationMetrics.errors} error${validationMetrics.errors === 1 ? "" : "s"} that must be fixed before submission. Review the affected rubrics below.`,
          badgeClass: "border-rose-500/25 bg-rose-500/12 text-rose-300",
          submissionClass: "border-rose-500/20 bg-rose-500/8 text-rose-200",
        }
      : validationMetrics.outcome === "warning"
        ? {
            label: "Passed with warnings",
            submission: "Review before submit",
            description: `This batch passes the required rules, but has ${validationMetrics.warnings} warning${validationMetrics.warnings === 1 ? "" : "s"} to review before submission.`,
            badgeClass: "border-amber-500/25 bg-amber-500/12 text-amber-300",
            submissionClass:
              "border-amber-500/20 bg-amber-500/8 text-amber-200",
          }
        : {
            label: "Pass",
            submission: "Ready to submit",
            description: `This batch meets the required rubric rules for ${application}. No changes are required before submission.`,
            badgeClass:
              "border-emerald-500/25 bg-emerald-500/12 text-emerald-300",
            submissionClass:
              "border-emerald-500/20 bg-emerald-500/8 text-emerald-200",
          };
  const documentationSources = useMemo(
    () =>
      displayedDocumentationSources(
        aiResponse?.sources || [],
        aiResponse?.applicationsReviewed || [],
      ),
    [aiResponse],
  );
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
            : [
                error instanceof Error
                  ? error.message
                  : "The JSON could not be parsed.",
              ],
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
    !isRunning && validation.ready && !validation.reconnecting,
  );

  function updateJsonInput(value: string) {
    if (!client.current?.dismiss()) return;
    setJsonInput(value);
  }

  async function loadProvidedExample() {
    const response = await fetch("/sample-rubrics.json");
    const text = await response.text();
    if (!client.current?.dismiss()) return;
    setJsonInput(text);
    setApplication("quickbooks");

    const inferredBatchKey = inferBatchKeyFromJson(text);
    if (inferredBatchKey) setBatchKey(inferredBatchKey);
  }

  function reset() {
    if (!client.current?.dismiss()) return;
    setApplication(null);
    setBatchKey(null);
    setJsonInput("");
  }

  function runValidation() {
    if (!canValidate || !application || !batchKey) return;
    if (!client.current?.submit({ application, batch: batchKey, rubrics: liveInput.rubrics })) return;

    window.requestAnimationFrame(() => {
      document.getElementById("validation-progress")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  }

  async function copyCorrectedJson() {
    const correctedRubrics = reviewedResults.map((result) =>
      applyFindingCorrections(
        result.rubric,
        result.aiReview?.correctedRubric,
        result.findings,
      ),
    );
    await navigator.clipboard.writeText(
      JSON.stringify(correctedRubrics, null, 2),
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function copyCorrectedRubric(index: number, rubric: RubricRecord) {
    await navigator.clipboard.writeText(JSON.stringify(rubric, null, 2));
    setCopiedRubricIndex(index);
    window.setTimeout(() => {
      setCopiedRubricIndex((currentIndex) =>
        currentIndex === index ? null : currentIndex,
      );
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
              <strong className="block text-sm tracking-tight">
                {PRODUCT_TITLE}
              </strong>
              <span className="block text-xs text-zinc-500">
                Documentation-grounded rubric QA
              </span>
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
            onClick={() => document.getElementById("rubrics-json")?.focus()}
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
            Check batch requirements, JSON structure, tags, section prefixes,
            and reproduction steps. Grammar-review every field, then validate
            only feature-request capabilities against current documentation.
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
                    Feature requests are checked for documented capabilities,
                    while bugs receive grammar review only. Section names, UI
                    placement, and locations are never validated against
                    documentation.
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
                  items={SUPPORTED_APPLICATION_IDS}
                  value={application}
                  disabled={isRunning}
                  onValueChange={(value) => {
                    if (!client.current?.dismiss()) return;
                    const nextApplication =
                      value && getSupportedApplication(value) ? value : null;
                    setApplication(nextApplication);
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
                      <InputGroupAddon
                        align="inline-start"
                        className="pl-3 pr-0 text-zinc-500"
                      >
                        <Search aria-hidden="true" className="size-4" />
                      </InputGroupAddon>
                    </ComboboxInput>
                  </div>
                  <ComboboxContent
                    anchor={applicationComboboxAnchor}
                    className="border border-white/10 bg-[#101317] p-1 text-zinc-100 shadow-2xl ring-0"
                  >
                    <ComboboxEmpty className="py-3 text-zinc-500">
                      No application found.
                    </ComboboxEmpty>
                    <ComboboxList>
                      {(item: Application) => (
                        <ComboboxItem
                          key={item}
                          value={item}
                          className="min-h-9 px-3 font-mono data-highlighted:bg-indigo-400/15 data-highlighted:text-indigo-100"
                        >
                          {getSupportedApplication(item)?.label || item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <span className="mt-2 block text-xs text-zinc-600">
                  {SUPPORTED_APPLICATIONS.length} supported applications
                </span>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-300">
                  Batch requirements <span className="text-rose-400">*</span>
                </span>
                <Select
                  value={batchKey}
                  disabled={isRunning}
                  onValueChange={(value) => {
                    if (!client.current?.dismiss()) return;
                    const nextBatchKey =
                      value && value in BATCHES ? (value as BatchKey) : null;
                    setBatchKey(nextBatchKey);
                  }}
                >
                  <SelectTrigger
                    aria-label="Batch requirements"
                    aria-required="true"
                    className="h-11 w-full rounded-xl border-white/10 bg-[#101317] px-3 text-zinc-100 shadow-none hover:bg-[#13171b] focus-visible:border-emerald-400/50 focus-visible:ring-emerald-400/10 data-[size=default]:h-11"
                  >
                    <ShieldCheck
                      aria-hidden="true"
                      className="size-4 text-zinc-500"
                    />
                    <SelectValue>
                      {(value: BatchKey | null) =>
                        value
                          ? BATCHES[value].label
                          : "Select batch requirements"
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
                    : "Select a batch or paste JSON to detect it automatically"}
                </span>
              </label>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0d1013]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">
                    Rubrics JSON array <span className="text-rose-400">*</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Paste the full batch as a JSON array.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadProvidedExample}
                    disabled={isRunning}
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
                readOnly={isRunning}
                onChange={(event) => updateJsonInput(event.target.value)}
                placeholder={
                  '[\n  {\n    "criterion": "Home: observable issue",\n    "score": 10,\n    "tags": ["bug"],\n    "forms": { ... }\n  }\n]'
                }
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
                    Match the structure of the provided rubric JSON file and fix
                    the following:
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
                      <p key={check.label}>
                        {batchFailureMessage(check, liveBatchSummary)}
                      </p>
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
                {isRunning ? "Validating" : "Validate Rubrics"}
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
                    {selectedBatch?.label ?? "No batch selected"}
                  </p>
                </div>
                {hasInput && selectedBatch && (
                  <Badge
                    className={
                      batchRequirementsMet
                        ? "bg-emerald-400/10 text-emerald-300"
                        : "bg-rose-400/10 text-rose-300"
                    }
                  >
                    {batchRequirementsMet ? "Passed" : "Needs work"}
                  </Badge>
                )}
              </div>

              <div className="mt-4 space-y-2">
                {liveBatchSummary ? (
                  liveBatchSummary.checks.map((check) => (
                    <div
                      key={check.label}
                      className="flex items-center justify-between gap-4 rounded-xl border border-white/7 bg-white/[0.02] px-3.5 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-zinc-300">
                          {check.label}
                        </p>
                        <p className="mt-0.5 text-[11px] text-zinc-600">
                          {check.detail}
                        </p>
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
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-zinc-600">
                    Select a batch or paste a complete JSON array to view its
                    requirements.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0d1013] p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-indigo-400/10 text-indigo-300">
                  {aiStatus === "researching" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Bot className="size-4" />
                  )}
                </span>
                <div>
                  <p className="text-sm font-medium">Application knowledge</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {aiStatus === "idle" && "Waiting for a batch"}
                    {aiStatus === "researching" &&
                      (isRepairing
                        ? "Preparing suggested corrections"
                        : "Searching product documentation")}
                    {aiStatus === "completed" && "Documentation context ready"}
                    {aiStatus === "failed" && "AI review unavailable"}
                    {aiStatus === "cancelled" && "Validation cancelled"}
                  </p>
                </div>
              </div>

              {aiResponse?.applicationBrief && (
                <p className="mt-4 text-xs leading-5 text-zinc-400">
                  {aiResponse.applicationBrief}
                </p>
              )}

              {aiResponse?.applicationsReviewed?.length ? (
                <div className="mt-4 border-t border-white/8 pt-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                    Applications reviewed
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {aiResponse.applicationsReviewed.map(
                      (reviewedApplication) => (
                        <Badge
                          key={`${reviewedApplication.role}-${reviewedApplication.name}`}
                          className={
                            reviewedApplication.role === "selected"
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              : "border-indigo-400/30 bg-indigo-400/10 text-indigo-200"
                          }
                        >
                          {reviewedApplication.name}
                          {reviewedApplication.role === "selected"
                            ? " · selected"
                            : " · found in rubrics"}
                        </Badge>
                      ),
                    )}
                  </div>
                </div>
              ) : null}

              {validation.reconnecting && !isRunning && (
                <output className="mt-4 block text-xs text-amber-300">
                  Reconnecting to the validation server…
                </output>
              )}

              {successfulJob?.warning && (
                <output className="mt-4 block text-xs text-amber-300">
                  {successfulJob.warning}
                </output>
              )}

              {aiError && (
                <div role="alert" className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-xs leading-5 text-amber-200">
                  {aiError}
                </div>
              )}

              {documentationSources.length ? (
                <div className="mt-4 space-y-2 border-t border-white/8 pt-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                    Documentation sources
                  </p>
                  {documentationSources.map((source) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 max-w-full items-start gap-2 overflow-hidden text-xs leading-5 text-indigo-300 hover:text-indigo-200"
                    >
                      <ExternalLink className="mt-0.5 size-3 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          {source.application ? (
                            <span className="mr-1.5 inline-flex rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                              {source.application}
                            </span>
                          ) : null}
                          <span className="[overflow-wrap:anywhere]">
                            {source.title || "Official documentation"}
                          </span>
                        </span>
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
            aria-label="Validation progress"
            className="mt-10 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-white/8 bg-[#090b0e] px-6 py-12 text-center"
          >
            <Loader2
              aria-hidden="true"
              className="size-14 animate-spin text-indigo-400"
              strokeWidth={2.25}
            />
            <h2 className="mt-7 text-xl font-semibold tracking-tight text-zinc-100 sm:text-2xl">
              {isCancelling
                ? "Cancelling validation…"
                : `${PRODUCT_NAME} is validating ${application || "your"} rubrics…`}
            </h2>
            <output className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 sm:text-base">
              {validation.reconnecting
                ? "Reconnecting to the validation server…"
                : isRepairing
                  ? "Preparing suggested corrections."
                  : "Grammar review and feature-capability documentation checks may take several minutes."}
            </output>
            {isActiveJob(job) && (
              <Button
                variant="outline"
                className="mt-5"
                disabled={isCancelling}
                onClick={() => client.current?.cancel()}
              >
                Cancel validation
              </Button>
            )}
          </section>
        )}

        {aiStatus === "completed" &&
          aiResponse &&
          application &&
          liveBatchSummary &&
          results.length > 0 && (
            <section
              id="validation-results"
              className="mt-10 scroll-mt-6 border-t border-white/8 pt-8"
            >
              <div className="rounded-2xl border border-white/10 bg-[#0d1013] p-5 sm:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        className={
                          "border px-3 py-1 text-xs font-semibold uppercase tracking-wide " +
                          outcomePresentation.badgeClass
                        }
                      >
                        {outcomePresentation.label}
                      </Badge>
                      <Badge
                        className={
                          "border px-3 py-1 text-xs " +
                          outcomePresentation.submissionClass
                        }
                      >
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
                    {copied ? "Corrected JSON copied" : "Copy corrected JSON"}
                  </Button>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
                {[
                  {
                    label: "Rubrics",
                    value: liveBatchSummary.total,
                    color: "text-zinc-100",
                  },
                  {
                    label: "Bugs",
                    value: liveBatchSummary.bugs,
                    color: "text-rose-300",
                  },
                  {
                    label: "Feature requests",
                    value: liveBatchSummary.features,
                    color: "text-indigo-300",
                  },
                  {
                    label: "Valid",
                    value: validationMetrics.valid,
                    color: "text-emerald-300",
                  },
                  {
                    label: "Need fix",
                    value: validationMetrics.needFix,
                    color: "text-amber-300",
                  },
                  {
                    label: "Errors",
                    value: validationMetrics.errors,
                    color: "text-rose-300",
                  },
                  {
                    label: "Warnings",
                    value: validationMetrics.warnings,
                    color: "text-amber-300",
                  },
                ].map((metric) => (
                  <div
                    key={metric.label}
                    className="rounded-2xl border border-white/10 bg-[#0d1013] px-4 py-5 text-center"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                      {metric.label}
                    </p>
                    <p
                      className={
                        "mt-2 text-3xl font-semibold tabular-nums " +
                        metric.color
                      }
                    >
                      {metric.value}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-600">
                    Validation report
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                    Rubric results
                  </h2>
                </div>
                <p className="hidden text-xs text-zinc-600 sm:block">
                  Select a rubric to inspect every check
                </p>
              </div>

              <div className="mt-5 space-y-3">
                {reviewedResults.map((result) => {
                  const hasErrors = result.errorCount > 0;
                  const hasWarnings = result.warningCount > 0;
                  const statusLabel = hasErrors
                    ? "Needs revision"
                    : hasWarnings
                      ? "Passed with warnings"
                      : "Valid";
                  const statusClass = hasErrors
                    ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
                    : hasWarnings
                      ? "border-amber-500/25 bg-amber-500/10 text-amber-300"
                      : "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
                  const declaredTag =
                    result.rubric.tags[0]?.toLowerCase() || "untagged";
                  const tagClass =
                    "border-indigo-400/20 bg-indigo-400/[0.08] text-indigo-200";
                  const criterionSection =
                    result.aiReview?.criterionSection ||
                    result.rubric.criterion.split(":")[0] ||
                    "Unknown";
                  const hasCorrectedRubric = rubricHasChanges(
                    result.rubric,
                    result.aiReview?.correctedRubric,
                  );

                  return (
                    <details
                      key={result.index}
                      className="group overflow-hidden rounded-2xl border border-white/10 bg-[#0d1013]"
                    >
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-5">
                        <div className="flex min-w-0 gap-3">
                          <span
                            className={
                              "mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl " +
                              (hasErrors
                                ? "bg-rose-500/10 text-rose-300"
                                : hasWarnings
                                  ? "bg-amber-500/10 text-amber-300"
                                  : "bg-emerald-500/10 text-emerald-300")
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
                              <span className="font-mono text-xs text-zinc-500">
                                #{result.index + 1}
                              </span>
                              <Badge
                                className={"border text-[10px] " + statusClass}
                              >
                                {statusLabel}
                              </Badge>
                              <Badge
                                className={"border text-[10px] " + tagClass}
                              >
                                {declaredTag}
                              </Badge>
                              {result.errorCount > 0 ? (
                                <Badge
                                  className={
                                    "border text-[10px] " +
                                    (hasErrors
                                      ? "border-rose-500/25 bg-rose-500/10 text-rose-200"
                                      : "border-white/10 bg-white/[0.04] text-zinc-600")
                                  }
                                >
                                  {result.errorCount} {result.errorCount === 1 ? "error" : "errors"}
                                </Badge>
                              ) : null}
                              {result.warningCount > 0 ? (
                                <Badge
                                  className={
                                    "border text-[10px] " +
                                    (hasWarnings
                                      ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
                                      : "border-white/10 bg-white/[0.04] text-zinc-600")
                                  }
                                >
                                  {result.warningCount} {result.warningCount === 1
                                    ? "warning"
                                    : "warnings"}
                                </Badge>
                              ) : null}
                              {(hasErrors || hasWarnings) && (
                                <>
                                  <Badge className="border border-sky-300/55 bg-sky-400/20 text-[10px] text-sky-100 shadow-[0_0_14px_rgba(56,189,248,0.1)]">
                                    Grammar {result.grammarCount}
                                  </Badge>
                                  <Badge className="border border-lime-300/65 bg-lime-500/20 text-[10px] text-lime-50 shadow-[0_0_14px_rgba(132,204,22,0.16)]">
                                    Documentation {result.documentationCount}
                                  </Badge>
                                  <Badge className="border border-fuchsia-300/65 bg-fuchsia-500/25 text-[10px] text-fuchsia-50 shadow-[0_0_14px_rgba(217,70,239,0.16)]">
                                    Validation {result.validationCount}
                                  </Badge>
                                </>
                              )}
                            </div>
                            <p className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-zinc-200">
                              {result.rubric.criterion || "Missing criterion"}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-4">
                          <div className="hidden text-right md:block">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Criterion section
                            </p>
                            <p className="mt-1 text-xs font-semibold text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.18)]">
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
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                            Criterion
                          </p>
                          <HighlightedFieldValue
                            value={result.rubric.criterion}
                            correctedValue={
                              result.aiReview?.correctedRubric.criterion
                            }
                            field="criterion"
                            findings={result.findings}
                            className="mt-2 text-sm leading-6 text-zinc-200"
                          />
                          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs text-zinc-500">
                            <p>
                              Declared tag:{" "}
                              <strong className="text-zinc-300">
                                {result.rubric.tags.join(", ") || "missing"}
                              </strong>
                            </p>
                          </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Page or workflow
                            </p>
                            <HighlightedFieldValue
                              value={result.rubric.forms.page_or_workflow}
                              correctedValue={
                                result.aiReview?.correctedRubric.forms
                                  .page_or_workflow
                              }
                              field="page_or_workflow"
                              findings={result.findings}
                              className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                            />
                          </div>
                          <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Reproduction steps
                            </p>
                            <HighlightedFieldValue
                              value={result.rubric.forms.reproduction_steps}
                              correctedValue={
                                result.aiReview?.correctedRubric.forms
                                  .reproduction_steps
                              }
                              field="reproduction_steps"
                              findings={result.findings}
                              className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                            />
                          </div>
                          <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Expected behavior
                            </p>
                            <HighlightedFieldValue
                              value={result.rubric.forms.expected_behavior}
                              correctedValue={
                                result.aiReview?.correctedRubric.forms
                                  .expected_behavior
                              }
                              field="expected_behavior"
                              findings={result.findings}
                              className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                            />
                          </div>
                          <div className="rounded-xl border border-white/7 bg-white/[0.02] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Actual behavior
                            </p>
                            <HighlightedFieldValue
                              value={result.rubric.forms.actual_behavior}
                              correctedValue={
                                result.aiReview?.correctedRubric.forms
                                  .actual_behavior
                              }
                              field="actual_behavior"
                              findings={result.findings}
                              className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300"
                            />
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                              Documentation review
                            </p>
                            {result.aiReview && (
                              <Badge
                                className={docsBadge(
                                  result.aiReview.documentationStatus,
                                )}
                              >
                                {docsStatusLabel(
                                  result.aiReview.documentationStatus,
                                )}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-3 rounded-xl border border-white/7 bg-white/[0.02] p-4 text-xs leading-5 text-zinc-400">
                            {result.aiReview?.documentationSummary}
                          </p>
                        </div>

                        {result.findings.length > 0 ? (
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                              Findings and corrections
                            </p>
                            <div className="mt-3 space-y-2">
                              {result.findings.map((finding, findingIndex) => {
                                const correctedText = correctedTextForFinding(
                                  finding,
                                  result.rubric,
                                  result.aiReview?.correctedRubric,
                                );
                                const recommendedChange =
                                  exactRecommendedChange(
                                    finding,
                                    result.rubric,
                                    result.aiReview?.correctedRubric,
                                  );
                                const displayedMessage =
                                  messageWithReferenceLinks(finding.message);
                                const referenceLinks =
                                  displayedMessage.references.length > 0
                                    ? displayedMessage.references
                                    : finding.kind === "documentation"
                                      ? fallbackDocumentationReferences(
                                          result.rubric,
                                          finding.message,
                                          application,
                                          result.aiReview?.documentationStatus,
                                          aiResponse,
                                        )
                                      : [];

                                return (
                                  <div
                                    key={`${finding.field}-${findingIndex}`}
                                    className={
                                      "rounded-xl border p-4 " +
                                      (finding.severity === "error"
                                        ? "border-rose-500/20 bg-rose-500/[0.06]"
                                        : "border-amber-500/20 bg-amber-500/[0.06]")
                                    }
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge
                                        className={
                                          finding.severity === "error"
                                            ? "bg-rose-500/15 text-rose-200"
                                            : "bg-amber-500/15 text-amber-200"
                                        }
                                      >
                                        {finding.severity}
                                      </Badge>
                                      <Badge
                                        className={
                                          finding.kind === "documentation"
                                            ? "border border-lime-300/65 bg-lime-500/20 text-lime-50 shadow-[0_0_14px_rgba(132,204,22,0.16)]"
                                            : finding.kind === "validation"
                                              ? "border border-fuchsia-300/65 bg-fuchsia-500/25 text-fuchsia-50 shadow-[0_0_14px_rgba(217,70,239,0.16)]"
                                              : "border border-sky-300/55 bg-sky-400/20 text-sky-100 shadow-[0_0_14px_rgba(56,189,248,0.1)]"
                                        }
                                      >
                                        {finding.kind === "documentation"
                                          ? "Documentation"
                                          : finding.kind === "validation"
                                            ? "Validation"
                                            : "Grammar"}
                                      </Badge>
                                      <Badge className="bg-white/5 font-mono text-[10px] text-zinc-400">
                                        {finding.field}
                                      </Badge>
                                      {typeof finding.lineNumber ===
                                        "number" && (
                                        <Badge className="bg-white/5 font-mono text-[10px] text-zinc-400">
                                          line {finding.lineNumber}
                                        </Badge>
                                      )}
                                      <strong
                                        className={
                                          finding.severity === "error"
                                            ? "text-xs text-rose-100"
                                            : "text-xs text-amber-100"
                                        }
                                      >
                                        {displayedMessage.text}
                                      </strong>
                                      {referenceLinks.map(
                                        (reference, referenceIndex) => (
                                          <a
                                            key={reference.url}
                                            href={reference.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            title={reference.title}
                                            className="inline-flex items-center gap-1 rounded-md border border-indigo-400/25 bg-indigo-400/10 px-2 py-1 text-[10px] font-medium text-indigo-200 transition-colors hover:border-indigo-300/40 hover:bg-indigo-400/15 hover:text-indigo-100"
                                          >
                                            <ExternalLink className="size-3" />
                                            {referenceLinks.length > 1
                                              ? `Open reference doc ${referenceIndex + 1}`
                                              : "Open reference doc"}
                                          </a>
                                        ),
                                      )}
                                    </div>
                                    <p className="mt-2 text-xs leading-5 text-zinc-400">
                                      <span className="font-medium text-zinc-300">
                                        Recommended change:
                                      </span>{" "}
                                      {recommendedChange}
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
                            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                              Findings and corrections
                            </p>
                            <div className="mt-3 flex gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 text-sm text-emerald-300">
                              <CheckCircle2 className="size-4 shrink-0" />
                              No changes requested for this rubric.
                            </div>
                          </div>
                        ) : null}

                        {result.findings.length > 0 &&
                          hasCorrectedRubric &&
                          result.aiReview?.correctedRubric && (
                            <details className="relative rounded-xl border border-indigo-400/15 bg-indigo-400/[0.035]">
                              <summary className="cursor-pointer list-none py-3 pr-36 pl-4 text-xs font-medium text-indigo-200">
                                View corrected JSON preview
                              </summary>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Copy corrected JSON for rubric ${result.index + 1}`}
                                onClick={() =>
                                  copyCorrectedRubric(
                                    result.index,
                                    result.aiReview!.correctedRubric,
                                  )
                                }
                                className="absolute top-1.5 right-2 h-8 text-xs text-indigo-300 hover:bg-indigo-400/10 hover:text-indigo-200"
                              >
                                {copiedRubricIndex === result.index ? (
                                  <Check />
                                ) : (
                                  <Copy />
                                )}
                                {copiedRubricIndex === result.index
                                  ? "Copied"
                                  : "Copy JSON"}
                              </Button>
                              <pre className="overflow-x-auto border-t border-indigo-400/10 p-4 font-mono text-[11px] leading-5 text-zinc-400">
                                {JSON.stringify(
                                  result.aiReview.correctedRubric,
                                  null,
                                  2,
                                )}
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
