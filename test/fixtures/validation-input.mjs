export function batch() {
  return {
    application: 'quickbooks',
    batch: 'Batch C',
    rubrics: Array.from({ length: 10 }, (_, index) => ({
      criterion: 'Invoice: Verify the invoice total.',
      score: 10,
      tags: [index < 3 ? 'bug' : 'feature request'],
      forms: {
        page_or_workflow: 'Invoice details',
        reproduction_steps: index < 3 ? '1. Open the invoice.' : 'N/A',
        expected_behavior: 'The invoice displays the updated total.',
        actual_behavior: 'The invoice displays the original total.',
      },
    })),
  };
}

export function completeReview(input, findings = []) {
  const docs = {
    title: 'Invoice guidance',
    url: 'https://quickbooks.intuit.com/learn-support/invoices',
  };
  return {
    applicationBrief: 'QuickBooks invoice documentation.',
    applicationsReviewed: [
      {
        id: 'quickbooks',
        name: 'QuickBooks',
        role: 'selected',
        officialDomains: ['quickbooks.intuit.com'],
        documentationSources: [docs],
      },
    ],
    sources: [docs],
    rubricReviews: input.rubrics.map((rubric, index) => ({
      index,
      criterionSection: 'Invoice',
      documentationStatus: index < 3 ? 'not_applicable' : 'supported',
      documentationSummary:
        index < 3 ? 'Grammar only.' : 'An invoice displays a total.',
      findings: index === 3 ? findings : [],
      correctedRubric: rubric,
    })),
  };
}
