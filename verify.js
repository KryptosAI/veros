const store = require('./store');
const { resolveMedicationClass } = require('./data');
const { generateCitation, scoreCitationConfidence } = require('./engine');

// ── Proposition validity ─────────────────────────────
function isPropositionValid(text) {
  const t = (text || '').trim();
  if (!t || t.length < 5) return { valid: false, reason: 'too_short' };
  // Imperative — starts with command words
  if (/^(?:please|kindly|make sure|ensure that|remember to|don't forget to|do not forget to)\b/i.test(t))
    return { valid: false, reason: 'imperative' };
  // Interrogative — ends with ? OR starts with question words
  if (/\?$/.test(t))
    return { valid: false, reason: 'interrogative' };
  if (/^(?:what|where|when|why|how|who)\b/i.test(t) && /\?/.test(t))
    return { valid: false, reason: 'interrogative' };
  // Truly empty/vague — no substance at all
  if (/^(?:this|that|it|the|a|an|he|she|they|patient|is|was|are|were|has|have|had)\s*$/i.test(t))
    return { valid: false, reason: 'too_short' };
  return { valid: true };
}

// ── Claim decomposition ──────────────────────────────
async function decomposeClaim(claimText) {
  const simplePatterns = [
    /^allergic to \w/i, /^allergy to \w/i, /reacts? to \w/i,
    /^(?:the )?patient is allergic/i, /^(?:the )?patient has an? (?:allerg|react)/i,
    /^(?:has|got|have) an? allerg/i,
    /^(?:is|are) (?:the patient|they|he|she) allergic/i,
    /^no known drug allerg/i, /^NKDA/i,
    /^(?:taking|prescribed|on) \w/i,
    /^(?:has|diagnosed with) \w/i,
    /^(?:the )?patient (?:has|is) \w/i,
    /^(?:his|her|their) (?:name|age|gender|dob|mrn)/i,
  ];
  const isSimple = simplePatterns.some(p => p.test(claimText));
  if (isSimple) return [claimText];

  // Try regex-based splitting on "and" / "but" / "while" for compound claims
  const conjunctions = claimText.split(/\s+(?:and|but|while|,?\s*(?:also|additionally))\s+/i).map(s => s.trim()).filter(s => s.length > 5);
  if (conjunctions.length > 1) {
    // Check if each part looks like a standalone claim
    const allLookValid = conjunctions.every(c =>
      /\b(?:allerg|reaction|has|taking|prescribed|on|diagnosed|condition)\b/i.test(c) || c.length > 15
    );
    if (allLookValid) return conjunctions;
  }

  // Try LLM decomposition
  try {
    const { callLLMRaw } = require('./llm-adapter');
    const prompt = `Break this clinical claim into separate, verifiable statements. Each statement should be a single fact that can be independently checked against a medical record. Split on conjunctions like "and", "but", "while". Remove qualifiers like "might", "could". 

Claim: "${claimText}"

Return ONLY valid JSON: {"propositions": ["statement 1", "statement 2"]}`;

    const response = await callLLMRaw(prompt);
    const json = extractJSON(response);
    if (json?.propositions?.length > 1) {
      return json.propositions.map(p => p.trim()).filter(p => p.length > 3);
    }
  } catch { /* fall through */ }

  return [claimText];
}

function extractJSON(text) {
  const cleaned = (text || '').replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try { return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1)); }
  catch { return null; }
}

// ── Per-proposition verification ─────────────────────
function verifyProposition(proposition, patientId) {
  const type = determinePropositionType(proposition);
  const parsed = parsePropositionClaim(proposition, type);

  if (!parsed) {
    return {
      proposition,
      valid: false,
      verdict: 'UNVERIFIABLE',
      reason: 'Could not parse this proposition into a verifiable clinical claim.',
      evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: 'Unable to extract clinical entity from statement.' }] },
    };
  }

  switch (type) {
    case 'allergy': return { proposition, valid: true, ...verifyPropAllergy(parsed, patientId) };
    case 'condition': return { proposition, valid: true, ...verifyPropCondition(parsed, patientId) };
    case 'medication': return { proposition, valid: true, ...verifyPropMedication(parsed, patientId) };
    case 'lab': return { proposition, valid: true, ...verifyPropLab(parsed, patientId) };
    default: return { proposition, valid: true, verdict: 'UNVERIFIABLE', reason: 'Could not determine the type of clinical claim.', evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: 'Unknown claim type.' }] } };
  }
}

function determinePropositionType(text) {
  const lower = text.toLowerCase();
  if (/allerg|adverse\s*reaction|intoleranc|hypersensitivity|rash|hives|anaphylaxis/i.test(lower)) return 'allergy';
  if (/medication|prescribed|taking|meds?|drug|injection|drops|mg|mcg/i.test(lower)) return 'medication';
  if (/lab|test|value|level|result|a1c|glucose|egfr|creatinine|iop|pressure|acuity|vision/i.test(lower)) return 'lab';
  if (/condition|diagnosis|diagnosed|history\s*of\s*(?!adverse)|has\s+(?:a\s+)?history|suffers? from/i.test(lower)) return 'condition';
  return 'unknown';
}

function parsePropositionClaim(text, type) {
  const lower = text.toLowerCase();
  if (type === 'allergy') {
    const m = lower.match(/allerg(?:ic|y|ys|ies)\s+to\s+(\w[\w\s-]*\w)/i)
      || lower.match(/react(?:s|ion|ed)?\s+to\s+(\w[\w\s-]*\w)/i)
      || lower.match(/intoleran(?:ce|t)\s+to\s+(\w[\w\s-]*\w)/i)
      || lower.match(/cannot\s+tolerate\s+(\w[\w\s-]*\w)/i)
      || lower.match(/sensitive\s+to\s+(\w[\w\s-]*\w)/i);
    return m ? { type: 'allergy', medication: m[1].trim(), status: 'active' } : null;
  }
  if (type === 'condition') {
    const m = lower.match(/(?:has|diagnosed with|suffers? from)\s+(.+)/i)
      || lower.match(/(?:the patient has|patient has)\s+(.+)/i);
    if (m) {
      const cond = m[1].replace(/^a\s+|^an\s+/, '').trim();
      return { type: 'condition', condition: cond, status: 'active' };
    }
    return null;
  }
  if (type === 'medication') {
    const m = lower.match(/(?:taking|prescribed|on|receives?|receiving)\s+(.+)/i);
    return m ? { type: 'medication', drug: m[1].trim(), status: 'active' } : null;
  }
  if (type === 'lab') {
    const m = lower.match(/(\w[\w\s]+)\s+(?:is|was|of)\s+[\w\s]*(\d+\.?\d*)/i);
    return m ? { type: 'lab', test: m[1].trim(), value: parseFloat(m[2]) } : null;
  }
  return null;
}

// ── Per-type verification with reasons ───────────────
function verifyPropAllergy(claim, patientId) {
  const medName = claim.medication || '';
  if (!medName) return { verdict: 'UNVERIFIABLE', reason: 'No medication specified.', evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: 'No medication name found in the claim.' }] } };

  const medClass = resolveMedicationClass(medName);
  let names = [medName];
  if (medClass) names = [...new Set([medName, ...medClass.terms])];

  const allergies = store.searchAllergiesByMedication(patientId, names);
  const medRequests = store.searchMedicationRequests(patientId, names);
  const supporting = [], contradicting = [], unverifiable = [];

  for (const a of allergies) {
    const citation = generateCitation(a);
    const critNote = a.criticality === 'high' ? 'HIGH RISK — ' : '';
    const reactionNote = a.reaction?.[0]?.manifestation?.[0]?.text || '';
    const detail = `Found ${a.code?.text || 'allergy'} in chart (${critNote}${a.verificationStatus?.coding?.[0]?.code || 'confirmed'}${reactionNote ? ', reaction: ' + reactionNote : ''}).`;
    supporting.push({ citation, relationship: 'direct_match', detail });
  }

  if (allergies.length === 0) {
    const nkda = store.searchAllAllergies(patientId).find(a =>
      a.code?.coding?.some(c => c.code === '409137002' || (c.display || '').toLowerCase().includes('no known')) ||
      (a.code?.text || '').toLowerCase().includes('no known')
    );
    if (nkda) {
      contradicting.push({ citation: generateCitation(nkda), relationship: 'direct_contradiction', detail: `Chart documents no known drug allergies — contradicts claim of ${medName} allergy.` });
    } else if (medRequests.length > 0) {
      const tolerated = medRequests.filter(m => m.status !== 'stopped');
      if (tolerated.length) {
        contradicting.push({ citation: generateCitation(tolerated[0]), relationship: 'tolerated', detail: `Patient was prescribed ${tolerated.map(m => m.medicationCodeableConcept?.text).join(', ')} without documented reaction.` });
      } else {
        unverifiable.push({ detail: `No allergy record found for ${medName} and no evidence of prior exposure.` });
      }
    } else {
      unverifiable.push({ detail: `No allergy or medication history found for ${medName}.` });
    }
  }

  return buildVerdict(supporting, contradicting, unverifiable);
}

function verifyPropCondition(claim, patientId) {
  const condName = claim.condition || '';
  if (!condName) return { verdict: 'UNVERIFIABLE', reason: 'No condition specified.', evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: 'No condition name found.' }] } };

  const conditions = store.searchConditions(patientId).filter(c =>
    (c.code?.text || '').toLowerCase().includes(condName.toLowerCase()) ||
    (c.code?.coding || []).some(cd => (cd.display || '').toLowerCase().includes(condName.toLowerCase()))
  );

  const supporting = [], contradicting = [];

  for (const c of conditions) {
    const citation = generateCitation(c);
    if (claim.status && c.clinicalStatus?.coding?.[0]?.code !== claim.status) {
      contradicting.push({ citation, relationship: 'status_mismatch', detail: `Found '${c.code?.text}' but status is '${c.clinicalStatus?.coding?.[0]?.code}', not '${claim.status}'.` });
    } else {
      supporting.push({ citation, relationship: 'direct_match', detail: `Confirmed: '${c.code?.text}' is documented (${c.clinicalStatus?.coding?.[0]?.code || 'unknown'}).` });
    }
  }

  if (conditions.length === 0) {
    return { verdict: 'UNVERIFIABLE', reason: `No condition matching '${condName}' found in chart.`, evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: `No diagnosis of '${condName}' in patient record.` }] } };
  }

  return buildVerdict(supporting, contradicting, []);
}

function verifyPropMedication(claim, patientId) {
  const drugName = claim.drug || '';
  if (!drugName) return { verdict: 'UNVERIFIABLE', reason: 'No medication specified.', evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: 'No drug name found.' }] } };

  const meds = store.searchAllMedications(patientId).filter(m =>
    (m.medicationCodeableConcept?.text || '').toLowerCase().includes(drugName.toLowerCase()) ||
    (m.medicationCodeableConcept?.coding || []).some(cd => (cd.display || '').toLowerCase().includes(drugName.toLowerCase()))
  );

  const supporting = [], contradicting = [];

  for (const m of meds) {
    const citation = generateCitation(m);
    if (claim.status && m.status !== claim.status) {
      contradicting.push({ citation, relationship: 'status_mismatch', detail: `Found '${m.medicationCodeableConcept?.text}' but status is '${m.status}', not '${claim.status}'.` });
    } else if (m.status === 'stopped') {
      contradicting.push({ citation, relationship: 'stopped', detail: `Medication was stopped — ${m.note?.[0]?.text || 'no reason documented'}.` });
    } else {
      supporting.push({ citation, relationship: 'direct_match', detail: `Confirmed: ${m.medicationCodeableConcept?.text} — ${m.status} (${m.intent}${m.dosageInstruction?.[0]?.text ? ', ' + m.dosageInstruction[0].text : ''}).` });
    }
  }

  if (meds.length === 0) {
    return { verdict: 'UNVERIFIABLE', reason: `No medication matching '${drugName}' found.`, evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: `No prescription for '${drugName}' in record.` }] } };
  }

  return buildVerdict(supporting, contradicting, []);
}

function verifyPropLab(claim, patientId) {
  const testName = claim.test || '';
  if (!testName) return { verdict: 'UNVERIFIABLE', reason: 'No lab test specified.', evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: 'No test name found.' }] } };

  const obs = store.searchObservations(patientId).filter(o =>
    (o.code?.text || '').toLowerCase().includes(testName.toLowerCase()) ||
    (o.code?.coding || []).some(cd => (cd.display || '').toLowerCase().includes(testName.toLowerCase()))
  );

  const supporting = [], contradicting = [];

  for (const o of obs) {
    const citation = generateCitation(o);
    if (claim.value !== undefined && o.valueQuantity) {
      const actual = o.valueQuantity.value;
      const tolerance = claim.tolerance || (Math.abs(actual) * 0.05);
      if (Math.abs(actual - claim.value) <= tolerance) {
        supporting.push({ citation, relationship: 'exact_match', detail: `Confirmed: ${o.code?.text} = ${actual} ${o.valueQuantity.unit || ''} (matches claimed ${claim.value}).` });
      } else {
        contradicting.push({ citation, relationship: 'value_mismatch', detail: `Found ${o.code?.text} = ${actual} ${o.valueQuantity.unit || ''} — differs from claimed ${claim.value}.` });
      }
    } else {
      supporting.push({ citation, relationship: 'found', detail: `Found: ${o.code?.text} = ${o.valueQuantity?.value ?? o.valueString ?? 'N/A'}.` });
    }
  }

  if (obs.length === 0) {
    return { verdict: 'UNVERIFIABLE', reason: `No lab result for '${testName}' found.`, evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: `No observation matching '${testName}' in record.` }] } };
  }

  return buildVerdict(supporting, contradicting, []);
}

function buildVerdict(supporting, contradicting, unverifiable) {
  if (supporting.length > 0 && contradicting.length === 0) {
    const reason = `Verified — ${supporting.map(s => s.detail).join(' ')}`;
    return { verdict: 'VERIFIED', reason, evidence: { supporting, contradicting, unverifiableParts: unverifiable } };
  }
  if (contradicting.length > 0 && supporting.length === 0) {
    const reason = `Contradicted — ${contradicting.map(c => c.detail).join(' ')}`;
    return { verdict: 'CONTRADICTED', reason, evidence: { supporting, contradicting, unverifiableParts: unverifiable } };
  }
  if (contradicting.length > 0 && supporting.length > 0) {
    const reason = `Mixed — ${supporting.length} finding(s) support this, but ${contradicting.length} contradict.`;
    return { verdict: 'CONTRADICTED', reason, evidence: { supporting, contradicting, unverifiableParts: unverifiable } };
  }
  const reason = `Unverifiable — ${unverifiable.map(u => u.detail).join(' ') || 'No data found.'}`;
  return { verdict: 'UNVERIFIABLE', reason, evidence: { supporting: [], contradicting: [], unverifiableParts: unverifiable } };
}

// ── Main verify function ─────────────────────────────
async function verifyClaim(claim, patientId) {
  if (typeof claim === 'string') {
    const validity = isPropositionValid(claim);
    if (!validity.valid) {
      return {
        verdict: 'UNVERIFIABLE',
        reason: `Cannot verify — ${validity.reason === 'too_short' ? 'statement is too short' : validity.reason === 'imperative' ? 'this is a command, not a verifiable claim' : validity.reason === 'interrogative' ? 'this is a question, not a verifiable claim' : validity.reason === 'speculative' ? 'statement is too vague or speculative' : 'no clinical terms found'}.`,
        evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: `Failed validity check: ${validity.reason}` }] },
        decomposed: false,
      };
    }

    // Decompose into atomic propositions
    const propositions = await decomposeClaim(claim);

    if (propositions.length === 1) {
      // Single proposition — verify directly
      const result = verifyProposition(propositions[0], patientId);
      return { ...result, decomposed: false };
    }

    // Multiple propositions — verify each independently
    const results = propositions.map(p => {
      const v = isPropositionValid(p);
      if (!v.valid) return { proposition: p, valid: false, verdict: 'UNVERIFIABLE', reason: `Skipped — ${v.reason}.`, evidence: { supporting: [], contradicting: [], unverifiableParts: [] } };
      return verifyProposition(p, patientId);
    });

    const allVerified = results.every(r => r.verdict === 'VERIFIED');
    const anyContradicted = results.some(r => r.verdict === 'CONTRADICTED');
    const anyUnverifiable = results.some(r => r.verdict === 'UNVERIFIABLE');

    let overallVerdict;
    if (anyContradicted) overallVerdict = 'CONTRADICTED';
    else if (anyUnverifiable && allVerified === false) overallVerdict = 'PARTIALLY_VERIFIED';
    else if (allVerified) overallVerdict = 'VERIFIED';
    else overallVerdict = 'UNVERIFIABLE';

    return {
      verdict: overallVerdict,
      reason: `${results.filter(r => r.verdict === 'VERIFIED').length} verified, ${results.filter(r => r.verdict === 'CONTRADICTED').length} contradicted, ${results.filter(r => r.verdict === 'UNVERIFIABLE').length} unverifiable.`,
      evidence: {
        supporting: results.flatMap(r => r.evidence?.supporting || []),
        contradicting: results.flatMap(r => r.evidence?.contradicting || []),
        unverifiableParts: results.flatMap(r => r.evidence?.unverifiableParts || []),
      },
      decomposed: true,
      propositions: results,
    };
  }

  // Structured claim — verify directly
  const parsedClaim = claim;
  const type = parsedClaim.type || 'unknown';
  let result;
  if (type === 'allergy') result = verifyPropAllergy(parsedClaim, patientId);
  else if (type === 'condition') result = verifyPropCondition(parsedClaim, patientId);
  else if (type === 'medication') result = verifyPropMedication(parsedClaim, patientId);
  else if (type === 'lab') result = verifyPropLab(parsedClaim, patientId);
  else if (type === 'relationship' || type === 'compound') {
    const subClaims = parsedClaim.supporting || parsedClaim.claims || [];
    const results = subClaims.map(sc => verifyClaim(sc, patientId));
    // Works synchronously because structured sub-claims are objects
    return {
      verdict: results.every(r => r.verdict === 'VERIFIED') ? 'VERIFIED' : results.some(r => r.verdict === 'CONTRADICTED') ? 'CONTRADICTED' : 'PARTIALLY_VERIFIED',
      reason: `${results.filter(r => r.verdict === 'VERIFIED').length} of ${results.length} sub-claims verified.`,
      evidence: {
        supporting: results.flatMap(r => r.evidence?.supporting || []),
        contradicting: results.flatMap(r => r.evidence?.contradicting || []),
        unverifiableParts: results.flatMap(r => r.evidence?.unverifiableParts || []),
      },
      decomposed: true,
      subResults: results,
    };
  } else {
    result = { verdict: 'UNVERIFIABLE', reason: `Unknown claim type: '${type}'.`, evidence: { supporting: [], contradicting: [], unverifiableParts: [{ detail: `Unsupported claim type.` }] } };
  }

  return { ...result, decomposed: false };
}

function verifyClaims(claims, patientId) {
  const results = claims.map(c => verifyClaim(c, patientId));
  return {
    summary: {
      total: results.length,
      verified: results.filter(r => r.verdict === 'VERIFIED').length,
      contradicted: results.filter(r => r.verdict === 'CONTRADICTED').length,
      unverifiable: results.filter(r => r.verdict === 'UNVERIFIABLE').length,
    },
    results,
  };
}

module.exports = { verifyClaim, verifyClaims, isPropositionValid, decomposeClaim };
