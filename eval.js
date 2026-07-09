const store = require('./store');
const { seedDatabase, resolveMedicationClass, getUserById } = require('./data');
const { processQuery, INTENTS } = require('./engine');
const { generateCitation, scoreCitationConfidence } = require('./intents');
const { logQuery, verifyChain } = require('./audit');
const { deidentifyResource } = require('./deidentify');

const { getResource } = store;

function setup() {
  if (store.resourceCount() === 0) seedDatabase();
}

function getPatientName(pid) {
  const p = store.getResource('Patient', pid);
  if (!p) return 'Unknown';
  return ((p.name?.[0]?.given || []).join(' ') + ' ' + (p.name?.[0]?.family || '')).trim();
}

async function runQuery(question, patientId, userId) {
  return processQuery(question, patientId, userId, getPatientName(patientId), 'eval');
}

const TEST_CASES = [
  { name: 'Sulfa allergy — Robert Chen (sulfa on patient-001)', question: 'Any history of adverse reaction to sulfa?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true, hasMatch: true, minCitations: 1 } },
  { name: 'Class match — Bactrim → sulfa class', question: 'Is the patient allergic to Bactrim?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true, hasMatch: true, minCitations: 1 } },
  { name: 'No allergy — ibuprofen on Robert Chen (sulfa only)', question: 'Any problems with ibuprofen?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true, hasMatch: false } },
  { name: 'Penicillin allergy — Maria Santos', question: 'Is the patient allergic to penicillin?', patientId: 'patient-002', userId: 'user-dr-nguyen', expected: { success: true, hasMatch: true, minCitations: 1 } },
  { name: 'NKDA — James Wright, no penicillin allergy', question: 'Does the patient have an allergy to penicillin?', patientId: 'patient-003', userId: 'user-dr-chen', expected: { success: true, hasMatch: false } },
  { name: 'Codeine allergy — Diane Foster', question: 'Does the patient have an allergy to codeine?', patientId: 'patient-004', userId: 'user-dr-patel', expected: { success: true, hasMatch: true, minCitations: 1 } },
  { name: 'Latex allergy — Diane Foster', question: 'Any history of adverse reaction to latex?', patientId: 'patient-004', userId: 'user-dr-patel', expected: { success: true, hasMatch: true, minCitations: 1 } },
  { name: 'NKDA — James Wright, no sulfa allergy', question: 'Any history of adverse reaction to sulfa?', patientId: 'patient-003', userId: 'user-dr-chen', expected: { success: true, hasMatch: false } },
  { name: 'No allergy — cephalexin on NKDA patient', question: 'Is the patient allergic to cephalexin?', patientId: 'patient-003', userId: 'user-dr-chen', expected: { success: true, hasMatch: false } },
  { name: 'List all allergies — Robert Chen has 1 (sulfa)', question: 'What allergies does the patient have?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true, minCitations: 1 } },
  { name: 'List all allergies — Maria Santos (penicillin)', question: 'Any known allergies?', patientId: 'patient-002', userId: 'user-dr-nguyen', expected: { success: true, minCitations: 1 } },
  { name: 'Permission denied — admin accessing AllergyIntolerance', question: 'Any history of adverse reaction to penicillin?', patientId: 'patient-001', userId: 'user-admin-smith', expected: { success: false } },
  { name: 'Permission denied — patient cross-access', question: 'Any history of adverse reaction to penicillin?', patientId: 'patient-004', userId: 'user-patient-001', expected: { success: false } },
  { name: 'Patient self-access — patient-001 own data', question: 'Any history of adverse reaction to sulfa?', patientId: 'patient-001', userId: 'user-patient-001', expected: { success: true, hasMatch: true } },
  { name: 'Gibberish query → patient overview (no error)', question: 'What color is the sky?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true }, validate: (r) => r.answer.includes('condition') || r.answer.includes('medication') },
  { name: 'Every response has FHIR citations', question: 'Any history of adverse reaction to sulfa?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true }, validate: (r) => r.citations.length > 0 && r.citations.every(c => c.fhirReference && c.sourceType && c.confidence !== undefined) },
  { name: 'No source no answer — cephalexin on NKDA patient', question: 'Any history of adverse reaction to cephalexin?', patientId: 'patient-003', userId: 'user-dr-chen', expected: { success: true, hasMatch: false, minCitations: 0 } },
  { name: 'Medication list — Robert Chen (metformin + lisinopril + bevacizumab)', question: 'What medications is the patient on?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true }, validate: (r) => r.citations.length >= 3 && r.citations.some(c => c.display.includes('Metformin')) },
  { name: 'Abnormal labs — Robert Chen has elevated HbA1c 8.2%', question: 'What labs are abnormal?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true }, validate: (r) => r.answer.includes('HbA1c') && r.answer.includes('8.2') },
  { name: 'Citation confidence — high for recent confirmed allergy', question: 'Any history of adverse reaction to sulfa?', patientId: 'patient-001', userId: 'user-dr-chen', expected: { success: true }, validate: (r) => r.citations[0].confidence >= 0.6 },
  { name: 'Abnormal labs — Maria Santos IOP now controlled (18/16, normal)', question: 'What labs are abnormal?', patientId: 'patient-002', userId: 'user-dr-nguyen', expected: { success: true }, validate: (r) => r.policy === 'negative_findings' || r.answer.toLowerCase().includes('no abnormal') },
  { name: 'Medication list — James Wright post-op meds (completed)', question: 'What medications is the patient on?', patientId: 'patient-003', userId: 'user-dr-chen', expected: { success: true }, validate: (r) => r.answer.includes('completed') },
];

async function runEval() {
  setup();
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Veros v0.3 — Evaluation Harness');
  console.log('══════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const tc of TEST_CASES) {
    const result = await runQuery(tc.question, tc.patientId, tc.userId);
    let valid = true;
    const reasons = [];

    if (tc.expected.success !== undefined && result.success !== tc.expected.success) {
      valid = false; reasons.push(`Expected success=${tc.expected.success}, got ${result.success}`);
    }
    if (result.success && tc.expected.hasMatch !== undefined && result.hasMatch !== tc.expected.hasMatch) {
      valid = false; reasons.push(`Expected hasMatch=${tc.expected.hasMatch}, got ${result.hasMatch}`);
    }
    if (result.success && tc.expected.minCitations !== undefined && (result.citations?.length || 0) < tc.expected.minCitations) {
      valid = false; reasons.push(`Expected >=${tc.expected.minCitations} citations, got ${result.citations?.length || 0}`);
    }
    if (tc.validate) {
      try { if (!tc.validate(result)) { valid = false; reasons.push('Custom validation failed'); } }
      catch (e) { valid = false; reasons.push(`Validation threw: ${e.message}`); }
    }

    if (valid) { passed++; console.log(`  ✓  PASS  ${tc.name}`); }
    else {
      failed++; console.log(`  ✗  FAIL  ${tc.name} — ${reasons.join('; ')}`);
      if (result.success) console.log(`     Answer: ${(result.answer || '').substring(0, 200)}`);
      else console.log(`     Error: ${result.error}`);
    }
  }

  // ─── Persistence test ───────────────────────────────────
  console.log('\n  --- Additional Tests ---');
  const preCount = store.resourceCount();
  store.addResource({ resourceType: 'Patient', id: 'test-persist', name: [{ family: 'Test', given: ['Persist'] }] });
  const midCount = store.resourceCount();
  const retrieved = store.getResource('Patient', 'test-persist');
  const persistOk = preCount + 1 === midCount && retrieved && retrieved.id === 'test-persist';
  store.getDb().prepare('DELETE FROM fhir_resources WHERE resource_type = ? AND resource_id = ?').run('Patient', 'test-persist');
  if (persistOk) { passed++; console.log(`  ✓  PASS  SQLite persistence`); }
  else { failed++; console.log(`  ✗  FAIL  SQLite persistence (pre:${preCount} mid:${midCount} retrieved:${!!retrieved})`); }

  // ─── Audit chain test ───────────────────────────────────
  const auditEntry = logQuery({
    userId: 'test', userRole: 'attending', userName: 'Test User',
    patientId: 'patient-001', patientName: 'Test',
    queryText: 'eval audit test', queryIntent: 'test',
    resourcesQueried: ['Test'], resourcesAccessed: [], resourcesReturned: 0,
    dataFiltered: false, responseSummary: 'test', citationsCount: 0,
    authMechanism: 'rbac', scopesApplied: [], sourceIp: 'eval',
    responseTimeMs: 1, success: true, purposeOfUse: 'TREATMENT',
  });
  const chainVerification = verifyChain();
  if (chainVerification.valid && chainVerification.entries >= 1) { passed++; console.log(`  ✓  PASS  Audit chain verification (${chainVerification.entries} entries)`); }
  else { failed++; console.log(`  ✗  FAIL  Audit chain verification: ${JSON.stringify(chainVerification)}`); }

  // ─── Deidentification test ──────────────────────────────
  const orig = store.getResource('Patient', 'patient-001');
  const deid = deidentifyResource(orig);
  const hasName = JSON.stringify(deid).includes('John');
  const hasRedactedLabel = deid.meta?.security?.some(s => s.code === 'REDACTED');
  if (!hasName && hasRedactedLabel) { passed++; console.log(`  ✓  PASS  Deidentification (name redacted, REDACTED label present)`); }
  else { failed++; console.log(`  ✗  FAIL  Deidentification (hasName:${hasName} hasLabel:${hasRedactedLabel})`); }

  // ─── Medication class resolution ────────────────────────
  const pc = resolveMedicationClass('amoxicillin');
  const sc = resolveMedicationClass('bactrim');
  const nc = resolveMedicationClass('cephalexin');
  const ms = resolveMedicationClass('morphine');
  if (pc && pc.className === 'penicillins' && sc && sc.className === 'sulfonamides' && nc && nc.className === 'cephalosporins' && ms && ms.className === 'opioids') {
    passed++; console.log(`  ✓  PASS  Medication class resolution`);
  } else { failed++; console.log(`  ✗  FAIL  Medication class resolution`); }

  // ─── Citation confidence test ───────────────────────────
  const allergy = store.getResource('AllergyIntolerance', 'allergy-001');
  const confidence = scoreCitationConfidence(allergy);
  if (confidence >= 0.6 && confidence <= 1.0) { passed++; console.log(`  ✓  PASS  Citation confidence scoring (${confidence})`); }
  else { failed++; console.log(`  ✗  FAIL  Citation confidence: ${confidence}`); }

  const elapsed = Date.now() - startTime;
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed out of ${TEST_CASES.length + 5}`);
  console.log(`  Time:    ${elapsed}ms`);
  console.log(`  Status:  ${failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED'}\n`);

  return { passed, failed, total: TEST_CASES.length + 5, elapsed };
}

if (require.main === module) runEval();

module.exports = { runEval, TEST_CASES };
