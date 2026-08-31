export const SUPPORTED_APPLICATIONS = Object.freeze([
  Object.freeze({
    id: 'quickbooks',
    label: 'QuickBooks',
    aliases: Object.freeze(['QuickBooks', 'QuickBooks Online']),
  }),
  Object.freeze({
    id: 'workday',
    label: 'Workday',
    aliases: Object.freeze(['Workday']),
  }),
]);

export const SUPPORTED_APPLICATION_IDS = Object.freeze(
  SUPPORTED_APPLICATIONS.map((application) => application.id),
);

const APPLICATION_BY_ID = new Map(
  SUPPORTED_APPLICATIONS.map((application) => [application.id, application]),
);

export function getSupportedApplication(applicationId) {
  return APPLICATION_BY_ID.get(applicationId) || null;
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsApplicationName(batchText, application) {
  return application.aliases.some((alias) => {
    const matcher = new RegExp(
      `(^|[^a-z0-9])${escapedPattern(alias)}(?=$|[^a-z0-9])`,
      'i',
    );
    return matcher.test(batchText);
  });
}

export function detectSupportedApplications(rubrics) {
  const batchText = JSON.stringify(Array.isArray(rubrics) ? rubrics : []);
  return SUPPORTED_APPLICATIONS.filter((application) =>
    containsApplicationName(batchText, application),
  );
}

export function resolveApplicationScope(selectedApplicationId, rubrics) {
  const selectedApplication = getSupportedApplication(selectedApplicationId);
  if (!selectedApplication) return [];

  const detectedApplications = detectSupportedApplications(rubrics).filter(
    (application) => application.id !== selectedApplication.id,
  );

  return [
    { ...selectedApplication, role: 'selected' },
    ...detectedApplications.map((application) => ({
      ...application,
      role: 'detected_in_rubrics',
    })),
  ];
}
