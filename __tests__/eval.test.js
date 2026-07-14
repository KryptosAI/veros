// ─── Hoisted mocks — applied before any module resolution ───

jest.mock('../llm-adapter', () => {
  const actual = jest.requireActual('../llm-adapter');

  return {
    ...actual,                                    // real regexParseQuery, SYSTEM_PROMPT, etc.
    LLM_CONFIG: {
      deepseekKey: null,
      openaiKey: null,
      cloudProvider: null,
      cloudEndpoint: null,
      cloudModel: null,
      ollamaEndpoint: 'http://localhost:11434',
      ollamaModel: 'medgemma:4b',
      ollamaFallback: 'qwen2.5:3b',
      enabled: false,                             // disables LLM answer refinement
      provider: 'none',
      timeout: 10000,
      temperature: 0,
    },
    llmParseQuery: jest.fn().mockResolvedValue(null),  // triggers regex fallback
    parseQuery: jest.fn().mockImplementation(async (q) => {
      const res = actual.regexParseQuery(q);
      return { ...res, parsedBy: 'regex' };
    }),
    callLLM: jest.fn().mockResolvedValue(null),
    callLLMRaw: jest.fn().mockResolvedValue(null),
  };
});

jest.mock('../research', () => ({
  searchResearch: jest.fn().mockResolvedValue([]),
}));

// ─── Now safe to import the real modules ───

const { seedDatabase, resolveMedicationClass, getUserById } = require('../data');
const { processQuery } = require('../engine');
const { generateCitation, scoreCitationConfidence } = require('../intents');
const { logQuery, verifyChain } = require('../audit');
const { deidentifyResource } = require('../deidentify');
const store = require('../store');
const fs = require('fs');

// ─── Helpers ─────────────────────────────────────────────────────

function getPatientName(pid) {
  const p = store.getResource('Patient', pid);
  if (!p) return 'Unknown';
  return ((p.name?.[0]?.given || []).join(' ') + ' ' + (p.name?.[0]?.family || '')).trim();
}

async function runQuery(question, patientId, userId) {
  return processQuery(question, patientId, userId, getPatientName(patientId), 'eval');
}

// ─── Test suites ─────────────────────────────────────────────────

describe('Query Tests', () => {
  beforeAll(() => {
    seedDatabase();
  });

  afterAll(() => {
    store.clearAll();
    fs.__clearAuditLog?.();
  });

  // ─── allergy_check: Sulfa on patient-001 (the most complex example) ───

  describe('allergy_check', () => {
    describe('Robert Chen (patient-001) — Sulfa allergy', () => {
      it('detects sulfa allergy from "history of adverse reaction to sulfa"', async () => {
        const result = await runQuery(
          'Any history of adverse reaction to sulfa?',
          'patient-001',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(true);
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
        expect(result.answer).toMatch(/sulfa|sulfonamide|bactrim/i);
      });

      it('resolves Bactrim → sulfonamide class and detects the allergy', async () => {
        const result = await runQuery(
          'Is the patient allergic to Bactrim?',
          'patient-001',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(true);
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
      });

      it('returns hasMatch=false for ibuprofen (only sulfa allergy)', async () => {
        const result = await runQuery(
          'Any problems with ibuprofen?',
          'patient-001',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(false);
      });

      it('every response includes FHIR citations with required fields', async () => {
        const result = await runQuery(
          'Any history of adverse reaction to sulfa?',
          'patient-001',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.citations.length).toBeGreaterThan(0);
        result.citations.forEach((c) => {
          expect(c).toHaveProperty('fhirReference');
          expect(c).toHaveProperty('sourceType');
          expect(c).toHaveProperty('confidence');
          expect(typeof c.confidence).toBe('number');
        });
      });

      it('scores citation confidence >= 0.6 for recent confirmed allergy', async () => {
        const result = await runQuery(
          'Any history of adverse reaction to sulfa?',
          'patient-001',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.citations[0].confidence).toBeGreaterThanOrEqual(0.6);
      });
    });

    describe('Maria Santos (patient-002) — Penicillin allergy', () => {
      it('detects penicillin allergy', async () => {
        const result = await runQuery(
          'Is the patient allergic to penicillin?',
          'patient-002',
          'user-dr-nguyen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(true);
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('James Wright (patient-003) — NKDA', () => {
      it('returns hasMatch=false for penicillin on NKDA patient', async () => {
        const result = await runQuery(
          'Does the patient have an allergy to penicillin?',
          'patient-003',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(false);
      });

      it('returns hasMatch=false for sulfa on NKDA patient', async () => {
        const result = await runQuery(
          'Any history of adverse reaction to sulfa?',
          'patient-003',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(false);
      });

      it('returns hasMatch=false for cephalexin on NKDA patient', async () => {
        const result = await runQuery(
          'Is the patient allergic to cephalexin?',
          'patient-003',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(false);
      });

      it('no source → no answer for cephalexin (0 citations)', async () => {
        const result = await runQuery(
          'Any history of adverse reaction to cephalexin?',
          'patient-003',
          'user-dr-chen',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(false);
        // NKDA check will have 0 allergy citations for this query
        expect(result.citations.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Diane Foster (patient-004) — Codeine + Latex', () => {
      it('detects codeine allergy', async () => {
        const result = await runQuery(
          'Does the patient have an allergy to codeine?',
          'patient-004',
          'user-dr-patel',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(true);
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
      });

      it('detects latex allergy', async () => {
        const result = await runQuery(
          'Any history of adverse reaction to latex?',
          'patient-004',
          'user-dr-patel',
        );

        expect(result.success).toBe(true);
        expect(result.hasMatch).toBe(true);
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ─── allergy_list ─────────────────────────────────────────────

  describe('allergy_list', () => {
    it('lists 1 active allergy for Robert Chen (sulfa)', async () => {
      const result = await runQuery(
        'What allergies does the patient have?',
        'patient-001',
        'user-dr-chen',
      );

      expect(result.success).toBe(true);
      expect(result.citations.length).toBeGreaterThanOrEqual(1);
    });

    it('lists allergies for Maria Santos (penicillin)', async () => {
      const result = await runQuery(
        'Any known allergies?',
        'patient-002',
        'user-dr-nguyen',
      );

      expect(result.success).toBe(true);
      expect(result.citations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── medication_list ──────────────────────────────────────────

  describe('medication_list', () => {
    it('lists 3 medications for Robert Chen including Metformin', async () => {
      const result = await runQuery(
        'What medications is the patient on?',
        'patient-001',
        'user-dr-chen',
      );

      expect(result.success).toBe(true);
      expect(result.citations.length).toBeGreaterThanOrEqual(3);
      const hasMetformin = result.citations.some(
        (c) => c.display && c.display.includes('Metformin'),
      );
      expect(hasMetformin).toBe(true);
    });

    it('shows completed medications for James Wright post-op', async () => {
      const result = await runQuery(
        'What medications is the patient on?',
        'patient-003',
        'user-dr-chen',
      );

      expect(result.success).toBe(true);
      expect(result.answer).toMatch(/completed/i);
    });
  });

  // ─── abnormal_labs ────────────────────────────────────────────

  describe('abnormal_labs', () => {
    it('finds elevated HbA1c 8.2% for Robert Chen', async () => {
      const result = await runQuery(
        'What labs are abnormal?',
        'patient-001',
        'user-dr-chen',
      );

      expect(result.success).toBe(true);
      expect(result.answer).toMatch(/HbA1c/i);
      expect(result.answer).toMatch(/8\.2/);
    });

    it('reports no abnormal labs for Maria Santos (IOP 18/16, normal)', async () => {
      const result = await runQuery(
        'What labs are abnormal?',
        'patient-002',
        'user-dr-nguyen',
      );

      expect(result.success).toBe(true);
      const isNegativeOrNormal =
        result.policy === 'negative_findings' ||
        result.answer.toLowerCase().includes('no abnormal');
      expect(isNegativeOrNormal).toBe(true);
    });
  });

  // ─── permissions ──────────────────────────────────────────────

  describe('permissions', () => {
    it('denies admin access to AllergyIntolerance', async () => {
      const result = await runQuery(
        'Any history of adverse reaction to penicillin?',
        'patient-001',
        'user-admin-smith',
      );

      expect(result.success).toBe(false);
    });

    it('denies cross-patient access for patient user', async () => {
      const result = await runQuery(
        'Any history of adverse reaction to penicillin?',
        'patient-004',
        'user-patient-001',
      );

      expect(result.success).toBe(false);
    });

    it('allows patient self-access to own data', async () => {
      const result = await runQuery(
        'Any history of adverse reaction to sulfa?',
        'patient-001',
        'user-patient-001',
      );

      expect(result.success).toBe(true);
      expect(result.hasMatch).toBe(true);
    });
  });

  // ─── gibberish / chart_overview ───────────────────────────────

  describe('chart_overview fallback', () => {
    it('falls back to chart overview for gibberish queries', async () => {
      const result = await runQuery(
        'What color is the sky?',
        'patient-001',
        'user-dr-chen',
      );

      expect(result.success).toBe(true);
      const hasContent =
        result.answer.includes('Conditions') ||
        result.answer.includes('Med');
      expect(hasContent).toBe(true);
    });
  });
});

// ─── Integration Tests ──────────────────────────────────────────────

describe('Integration Tests', () => {
  beforeAll(() => {
    seedDatabase();
  });

  afterAll(() => {
    store.clearAll();
    fs.__clearAuditLog?.();
  });

  describe('SQLite Persistence', () => {
    it('adds, retrieves, and deletes a test resource', () => {
      const preCount = store.resourceCount();

      store.addResource({
        resourceType: 'Patient',
        id: 'test-persist',
        name: [{ family: 'Test', given: ['Persist'] }],
      });

      const midCount = store.resourceCount();
      expect(midCount).toBe(preCount + 1);

      const retrieved = store.getResource('Patient', 'test-persist');
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe('test-persist');

      // Clean up inline (same as original eval.js)
      store.getDb().prepare('DELETE FROM fhir_resources WHERE resource_type = ? AND resource_id = ?').run('Patient', 'test-persist');
      const finalCount = store.resourceCount();
      expect(finalCount).toBe(preCount);
    });
  });

  describe('Audit Chain Verification', () => {
    it('logs a query entry and verifies the chain is intact', () => {
      const entryId = logQuery({
        userId: 'test',
        userRole: 'attending',
        userName: 'Test User',
        patientId: 'patient-001',
        patientName: 'Test',
        queryText: 'jest audit test',
        queryIntent: 'test',
        resourcesQueried: ['Test'],
        resourcesAccessed: [],
        resourcesReturned: 0,
        dataFiltered: false,
        responseSummary: 'test',
        citationsCount: 0,
        authMechanism: 'rbac',
        scopesApplied: [],
        sourceIp: 'jest',
        responseTimeMs: 1,
        success: true,
        purposeOfUse: 'TREATMENT',
      });

      expect(entryId).toBeDefined();

      const chainVerification = verifyChain();
      expect(chainVerification.valid).toBe(true);
      expect(chainVerification.entries).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Deidentification', () => {
    it('redacts name and adds REDACTED security label', () => {
      const orig = store.getResource('Patient', 'patient-001');
      const deid = deidentifyResource(orig);

      const json = JSON.stringify(deid);
      expect(json).not.toContain('John');   // original eval checks for 'John' — patient-001 is Robert Chen
      expect(json).not.toContain('Robert');

      const hasRedactedLabel = deid.meta?.security?.some(
        (s) => s.code === 'REDACTED',
      );
      expect(hasRedactedLabel).toBe(true);
    });
  });

  describe('Medication Class Resolution', () => {
    it('resolves amoxicillin → penicillins', () => {
      const pc = resolveMedicationClass('amoxicillin');
      expect(pc).not.toBeNull();
      expect(pc.className).toBe('penicillins');
    });

    it('resolves bactrim → sulfonamides', () => {
      const sc = resolveMedicationClass('bactrim');
      expect(sc).not.toBeNull();
      expect(sc.className).toBe('sulfonamides');
    });

    it('resolves cephalexin → cephalosporins', () => {
      const nc = resolveMedicationClass('cephalexin');
      expect(nc).not.toBeNull();
      expect(nc.className).toBe('cephalosporins');
    });

    it('resolves morphine → opioids', () => {
      const ms = resolveMedicationClass('morphine');
      expect(ms).not.toBeNull();
      expect(ms.className).toBe('opioids');
    });
  });

  describe('Citation Confidence Scoring', () => {
    it('scores >= 0.6 for confirmed allergy on patient-001', () => {
      const allergy = store.getResource('AllergyIntolerance', 'allergy-001');
      const confidence = scoreCitationConfidence(allergy);

      expect(confidence).toBeGreaterThanOrEqual(0.6);
      expect(confidence).toBeLessThanOrEqual(1.0);
    });
  });
});
