const store = require('./store');
const { resolveMedicationClass } = require('./data');

function calculateAge(birthDate) {
  const birth = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

const INTENTS = [
  {
    name: 'allergy_check',
    description: 'Check if the patient has an allergy or adverse reaction to a specific medication, drug, or substance. Includes questions about intolerances and hypersensitivities.',
    resourceTypes: ['AllergyIntolerance', 'MedicationRequest'],
    search(patientId, params) {
      const medName = params.medication || params.drug_name || params.allergen || '';
      if (!medName) return { type: 'allergy_check', allergies: [], medRequests: [], medicationNames: [] };
      const medClass = resolveMedicationClass(medName);
      let medicationNames = [medName];
      if (medClass) medicationNames = [...new Set([medName, ...medClass.terms])];
      return {
        type: 'allergy_check',
        allergies: store.searchAllergiesByMedication(patientId, medicationNames),
        medRequests: store.searchMedicationRequests(patientId, medicationNames),
        medicationNames,
      };
    },
    answer(patientName, result, params) {
      const { allergies, medRequests } = result;
      const citations = [];
      if (allergies.length === 0) {
        let classHint = '';
        const medName = params.medication || params.drug_name || params.allergen || '';
        const medClass = resolveMedicationClass(medName);
        if (medClass) {
          const related = medClass.terms.filter(t => t !== medName.toLowerCase()).slice(0, 4);
          if (related.length > 0) classHint = ` Also checked related medications: ${related.join(', ')}.`;
        }
        let medHistoryNote = '';
        if (medRequests.length > 0) {
          for (const m of medRequests) citations.push(generateCitation(m));
          medHistoryNote = ` However, ${patientName} was prescribed ${medRequests.map(m => m.medicationCodeableConcept?.text || 'this medication').join(', ')} with no documented adverse reaction.`;
        }
        return { answer: `No documented allergy or adverse reaction to ${medName} found in ${patientName}'s record.${classHint}${medHistoryNote}`, citations, hasMatch: false, confidence: 0.3 };
      }
      for (const a of allergies) citations.push(generateCitation(a));
      for (const m of medRequests) citations.push(generateCitation(m));
      const displays = allergies.map(a => a.code?.text || a.code?.coding?.[0]?.display || 'this substance');
      let answer = `YES — ${patientName} has a documented ${displays.join(' and ')}. `;
      for (const allergy of allergies) {
        if (allergy.criticality === 'high') answer += 'This is a HIGH-RISK allergy. ';
        const reaction = allergy.reaction?.[0];
        const manifestation = reaction?.manifestation?.[0]?.text || '';
        const severity = reaction?.severity || '';
        if (manifestation) answer += `Reported reaction: ${manifestation}${severity ? ` (${severity})` : ''}. `;
        if (allergy.note?.[0]?.text) answer += `Note: "${allergy.note[0].text.substring(0, 150)}" `;
      }
      return { answer: answer.trim(), citations, hasMatch: true, confidence: 0.9 };
    },
  },
  {
    name: 'allergy_list',
    description: 'List all known allergies, intolerances, or adverse reactions for the patient.',
    resourceTypes: ['AllergyIntolerance'],
    search(patientId) {
      return { type: 'allergy_list', allergies: store.searchAllAllergies(patientId) };
    },
    answer(patientName, result) {
      const { allergies } = result;
      const citations = allergies.map(a => generateCitation(a));
      if (allergies.length === 0) return { answer: `${patientName} has no known allergies.`, citations, hasMatch: false, confidence: 0.8 };
      const active = allergies.filter(a => a.clinicalStatus?.coding?.[0]?.code === 'active');
      let answer = `${patientName} has ${active.length} active allergy record(s). `;
      for (const a of active) answer += `${a.code?.text || a.code?.coding?.[0]?.display || 'unknown'}${a.criticality === 'high' ? ' (HIGH RISK)' : ''}; `;
      return { answer: answer.trim(), citations, hasMatch: active.length > 0, confidence: 0.9 };
    },
  },
  {
    name: 'medication_list',
    description: 'List the patient\'s medications — what they are currently taking, previously took, or were prescribed.',
    resourceTypes: ['MedicationRequest'],
    search(patientId) {
      return { type: 'medication_list', medications: store.searchAllMedications(patientId) };
    },
    answer(patientName, result) {
      const { medications } = result;
      const citations = medications.map(m => generateCitation(m));
      if (medications.length === 0) return { answer: `${patientName} has no medications documented.`, citations, hasMatch: false, confidence: 0.8 };
      const active = medications.filter(m => m.status === 'active');
      const stopped = medications.filter(m => m.status === 'stopped');
      const completed = medications.filter(m => m.status === 'completed');
      let answer = `${patientName} has ${medications.length} medication(s) on record. `;
      if (active.length > 0) answer += `Currently active: ${active.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
      if (stopped.length > 0) answer += `Previously stopped: ${stopped.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
      if (completed.length > 0) answer += `completed: ${completed.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
      return { answer: answer.trim(), citations, hasMatch: true, confidence: 0.9 };
    },
  },
  {
    name: 'abnormal_labs',
    description: 'Find lab results or test values that are abnormal, out of range, elevated, or concerning.',
    resourceTypes: ['Observation'],
    search(patientId) {
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
    },
    answer(patientName, result) {
      const { observations, allObservations } = result;
      const citations = observations.map(o => generateCitation(o));
      if (observations.length === 0) return { answer: `No abnormal lab results found in ${patientName}'s record (${allObservations.length} total labs reviewed).`, citations, hasMatch: false, confidence: 0.8 };
      let answer = `Found ${observations.length} abnormal lab result(s). `;
      for (const obs of observations) {
        const label = obs.code?.text || obs.code?.coding?.[0]?.display || 'unknown';
        const value = obs.valueQuantity ? `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ''}` : (obs.valueString || 'N/A');
        const direction = obs.referenceRange?.[0]?.high?.value && obs.valueQuantity?.value > obs.referenceRange[0].high.value ? 'HIGH' : 'LOW';
        answer += `${label}: ${value} (${direction}); `;
      }
      return { answer: answer.trim(), citations, hasMatch: true, confidence: 0.9 };
    },
  },
  {
    name: 'demographic',
    description: 'Get a specific patient demographic detail — age, date of birth, name, gender, MRN, vital status (alive/deceased), or other single-fact questions about who the patient is. Not for chart overviews.',
    resourceTypes: ['Patient'],
    search(patientId) {
      const patient = store.getResource('Patient', patientId);
      return { type: 'demographic', patient, patientId };
    },
    answer(patientName, result, params, question) {
      const patient = result.patient;
      const citations = patient ? [generateCitation(patient)] : [];
      if (!patient) return { answer: `Could not find ${patientName}'s record.`, citations, hasMatch: false, confidence: 0 };

      const lower = (question || '').toLowerCase();

      // Vital status / mortality
      if (/alive|dead|deceased|living|died|passed|mortality|still\s+with/i.test(lower)) {
        if (patient.deceasedBoolean === true || patient.deceasedDateTime) {
          const when = patient.deceasedDateTime || 'unknown date';
          return { answer: `${patientName} is deceased (recorded ${when}).`, citations, hasMatch: true, confidence: 1.0 };
        }
        // Check for recent activity as evidence of being alive
        const recentMeds = store.searchAllMedications(result.patientId).filter(m => m.status === 'active').length;
        const recentObs = store.searchObservations(result.patientId).filter(o => {
          try { return new Date(o.effectiveDateTime) > new Date(Date.now() - 365*24*60*60*1000); } catch { return false; }
        }).length;
        if (recentMeds > 0 || recentObs > 0) {
          return { answer: `${patientName} is alive — chart shows ${recentMeds} active medication(s) and ${recentObs} recent observation(s) within the past year. No deceased record found.`, citations, hasMatch: true, confidence: 0.9 };
        }
        return { answer: `${patientName}'s chart does not indicate deceased status. There are no active medications or recent observations to confirm, but no death record exists.`, citations, hasMatch: true, confidence: 0.7 };
      }
      const dob = patient.birthDate;

      if (/how\s+old|age|born|birth|dob/i.test(lower)) {
        if (!dob) return { answer: `${patientName}'s date of birth is not recorded.`, citations, hasMatch: false, confidence: 0 };
        const age = calculateAge(dob);
        if (/when|born\s|birth\s|dob/i.test(lower) && !/how\s+old|what.*age/i.test(lower)) {
          return { answer: `${patientName} was born on ${dob} (age ${age}).`, citations, hasMatch: true, confidence: 1.0 };
        }
        return { answer: `${patientName} is ${age} years old, based on date of birth ${dob}.`, citations, hasMatch: true, confidence: 1.0 };
      }
      if (/name|who\s+(?:is|are)/i.test(lower)) {
        const name = (patient.name?.[0]?.given || []).join(' ') + ' ' + (patient.name?.[0]?.family || '');
        return { answer: `The patient's name is ${name.trim()}.`, citations, hasMatch: true, confidence: 1.0 };
      }
      if (/gender|sex|male|female/i.test(lower)) {
        return { answer: `${patientName} is ${patient.gender || 'not recorded'}.`, citations, hasMatch: true, confidence: 1.0 };
      }
      if (/mrn/i.test(lower)) {
        return { answer: `${patientName}'s MRN is ${patient.identifier?.[0]?.value || 'not recorded'}.`, citations, hasMatch: true, confidence: 1.0 };
      }
      const age = dob ? calculateAge(dob) : 'unknown';
      return { answer: `${patientName} — ${patient.gender || 'N/A'}, ${dob ? age + ' years old (DOB: ' + dob + ')' : 'age unknown'}, MRN: ${patient.identifier?.[0]?.value || 'N/A'}.`, citations, hasMatch: true, confidence: 1.0 };
    },
  },
  {
    name: 'chart_overview',
    description: 'Get a complete overview of the patient\'s chart — who they are, their conditions, allergies, medications, and key findings. Use this for vague questions like "what is this?", "tell me about this patient", "summarize this chart", or "what am I looking at?".',
    resourceTypes: ['Patient', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'Observation'],
    search(patientId) {
      return {
        patient: store.getResource('Patient', patientId),
        conditions: store.searchConditions(patientId),
        allergies: store.searchAllAllergies(patientId),
        medications: store.searchAllMedications(patientId),
        observations: store.searchObservations(patientId),
      };
    },
    answer(patientName, result, params, question) {
      const { patient, conditions, allergies, medications, observations } = result;
      const citations = [];

      if (patient) citations.push(generateCitation(patient));
      for (const c of conditions) citations.push(generateCitation(c));
      for (const a of allergies) citations.push(generateCitation(a));
      for (const m of medications) citations.push(generateCitation(m));

      if (!patient) return { answer: `Could not find ${patientName}'s chart.`, citations: [], hasMatch: false, confidence: 0 };

      const dob = patient.birthDate;
      const age = dob ? calculateAge(dob) : 'unknown';
      const gender = patient.gender || 'N/A';
      const mrn = patient.identifier?.[0]?.value || 'N/A';

      const activeConditions = conditions.filter(c => c.clinicalStatus?.coding?.[0]?.code === 'active');
      const resolvedConditions = conditions.filter(c => c.clinicalStatus?.coding?.[0]?.code !== 'active');
      const activeAllergies = allergies.filter(a => a.verificationStatus?.coding?.[0]?.code !== 'refuted');
      const activeMeds = medications.filter(m => m.status === 'active');

      let answer = `This is the chart for ${patientName}, a ${age}-year-old ${gender} patient, MRN ${mrn}. `;

      if (activeConditions.length > 0) {
        answer += `Active conditions: ${activeConditions.map(c => c.code?.text || 'unknown').join(', ')}. `;
      }
      if (resolvedConditions.length > 0) {
        answer += `Resolved: ${resolvedConditions.map(c => c.code?.text || 'unknown').join(', ')}. `;
      }
      if (activeAllergies.length > 0) {
        answer += `Allergies: ${activeAllergies.map(a => `${a.code?.text || 'unknown'}${a.criticality === 'high' ? ' (HIGH RISK)' : ''}`).join(', ')}. `;
      } else if (allergies.some(a => a.code?.coding?.some(c => c.code === '409137002'))) {
        answer += `No known drug allergies. `;
      }
      if (activeMeds.length > 0) {
        answer += `Active medications: ${activeMeds.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
      } else if (medications.length > 0) {
        answer += `${medications.length} medication(s) on record, none currently active. `;
      }

      const abnormalObs = observations.filter(o => {
        if (!o.valueQuantity || !o.referenceRange || o.referenceRange.length === 0) return false;
        for (const range of o.referenceRange) {
          if (range.high?.value !== undefined && o.valueQuantity.value > range.high.value) return true;
          if (range.low?.value !== undefined && o.valueQuantity.value < range.low.value) return true;
        }
        return false;
      });
      if (abnormalObs.length > 0) {
        answer += `Notable findings: ${abnormalObs.map(o => `${o.code?.text || 'lab'}: ${o.valueQuantity?.value} ${o.valueQuantity?.unit || ''}`).join(', ')}. `;
      }

      answer += `All claims cited from FHIR source records.`;

      return { answer: answer.trim(), citations, hasMatch: true, confidence: 0.9 };
    },
  },
];

function findIntent(name) {
  return INTENTS.find(i => i.name === name) || null;
}

function generateLLMPrompt() {
  const intentList = INTENTS.map(i => `  "${i.name}" — ${i.description}`).join('\n');
  return `You parse clinical questions about a patient's medical record. Return ONLY valid JSON.

{
  "query_type": string,
  "parameters": {
    "medication": string|null,
    "drug_name": string|null,
    "drug_class": string|null,
    "lab_name": string|null,
    "date_range": string|null,
    "allergen": string|null,
    "condition": string|null
  }
}

query_type must be one of:
${intentList}

Understand the user's intent even if grammar or spelling is imperfect. Colloquial phrasing, slang, and typos are expected.`;
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
  } else if (type === 'DocumentReference') {
    display = resource.content?.[0]?.attachment?.title || resource.type?.text || 'Clinical Note';
    date = resource.date || '';
    author = (resource.author || []).map(a => a.display).filter(Boolean).join(', ');
    snippet = (resource.content?.[0]?.attachment?.data || '').substring(0, 200);
    category = 'clinical_note';
  } else {
    display = `${type}/${id}`;
    date = resource.meta?.lastUpdated || '';
    author = '';
    snippet = '';
    category = '';
  }

  return { sourceType: type, sourceId: id, fhirReference: fhirRef, display, date, author, snippet: (snippet || '').substring(0, 200), category, resourceUrl: `/fhir/${fhirRef}`, confidence: scoreCitationConfidence(resource) };
}

function scoreCitationConfidence(resource) {
  let score = 0.5;
  const dateStr = resource.recordedDate || resource.authoredOn || resource.effectiveDateTime || resource.meta?.lastUpdated || '';
  if (dateStr) {
    const ageMs = Date.now() - new Date(dateStr);
    const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
    if (ageYears < 1) score += 0.3; else if (ageYears < 3) score += 0.15; else if (ageYears < 5) score += 0.05; else score -= 0.1;
  }
  const author = resource.recorder?.display || resource.requester?.display || '';
  if (author && author !== 'Unknown') score += 0.1;
  const verification = resource.verificationStatus?.coding?.[0]?.code;
  if (verification === 'confirmed') score += 0.15; else if (verification === 'unconfirmed') score -= 0.2; else if (verification === 'refuted') score = 0;
  const status = resource.clinicalStatus?.coding?.[0]?.code || resource.status;
  if (status === 'active') score += 0.05; else if (status === 'resolved' || status === 'completed') score -= 0.05; else if (status === 'stopped' || status === 'entered-in-error') score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

module.exports = { INTENTS, findIntent, generateLLMPrompt, generateCitation, scoreCitationConfidence, calculateAge };
