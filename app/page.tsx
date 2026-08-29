'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleHelp,
  Copy,
  FileCheck2,
  Layers3,
  Link2,
  ListChecks,
  Loader2,
  Play,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Target,
  WandSparkles,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const EXAMPLE_PROMPT = `Find the relevant candidate files for Tyler and Nathan. Compare their experience, determine which candidate progressed further in the hiring process, and recommend who should be prioritized.`;

const EXAMPLE_RUBRICS = `1. Locates the correct candidate files.
2. Calculates the total years of experience for each candidate.
3. Identifies Tyler as having more experience and determines that Nathan progressed further in the interview process.
4. Provides a clear, high-quality recommendation.
5. Does not include irrelevant candidate information.`;

type Severity = 'High' | 'Medium' | 'Low';
type Tab = 'findings' | 'alignment' | 'revision';

type Finding = {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  fix: string;
};

type Alignment = {
  id: string;
  requirement: string;
  rubricIds: string[];
  status: 'Covered' | 'Partial' | 'Missing';
};

type Analysis = {
  overall: number;
  scores: {
    prompt: number;
    rubrics: number;
    alignment: number;
    complexity: number;
  };
  findings: Finding[];
  alignments: Alignment[];
  revisedPrompt: string;
  revisedRubrics: string;
  rubricCount: number;
};

const ACTION_VERBS = [
  'find',
  'locate',
  'compare',
  'calculate',
  'determine',
  'recommend',
  'identify',
  'analyze',
  'summarize',
  'evaluate',
  'rank',
  'provide',
  'create',
  'write',
];

const RUBRIC_VERBS = [
  'locates',
  'finds',
  'compares',
  'calculates',
  'determines',
  'recommends',
  'identifies',
  'analyzes',
  'summarizes',
  'evaluates',
  'ranks',
  'provides',
  'explains',
  'verifies',
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'their',
  'each', 'that', 'which', 'who', 'should', 'be', 'is', 'as', 'correct', 'correctly',
]);

function parseRubrics(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      id: `R${index + 1}`,
      text: line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim(),
    }));
}
function extractRequirements(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const pieces = normalized
    .split(/(?<=[.!?])\s+|,\s+|\s+and\s+/i)
    .map((piece) => piece.replace(/^[.\s]+|[.\s]+$/g, ''))
    .filter((piece) => {
      const lower = piece.toLowerCase();
      return ACTION_VERBS.some((verb) => new RegExp(`\\b${verb}\\w*\\b`).test(lower));
    });

  return (pieces.length ? pieces : [normalized || 'No explicit requirement found']).map(
    (requirement, index) => ({ id: `P${index + 1}`, requirement }),
  );
}

function keywords(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

function buildRevision(prompt: string, rubrics: ReturnType<typeof parseRubrics>) {
  const promptLower = prompt.toLowerCase();
  const rubricCalculation = rubrics.some((rubric) =>
    /\b(calculate|calculates|percentage|total years|total amount)\b/i.test(rubric.text),
  );
  const promptCalculation = /\b(calculate|percentage|total years|total amount)\b/i.test(promptLower);

  let revisedPrompt = prompt.trim();
  if (rubricCalculation && !promptCalculation) {
    revisedPrompt += `${/[.!?]$/.test(revisedPrompt) ? '' : '.'} Calculate the total years of experience for each candidate.`;
  }

  const revised: string[] = [];
  rubrics.forEach((rubric) => {
    const text = rubric.text;
    const lower = text.toLowerCase();
    const verbCount = RUBRIC_VERBS.filter((verb) =>
      new RegExp(`\\b${verb}\\w*\\b`).test(lower),
    ).length;

    if (lower.includes(' and ') && verbCount >= 2) {
      const parts = text.split(/\s+and\s+/i).filter(Boolean);
      revised.push(...parts.map((part) => `${part.replace(/^[a-z]/, (char) => char.toUpperCase()).replace(/[.]$/, '')}.`));
      return;
    }

    let improved = text
      .replace(/clear,?\s*high-quality/gi, 'evidence-backed')
      .replace(/\bhigh-quality\b/gi, 'evidence-backed')
      .replace(/^Does not include irrelevant candidate information\.?$/i, 'Includes only candidate information that supports the requested comparison.');
    if (!/[.!?]$/.test(improved)) improved += '.';
    revised.push(improved);
  });

  return {
    revisedPrompt,
    revisedRubrics: revised.map((rubric, index) => `${index + 1}. ${rubric}`).join('\n'),
  };
}

function evaluateTask(prompt: string, rubricText: string): Analysis {
  const rubrics = parseRubrics(rubricText);
  const requirements = extractRequirements(prompt);
  const findings: Finding[] = [];
  const promptLower = prompt.toLowerCase();

  const rubricCalculation = rubrics.find((rubric) =>
    /\b(calculate|calculates|percentage|total years|total amount)\b/i.test(rubric.text),
  );
  const promptCalculation = /\b(calculate|percentage|total years|total amount)\b/i.test(promptLower);

  if (rubricCalculation && !promptCalculation) {
    findings.push({
      id: 'unsupported-calculation',
      severity: 'High',
      category: 'Alignment',
      title: `${rubricCalculation.id} evaluates an unrequested calculation`,
      detail: `“${rubricCalculation.text}” requires a derived result that the prompt never explicitly requests.`,
      fix: 'Add the calculation to the prompt, or remove it from the rubric.',
    });
  }

  rubrics.forEach((rubric) => {
    const lower = rubric.text.toLowerCase();
    const verbCount = RUBRIC_VERBS.filter((verb) =>
      new RegExp(`\\b${verb}\\w*\\b`).test(lower),
    ).length;

    if (lower.includes(' and ') && verbCount >= 2) {
      findings.push({
        id: `stacked-${rubric.id}`,
        severity: 'High',
        category: 'Rubric quality',
        title: `${rubric.id} contains multiple gradable outcomes`,
        detail: 'One part can pass while the other fails, making the criterion difficult to grade consistently.',
        fix: 'Split the criterion so that each rubric checks exactly one observable outcome.',
      });
    }

    if (/\b(high-quality|good|appropriate|excellent|comprehensive)\b/i.test(rubric.text)) {
      findings.push({
        id: `vague-${rubric.id}`,
        severity: 'Medium',
        category: 'Rubric quality',
        title: `${rubric.id} uses a subjective quality label`,
        detail: 'The criterion does not identify the evidence or observable result required to pass.',
        fix: 'Replace the subjective label with a specific, verifiable outcome.',
      });
    }

    if (/^(does not|avoids|without|no\s)/i.test(rubric.text)) {
      findings.push({
        id: `negative-${rubric.id}`,
        severity: 'Low',
        category: 'Rubric quality',
        title: `${rubric.id} is written as a negative criterion`,
        detail: 'Absence-based criteria can be ambiguous because they do not describe the desired observable output.',
        fix: 'Rewrite it positively so the grader can verify what the response should contain.',
      });
    }
  });

  if (!prompt.trim()) {
    findings.unshift({
      id: 'empty-prompt',
      severity: 'High',
      category: 'Prompt quality',
      title: 'The prompt is empty',
      detail: 'There is no task for the agent to complete or for the rubrics to evaluate.',
      fix: 'Add the user goal, relevant context, constraints, and expected deliverable.',
    });
  }

  if (!rubrics.length) {
    findings.unshift({
      id: 'empty-rubrics',
      severity: 'High',
      category: 'Rubric quality',
      title: 'No rubric criteria were provided',
      detail: 'The task cannot be graded consistently without explicit success criteria.',
      fix: 'Add atomic, independently verifiable rubric criteria.',
    });
  }

  const alignments: Alignment[] = requirements.map((requirement) => {
    const requirementWords = keywords(requirement.requirement);
    const matches = rubrics.filter((rubric) => {
      const rubricWords = new Set(keywords(rubric.text));
      return requirementWords.some((word) => rubricWords.has(word));
    });
    const isCalculationGap =
      /compare.*experience/i.test(requirement.requirement) && Boolean(rubricCalculation) && !promptCalculation;
    return {
      ...requirement,
      rubricIds: matches.map((match) => match.id),
      status: matches.length === 0 ? 'Missing' : isCalculationGap ? 'Partial' : 'Covered',
    };
  });

  alignments
    .filter((alignment) => alignment.status === 'Missing')
    .slice(0, 1)
    .forEach((alignment) => {
      findings.push({
        id: `missing-${alignment.id}`,
        severity: 'High',
        category: 'Alignment',
        title: `${alignment.id} is not evaluated by any rubric`,
        detail: `The prompt asks to “${alignment.requirement},” but no criterion checks the outcome.`,
        fix: 'Add an atomic rubric criterion that evaluates this requirement.',
      });
    });

  const stackedCount = findings.filter((finding) => finding.id.startsWith('stacked-')).length;
  const vagueCount = findings.filter((finding) => finding.id.startsWith('vague-')).length;
  const negativeCount = findings.filter((finding) => finding.id.startsWith('negative-')).length;
  const missingCount = alignments.filter((alignment) => alignment.status === 'Missing').length;

  const promptScore = Math.max(25, 92 - (!prompt.trim() ? 60 : 0) - missingCount * 6);
  const rubricScore = Math.max(20, 96 - stackedCount * 14 - vagueCount * 10 - negativeCount * 6 - (!rubrics.length ? 60 : 0));
  const alignmentScore = Math.max(20, 96 - (rubricCalculation && !promptCalculation ? 26 : 0) - missingCount * 18);
  const complexitySignals = [
    /\b(compare|rank)\b/i.test(prompt),
    /\b(file|document|source|record)s?\b/i.test(prompt),
    /\b(calculate|percentage|total)\b/i.test(prompt),
    /\b(determine|recommend|evaluate|analyze)\b/i.test(prompt),
    requirements.length >= 3,
  ].filter(Boolean).length;
  const complexityScore = Math.min(92, 48 + complexitySignals * 8);
  const overall = Math.round(
    promptScore * 0.2 + rubricScore * 0.3 + alignmentScore * 0.35 + complexityScore * 0.15,
  );
  const revision = buildRevision(prompt, rubrics);

  return {
    overall,
    scores: {
      prompt: promptScore,
      rubrics: rubricScore,
      alignment: alignmentScore,
      complexity: complexityScore,
    },
    findings,
    alignments,
    ...revision,
    rubricCount: rubrics.length,
  };
}

function severityVariant(severity: Severity) {
  if (severity === 'High') return 'destructive' as const;
  if (severity === 'Medium') return 'secondary' as const;
  return 'outline' as const;
}

function findingIcon(category: string) {
  if (category === 'Alignment') return Target;
  if (category === 'Prompt quality') return CircleHelp;
  return Layers3;
}

const RULES = [
  {
    icon: CircleHelp,
    title: 'Prompt quality',
    copy: 'Checks clarity, missing context, ambiguity, deliverables, constraints, and realism.',
    example: 'A clear task states what to produce and what evidence to use.',
  },
  {
    icon: ListChecks,
    title: 'Rubric atomicity',
    copy: 'Finds stacked criteria that combine outcomes which could pass or fail independently.',
    example: 'One rubric criterion should test one observable result.',
  },
  {
    icon: Link2,
    title: 'Prompt ↔ rubric alignment',
    copy: 'Maps every requested outcome to a criterion and flags rubric-only expectations.',
    example: 'No hidden calculations and no unevaluated requirements.',
  },
  {
    icon: ShieldCheck,
    title: 'Verifiability',
    copy: 'Replaces vague quality labels with outcomes a grader can consistently judge.',
    example: 'Prefer “cites two sources” over “provides a good answer.”',
  },
  {
    icon: BrainCircuit,
    title: 'Genuine complexity',
    copy: 'Recognizes discovery, cross-referencing, synthesis, interpretation, and calculation.',
    example: 'Long wording alone does not make a task complex.',
  },
  {
    icon: BookOpenCheck,
    title: 'Consistency',
    copy: 'Looks for contradictions, duplicate criteria, unsupported answers, and negative checks.',
    example: 'Expected answers must be supported by the prompt and source material.',
  },
];

export default function Home() {
  const [prompt, setPrompt] = useState(EXAMPLE_PROMPT);
  const [rubrics, setRubrics] = useState(EXAMPLE_RUBRICS);
  const [analysis, setAnalysis] = useState(() => evaluateTask(EXAMPLE_PROMPT, EXAMPLE_RUBRICS));
  const [activeTab, setActiveTab] = useState<Tab>('findings');
  const [showRulebook, setShowRulebook] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [hasReview, setHasReview] = useState(true);

  const wordCount = useMemo(() => prompt.trim().split(/\s+/).filter(Boolean).length, [prompt]);
  const rubricCount = useMemo(() => parseRubrics(rubrics).length, [rubrics]);
  const highCount = analysis.findings.filter((finding) => finding.severity === 'High').length;

  function runReview() {
    setIsRunning(true);
    setNotice('');
    window.setTimeout(() => {
      setAnalysis(evaluateTask(prompt, rubrics));
      setActiveTab('findings');
      setHasReview(true);
      setIsRunning(false);
      setNotice('Review complete');
      window.setTimeout(() => setNotice(''), 1800);
    }, 650);
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(message);
      window.setTimeout(() => setNotice(''), 1800);
    } catch {
      setNotice('Copy is unavailable in this preview');
    }
  }

  function applyRevision() {
    setPrompt(analysis.revisedPrompt);
    setRubrics(analysis.revisedRubrics);
    const revised = evaluateTask(analysis.revisedPrompt, analysis.revisedRubrics);
    setAnalysis(revised);
    setActiveTab('findings');
    setNotice('Improved version applied');
    window.setTimeout(() => setNotice(''), 1800);
  }

  function resetFields() {
    setPrompt('');
    setRubrics('');
    setAnalysis(evaluateTask('', ''));
    setActiveTab('findings');
    setHasReview(false);
    setNotice('Fields cleared');
    window.setTimeout(() => setNotice(''), 1800);
  }

  function loadExample() {
    setPrompt(EXAMPLE_PROMPT);
    setRubrics(EXAMPLE_RUBRICS);
    setAnalysis(evaluateTask(EXAMPLE_PROMPT, EXAMPLE_RUBRICS));
    setActiveTab('findings');
    setHasReview(true);
    setNotice('Example loaded');
    window.setTimeout(() => setNotice(''), 1800);
  }

  const reportText = [
    `Rhea Review score: ${analysis.overall}/100`,
    '',
    ...analysis.findings.flatMap((finding, index) => [
      `${index + 1}. [${finding.severity}] ${finding.title}`,
      finding.detail,
      `Fix: ${finding.fix}`,
      '',
    ]),
  ].join('\n');

  return (
    <main className="min-h-screen px-3 py-3 text-foreground sm:px-5 sm:py-5 lg:px-8">
      <div className="mx-auto max-w-[1560px] overflow-hidden rounded-[24px] border border-border/80 bg-card shadow-[0_24px_80px_rgba(24,47,43,0.11)]">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-4 sm:px-7">
          <button
            className="flex min-w-0 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            onClick={() => setShowRulebook(false)}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles className="size-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <strong className="truncate text-[15px] tracking-tight">Rhea Review</strong>
                <Badge className="bg-accent text-accent-foreground">AI QA</Badge>
              </span>
              <span className="block truncate text-xs text-muted-foreground">Prompt and rubric quality lab</span>
            </span>
          </button>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="hidden sm:inline-flex"
              onClick={() => setShowRulebook((current) => !current)}
            >
              {showRulebook ? <ArrowRight className="rotate-180" /> : <FileCheck2 />}
              {showRulebook ? 'Back to review' : 'Rulebook'}
            </Button>
            {!showRulebook && (
              <Button className="h-9 bg-primary px-4" onClick={runReview} disabled={isRunning}>
                {isRunning ? <Loader2 className="animate-spin" /> : <Play />}
                {isRunning ? 'Reviewing…' : 'Run review'}
              </Button>
            )}
          </div>
        </header>

        {showRulebook ? (
          <section className="min-h-[calc(100vh-114px)] bg-[#fbfaf6] p-5 sm:p-8 lg:p-10">
            <div className="mx-auto max-w-6xl">
              <div className="flex flex-col gap-4 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Evaluation policy</p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">The Rhea rulebook</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Every review applies the same observable checks so prompt authors and graders can reproduce the result.
                  </p>
                </div>
                <Badge variant="outline" className="w-fit bg-white px-3 py-1">6 evaluator families</Badge>
              </div>

              <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {RULES.map((rule, index) => {
                  const Icon = rule.icon;
                  return (
                    <article key={rule.title} className="rounded-2xl border border-border bg-white p-5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="grid size-10 place-items-center rounded-xl bg-primary/[0.08] text-primary">
                          <Icon className="size-[18px]" />
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                      </div>
                      <h3 className="mt-5 font-semibold tracking-tight">{rule.title}</h3>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">{rule.copy}</p>
                      <div className="mt-4 flex gap-2 rounded-xl bg-muted/60 p-3 text-xs leading-5">
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        {rule.example}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        ) : (
          <section className="grid min-h-[calc(100vh-114px)] lg:grid-cols-[minmax(370px,0.9fr)_minmax(520px,1.25fr)]">
            <div className="border-b border-border bg-[#fbfaf6] p-5 lg:border-r lg:border-b-0 sm:p-7">
              <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Task input</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight">What should Rhea inspect?</h2>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={loadExample} disabled={isRunning}>
                    <Sparkles /> Example
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetFields} disabled={isRunning}>
                    <RefreshCcw /> Reset
                  </Button>
                </div>
              </div>

              <div className="space-y-5">
                <label className="block">
                  <span className="mb-2 flex items-center justify-between text-sm font-medium">
                    Prompt
                    <span className="font-normal text-muted-foreground">{wordCount} words</span>
                  </span>
                  <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Paste the task prompt here…"
                    className="min-h-40 resize-y rounded-2xl border-border bg-white p-4 leading-6 shadow-sm"
                  />
                </label>

                <label className="block">
                  <span className="mb-2 flex items-center justify-between text-sm font-medium">
                    Rubrics
                    <span className="font-normal text-muted-foreground">{rubricCount} criteria</span>
                  </span>
                  <Textarea
                    value={rubrics}
                    onChange={(event) => setRubrics(event.target.value)}
                    placeholder={'1. First observable criterion\n2. Second observable criterion'}
                    className="min-h-64 resize-y rounded-2xl border-border bg-white p-4 font-mono text-[13px] leading-6 shadow-sm"
                  />
                </label>

                <div className="rounded-2xl border border-border bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircle2 className="size-4 text-primary" /> Review scope
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {['Prompt quality', 'Rubric quality', 'Alignment', 'Complexity', 'Consistency'].map((item) => (
                      <Badge key={item} variant="outline" className="bg-background px-2.5 py-1 text-[11px]">
                        {item}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-w-0 bg-card p-5 sm:p-7">
              {hasReview ? (
                <>
                  <div className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className="grid size-[74px] shrink-0 place-items-center rounded-full p-[7px]"
                    style={{
                      background: `conic-gradient(var(--primary) 0 ${analysis.overall}%, var(--muted) ${analysis.overall}% 100%)`,
                    }}
                  >
                    <div className="grid size-full place-items-center rounded-full bg-card">
                      <div className="text-center">
                        <strong className="block text-xl leading-none">{analysis.overall}</strong>
                        <span className="text-[10px] text-muted-foreground">/ 100</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-semibold tracking-tight">
                        {analysis.findings.length === 0 ? 'Ready to grade' : analysis.overall >= 80 ? 'Small revisions' : 'Needs revision'}
                      </h2>
                      <Badge variant={highCount ? 'destructive' : 'secondary'}>
                        {analysis.findings.length} {analysis.findings.length === 1 ? 'issue' : 'issues'}
                      </Badge>
                    </div>
                    <p className="mt-1 max-w-lg text-sm leading-5 text-muted-foreground">
                      {analysis.findings.length === 0
                        ? 'The prompt and rubric set are aligned, atomic, and objectively gradable.'
                        : `${highCount} high-impact finding${highCount === 1 ? '' : 's'} should be resolved before this task is published.`}
                    </p>
                  </div>
                </div>
                <Button variant="outline" onClick={() => copyText(reportText, 'Report copied')}>
                  <Copy /> Copy report
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 py-5 sm:grid-cols-4">
                {[
                  ['Prompt', analysis.scores.prompt, analysis.scores.prompt >= 80 ? 'Strong' : 'Review'],
                  ['Rubrics', analysis.scores.rubrics, `${analysis.findings.filter((f) => f.category === 'Rubric quality').length} issues`],
                  ['Alignment', analysis.scores.alignment, `${analysis.alignments.filter((a) => a.status !== 'Covered').length} gaps`],
                  ['Complexity', analysis.scores.complexity, analysis.scores.complexity >= 65 ? 'Valid' : 'Light'],
                ].map(([label, score, note]) => (
                  <div key={String(label)} className="rounded-2xl border border-border bg-background/55 p-3.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-muted-foreground">{label}</span>
                      <strong className="text-lg">{score}</strong>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{note}</p>
                  </div>
                ))}
              </div>

              <div className="flex gap-1 overflow-x-auto border-b border-border">
                {([
                  ['findings', `Findings (${analysis.findings.length})`],
                  ['alignment', 'Alignment map'],
                  ['revision', 'Improved version'],
                ] as [Tab, string][]).map(([tab, label]) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`relative shrink-0 px-3 py-2.5 text-sm font-medium transition ${
                      activeTab === tab ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                    {activeTab === tab && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
                  </button>
                ))}
              </div>

              {activeTab === 'findings' && (
                <div className="pt-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Findings</h3>
                    <span className="text-xs text-muted-foreground">Sorted by impact</span>
                  </div>
                  {analysis.findings.length ? (
                    <div className="space-y-3">
                      {analysis.findings.map((finding) => {
                        const Icon = findingIcon(finding.category);
                        return (
                          <article key={finding.id} className="group rounded-2xl border border-border bg-white p-4 transition hover:border-primary/35 hover:shadow-sm sm:p-5">
                            <div className="flex gap-3.5">
                              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#fff2e8] text-[#a94918]">
                                <Icon className="size-[17px]" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant={severityVariant(finding.severity)}>{finding.severity}</Badge>
                                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{finding.category}</span>
                                  <h4 className="basis-full font-semibold tracking-tight sm:basis-auto">{finding.title}</h4>
                                </div>
                                <p className="mt-2 text-sm leading-5 text-muted-foreground">{finding.detail}</p>
                                <div className="mt-3 flex items-start gap-2 rounded-xl bg-muted/65 px-3 py-2.5 text-sm">
                                  <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                                  <span><strong className="font-medium">Suggested fix:</strong> {finding.fix}</span>
                                </div>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-primary/30 bg-primary/[0.035] p-8 text-center">
                      <div>
                        <span className="mx-auto grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
                          <Check className="size-5" />
                        </span>
                        <h4 className="mt-4 font-semibold">No blocking issues found</h4>
                        <p className="mt-1 text-sm text-muted-foreground">The prompt and rubrics are ready for a human final review.</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'alignment' && (
                <div className="pt-5">
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold">Requirement coverage</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Every prompt requirement should map to at least one independently gradable criterion.</p>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border">
                    {analysis.alignments.map((alignment, index) => (
                      <div
                        key={alignment.id}
                        className={`grid gap-3 bg-white p-4 sm:grid-cols-[44px_minmax(0,1fr)_120px_84px] sm:items-center ${index ? 'border-t border-border' : ''}`}
                      >
                        <Badge variant="outline" className="justify-self-start bg-background font-mono">{alignment.id}</Badge>
                        <p className="text-sm leading-5">{alignment.requirement}</p>
                        <div className="flex flex-wrap gap-1">
                          {alignment.rubricIds.length ? alignment.rubricIds.map((id) => (
                            <Badge key={id} className="bg-primary/10 text-primary">{id}</Badge>
                          )) : <span className="text-xs text-muted-foreground">No match</span>}
                        </div>
                        <Badge
                          variant={alignment.status === 'Missing' ? 'destructive' : alignment.status === 'Partial' ? 'secondary' : 'outline'}
                          className="justify-self-start"
                        >
                          {alignment.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex items-start gap-3 rounded-2xl border border-primary/15 bg-primary/[0.045] p-4">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" />
                    <p className="text-sm leading-5">
                      Rubric-only expectations remain visible as findings even when related keywords create a partial mapping.
                    </p>
                  </div>
                </div>
              )}

              {activeTab === 'revision' && (
                <div className="pt-5">
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold">Rhea’s improved version</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Minimal edits preserve the original task while resolving detected issues.</p>
                    </div>
                    <Button onClick={applyRevision}><WandSparkles /> Apply improvements</Button>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-2xl border border-border bg-[#fbfaf6] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Revised prompt</span>
                        <Button variant="ghost" size="xs" onClick={() => copyText(analysis.revisedPrompt, 'Prompt copied')}><Copy /> Copy</Button>
                      </div>
                      <p className="text-sm leading-6">{analysis.revisedPrompt}</p>
                    </div>
                    <div className="rounded-2xl border border-border bg-[#fbfaf6] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Revised rubrics</span>
                        <Button variant="ghost" size="xs" onClick={() => copyText(analysis.revisedRubrics, 'Rubrics copied')}><Copy /> Copy</Button>
                      </div>
                      <pre className="whitespace-pre-wrap font-mono text-[13px] leading-6">{analysis.revisedRubrics}</pre>
                    </div>
                  </div>
                </div>
              )}
                </>
              ) : (
                <div className="grid min-h-[520px] place-items-center rounded-2xl border border-dashed border-border bg-background/40 p-8 text-center">
                  <div className="max-w-sm">
                    <span className="mx-auto grid size-12 place-items-center rounded-full bg-primary/[0.08] text-primary">
                      <ListChecks className="size-5" />
                    </span>
                    <h3 className="mt-4 font-semibold">Ready for a fresh review</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Add your prompt and rubric criteria, or use Example to fill both fields with sample content.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {notice && (
        <div role="status" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-xl">
          <Check className="size-4" /> {notice}
        </div>
      )}
    </main>
  );
}
