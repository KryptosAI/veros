const { ROLES, getUserById } = require('./data');
const store = require('./store');
const { parseQuery: llmParseQuery } = require('./llm-adapter');
const { INTENTS, findIntent, generateCitation, generateLLMPrompt } = require('./intents');

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
      return { allowed: false, reason: `Role '${user.role}' (${role.label}) lacks read access to ${rt} resources`, missingResource: rt };
    }
  }
  return { allowed: true, role: user.role, roleLabel: role.label, userName: user.name, scopes: resourceTypes.map(rt => `patient/${rt}.rs`) };
}

function humanizeIntent(name) {
  const map = {
    allergy_check: 'Checking for allergies or adverse reactions',
    allergy_list: 'Listing all known allergies',
    medication_list: 'Listing medications on record',
    abnormal_labs: 'Finding abnormal lab results',
    demographic: 'Looking up patient demographics',
    chart_overview: 'Assembling full chart overview',
  };
  return map[name] || `Processing as: ${name}`;
}

function extractKeywords(question) {
  const stop = new Set(['the','is','are','was','were','a','an','any','this','that','for','with','from','has','have','had','does','do','did','can','could','would','should','will','may','tell','me','if','about','of','to','in','on','at','by','or','and','not','no','it','be','been','being','check','see','find','show','get','there','their','patient','what','which','who','please','you','we','he','she','they']);
  return question.toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)).slice(0, 15);
}

function keywordSearch(patientId, keywords) {
  if (keywords.length === 0) return [];
  const results = [];
  const match = (text) => keywords.filter(k => text.includes(k)).length;

  for (const r of store.searchAllAllergies(patientId)) { const s = match(JSON.stringify(r).toLowerCase()); if (s > 0) results.push({ ...r, _score: s, _type: 'allergy' }); }
  for (const r of store.searchConditions(patientId)) { const s = match(JSON.stringify(r).toLowerCase()); if (s > 0) results.push({ ...r, _score: s, _type: 'condition' }); }
  for (const r of store.searchAllMedications(patientId)) { const s = match(JSON.stringify(r).toLowerCase()); if (s > 0) results.push({ ...r, _score: s, _type: 'medication' }); }
  for (const r of store.searchObservations(patientId)) { const s = match(JSON.stringify(r).toLowerCase()); if (s > 0) results.push({ ...r, _score: s, _type: 'observation' }); }

  return results.sort((a, b) => b._score - a._score);
}

function chartSummary(patientId, patientName) {
  const patient = store.getResource('Patient', patientId);
  const conditions = store.searchConditions(patientId);
  const allergies = store.searchAllAllergies(patientId);
  const meds = store.searchAllMedications(patientId);

  const dob = patient?.birthDate;
  const age = dob ? (() => { const b = new Date(dob); const n = new Date(); let a = n.getFullYear() - b.getFullYear(); const m = n.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--; return a; })() : 'unknown';

  const activeConds = conditions.filter(c => c.clinicalStatus?.coding?.[0]?.code === 'active');
  const activeMeds = meds.filter(m => m.status === 'active');

  let text = `${patientName}, ${age}yo ${patient?.gender || ''}, MRN ${patient?.identifier?.[0]?.value || 'N/A'}. `;
  if (activeConds.length) text += `Conditions: ${activeConds.map(c => c.code?.text).join(', ')}. `;
  if (allergies.length) text += `Allergies: ${allergies.filter(a => a.verificationStatus?.coding?.[0]?.code !== 'refuted').map(a => a.code?.text).join(', ')}. `;
  if (activeMeds.length) text += `Meds: ${activeMeds.map(m => m.medicationCodeableConcept?.text).join(', ')}. `;

  const allCitations = [patient, ...conditions, ...allergies, ...meds].filter(Boolean).map(generateCitation);
  return { text: text.trim(), citations: allCitations };
}

async function processQuery(question, patientId, userId, patientName, sourceIp) {
  const startTime = Date.now();
  const user = getUserById(userId);
  const userRole = user ? user.role : 'unknown';
  const userName = user ? user.name : 'Unknown User';

  const allRT = ['AllergyIntolerance', 'MedicationRequest', 'Observation', 'Condition', 'Patient'];
  const perm = validatePermissions(userId, patientId, allRT);
  if (!perm.allowed) {
    return { success: false, error: perm.reason, audit: mkAudit(userId, userRole, userName, patientId, patientName, question, 'permission_denied', allRT, [], 0, perm.reason, Date.now() - startTime, sourceIp, false, perm.reason) };
  }

  // 1. LLM interprets the question
  const interpretation = await llmParseQuery(question);
  let intentName = interpretation?.type || null;

  // 2. Regex fallback when LLM is unavailable (eval mode, offline)
  let fallbackParams = {};
  if (!intentName) {
    const q = question.toLowerCase();
    const medMatch = q.match(/allerg(?:ic|y|ys|ies)\s+to\s+(\w[\w\s-]*\w)/i) || q.match(/(?:reaction|react)\s+to\s+(\w[\w\s-]*\w)/i) || q.match(/intoleran(?:ce|t)\s+to\s+(\w[\w\s-]*\w)/i) || q.match(/problems?\s+with\s+(\w[\w\s-]*\w)/i);
    if (medMatch) { intentName = 'allergy_check'; fallbackParams = { medication: medMatch[1].trim() }; }
    else if (/all.*allerg|any.*allerg|what.*allerg|list.*allerg/i.test(q)) intentName = 'allergy_list';
    else if (/meds|medication|taking|prescribed|what.*on/i.test(q)) intentName = 'medication_list';
    else if (/abnormal.*lab|lab.*abnormal|out.*range/i.test(q)) intentName = 'abnormal_labs';
    else if (/how.*old|age|born|birth|dob|name|gender|sex|mrn/i.test(q)) intentName = 'demographic';
    else if (/tell.*about|what.*this|summarize|overview|looking.*at/i.test(q)) intentName = 'chart_overview';
  }

  const intent = intentName ? findIntent(intentName) : null;
  const understanding = humanizeIntent(intentName || 'search');
  const searchedTypes = intent ? intent.resourceTypes : allRT;

  // 3. Run the intent handler if found
  if (intent) {
    const searchParams = (interpretation?.llmRaw?.parameters) || (interpretation?.medication ? { medication: interpretation.medication } : {}) || fallbackParams;
    const result = intent.search(patientId, searchParams, question);
    const answer = intent.answer(patientName, result, searchParams, question);
    const rt = Date.now() - startTime;

    return {
      success: true, question, understanding, searched: searchedTypes,
      answer: answer.answer, citations: answer.citations, hasMatch: answer.hasMatch,
      confidence: answer.confidence, policy: 'all_cited',
      permissions: perm, responseTimeMs: rt, parsedBy: 'llm',
      audit: mkAudit(userId, perm.role, perm.userName, patientId, patientName, question, intentName, searchedTypes, answer.citations.map(c => ({ type: c.sourceType, id: c.sourceId })), answer.citations.length, answer.answer.substring(0, 500), rt, sourceIp, true),
    };
  }

  // 4. No matching intent — keyword search
  const keywords = extractKeywords(question);
  const matches = keywordSearch(patientId, keywords);
  const rt = Date.now() - startTime;

  if (matches.length > 0) {
    const top = matches.slice(0, 8);
    const citations = top.map(generateCitation);
    const grouped = {};
    for (const m of top) { const t = m._type; if (!grouped[t]) grouped[t] = []; grouped[t].push(m); }

    let answer = `Searched across conditions, allergies, medications, and labs for: "${keywords.join(' ')}". `;
    for (const [t, items] of Object.entries(grouped)) {
      answer += `Found in ${t}s: ${items.map(i => {
        if (t === 'allergy') return i.code?.text;
        if (t === 'condition') return i.code?.text;
        if (t === 'medication') return i.medicationCodeableConcept?.text;
        if (t === 'observation') return `${i.code?.text}: ${i.valueQuantity?.value || i.valueString}`;
        return '';
      }).filter(Boolean).join(', ')}. `;
    }

    return {
      success: true, question, understanding: `Searched chart for: "${keywords.join(' ')}"`, searched: allRT,
      answer: answer.trim(), citations, hasMatch: true, confidence: 0.3, policy: 'keyword_search',
      permissions: perm, responseTimeMs: rt, parsedBy: 'llm',
      audit: mkAudit(userId, perm.role, perm.userName, patientId, patientName, question, 'keyword_search', allRT, citations.map(c => ({ type: c.sourceType, id: c.sourceId })), citations.length, answer.substring(0, 500), rt, sourceIp, true),
    };
  }

  // 5. Nothing found — patient summary
  const summary = chartSummary(patientId, patientName);
  return {
    success: true, question, understanding: 'Assembling chart overview', searched: allRT,
    answer: summary.text, citations: summary.citations, hasMatch: true, confidence: 0.2, policy: 'chart_summary',
    permissions: perm, responseTimeMs: rt, parsedBy: 'llm',
    audit: mkAudit(userId, perm.role, perm.userName, patientId, patientName, question, 'chart_summary', allRT, summary.citations.map(c => ({ type: c.sourceType, id: c.sourceId })), summary.citations.length, summary.text.substring(0, 500), rt, sourceIp, true),
  };
}

function mkAudit(userId, role, name, patientId, patientName, queryText, intent, queried, accessed, returned, summary, ms, ip, success, errReason) {
  return { userId, userRole: role, userName: name, patientId, patientName, queryText, queryIntent: intent, resourcesQueried: queried, resourcesAccessed: accessed || [], resourcesReturned: returned || 0, dataFiltered: false, responseSummary: summary || '', citationsCount: returned || 0, authMechanism: 'rbac', scopesApplied: [], sourceIp: ip, responseTimeMs: ms, success, errorReason: errReason || null, purposeOfUse: 'TREATMENT' };
}

module.exports = { processQuery, generateLLMPrompt, generateCitation, INTENTS };
