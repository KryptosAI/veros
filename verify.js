const store = require('./store');
const { resolveMedicationClass } = require('./data');
const { generateCitation, scoreCitationConfidence } = require('./engine');

function determineClaimType(claim) {
  if (typeof claim === 'string') {
    const lower = claim.toLowerCase();
    if (/allerg|adverse\s*reaction|intoleranc|hypersensitivity/i.test(lower)) return 'allergy';
    if (/medication|prescribed|taking|meds?|drug/i.test(lower)) return 'medication';
    if (/lab|test|value|level|result|a1c|glucose|egfr|creatinine|blood/i.test(lower)) return 'lab';
    if (/condition|diagnosis|diagnosed|history\s*of\s*(?!adverse)|has\s+(?:a\s+)?history/i.test(lower)) return 'condition';
    return 'unknown';
  }
  return claim.type || 'unknown';
}

function parseNaturalLanguageClaim(claimText) {
  const lower = claimText.toLowerCase();

  const allergyMatch = lower.match(/(?:patient\s+(?:has|is)\s+)?(?:an?\s+)?allerg(?:y|ic)\s+to\s+(\w[\w\s-]*\w)/i)
    || lower.match(/(?:has\s+)?(?:an?\s+)?(?:adverse\s+)?reaction\s+to\s+(\w[\w\s-]*\w)/i)
    || lower.match(/intoleran(?:ce|t)\s+to\s+(\w[\w\s-]*\w)/i)
    || lower.match(/cannot\s+tolerate\s+(\w[\w\s-]*\w)/i)
    || lower.match(/(?:doesn't|does\s+not)\s+tolerate\s+(\w[\w\s-]*\w)/i)
    || lower.match(/sensitive\s+to\s+(\w[\w\s-]*\w)/i);

  if (allergyMatch) {
    return { type: 'allergy', medication: allergyMatch[1].trim(), status: 'active' };
  }

  const conditionMatch = lower.match(/(?:has|diagnosed\s+with|history\s+of)\s+(\w[\w\s]+)/i);
  if (conditionMatch) {
    const cond = conditionMatch[1].trim();
    if (!/allerg|reaction|medication|drug/i.test(cond)) {
      return { type: 'condition', condition: cond, status: 'active' };
    }
  }

  const medMatch = lower.match(/(?:taking|prescribed|on)\s+(\w[\w\s]+)/i);
  if (medMatch) {
    return { type: 'medication', drug: medMatch[1].trim(), status: 'active' };
  }

  const labMatch = lower.match(/(\w[\w\s]+)\s+(?:is|was)\s+(\d+\.?\d*)/i);
  if (labMatch) {
    return { type: 'lab', test: labMatch[1].trim(), value: parseFloat(labMatch[2]) };
  }

  return { type: 'unknown', original: claimText };
}

function verifyAllergyClaim(claim, patientId) {
  const medName = claim.medication || '';
  if (!medName) return { verdict: 'UNVERIFIABLE', reason: 'No medication specified in allergy claim' };

  const medClass = resolveMedicationClass(medName);
  let medicationNames = [medName];
  if (medClass) medicationNames = [...new Set([medName, ...medClass.terms])];

  const allergies = store.searchAllergiesByMedication(patientId, medicationNames);
  const medRequests = store.searchMedicationRequests(patientId, medicationNames);

  const supporting = [];
  const contradicting = [];
  const unverifiableParts = [];

  for (const allergy of allergies) {
    const citation = generateCitation(allergy);
    const matches = {};

    if (claim.status && allergy.clinicalStatus?.coding?.[0]?.code !== claim.status) {
      matches.statusMismatch = true;
    }
    if (claim.criticality && allergy.criticality !== claim.criticality) {
      matches.criticalityMismatch = true;
    }
    if (claim.reaction) {
      const hasReaction = (allergy.reaction || []).some(r =>
        (r.manifestation || []).some(m =>
          (m.text || '').toLowerCase().includes(claim.reaction.toLowerCase()) ||
          (m.coding || []).some(c => (c.display || '').toLowerCase().includes(claim.reaction.toLowerCase()))
        )
      );
      if (!hasReaction) matches.reactionMismatch = true;
    }

    const hasMismatch = Object.values(matches).some(v => v);
    if (hasMismatch) {
      contradicting.push({
        citation,
        relationship: 'partial_mismatch',
        detail: `Found allergy but ${Object.entries(matches).filter(([,v]) => v).map(([k]) => k.replace('Mismatch', '')).join(', ')} differ`,
        mismatches: matches,
      });
    } else {
      const classNote = medClass && medName.toLowerCase() !== allergy.code?.text?.toLowerCase()
        ? ` (matched via ${medClass.className} class: ${medName} → ${allergy.code?.text})`
        : '';
      supporting.push({
        citation,
        relationship: 'direct_match',
        detail: `Confirmed ${allergy.code?.text || 'allergy'} — ${allergy.criticality === 'high' ? 'HIGH RISK' : 'known'}${classNote}`,
      });
    }
  }

  if (allergies.length === 0) {
    const nkda = store.searchAllAllergies(patientId).find(a =>
      a.code?.coding?.some(c => c.code === '409137002' || (c.display || '').toLowerCase().includes('no known')) ||
      (a.code?.text || '').toLowerCase().includes('no known')
    );

    if (nkda) {
      contradicting.push({
        citation: generateCitation(nkda),
        relationship: 'direct_contradiction',
        detail: `Patient record shows no known drug allergies — contradicts claim of ${medName} allergy`,
      });
    } else if (medRequests.length > 0) {
      const tolerated = medRequests.filter(m => m.status !== 'stopped');
      if (tolerated.length > 0) {
        contradicting.push({
          citation: generateCitation(tolerated[0]),
          relationship: 'tolerated_medication',
          detail: `Patient has been prescribed ${tolerated.map(m => m.medicationCodeableConcept?.text || 'this').join(', ')} with no documented adverse reaction`,
        });
      } else {
        unverifiableParts.push({
          detail: `No allergy data found for ${medName}. ${medClass ? `Checked ${medClass.terms.length} medications in ${medClass.className} class.` : ''}`,
          searched: ['AllergyIntolerance', 'MedicationRequest'],
        });
      }
    } else {
      unverifiableParts.push({
        detail: `No data found for ${medName} allergy or tolerance`,
        searched: ['AllergyIntolerance', 'MedicationRequest'],
      });
    }
  }

  return buildVerdict(supporting, contradicting, unverifiableParts);
}

function verifyConditionClaim(claim, patientId) {
  const condName = claim.condition || '';
  if (!condName) return { verdict: 'UNVERIFIABLE', reason: 'No condition specified' };

  const conditions = store.searchConditions(patientId).filter(c =>
    (c.code?.text || '').toLowerCase().includes(condName.toLowerCase()) ||
    (c.code?.coding || []).some(cd => (cd.display || '').toLowerCase().includes(condName.toLowerCase()))
  );

  const supporting = [];
  const contradicting = [];

  for (const condition of conditions) {
    const citation = generateCitation(condition);

    if (claim.status && condition.clinicalStatus?.coding?.[0]?.code !== claim.status) {
      contradicting.push({
        citation,
        relationship: 'status_mismatch',
        detail: `Found '${condition.code?.text}' but status is '${condition.clinicalStatus?.coding?.[0]?.code}', not '${claim.status}'`,
      });
    } else {
      supporting.push({
        citation,
        relationship: 'direct_match',
        detail: `Confirmed diagnosis: ${condition.code?.text} (${condition.clinicalStatus?.coding?.[0]?.code || 'unknown'})`,
      });
    }
  }

  if (conditions.length === 0) {
    return {
      verdict: 'UNVERIFIABLE',
      confidence: 0,
      evidence: {
        supporting: [],
        contradicting: [],
        unverifiableParts: [{ detail: `No condition matching '${condName}' found in patient record`, searched: ['Condition'] }],
      },
      policy: 'no_source_no_verification',
    };
  }

  return buildVerdict(supporting, contradicting, []);
}

function verifyMedicationClaim(claim, patientId) {
  const drugName = claim.drug || '';
  if (!drugName) return { verdict: 'UNVERIFIABLE', reason: 'No medication specified' };

  const meds = store.searchAllMedications(patientId).filter(m =>
    (m.medicationCodeableConcept?.text || '').toLowerCase().includes(drugName.toLowerCase()) ||
    (m.medicationCodeableConcept?.coding || []).some(cd => (cd.display || '').toLowerCase().includes(drugName.toLowerCase()))
  );

  const supporting = [];
  const contradicting = [];

  for (const med of meds) {
    const citation = generateCitation(med);

    if (claim.status && med.status !== claim.status) {
      contradicting.push({
        citation,
        relationship: 'status_mismatch',
        detail: `Found '${med.medicationCodeableConcept?.text}' but status is '${med.status}', not '${claim.status}'`,
      });
    } else if (med.status === 'stopped') {
      contradicting.push({
        citation,
        relationship: 'stopped',
        detail: `Medication was stopped — ${med.note?.[0]?.text || 'no reason documented'}`,
      });
    } else {
      const dosageMatch = claim.dosage
        ? (med.dosageInstruction || []).some(d => (d.text || '').toLowerCase().includes(claim.dosage.toLowerCase()))
        : true;

      if (!dosageMatch) {
        contradicting.push({
          citation,
          relationship: 'dosage_mismatch',
          detail: `Found medication but dosage differs from claimed '${claim.dosage}'`,
        });
      } else {
        supporting.push({
          citation,
          relationship: 'direct_match',
          detail: `Confirmed: ${med.medicationCodeableConcept?.text} — ${med.status} (${med.intent})`,
        });
      }
    }
  }

  if (meds.length === 0) {
    return {
      verdict: 'UNVERIFIABLE',
      confidence: 0,
      evidence: {
        supporting: [],
        contradicting: [],
        unverifiableParts: [{ detail: `No medication matching '${drugName}' found in patient record`, searched: ['MedicationRequest'] }],
      },
      policy: 'no_source_no_verification',
    };
  }

  return buildVerdict(supporting, contradicting, []);
}

function verifyLabClaim(claim, patientId) {
  const testName = claim.test || '';
  if (!testName) return { verdict: 'UNVERIFIABLE', reason: 'No lab test specified' };

  const observations = store.searchObservations(patientId).filter(o =>
    (o.code?.text || '').toLowerCase().includes(testName.toLowerCase()) ||
    (o.code?.coding || []).some(cd => (cd.display || '').toLowerCase().includes(testName.toLowerCase()))
  );

  const supporting = [];
  const contradicting = [];

  for (const obs of observations) {
    const citation = generateCitation(obs);

    if (claim.value !== undefined && obs.valueQuantity) {
      const actualValue = obs.valueQuantity.value;
      const tolerance = claim.tolerance || (actualValue * 0.05);

      if (Math.abs(actualValue - claim.value) <= tolerance) {
        supporting.push({
          citation,
          relationship: 'exact_match',
          detail: `Confirmed: ${obs.code?.text} = ${actualValue} ${obs.valueQuantity.unit || ''} (claimed ${claim.value})`,
        });
      } else {
        contradicting.push({
          citation,
          relationship: 'value_mismatch',
          detail: `Found ${obs.code?.text} = ${actualValue} ${obs.valueQuantity.unit || ''}, which differs from claimed ${claim.value}`,
        });
      }
    } else {
      supporting.push({
        citation,
        relationship: 'test_found',
        detail: `Found: ${obs.code?.text} = ${obs.valueQuantity?.value || obs.valueString || 'unknown'}`,
      });
    }
  }

  if (observations.length === 0) {
    return {
      verdict: 'UNVERIFIABLE',
      confidence: 0,
      evidence: {
        supporting: [],
        contradicting: [],
        unverifiableParts: [{ detail: `No lab result matching '${testName}' found in patient record`, searched: ['Observation'] }],
      },
      policy: 'no_source_no_verification',
    };
  }

  return buildVerdict(supporting, contradicting, []);
}

function verifyCompoundClaim(claim, patientId) {
  const subClaims = claim.supporting || claim.claims || [];
  if (subClaims.length === 0) {
    return { verdict: 'UNVERIFIABLE', reason: 'Compound claim requires supporting.claims array' };
  }

  const results = subClaims.map(sc => verifyClaim(sc, patientId));
  const allVerified = results.every(r => r.verdict === 'VERIFIED');
  const anyContradicted = results.some(r => r.verdict === 'CONTRADICTED');
  const anyUnverifiable = results.some(r => r.verdict === 'UNVERIFIABLE' || r.verdict === 'PARTIALLY_VERIFIED');

  const supporting = results.flatMap(r => r.evidence?.supporting || []);
  const contradicting = results.flatMap(r => r.evidence?.contradicting || []);
  const unverifiableParts = results.flatMap(r => r.evidence?.unverifiableParts || []);

  if (anyContradicted) {
    return {
      verdict: 'CONTRADICTED',
      confidence: supporting.length / (supporting.length + contradicting.length + 1),
      evidence: { supporting, contradicting, unverifiableParts },
      subResults: results,
      policy: 'compound_contradicted',
    };
  }

  if (anyUnverifiable) {
    return {
      verdict: 'PARTIALLY_VERIFIED',
      confidence: supporting.length / (supporting.length + unverifiableParts.length + 1),
      evidence: { supporting, contradicting, unverifiableParts },
      subResults: results,
      policy: 'compound_partial',
    };
  }

  return {
    verdict: 'VERIFIED',
    confidence: 0.95,
    evidence: { supporting, contradicting: [], unverifiableParts: [] },
    subResults: results,
    policy: 'compound_verified',
  };
}

function buildVerdict(supporting, contradicting, unverifiableParts) {
  const total = supporting.length + contradicting.length + unverifiableParts.length || 1;

  if (supporting.length > 0 && contradicting.length === 0) {
    return {
      verdict: 'VERIFIED',
      confidence: supporting.length / total,
      evidence: { supporting, contradicting, unverifiableParts },
      policy: 'all_claims_cited',
    };
  }

  if (contradicting.length > 0 && supporting.length === 0) {
    return {
      verdict: 'CONTRADICTED',
      confidence: contradicting.length / total,
      evidence: { supporting, contradicting, unverifiableParts },
      policy: 'claim_contradicted',
    };
  }

  if (supporting.length > 0 && contradicting.length > 0) {
    return {
      verdict: 'CONTRADICTED',
      confidence: contradicting.length / total,
      evidence: { supporting, contradicting, unverifiableParts },
      policy: 'mixed_evidence_contradicted',
    };
  }

  return {
    verdict: 'UNVERIFIABLE',
    confidence: 0,
    evidence: { supporting: [], contradicting: [], unverifiableParts },
    policy: 'no_source_no_verification',
  };
}

function verifyClaim(claim, patientId) {
  let parsedClaim;

  if (typeof claim === 'string') {
    parsedClaim = parseNaturalLanguageClaim(claim);
    if (parsedClaim.type === 'unknown') {
      return {
        verdict: 'UNVERIFIABLE',
        confidence: 0,
        evidence: {
          supporting: [],
          contradicting: [],
          unverifiableParts: [{ detail: 'Could not parse claim into a verifiable type. Please use structured format: {"type":"allergy","medication":"penicillin"} or one of: allergy, condition, medication, lab', searched: [] }],
        },
        policy: 'unparseable_claim',
        originalClaim: claim,
      };
    }
  } else {
    parsedClaim = claim;
  }

  switch (parsedClaim.type) {
    case 'allergy':
      return verifyAllergyClaim(parsedClaim, patientId);
    case 'condition':
      return verifyConditionClaim(parsedClaim, patientId);
    case 'medication':
      return verifyMedicationClaim(parsedClaim, patientId);
    case 'lab':
      return verifyLabClaim(parsedClaim, patientId);
    case 'relationship':
    case 'compound':
      return verifyCompoundClaim(parsedClaim, patientId);
    default:
      return {
        verdict: 'UNVERIFIABLE',
        confidence: 0,
        evidence: {
          supporting: [], contradicting: [],
          unverifiableParts: [{ detail: `Unknown claim type: '${parsedClaim.type}'. Supported types: allergy, condition, medication, lab, relationship`, searched: [] }],
        },
        policy: 'unknown_claim_type',
      };
  }
}

function verifyClaims(claims, patientId) {
  const results = claims.map(c => verifyClaim(c, patientId));
  const verified = results.filter(r => r.verdict === 'VERIFIED').length;
  const contradicted = results.filter(r => r.verdict === 'CONTRADICTED').length;
  const unverifiable = results.filter(r => r.verdict === 'UNVERIFIABLE').length;
  const partial = results.filter(r => r.verdict === 'PARTIALLY_VERIFIED').length;

  return {
    summary: {
      total: results.length,
      verified,
      contradicted,
      unverifiable,
      partiallyVerified: partial,
      verifiedRate: results.length > 0 ? verified / results.length : 0,
    },
    results,
    policy: 'bulk_verification',
  };
}

module.exports = { verifyClaim, verifyClaims, parseNaturalLanguageClaim, determineClaimType };
