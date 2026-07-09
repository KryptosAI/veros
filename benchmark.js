const store = require('./store');
const { processQuery, generateCitation } = require('./engine');
const { seedDatabase } = require('./data');

function ensureSeeded() {
  if (store.resourceCount() === 0) seedDatabase();
}

function getPatientName(pid) {
  const p = store.getResource('Patient', pid);
  if (!p) return 'Unknown';
  return ((p.name?.[0]?.given || []).join(' ') + ' ' + (p.name?.[0]?.family || '')).trim();
}

const BENCHMARK_CASES = [
  // ── FACTUAL LOOKUP ─────────────────────────────────
  {
    testId: 'bm-001', category: 'factual_lookup', patientId: 'patient-001', userId: 'user-dr-chen',
    query: 'Any history of adverse reaction to sulfa?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-001', supportsClaim: 'Patient has active sulfa allergy with severe urticaria' },
      ],
    },
  },
  {
    testId: 'bm-002', category: 'factual_lookup', patientId: 'patient-004', userId: 'user-dr-patel',
    query: 'Does the patient have an allergy to codeine?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-004', supportsClaim: 'Codeine allergy with severe respiratory depression' },
      ],
    },
  },

  // ── CLASS MATCH ────────────────────────────────────
  {
    testId: 'bm-003', category: 'class_match', patientId: 'patient-001', userId: 'user-dr-chen',
    query: 'Is the patient allergic to Bactrim?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-001', supportsClaim: 'Bactrim is TMP-SMX, matches sulfa allergy' },
      ],
    },
  },
  {
    testId: 'bm-004', category: 'class_match', patientId: 'patient-002', userId: 'user-dr-nguyen',
    query: 'Is the patient allergic to amoxicillin?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-002', supportsClaim: 'Amoxicillin is penicillin-class, matches penicillin allergy' },
      ],
    },
  },

  // ── UNABLE TO ANSWER ───────────────────────────────
  {
    testId: 'bm-005', category: 'unanswerable', patientId: 'patient-003', userId: 'user-dr-chen',
    query: 'Any history of adverse reaction to cephalexin?',
    groundTruth: {
      answerIsDerivable: false, expectedAbstention: true,
      reasonNotDerivable: 'No cephalexin or cephalosporin allergy — patient has NKDA',
      relevantCitations: [],
    },
  },
  {
    testId: 'bm-006', category: 'unanswerable', patientId: 'patient-001', userId: 'user-dr-chen',
    query: 'Any history of adverse reaction to ibuprofen?',
    groundTruth: {
      answerIsDerivable: false, expectedAbstention: true,
      reasonNotDerivable: 'Patient has sulfa allergy only, no NSAID allergy',
      relevantCitations: [],
    },
  },

  // ── MULTI-RESOURCE ─────────────────────────────────
  {
    testId: 'bm-007', category: 'multi_resource', patientId: 'patient-004', userId: 'user-dr-patel',
    query: 'What allergies does the patient have?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-004', supportsClaim: 'Codeine allergy' },
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-005', supportsClaim: 'Latex allergy' },
      ],
    },
  },

  // ── MEDICATION LIST ────────────────────────────────
  {
    testId: 'bm-008', category: 'medication_list', patientId: 'patient-001', userId: 'user-dr-chen',
    query: 'What medications is the patient on?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'MedicationRequest', sourceId: 'med-001', supportsClaim: 'Metformin 1000mg' },
        { sourceType: 'MedicationRequest', sourceId: 'med-002', supportsClaim: 'Lisinopril 10mg' },
        { sourceType: 'MedicationRequest', sourceId: 'med-003', supportsClaim: 'Bevacizumab intravitreal injection' },
      ],
    },
  },

  // ── ABNORMAL LABS ──────────────────────────────────
  {
    testId: 'bm-009', category: 'lab_query', patientId: 'patient-001', userId: 'user-dr-chen',
    query: 'What labs are abnormal?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'Observation', sourceId: 'obs-001', supportsClaim: 'HbA1c 8.2% — above normal <5.7%' },
      ],
    },
  },

  // ── NEGATIVE FINDING ───────────────────────────────
  {
    testId: 'bm-010', category: 'negative_finding', patientId: 'patient-003', userId: 'user-dr-chen',
    query: 'What labs are abnormal?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: ['negative_findings'],
    },
  },

  // ── PERMISSION DENIED ──────────────────────────────
  {
    testId: 'bm-011', category: 'permission', patientId: 'patient-001', userId: 'user-admin-smith',
    query: 'Any history of adverse reaction to sulfa?',
    groundTruth: {
      answerIsDerivable: false, expectedAbstention: true,
      reasonNotDerivable: 'Permission denied — admin cannot access AllergyIntolerance',
      relevantCitations: [],
    },
  },

  // ── PATIENT SELF-ACCESS ────────────────────────────
  {
    testId: 'bm-012', category: 'patient_access', patientId: 'patient-001', userId: 'user-patient-001',
    query: 'Any history of adverse reaction to sulfa?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'AllergyIntolerance', sourceId: 'allergy-001', supportsClaim: 'Sulfa allergy' },
      ],
    },
  },

  // ── POST-OP MED CORRELATION ────────────────────────
  {
    testId: 'bm-013', category: 'cross_reference', patientId: 'patient-003', userId: 'user-dr-chen',
    query: 'What medications is the patient on?',
    groundTruth: {
      answerIsDerivable: true, expectedAbstention: false,
      relevantCitations: [
        { sourceType: 'MedicationRequest', sourceId: 'med-006', supportsClaim: 'Prednisolone — completed post-op taper' },
        { sourceType: 'MedicationRequest', sourceId: 'med-007', supportsClaim: 'Moxifloxacin — completed post-op course' },
      ],
    },
  },
];

function matchCitation(citation, groundTruthCitation) {
  if (groundTruthCitation === 'negative_findings') {
    return citation === 'negative_findings';
  }
  if (typeof citation === 'string' || typeof groundTruthCitation === 'string') return false;
  return citation.sourceType === groundTruthCitation.sourceType &&
    citation.sourceId === groundTruthCitation.sourceId;
}

async function runBenchmark() {
  ensureSeeded();
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Veros — Citation Benchmark');
  console.log('══════════════════════════════════════════════════════════\n');

  const results = [];
  let totalPrecision = 0, totalRecall = 0, precisionCount = 0, recallCount = 0;
  let correctAbstentions = 0, totalAbstentionCases = 0;

  for (const tc of BENCHMARK_CASES) {
    const patientName = getPatientName(tc.patientId);
    const result = await processQuery(tc.query, tc.patientId, tc.userId, patientName, 'benchmark');

    const gt = tc.groundTruth;
    const returnedCitations = result.success ? (result.citations || []) : [];

    let precision = null;
    let recall = null;
    let correct = false;

    if (gt.expectedAbstention) {
      totalAbstentionCases++;
      if (!result.success || returnedCitations.length === 0) {
        correctAbstentions++;
        correct = true;
      }
    } else {
      if (gt.relevantCitations && gt.relevantCitations.length > 0) {
        if (gt.relevantCitations[0] === 'negative_findings') {
          correct = returnedCitations.length === 0 && result.success;
        } else {
          const matchedCitations = returnedCitations.filter(rc =>
            gt.relevantCitations.some(gc => matchCitation(rc, gc))
          );

          precision = returnedCitations.length > 0
            ? matchedCitations.length / returnedCitations.length
            : null;
          recall = gt.relevantCitations.length > 0
            ? matchedCitations.length / gt.relevantCitations.length
            : null;
          correct = recall !== null && recall >= 0.8;
        }
      }
    }

    results.push({ testId: tc.testId, category: tc.category, query: tc.query, correct, precision, recall });

    const status = correct ? '✓' : '✗';
    console.log(`  ${status} ${tc.testId} [${tc.category}] precision=${precision?.toFixed(2) || 'N/A'} recall=${recall?.toFixed(2) || 'N/A'}`);

    if (precision !== null) { totalPrecision += precision; precisionCount++; }
    if (recall !== null) { totalRecall += recall; recallCount++; }
  }

  const avgPrecision = precisionCount > 0 ? totalPrecision / precisionCount : null;
  const avgRecall = recallCount > 0 ? totalRecall / recallCount : null;
  const f05 = avgPrecision !== null && avgRecall !== null
    ? (1 + 0.5 * 0.5) * (avgPrecision * avgRecall) / (0.5 * 0.5 * avgPrecision + avgRecall)
    : null;
  const abstentionRate = totalAbstentionCases > 0
    ? correctAbstentions / totalAbstentionCases
    : null;

  const passed = results.filter(r => r.correct).length;

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed}/${results.length} correct`);
  console.log(`  Citation Precision: ${avgPrecision !== null ? (avgPrecision * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Citation Recall:    ${avgRecall !== null ? (avgRecall * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  F0.5 (precision-weighted): ${f05 !== null ? (f05 * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Abstention Accuracy: ${abstentionRate !== null ? (abstentionRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Threshold check: ${avgPrecision !== null && avgPrecision >= 0.95 ? 'Production-ready (>95% precision)' : avgPrecision !== null && avgPrecision >= 0.90 ? 'Clinician-in-the-loop ready (>90%)' : avgPrecision !== null ? 'Requires human verification (<90%)' : 'Insufficient data'}`);
  console.log('');

  return { results, avgPrecision, avgRecall, f05, abstentionRate, passed, total: results.length };
}

module.exports = { runBenchmark, BENCHMARK_CASES };

if (require.main === module) runBenchmark().catch(console.error);
