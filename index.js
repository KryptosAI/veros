const express = require('express');
const path = require('path');
const store = require('./store');
const { seedDatabase, getUsers, MEDICATION_CLASSES, ROLES } = require('./data');
const { processQuery } = require('./engine');
const { verifyClaim, verifyClaims } = require('./verify');
const { logQuery, verifyChain, getRecentEntries } = require('./audit');
const { smartConfig, handleAuthorize, handleToken, handleIntrospect, authMiddleware } = require('./auth-smart');
const { deidentifyResource, deidentifyBundle, DEFAULT_RULES } = require('./deidentify');
const { validate, isValid, validateBundle: validateFHIRBundle } = require('./validate');
const { LLM_CONFIG } = require('./llm-adapter');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const demoRateLimit = new Map();
app.use('/api/query/demo', (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const window = demoRateLimit.get(ip) || [];
  const recent = window.filter(t => now - t < 60000);
  if (recent.length > 30) return res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
  recent.push(now);
  demoRateLimit.set(ip, recent);
  next();
});
app.use('/api/verify/demo', (req, res, next) => {
  const ip = req.ip; const now = Date.now();
  const window = demoRateLimit.get(ip + '_v') || [];
  const recent = window.filter(t => now - t < 60000);
  if (recent.length > 30) return res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
  recent.push(now);
  demoRateLimit.set(ip + '_v', recent);
  next();
});

if (store.resourceCount() === 0) {
  const result = seedDatabase();
  console.log(`Seeded database: ${result.patients} patients, ${result.totalResources} total FHIR resources`);
}

function getPatientSummary(patientId) {
  const resource = store.getResource('Patient', patientId);
  if (!resource) return null;
  const name = (resource.name?.[0]?.given || []).join(' ') + ' ' + (resource.name?.[0]?.family || '');
  return { id: patientId, name: name.trim(), birthDate: resource.birthDate, gender: resource.gender, mrn: resource.identifier?.[0]?.value || patientId };
}

function getPatientName(patientId) {
  const resource = store.getResource('Patient', patientId);
  if (!resource) return 'Unknown';
  return ((resource.name?.[0]?.given || []).join(' ') + ' ' + (resource.name?.[0]?.family || '')).trim();
}

// ─── Health ──────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const counts = store.countResources();
  res.json({ status: 'ok', patients: store.patientCount(), resources: counts, totalResources: Object.values(counts).reduce((a, b) => a + b, 0), timestamp: new Date().toISOString() });
});

// ─── Patients ────────────────────────────────────────────
app.get('/api/patients', (req, res) => {
  const rows = store.getDb().prepare("SELECT resource_id FROM fhir_resources WHERE resource_type = 'Patient' ORDER BY resource_id").all();
  const patients = rows.map(r => getPatientSummary(r.resource_id)).filter(Boolean);
  res.json(patients);
});

app.get('/api/patients/:id', authMiddleware, (req, res) => {
  const s = getPatientSummary(req.params.id);
  if (!s) return res.status(404).json({ error: 'Patient not found' });
  res.json(s);
});

app.get('/api/patients/:id/summary', (req, res) => {
  const patient = store.getResource('Patient', req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const allergies = store.searchAllAllergies(req.params.id);
  const meds = store.searchAllMedications(req.params.id);
  const conditions = store.searchConditions(req.params.id);
  res.json({
    ...getPatientSummary(req.params.id),
    allergyCount: allergies.length,
    allergies: allergies.map(a => ({ substance: a.code?.text || a.code?.coding?.[0]?.display || 'Unknown', criticality: a.criticality, status: a.clinicalStatus?.coding?.[0]?.code, verified: a.verificationStatus?.coding?.[0]?.code })),
    medicationCount: meds.length,
    activeMedications: meds.filter(m => m.status === 'active').length,
    conditionCount: conditions.length,
    conditions: conditions.map(c => ({ label: c.code?.text || c.code?.coding?.[0]?.display || 'Unknown', status: c.clinicalStatus?.coding?.[0]?.code })),
  });
});

// ─── Query ───────────────────────────────────────────────
app.post('/api/query', authMiddleware, async (req, res) => {
  const { question, patientId } = req.body;
  if (!question || !patientId) return res.status(400).json({ error: 'question and patientId are required' });

  const userId = req.user.sub;
  const patient = store.getResource('Patient', patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const patientName = getPatientName(patientId);
  const result = await processQuery(question, patientId, userId, patientName, req.ip);

  if (result.audit) logQuery(result.audit);

  if (!result.success) {
    const status = result.error === 'Unrecognized query pattern' ? 422 : 403;
    return res.status(status).json({ error: result.error, question: result.question });
  }

  res.json({
    question: result.question,
    answer: result.answer,
    citations: result.citations,
    hasMatch: result.hasMatch,
    confidence: result.confidence,
    policy: result.policy,
    permissions: { role: result.permissions.role, roleLabel: result.permissions.roleLabel, scopes: result.permissions.scopes },
    responseTimeMs: result.responseTimeMs,
    parsedBy: result.parsed ? (result.parsed.parsedBy || 'rule') : 'rule',
  });
});

// Demo mode query
app.post('/api/query/demo', async (req, res) => {
  const { question, patientId, userId } = req.body;
  if (!question || !patientId || !userId) return res.status(400).json({ error: 'question, patientId, and userId are required' });
  if (typeof question !== 'string' || question.length > 2000) return res.status(400).json({ error: 'question must be a string under 2000 characters' });

  const patient = store.getResource('Patient', patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const patientName = getPatientName(patientId);
  const result = await processQuery(question, patientId, userId, patientName, req.ip);

  if (result.audit) logQuery(result.audit);

  if (!result.success) {
    return res.status(result.error === 'Unrecognized query pattern' ? 422 : 403).json({ error: result.error, question: result.question });
  }

  res.json({
    question: result.question, answer: result.answer, citations: result.citations,
    hasMatch: result.hasMatch,
    confidence: result.confidence, policy: result.policy,
    permissions: { role: result.permissions.role, roleLabel: result.permissions.roleLabel, scopes: result.permissions.scopes },
    responseTimeMs: result.responseTimeMs,
    parsedBy: result.parsed ? (result.parsed.parsedBy || 'rule') : 'rule',
  });
});

app.get('/api/query/supported', (_req, res) => {
  res.json({
    patterns: [
      { type: 'allergy_check', description: 'Check for adverse reaction/allergy to a medication', examples: ['Any history of adverse reaction to penicillin?', 'Is the patient allergic to sulfa?', 'Does this patient have an allergy to codeine?'] },
      { type: 'allergy_list', description: 'List all known allergies', examples: ['What allergies does the patient have?', 'Any known allergies?'] },
      { type: 'medication_list', description: 'List medications', examples: ['What medications is the patient on?', 'Current meds?', 'List active medications'] },
      { type: 'abnormal_labs', description: 'Find abnormal lab results', examples: ['What labs are abnormal?', 'Any abnormal lab results?'] },
    ],
    medicationClasses: Object.fromEntries(Object.entries(MEDICATION_CLASSES).map(([k, v]) => [k, v.terms])),
  });
});

// ─── Verify — AI Claim Provenance ──────────────────────
app.get('/api/verify/supported', (_req, res) => {
  res.json({
    description: 'Verify AI-generated clinical claims against FHIR source of truth. Every verdict cites supporting or contradicting evidence.',
    claimTypes: [
      { type: 'allergy', fields: 'medication (required), status, criticality, reaction', description: 'Verify an allergy claim', examples: [{ claim: 'Patient is allergic to penicillin', labels: 'VERIFIED/CONTRADICTED/UNVERIFIABLE' }, { claim: { type: 'allergy', medication: 'penicillin', status: 'active' } }] },
      { type: 'condition', fields: 'condition (required), status', description: 'Verify a diagnosis/condition claim', examples: [{ claim: { type: 'condition', condition: 'Type 2 Diabetes Mellitus', status: 'active' } }] },
      { type: 'medication', fields: 'drug (required), status, dosage', description: 'Verify a medication claim', examples: [{ claim: { type: 'medication', drug: 'Metformin', status: 'active' } }] },
      { type: 'lab', fields: 'test (required), value, unit, tolerance', description: 'Verify a lab result claim', examples: [{ claim: { type: 'lab', test: 'HbA1c', value: 7.1, unit: '%' } }] },
      { type: 'relationship', fields: 'supporting (array of sub-claims)', description: 'Verify a compound claim (all sub-claims must be verified)', examples: [{ claim: { type: 'relationship', supporting: [{ type: 'condition', condition: 'Type 2 Diabetes' }, { type: 'lab', test: 'HbA1c', value: 7.1 }] } }] },
    ],
    verdicts: ['VERIFIED', 'CONTRADICTED', 'UNVERIFIABLE', 'PARTIALLY_VERIFIED'],
    note: 'Claims can be natural language strings or structured JSON objects',
  });
});

app.post('/api/verify', authMiddleware, async (req, res) => {
  const { claim, patientId } = req.body;
  if (!patientId) return res.status(400).json({ error: 'patientId is required' });
  if (!claim || (typeof claim === 'object' && !claim.type && Object.keys(claim).length === 0))
    return res.status(400).json({ error: 'claim is required and must be a non-empty string or object with a type field' });

  const userId = req.user.sub;
  const patient = store.getResource('Patient', patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const user = require('./data').getUserById(userId);
  const userRole = user?.role || 'unknown';
  const userName = user?.name || 'Unknown';
  const patientName = getPatientName(patientId);

  const startTime = Date.now();
  const result = verifyClaim(claim, patientId);
  const responseTimeMs = Date.now() - startTime;

  const evidenceCount = (result.evidence?.supporting?.length || 0) + (result.evidence?.contradicting?.length || 0);

  logQuery({
    userId, userRole, userName, patientId, patientName,
    queryText: `VERIFY: ${typeof claim === 'string' ? claim : JSON.stringify(claim)}`,
    queryIntent: 'claim_verification', queryParams: claim,
    resourcesQueried: ['AllergyIntolerance', 'MedicationRequest', 'Condition', 'Observation'],
    resourcesAccessed: (result.evidence?.supporting || []).concat(result.evidence?.contradicting || []).map(e => ({ type: e.citation?.sourceType, id: e.citation?.sourceId })).filter(x => x.type),
    resourcesReturned: evidenceCount,
    dataFiltered: false,
    responseSummary: `Verdict: ${result.verdict} | Evidence: ${evidenceCount} items`,
    citationsCount: evidenceCount,
    authMechanism: 'jwt', scopesApplied: req.user.scopes ? [req.user.scopes].flat() : [],
    sourceIp: req.ip, responseTimeMs, success: true, purposeOfUse: 'TREATMENT',
  });

  res.json({
    claim: typeof claim === 'string' ? { original: claim, parsed: result.originalClaim ? null : (typeof claim) } : claim,
    verdict: result.verdict,
    confidence: result.confidence,
    policy: result.policy,
    evidence: result.evidence,
    subResults: result.subResults || null,
    responseTimeMs,
  });
});

app.post('/api/verify/demo', async (req, res) => {
  const { claim, patientId, userId } = req.body;
  if (!patientId || !userId) return res.status(400).json({ error: 'patientId and userId are required' });
  if (!claim || (typeof claim === 'object' && !claim.type && Object.keys(claim).length === 0))
    return res.status(400).json({ error: 'claim is required and must be a non-empty string or object with a type field' });

  const patient = store.getResource('Patient', patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const user = require('./data').getUserById(userId);
  const userRole = user?.role || 'unknown';
  const userName = user?.name || 'Unknown';
  const patientName = getPatientName(patientId);

  const startTime = Date.now();
  const result = verifyClaim(claim, patientId);
  const responseTimeMs = Date.now() - startTime;

  const evidenceCount = (result.evidence?.supporting?.length || 0) + (result.evidence?.contradicting?.length || 0);

  logQuery({
    userId, userRole, userName, patientId, patientName,
    queryText: `VERIFY(DEMO): ${typeof claim === 'string' ? claim : JSON.stringify(claim)}`,
    queryIntent: 'claim_verification', queryParams: claim,
    resourcesQueried: ['AllergyIntolerance', 'MedicationRequest', 'Condition', 'Observation'],
    resourcesAccessed: (result.evidence?.supporting || []).concat(result.evidence?.contradicting || []).map(e => ({ type: e.citation?.sourceType, id: e.citation?.sourceId })).filter(x => x.type),
    resourcesReturned: evidenceCount,
    dataFiltered: false,
    responseSummary: `Verdict: ${result.verdict}`,
    citationsCount: evidenceCount,
    authMechanism: 'demo', scopesApplied: [],
    sourceIp: req.ip, responseTimeMs, success: true, purposeOfUse: 'TREATMENT',
  });

  res.json({
    claim: typeof claim === 'string' ? claim : JSON.stringify(claim),
    verdict: result.verdict,
    confidence: result.confidence,
    policy: result.policy,
    evidence: result.evidence,
    subResults: result.subResults || null,
    responseTimeMs,
  });
});

app.post('/api/verify/bulk', authMiddleware, async (req, res) => {
  const { claims, patientId } = req.body;
  if (!claims || !patientId) return res.status(400).json({ error: 'claims (array) and patientId are required' });

  const userId = req.user.sub;
  const patient = store.getResource('Patient', patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const startTime = Date.now();
  const result = verifyClaims(claims, patientId);
  const responseTimeMs = Date.now() - startTime;

  logQuery({
    userId, userRole: req.user.role, userName: req.user.name,
    patientId, patientName: getPatientName(patientId),
    queryText: `VERIFY BULK: ${claims.length} claims`, queryIntent: 'bulk_verification',
    resourcesQueried: ['AllergyIntolerance', 'MedicationRequest', 'Condition', 'Observation'],
    resourcesReturned: result.summary.total,
    dataFiltered: false,
    responseSummary: `${result.summary.verified} verified, ${result.summary.contradicted} contradicted, ${result.summary.unverifiable} unverifiable`,
    citationsCount: result.summary.total,
    authMechanism: 'jwt', scopesApplied: [req.user.scopes].flat(),
    sourceIp: req.ip, responseTimeMs, success: true, purposeOfUse: 'TREATMENT',
  });

  res.json({ ...result, responseTimeMs });
});

// ─── Users & Roles ───────────────────────────────────────
app.get('/api/roles', (_req, res) => {
  res.json(Object.entries(ROLES).map(([id, role]) => ({ id, label: role.label, resourceAccess: role.access })));
});

app.get('/api/users', (_req, res) => {
  const users = getUsers();
  res.json(users.map(u => ({ id: u.id, name: u.name, role: u.role, roleLabel: ROLES[u.role]?.label || 'Unknown', patientId: u.patient_id || null })));
});

// ─── Audit ───────────────────────────────────────────────
app.get('/api/audit', (req, res) => {
  if (req.query.key !== 'veros-demo') return res.status(401).json({ error: 'Access restricted. Add ?key=veros-demo for demo access.' });
  res.json(getRecentEntries(100));
});

app.get('/api/audit/verify', (req, res) => {
  if (req.query.key !== 'veros-demo') return res.status(401).json({ error: 'Access restricted. Add ?key=veros-demo for demo access.' });
  res.json(verifyChain());
});

app.get('/api/audit/patient/:id', (req, res) => {
  if (req.query.key !== 'veros-demo') return res.status(401).json({ error: 'Access restricted.' });
  const { getEntriesByPatient } = require('./audit');
  res.json(getEntriesByPatient(req.params.id));
});

// ─── Deidentification ───────────────────────────────────
app.get('/api/deidentify/rules', (_req, res) => {
  res.json({ rules: DEFAULT_RULES, note: 'POST a FHIR resource or bundle to /api/deidentify to apply these rules' });
});

app.post('/api/deidentify', (req, res) => {
  const { resource, rules } = req.body;
  if (!resource) return res.status(400).json({ error: 'resource body required' });

  try {
    const result = resource.resourceType === 'Bundle'
      ? deidentifyBundle(resource, rules)
      : deidentifyResource(resource, rules);
    res.json({ deidentified: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/deidentify/export', authMiddleware, (req, res) => {
  const { patientId, resourceTypes } = req.body;
  if (!patientId) return res.status(400).json({ error: 'patientId required' });

  const types = resourceTypes || ['AllergyIntolerance', 'MedicationRequest', 'Observation', 'Condition'];
  const bundle = { resourceType: 'Bundle', type: 'searchset', timestamp: new Date().toISOString(), entry: [] };

  for (const rt of types) {
    const resources = store.searchByPatient(rt, patientId);
    for (const r of resources) {
      bundle.entry.push({ fullUrl: `/fhir/${rt}/${r.id}`, resource: deidentifyResource(r) });
    }
  }

  bundle.total = bundle.entry.length;
  logQuery({
    userId: req.user.sub, userRole: req.user.role, userName: req.user.name,
    patientId, patientName: getPatientName(patientId),
    queryText: `DEID EXPORT: ${types.join(', ')}`, queryIntent: 'deidentify_export',
    resourcesQueried: types, resourcesAccessed: bundle.entry.map(e => ({ type: e.resource.resourceType, id: e.resource.id })),
    resourcesReturned: bundle.entry.length, dataFiltered: true, filteredReason: 'deidentified_export',
    responseSummary: `Exported ${bundle.entry.length} deidentified resources`, citationsCount: bundle.entry.length,
    authMechanism: 'jwt', scopesApplied: [req.user.scopes].flat(), sourceIp: req.ip,
    responseTimeMs: 0, success: true, purposeOfUse: 'TREATMENT',
  });

  res.json(bundle);
});

// ─── FHIR import ─────────────────────────────────────────
app.post('/api/fhir/import', authMiddleware, (req, res) => {
  const { bundle } = req.body;
  if (!bundle) return res.status(400).json({ error: 'FHIR bundle required' });
  if (!bundle.entry || !Array.isArray(bundle.entry)) return res.status(400).json({ error: 'Bundle must have an entry array' });

  const errors = [];
  const validEntries = [];
  for (const entry of bundle.entry) {
    const resource = entry.resource || entry;
    if (!resource.resourceType || !resource.id) {
      errors.push({ id: resource.id || 'unknown', error: 'Missing resourceType or id' });
      continue;
    }
    const issues = validate(resource);
    if (issues.some(i => i.severity === 'error')) {
      errors.push({ id: resource.id, resourceType: resource.resourceType, issues });
      continue;
    }
    validEntries.push({ resource });
  }

  if (validEntries.length === 0) {
    return res.status(422).json({ error: 'No valid resources to import', validationErrors: errors });
  }

  const count = store.importFHIRBundle({ entry: validEntries });
  res.json({ imported: count, totalResources: store.resourceCount(), skipped: errors.length, validationErrors: errors.length > 0 ? errors : undefined });
});

// ─── FHIR Endpoints ──────────────────────────────────────
app.get('/fhir/Patient/:id', (req, res) => {
  const r = store.getResource('Patient', req.params.id);
  if (!r) return res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
  res.json(r);
});

app.get('/fhir/AllergyIntolerance', (req, res) => {
  const pid = req.query.patient?.split('/').pop();
  if (!pid) return res.json({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] });
  const items = store.searchByPatient('AllergyIntolerance', pid);
  res.json({ resourceType: 'Bundle', type: 'searchset', total: items.length, entry: items.map(r => ({ fullUrl: `/fhir/AllergyIntolerance/${r.id}`, resource: r })) });
});

app.get('/fhir/AllergyIntolerance/:id', (req, res) => {
  const r = store.getResource('AllergyIntolerance', req.params.id);
  if (!r) return res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
  res.json(r);
});

app.get('/fhir/MedicationRequest', (req, res) => {
  const pid = req.query.patient?.split('/').pop();
  if (!pid) return res.json({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] });
  const items = store.searchByPatient('MedicationRequest', pid);
  res.json({ resourceType: 'Bundle', type: 'searchset', total: items.length, entry: items.map(r => ({ fullUrl: `/fhir/MedicationRequest/${r.id}`, resource: r })) });
});

app.get('/fhir/Condition', (req, res) => {
  const pid = req.query.patient?.split('/').pop();
  if (!pid) return res.json({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] });
  const items = store.searchConditions(pid);
  res.json({ resourceType: 'Bundle', type: 'searchset', total: items.length, entry: items.map(r => ({ fullUrl: `/fhir/Condition/${r.id}`, resource: r })) });
});

app.get('/fhir/Observation', (req, res) => {
  const pid = req.query.patient?.split('/').pop();
  if (!pid) return res.json({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] });
  const items = store.searchObservations(pid);
  res.json({ resourceType: 'Bundle', type: 'searchset', total: items.length, entry: items.map(r => ({ fullUrl: `/fhir/Observation/${r.id}`, resource: r })) });
});

// ─── LLM Status ────────────────────────────────────────
app.get('/api/llm/status', (_req, res) => {
  const provider = LLM_CONFIG.cloudProvider || LLM_CONFIG.provider;
  res.json({
    enabled: LLM_CONFIG.enabled,
    provider,
    model: LLM_CONFIG.cloudProvider ? LLM_CONFIG.cloudModel : LLM_CONFIG.ollamaModel,
    note: provider === 'deepseek'
      ? `DeepSeek API active (${LLM_CONFIG.cloudModel})`
      : provider === 'openai'
        ? `OpenAI API active (${LLM_CONFIG.cloudModel})`
        : provider === 'ollama'
          ? `Ollama active (${LLM_CONFIG.ollamaModel})`
          : 'LLM disabled. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, or LLM_ENDPOINT to enable.',
  });
});

// ─── FHIR Validation ───────────────────────────────────
app.post('/api/fhir/validate', (req, res) => {
  const { resource, bundle } = req.body;
  if (bundle) return res.json({ bundleValidation: validateFHIRBundle(bundle) });
  if (resource) return res.json({ issues: validate(resource), valid: isValid(resource) });
  res.status(400).json({ error: 'resource or bundle body required' });
});

// ─── SMART App Launch ───────────────────────────────────
app.get('/launch.html', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'launch.html'));
});

// ─── SMART on FHIR ───────────────────────────────────────
app.get('/.well-known/smart-configuration', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(smartConfig(baseUrl));
});

app.get('/auth/authorize', handleAuthorize);
app.post('/auth/token', handleToken);
app.post('/auth/introspect', handleIntrospect);

// ─── Global error handler ──────────────────────────────
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large. Maximum is 1MB.' });
  if (err.status === 413) return res.status(413).json({ error: 'Request body too large.' });
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  const counts = store.countResources();
  const llmNote = LLM_CONFIG.cloudProvider
    ? `LLM: ${LLM_CONFIG.cloudProvider} (${LLM_CONFIG.cloudModel})`
    : LLM_CONFIG.provider === 'ollama'
      ? `LLM: Ollama (${LLM_CONFIG.ollamaModel})`
      : 'LLM: disabled (set DEEPSEEK_API_KEY or OPENAI_API_KEY)';

  console.log(`\nVeros v0.3 — Clinical Ground Truth for AI`);
  console.log(`  Patients: ${store.patientCount()} | Total FHIR resources: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
  console.log(`  ${llmNote}`);
  console.log(`  Query:   POST /api/query        — Ask questions, get cited answers`);
  console.log(`  Verify:  POST /api/verify       — Verify AI claims against FHIR truth`);
  console.log(`  Bulk:    POST /api/verify/bulk  — Verify multiple claims at once`);
  console.log(`  SMART:   http://localhost:${PORT}/.well-known/smart-configuration`);
  console.log(`  UI:      http://localhost:${PORT}\n`);
});

module.exports = app;
