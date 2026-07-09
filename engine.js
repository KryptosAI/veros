const { ROLES, getUserById, resolveMedicationClass, MEDICATION_CLASSES } = require('./data');
const store = require('./store');
const { parseQuery: llmParseQuery } = require('./llm-adapter');

function validatePermissions(userId, patientId, resourceTypes) {
  const user = getUserById(userId);
  if (!user) return { allowed: false, reason: 'User not found' };

  const role = ROLES[user.role];
  if (!role) return { allowed: false, reason: 'Unknown role' };

  if (user.role === 'patient' && user.patient_id !== patientId) {
    return { allowed: false, reason: 'Patient can only access own records' };
  }

  for (const rt of resourceTypes) {
    const access = role.access[rt];
    if (!access || !access.includes('r')) {
      return {
        allowed: false,
        reason: `Role '${user.role}' (${role.label}) lacks read access to ${rt} resources`,
        missingResource: rt,
      };
    }
  }

  return {
    allowed: true,
    role: user.role,
    roleLabel: role.label,
    userName: user.name,
    scopes: resourceTypes.map(rt => `patient/${rt}.rs`),
  };
}

const ALLERGY_QUERY_PATTERNS = [
  /(?:any\s+)?history\s+(?:of\s+)?(?:an?\s+)?(?:adverse\s+)?reaction\s+to\s+(\w[\w\s-]*\w)/i,
  /(?:is\s+(?:the\s+)?(?:patient|pt)\s+)?allergic\s+to\s+(\w[\w\s-]*\w)/i,
  /allergy\s+to\s+(\w[\w\s-]*\w)/i,
  /intolerance\s+to\s+(\w[\w\s-]*\w)/i,
  /(?:any\s+)?problems?\s+with\s+(\w[\w\s-]*\w)/i,
  /hypersensitivity\s+to\s+(\w[\w\s-]*\w)/i,
  /(?:does\s+(?:the\s+)?(?:patient|pt)\s+)?have\s+(?:an?\s+)?(?:allergy|reaction)\s+to\s+(\w[\w\s-]*\w)/i,
];

const GENERIC_ALLERGY_PATTERNS = [
  /(?:what|any)\s+allerg(?:y|ies)/i,
  /(?:list|show)\s+(?:all\s+)?allerg(?:y|ies)/i,
  /(?:any|all)\s+(?:known\s+)?allerg(?:y|ies)/i,
  /(?:what|any)\s+(?:adverse\s+)?reactions/i,
  /allergic\s+to\s+anything/i,
  /what\s+(?:am\s+)?i\s+allergic\s+to/i,
];

const MED_HISTORY_PATTERNS = [
  /(?:what\s+)?(?:medications|meds|drugs)\s+(?:is|are|has|does).*?(?:taking|prescribed|on)/i,
  /(?:current|active)\s+(?:medications|meds|drugs)/i,
  /(?:list|show)\s+(?:all\s+)?(?:medications|meds|drugs)/i,
  /what\s+(?:is|are)\s+(?:the\s+)?(?:patient|pt)\s+(?:taking|on)/i,
  /(?:show|list)\s+(?:active\s+)?meds/i,
];

const LAB_QUERY_PATTERNS = [
  /(?:what|which|any)\s+labs?\s+(?:are|is|were)\s+(?:abnormal|out\s+of\s+range|high|low|elevated|flagged)/i,
  /(?:show|list)\s+abnormal\s+labs/i,
  /(?:any|what)\s+labs?\s+(?:are|is)\s+concerning/i,
  /what\s+(?:labs?|results?)\s+(?:are|is|were)\s+(?:abnormal|out\s+of\s+range)/i,
];

const DEMOGRAPHIC_PATTERNS = [
  /how\s+old\s+(?:is|are|be|was|were)\s*(?:he|she|they|the\s+patient|this\s+patient|the\s+pt|pt|this\s+dude|this\s+guy|this\s+lady|this\s+man|this\s+woman)?\s*\??/i,
  /how\s+old\s+he\b/i,
  /how\s+old\s+she\b/i,
  /how\s+old\s+they\b/i,
  /how\s+old\s*(?:\?|$)/i,
  /what'?s?\s+(?:his|her|their|the\s+patient'?s?|pt'?s?\s+)?age\s*\??/i,
  /(?:what\s+(?:is|are)\s+)?(?:his|her|their|the\s+patient'?s?|pt'?s?\s+)?(?:birth\s*date|dob|birthday|date\s+of\s+birth)\s*\??/i,
  /when\s+was\s+(?:he|she|they|the\s+patient|this\s+patient)\s+born\??/i,
  /(?:what\s+(?:is|are)\s+)?(?:his|her|their|the\s+patient'?s?|pt'?s?\s+)?name\s*\??/i,
  /(?:what\s+(?:is|are)\s+)?(?:his|her|their|the\s+patient'?s?|pt'?s?\s+)?(?:gender|sex)\s*\??/i,
  /(?:is\s+)?(?:he|she|the\s+patient|this\s+patient)\s+(?:male|female)\??/i,
  /(?:what\s+(?:is|are)\s+)?(?:his|her|their|the\s+patient'?s?|pt'?s?\s+)?MRN\s*\??/i,
];

function parseQuery(question) {
  const q = question.trim();

  for (const pattern of ALLERGY_QUERY_PATTERNS) {
    const match = q.match(pattern);
    if (match) {
      return { type: 'allergy_check', medication: match[1].trim(), intent: `Check for adverse reaction/allergy to ${match[1].trim()}` };
    }
  }

  for (const pattern of GENERIC_ALLERGY_PATTERNS) {
    if (pattern.test(q)) return { type: 'allergy_list', intent: 'List all known allergies' };
  }

  for (const pattern of MED_HISTORY_PATTERNS) {
    if (pattern.test(q)) return { type: 'medication_list', intent: 'List current/active medications' };
  }

  for (const pattern of LAB_QUERY_PATTERNS) {
    if (pattern.test(q)) return { type: 'abnormal_labs', intent: 'Find abnormal lab results' };
  }

  for (const pattern of DEMOGRAPHIC_PATTERNS) {
    if (pattern.test(q)) return { type: 'demographic', intent: 'Patient demographic information' };
  }

  return { type: 'unknown', intent: 'Unrecognized query pattern' };
}

function searchFHIR(patientId, parsedQuery) {
  if (parsedQuery.type === 'allergy_check') {
    const medName = parsedQuery.medication;
    const medClass = resolveMedicationClass(medName);
    let medicationNames = [medName];
    if (medClass) medicationNames = [...new Set([medName, ...medClass.terms])];

    const allergies = store.searchAllergiesByMedication(patientId, medicationNames);
    const medRequests = store.searchMedicationRequests(patientId, medicationNames);

    const stoppedWithAllergy = medRequests.filter(m =>
      m.status === 'stopped' &&
      allergies.some(a => {
        const allergyOnset = a.onsetDateTime || a.recordedDate || '';
        const medStop = m.meta?.lastUpdated || '';
        return allergyOnset && medStop && medStop > allergyOnset;
      })
    );
    const stoppedMatch = stoppedWithAllergy.length > 0 ? {
      meds: stoppedWithAllergy.map(m => m.medicationCodeableConcept?.text || 'unknown'),
      allergySubstance: allergies[0]?.code?.text || 'the medication',
    } : null;

    return { type: 'allergy_check', allergies, medRequests, medicationNames, stoppedMatch };
  }

  if (parsedQuery.type === 'allergy_list') {
    return { type: 'allergy_list', allergies: store.searchAllAllergies(patientId) };
  }

  if (parsedQuery.type === 'medication_list') {
    return { type: 'medication_list', medications: store.searchAllMedications(patientId) };
  }

  if (parsedQuery.type === 'abnormal_labs') {
    const allObs = store.searchObservations(patientId);
    const abnormal = allObs.filter(obs => {
      if (!obs.valueQuantity || !obs.referenceRange || obs.referenceRange.length === 0) return false;
      for (const range of obs.referenceRange) {
        const val = obs.valueQuantity.value;
        if (range.high?.value !== undefined && val > range.high.value) return true;
        if (range.low?.value !== undefined && val < range.low.value) return true;
      }
      return false;
    });
    return { type: 'abnormal_labs', observations: abnormal, allObservations: allObs };
  }

  if (parsedQuery.type === 'demographic') {
    return { type: 'demographic', patient: store.getResource('Patient', patientId) };
  }

  return { type: 'unknown' };
}

function calculateAge(birthDate) {
  const birth = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

function buildDemographicAnswer(question, patientName, patientResource) {
  const citations = [];
  if (patientResource) citations.push(generateCitation(patientResource));

  if (!patientResource) {
    return { answer: `Could not find ${patientName}'s record.`, citations: [], hasMatch: false, confidence: 'no_data' };
  }

  const lower = question.toLowerCase();

  if (/how\s+old|age|born|birth|dob/i.test(lower)) {
    const dob = patientResource.birthDate;
    if (!dob) return { answer: `${patientName}'s date of birth is not recorded.`, citations, hasMatch: false, confidence: 'no_data' };
    const age = calculateAge(dob);
    if (/when|born\s|birth\s|dob/i.test(lower) && !/how\s+old|what.*age/i.test(lower)) {
      return { answer: `${patientName} was born on ${dob} (age ${age}).`, citations, hasMatch: true, confidence: 'confirmed' };
    }
    return { answer: `${patientName} is ${age} years old, based on date of birth ${dob}.`, citations, hasMatch: true, confidence: 'confirmed' };
  }

  if (/name|who\s+(?:is|are)/i.test(lower)) {
    const name = (patientResource.name?.[0]?.given || []).join(' ') + ' ' + (patientResource.name?.[0]?.family || '');
    return {
      answer: `The patient's name is ${name.trim()}.`,
      citations, hasMatch: true, confidence: 'confirmed',
    };
  }

  if (/gender|sex|male|female/i.test(lower)) {
    const gender = patientResource.gender || 'not recorded';
    return {
      answer: `${patientName} is ${gender}.`,
      citations, hasMatch: true, confidence: 'confirmed',
    };
  }

  if (/mrn/i.test(lower)) {
    const mrn = patientResource.identifier?.[0]?.value || 'not recorded';
    return { answer: `${patientName}'s MRN is ${mrn}.`, citations, hasMatch: true, confidence: 'confirmed' };
  }

  const dob = patientResource.birthDate;
  const age = dob ? calculateAge(dob) : 'unknown';
  const gender = patientResource.gender || 'not recorded';
  const mrn = patientResource.identifier?.[0]?.value || 'not recorded';
  return {
    answer: `${patientName} — ${gender}, ${dob ? age + ' years old (DOB: ' + dob + ')' : 'age unknown'}, MRN: ${mrn}.`,
    citations, hasMatch: true, confidence: 'confirmed',
  };
}

function extractKeywords(question) {
  const stopWords = new Set(['the','is','are','was','were','a','an','any','this','that','for','with','from','has','have','had','does','do','did','can','could','would','should','will','may','tell','me','if','about','of','to','in','on','at','by','or','and','not','no','it','be','been','being','check','see','find','show','get','there','their','patient','what','which','who','please','you','we','he','she','they']);
  return question.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 20);
}

function searchFHIRFallback(patientId, question) {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return { type: 'fallback', matches: [], keywords: [] };

  const allResources = [];

  const allergies = store.searchAllAllergies(patientId);
  for (const r of allergies) {
    const text = JSON.stringify(r).toLowerCase();
    const matchCount = keywords.filter(k => text.includes(k)).length;
    if (matchCount > 0) allResources.push({ ...r, _matchScore: matchCount, _searchHit: 'allergy' });
  }

  const conditions = store.searchConditions(patientId);
  for (const r of conditions) {
    const text = JSON.stringify(r).toLowerCase();
    const matchCount = keywords.filter(k => text.includes(k)).length;
    if (matchCount > 0) allResources.push({ ...r, _matchScore: matchCount, _searchHit: 'condition' });
  }

  const meds = store.searchAllMedications(patientId);
  for (const r of meds) {
    const text = JSON.stringify(r).toLowerCase();
    const matchCount = keywords.filter(k => text.includes(k)).length;
    if (matchCount > 0) allResources.push({ ...r, _matchScore: matchCount, _searchHit: 'medication' });
  }

  const obs = store.searchObservations(patientId);
  for (const r of obs) {
    const text = JSON.stringify(r).toLowerCase();
    const matchCount = keywords.filter(k => text.includes(k)).length;
    if (matchCount > 0) allResources.push({ ...r, _matchScore: matchCount, _searchHit: 'observation' });
  }

  allResources.sort((a, b) => b._matchScore - a._matchScore || (b.resourceType || '').localeCompare(a.resourceType || ''));
  return { type: 'fallback', matches: allResources, keywords };
}

function buildFallbackAnswer(patientName, result, patientId) {
  const { matches, keywords } = result;
  const topMatches = matches.slice(0, 10);
  const citations = topMatches.map(r => generateCitation(r));

  if (topMatches.length === 0) {
    // If keyword search found nothing, return a patient overview instead of "nothing found"
    const allergies = store.searchAllAllergies(patientId);
    const conditions = store.searchConditions(patientId);
    const meds = store.searchAllMedications(patientId);
    const allCitations = [...allergies, ...conditions, ...meds].map(r => generateCitation(r));

    if (allCitations.length === 0) {
      return {
        answer: `No information found in ${patientName}'s record`,
        citations: [], hasMatch: false, confidence: 'no_data',
      };
    }

    const activeMeds = meds.filter(m => m.status === 'active');
    const allergyList = allergies.filter(a => a.verificationStatus?.coding?.[0]?.code !== 'refuted');
    let overview = `${patientName} has ${conditions.length} condition(s), ${allergyList.length} allergy record(s), and ${meds.length} medication(s) on file. `;
    if (activeMeds.length > 0) overview += `Currently taking: ${activeMeds.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
    if (conditions.length > 0) overview += `Diagnoses: ${conditions.map(c => c.code?.text || 'unknown').join(', ')}.`;
    return {
      answer: overview.trim(),
      citations: allCitations, hasMatch: true, confidence: 'overview',
    };
  }

  // ... rest stays the same

  const grouped = {};
  for (const m of topMatches) {
    const type = m._searchHit || m.resourceType;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(m);
  }

  let answer = `Found ${topMatches.length} relevant record(s) for ${patientName} matching "${keywords.join(' ')}". `;
  for (const [type, items] of Object.entries(grouped)) {
    const displayType = type === 'allergy' ? 'allergies' : type === 'condition' ? 'conditions' : type === 'medication' ? 'medications' : type === 'observation' ? 'lab results' : type;
    const labels = items.map(i => {
      if (type === 'allergy') return i.code?.text || i.code?.coding?.[0]?.display || 'unknown';
      if (type === 'condition') return i.code?.text || i.code?.coding?.[0]?.display || 'unknown';
      if (type === 'medication') return i.medicationCodeableConcept?.text || 'unknown';
      if (type === 'observation') return `${i.code?.text || 'unknown'}: ${i.valueQuantity?.value || i.valueString || 'N/A'}`;
      return 'unknown';
    });
    answer += `${displayType}: ${labels.join(', ')}. `;
  }

  return { answer: answer.trim(), citations, hasMatch: true, confidence: 'keyword_match' };
}

function scoreCitationConfidence(resource) {
  let score = 0.5;
  const now = new Date();

  const dateStr = resource.recordedDate || resource.authoredOn || resource.effectiveDateTime || resource.meta?.lastUpdated || '';
  if (dateStr) {
    const ageMs = now - new Date(dateStr);
    const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
    if (ageYears < 1) score += 0.3;
    else if (ageYears < 3) score += 0.15;
    else if (ageYears < 5) score += 0.05;
    else score -= 0.1;
  }

  const author = resource.recorder?.display || resource.requester?.display || '';
  if (author && author !== 'Unknown') score += 0.1;

  const verification = resource.verificationStatus?.coding?.[0]?.code;
  if (verification === 'confirmed') score += 0.15;
  else if (verification === 'unconfirmed') score -= 0.2;
  else if (verification === 'refuted') score = 0;

  const status = resource.clinicalStatus?.coding?.[0]?.code || resource.status;
  if (status === 'active') score += 0.05;
  else if (status === 'resolved' || status === 'completed') score -= 0.05;
  else if (status === 'stopped' || status === 'entered-in-error') score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

function generateCitation(resource) {
  const type = resource.resourceType;
  const id = resource.id;
  const fhirRef = `${type}/${id}`;

  let display, author, date, snippet, category;

  if (type === 'AllergyIntolerance') {
    display = resource.code?.text || resource.code?.coding?.[0]?.display || 'Unknown';
    author = resource.recorder?.display || 'Unknown';
    date = resource.recordedDate || resource.onsetDateTime || '';
    snippet = resource.note?.[0]?.text || '';
    const reaction = resource.reaction?.[0];
    if (reaction) {
      const manifest = reaction.manifestation?.[0]?.text || reaction.manifestation?.[0]?.coding?.[0]?.display || '';
      const severity = reaction.severity || '';
      if (manifest && !snippet) snippet = `${manifest}${severity ? ` (${severity})` : ''}`;
    }
    category = (resource.category || []).join(', ') || 'allergy';
    display = `${display} — ${resource.criticality === 'high' ? 'HIGH RISK' : 'known'} (${resource.verificationStatus?.coding?.[0]?.display || 'confirmed'})`;
  } else if (type === 'MedicationRequest') {
    display = resource.medicationCodeableConcept?.text || resource.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown';
    author = resource.requester?.display || 'Unknown';
    date = resource.authoredOn || '';
    snippet = resource.dosageInstruction?.[0]?.text || '';
    category = resource.status || 'unknown';
    display = `${display} — ${resource.status} (${resource.intent})`;
  } else if (type === 'Observation') {
    display = resource.code?.text || resource.code?.coding?.[0]?.display || 'Unknown lab';
    author = resource.performer?.[0]?.display || 'Lab';
    date = resource.effectiveDateTime || resource.issued || '';
    snippet = resource.valueQuantity ? `${resource.valueQuantity.value} ${resource.valueQuantity.unit || ''}` : (resource.valueString || '');
    category = 'laboratory';
  } else if (type === 'Patient') {
    const name = (resource.name?.[0]?.given || []).join(' ') + ' ' + (resource.name?.[0]?.family || '');
    display = name.trim() || 'Unknown patient';
    date = resource.birthDate || '';
    snippet = `DOB: ${resource.birthDate || 'N/A'}, Gender: ${resource.gender || 'N/A'}, MRN: ${resource.identifier?.[0]?.value || 'N/A'}`;
    category = 'demographics';
  } else {
    display = `${type}/${id}`;
    date = resource.meta?.lastUpdated || '';
    author = '';
    snippet = '';
    category = '';
  }

  return {
    sourceType: type,
    sourceId: id,
    fhirReference: fhirRef,
    display,
    date,
    author,
    snippet: (snippet || '').substring(0, 200),
    category,
    resourceUrl: `/fhir/${fhirRef}`,
    confidence: Math.round(scoreCitationConfidence(resource) * 100) / 100,
  };
}

function buildAllergyCheckAnswer(question, result, patientName) {
  const { allergies, medRequests, stoppedMatch } = result;
  const citations = [];

  if (allergies.length === 0) {
    let classHint = '';
    const medClass = resolveMedicationClass(question.medication);
    if (medClass) {
      const related = medClass.terms.filter(t => t !== question.medication.toLowerCase()).slice(0, 4);
      if (related.length > 0) classHint = ` Also checked related medications in the same class: ${related.join(', ')}.`;
    }

    let medHistoryNote = '';
    if (medRequests.length > 0) {
      for (const m of medRequests) citations.push(generateCitation(m));
      medHistoryNote = ` However, ${patientName} has been prescribed ${medRequests.map(m => m.medicationCodeableConcept?.text || 'this medication').join(' and ')} in the past with no documented adverse reaction.`;
    }

    return {
      answer: `No documented allergy or adverse reaction to ${question.medication} found in ${patientName}'s record.${classHint}${medHistoryNote}`,
      citations,
      hasMatch: false,
      confidence: allergies.length === 0 && medRequests.length === 0 ? 'no_data' : 'low',
    };
  }

  for (const a of allergies) citations.push(generateCitation(a));
  for (const m of medRequests) citations.push(generateCitation(m));

  const allergyDisplays = allergies.map(a => a.code?.text || a.code?.coding?.[0]?.display || 'this substance');
  let answer = `YES — ${patientName} has a documented ${allergyDisplays.join(' and ')}. `;

  for (const allergy of allergies) {
    if (allergy.criticality === 'high') answer += 'This is a HIGH-RISK allergy. ';
    const reaction = allergy.reaction?.[0];
    const manifestation = reaction?.manifestation?.[0]?.text || '';
    const severity = reaction?.severity || '';
    if (manifestation) answer += `Reported reaction: ${manifestation}${severity ? ` (${severity})` : ''}. `;
    if (allergy.note?.[0]?.text) answer += `Note: "${allergy.note[0].text.substring(0, 150)}" `;
  }

  if (stoppedMatch) {
    answer += `A medication in this class (${stoppedMatch.meds.join(', ')}) was stopped, correlating with the documented ${stoppedMatch.allergySubstance}. `;
  }

  return { answer: answer.trim(), citations, hasMatch: true, confidence: 'confirmed' };
}

function buildAllergyListAnswer(patientName, result) {
  const { allergies } = result;
  const citations = allergies.map(a => generateCitation(a));

  if (allergies.length === 0) {
    return { answer: `${patientName} has no known allergies documented in their record.`, citations, hasMatch: false, confidence: 'no_data' };
  }

  const activeAllergies = allergies.filter(a => a.clinicalStatus?.coding?.[0]?.code === 'active');
  let answer = `${patientName} has ${activeAllergies.length} active allergy(s). `;
  for (const a of activeAllergies) {
    const display = a.code?.text || a.code?.coding?.[0]?.display || 'unknown';
    answer += `${display}${a.criticality === 'high' ? ' (HIGH RISK)' : ''}; `;
  }
  return { answer: answer.trim(), citations, hasMatch: activeAllergies.length > 0, confidence: 'confirmed' };
}

function buildMedicationListAnswer(patientName, result) {
  const { medications } = result;
  const citations = medications.map(m => generateCitation(m));

  if (medications.length === 0) {
    return { answer: `${patientName} has no medications documented.`, citations, hasMatch: false, confidence: 'no_data' };
  }

  const active = medications.filter(m => m.status === 'active');
  const stopped = medications.filter(m => m.status === 'stopped');
  const completed = medications.filter(m => m.status === 'completed');

  let answer = `${patientName} has ${medications.length} medication(s) on record. `;
  if (active.length > 0) {
    answer += `Currently active: ${active.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
  }
  if (stopped.length > 0) {
    answer += `Previously stopped: ${stopped.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
  }
  if (completed.length > 0) {
    answer += `completed: ${completed.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
  }

  return { answer: answer.trim(), citations, hasMatch: true, confidence: 'confirmed' };
}

function buildAbnormalLabsAnswer(patientName, result) {
  const { observations, allObservations } = result;
  const citations = observations.map(o => generateCitation(o));

  if (observations.length === 0) {
    return {
      answer: `No abnormal lab results found in ${patientName}'s record (${allObservations.length} total labs reviewed).`,
      citations, hasMatch: false, confidence: 'no_data',
    };
  }

  let answer = `Found ${observations.length} abnormal lab result(s) out of ${allObservations.length} total for ${patientName}. `;
  for (const obs of observations) {
    const label = obs.code?.text || obs.code?.coding?.[0]?.display || 'unknown';
    const value = obs.valueQuantity ? `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ''}` : (obs.valueString || 'unknown');
    const direction = obs.referenceRange?.[0]?.high?.value && obs.valueQuantity?.value > obs.referenceRange[0].high.value ? 'HIGH' :
      obs.referenceRange?.[0]?.low?.value && obs.valueQuantity?.value < obs.referenceRange[0].low.value ? 'LOW' : 'ABNORMAL';
    answer += `${label}: ${value} (${direction}); `;
  }

  return { answer: answer.trim(), citations, hasMatch: true, confidence: 'confirmed' };
}

function enforceNoSourceNoAnswer(answer, citations, searched) {
  if (citations.length === 0 && !searched) {
    return {
      ...answer,
      answer: 'Unable to provide an answer — no source data was found in the patient record to support a response. This system operates under a "no source, no answer" policy and will not generate unsupported claims.',
      policy: 'no_source_no_answer',
    };
  }
  if (citations.length === 0 && searched) {
    return { ...answer, policy: 'negative_findings' };
  }
  return { ...answer, policy: 'all_cited' };
}

async function processQuery(question, patientId, userId, patientName, sourceIp) {
  const startTime = Date.now();

  const user = getUserById(userId);
  const userRole = user ? user.role : 'unknown';
  const userName = user ? user.name : 'Unknown User';

  const resourceTypes = ['AllergyIntolerance', 'MedicationRequest', 'Observation', 'Condition'];
  const permResult = validatePermissions(userId, patientId, resourceTypes);

  if (!permResult.allowed) {
    return {
      success: false,
      error: permResult.reason,
      permissions: permResult,
      audit: {
        userId, userRole, userName, patientId, patientName,
        queryText: question,
        resourcesQueried: resourceTypes, resourcesAccessed: [], resourcesReturned: 0,
        dataFiltered: false, filteredReason: null,
        responseSummary: permResult.reason, citationsCount: 0,
        authMechanism: 'rbac', scopesApplied: [], sourceIp,
        responseTimeMs: Date.now() - startTime,
        success: false, errorReason: permResult.reason, purposeOfUse: 'TREATMENT',
      },
    };
  }

  // LLM first — handles any phrasing, poor spelling, colloquialisms
  // Regex is the safety net if the LLM is unavailable or times out
  let parsed = null;
  let usedLlm = false;

  const llmParsed = await llmParseQuery(question);
  if (llmParsed && llmParsed.type !== 'unknown') {
    parsed = llmParsed;
    usedLlm = true;
  }

  // Regex fallback only if LLM couldn't handle it
  if (!parsed) {
    parsed = parseQuery(question);
  }

  if (parsed.type === 'unknown') {
    const fallbackResult = searchFHIRFallback(patientId, question);
    const answer = buildFallbackAnswer(patientName, fallbackResult, patientId);
    const enforced = enforceNoSourceNoAnswer(answer, answer.citations, true);
    const responseTimeMs = Date.now() - startTime;

    return {
      success: true,
      question,
      answer: enforced.answer,
      citations: enforced.citations,
      hasMatch: enforced.hasMatch,
      confidence: enforced.confidence,
      policy: enforced.policy,
      permissions: permResult,
      responseTimeMs,
      parsed,
      audit: {
        userId, userRole: permResult.role, userName: permResult.userName,
        patientId, patientName,
        queryText: question, queryIntent: 'fallback_keyword_search', queryParams: parsed,
        resourcesQueried: resourceTypes,
        resourcesAccessed: fallbackResult.matches.slice(0, 10).map(m => ({ type: m.resourceType, id: m.id })),
        resourcesReturned: answer.citations.length,
        dataFiltered: false, filteredReason: null,
        responseSummary: enforced.answer.substring(0, 500),
        citationsCount: enforced.citations.length,
        authMechanism: 'rbac', scopesApplied: permResult.scopes, sourceIp,
        responseTimeMs, success: true, errorReason: null, purposeOfUse: 'TREATMENT',
      },
    };
  }

  const searchResult = searchFHIR(patientId, parsed);
  let answer;

  switch (parsed.type) {
    case 'allergy_check':
      answer = buildAllergyCheckAnswer(parsed, searchResult, patientName);
      break;
    case 'allergy_list':
      answer = buildAllergyListAnswer(patientName, searchResult);
      break;
    case 'medication_list':
      answer = buildMedicationListAnswer(patientName, searchResult);
      break;
    case 'abnormal_labs':
      answer = buildAbnormalLabsAnswer(patientName, searchResult);
      break;
    case 'demographic':
      answer = buildDemographicAnswer(question, patientName, searchResult.patient);
      break;
    default:
      return {
        success: false, error: 'Query type not yet supported',
        audit: {
          userId, userRole: permResult.role, userName: permResult.userName,
          patientId, patientName, queryText: question,
          resourcesQueried: resourceTypes, resourcesAccessed: [], resourcesReturned: 0,
          dataFiltered: false, responseSummary: 'unsupported_query_type', citationsCount: 0,
          authMechanism: 'rbac', scopesApplied: permResult.scopes, sourceIp,
          responseTimeMs: Date.now() - startTime,
          success: false, errorReason: 'unsupported_query_type', purposeOfUse: 'TREATMENT',
        },
      };
  }

  const searched = parsed.type !== 'unknown';
  const enforced = enforceNoSourceNoAnswer(answer, answer.citations, searched);
  const responseTimeMs = Date.now() - startTime;

  return {
    success: true,
    question,
    answer: enforced.answer,
    citations: enforced.citations,
    hasMatch: enforced.hasMatch,
    confidence: enforced.confidence,
    policy: enforced.policy,
    permissions: permResult,
    responseTimeMs,
    parsed,
    audit: {
      userId, userRole: permResult.role, userName: permResult.userName,
      patientId, patientName,
      queryText: question, queryIntent: parsed.intent, queryParams: parsed,
      resourcesQueried: resourceTypes,
      resourcesAccessed: answer.citations.map(c => ({ type: c.sourceType, id: c.sourceId })),
      resourcesReturned: answer.citations.length,
      dataFiltered: false, filteredReason: null,
      responseSummary: enforced.answer.substring(0, 500),
      citationsCount: enforced.citations.length,
      authMechanism: 'rbac', scopesApplied: permResult.scopes, sourceIp,
      responseTimeMs, success: true, errorReason: null, purposeOfUse: 'TREATMENT',
    },
  };
}

module.exports = {
  processQuery, parseQuery, validatePermissions, searchFHIR, generateCitation,
  scoreCitationConfidence,
  MEDICATION_CLASSES,
};
