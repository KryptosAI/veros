const store = require('./store');

function buildDiffContext(patientId, patientName) {
  const patient = store.getResource('Patient', patientId);
  const conditions = store.searchConditions(patientId);
  const allergies = store.searchAllAllergies(patientId);
  const medications = store.searchAllMedications(patientId);
  const observations = store.searchObservations(patientId);
  const notes = store.searchByPatient('DocumentReference', patientId);

  let ctx = `Patient: ${patientName}\n`;
  if (patient) {
    const dob = patient.birthDate;
    let age = 'unknown';
    if (dob) { const b = new Date(dob); const n = new Date(); let a = n.getFullYear() - b.getFullYear(); const m = n.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--; age = a; }
    ctx += `  Gender: ${patient.gender || 'N/A'}, Age: ${age}, DOB: ${dob || 'N/A'}, MRN: ${patient.identifier?.[0]?.value || 'N/A'}\n`;
  }

  const activeConds = conditions.filter(c => c.clinicalStatus?.coding?.[0]?.code === 'active');
  if (activeConds.length) ctx += `Active Conditions: ${activeConds.map(c => c.code?.text).join(', ')}\n`;
  const resolvedConds = conditions.filter(c => c.clinicalStatus?.coding?.[0]?.code !== 'active');
  if (resolvedConds.length) ctx += `Resolved/Historical: ${resolvedConds.map(c => c.code?.text).join(', ')}\n`;

  const activeAllergies = allergies.filter(a => a.verificationStatus?.coding?.[0]?.code !== 'refuted');
  if (activeAllergies.length) ctx += `Allergies: ${activeAllergies.map(a => `${a.code?.text} (${a.criticality}, ${a.reaction?.[0]?.manifestation?.[0]?.text || ''})`).join(', ')}\n`;

  const active = medications.filter(m => m.status === 'active');
  const stopped = medications.filter(m => m.status === 'stopped');
  if (active.length) ctx += `Active Medications: ${active.map(m => `${m.medicationCodeableConcept?.text} (${m.dosageInstruction?.[0]?.text || ''})`).join(', ')}\n`;
  if (stopped.length) ctx += `Stopped: ${stopped.map(m => m.medicationCodeableConcept?.text).join(', ')}\n`;

  if (observations.length) {
    ctx += `Lab Results:\n`;
    for (const o of observations) {
      ctx += `  ${o.code?.text}: ${o.valueQuantity?.value ?? o.valueString ?? 'N/A'}${o.valueQuantity?.unit ? ' ' + o.valueQuantity.unit : ''} (${o.effectiveDateTime})\n`;
    }
  }

  if (notes.length) {
    ctx += `Clinical Notes (recent first):\n`;
    for (const n of notes.slice(0, 3)) {
      const data = (n.content?.[0]?.attachment?.data || '').substring(0, 400);
      ctx += `  [${n.date}] ${n.content?.[0]?.attachment?.title || 'Note'} by ${(n.author||[]).map(a=>a.display).join(', ')}\n    ${data}\n`;
    }
  }

  return ctx;
}

function generateDifferentialPrompt(patientContext, symptoms) {
  return `You are a clinical reasoning assistant. Given a patient's chart and presenting symptoms, generate a ranked differential diagnosis.

For each differential, provide:
- The diagnosis name
- Supporting evidence from the chart (specific findings that make this diagnosis more likely)
- Contradicting evidence from the chart (specific findings that make this diagnosis less likely)
- Suggested tests or imaging to order
- Suggested questions to ask the patient

You MUST only cite findings that actually appear in the chart data. If a finding is missing, note it honestly rather than inventing it. Return ONLY valid JSON in this exact format:

{
  "differentials": [
    {
      "rank": 1,
      "diagnosis": "Diagnosis Name",
      "likelihood": "high/medium/low",
      "supportingEvidence": ["specific chart finding 1", "specific chart finding 2"],
      "contradictingEvidence": ["finding that argues against this", "missing data point"],
      "suggestedTests": ["test 1", "test 2"],
      "suggestedQuestions": ["question 1", "question 2"]
    }
  ],
  "summary": "One-sentence clinical reasoning summary"
}

PATIENT CHART:
${patientContext}

PRESENTING SYMPTOMS:
${symptoms}

Generate 3-5 differential diagnoses ranked by likelihood. Consider the patient's full chart — conditions, medications, allergies, lab results, and clinical notes.`;
}

module.exports = { buildDiffContext, generateDifferentialPrompt };
