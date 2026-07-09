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

// Regex patterns — used only as fallback when LLM is unavailable
const REGEX_PATTERNS = [
  { pattern: /(?:any\s+)?history\s+(?:of\s+)?(?:an?\s+)?(?:adverse\s+)?reaction\s+to\s+(\w[\w\s-]*\w)/i, intent: 'allergy_check', extract: m => ({ medication: m[1].trim() }) },
  { pattern: /(?:is\s+(?:the\s+)?(?:patient|pt)\s+)?allergic\s+to\s+(\w[\w\s-]*\w)/i, intent: 'allergy_check', extract: m => ({ medication: m[1].trim() }) },
  { pattern: /allergy\s+to\s+(\w[\w\s-]*\w)/i, intent: 'allergy_check', extract: m => ({ medication: m[1].trim() }) },
  { pattern: /intolerance\s+to\s+(\w[\w\s-]*\w)/i, intent: 'allergy_check', extract: m => ({ medication: m[1].trim() }) },
  { pattern: /(?:any\s+)?problems?\s+with\s+(\w[\w\s-]*\w)/i, intent: 'allergy_check', extract: m => ({ medication: m[1].trim() }) },
  { pattern: /hypersensitivity\s+to\s+(\w[\w\s-]*\w)/i, intent: 'allergy_check', extract: m => ({ medication: m[1].trim() }) },
  { pattern: /(?:what|any)\s+allerg(?:y|ies)/i, intent: 'allergy_list' },
  { pattern: /allergic\s+to\s+anything/i, intent: 'allergy_list' },
  { pattern: /(?:list|show)\s+(?:all\s+)?(?:medications|meds|drugs)/i, intent: 'medication_list' },
  { pattern: /(?:what|current|active)\s+(?:medications|meds|drugs)/i, intent: 'medication_list' },
  { pattern: /what\s+(?:is|are)\s+(?:the\s+)?(?:patient|pt)\s+(?:taking|on)/i, intent: 'medication_list' },
  { pattern: /(?:what|which|any)\s+labs?\s+(?:are|is|were)\s+(?:abnormal|out\s+of\s+range)/i, intent: 'abnormal_labs' },
  { pattern: /(?:show|list)\s+abnormal\s+labs/i, intent: 'abnormal_labs' },
  { pattern: /how\s+old/i, intent: 'demographic' },
  { pattern: /(?:date\s+of\s+)?birth|dob\b|birthday/i, intent: 'demographic' },
  { pattern: /when\s+was\s+(?:he|she|they|the\s+patient)\s+born/i, intent: 'demographic' },
  { pattern: /what\s+(?:is|are)\s+(?:his|her|their|the\s+patient'?s?)\s+(?:name|gender|sex|MRN)/i, intent: 'demographic' },
];

function regexParseQuestion(question) {
  const q = question.trim();
  for (const rule of REGEX_PATTERNS) {
    const match = q.match(rule.pattern);
    if (match) {
      const params = rule.extract ? rule.extract(match) : {};
      return { intent: rule.intent, params, parsedBy: 'regex' };
    }
  }
  return { intent: 'fallback', params: {}, parsedBy: 'regex' };
}

function keywordSearchFallback(patientId, question) {
  const stopWords = new Set(['the','is','are','was','were','a','an','any','this','that','for','with','from','has','have','had','does','do','did','can','could','would','should','will','may','tell','me','if','about','of','to','in','on','at','by','or','and','not','no','it','be','been','being','check','see','find','show','get','there','their','patient','what','which','who','please','you','we','he','she','they']);
  const keywords = question.toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)).slice(0, 20);

  if (keywords.length === 0) return { type: 'fallback', matches: [], keywords: [] };

  const allResources = [];
  const searchText = (r) => JSON.stringify(r).toLowerCase();

  for (const r of store.searchAllAllergies(patientId)) { const c = keywords.filter(k => searchText(r).includes(k)).length; if (c > 0) allResources.push({ ...r, _matchScore: c, _searchHit: 'allergy' }); }
  for (const r of store.searchConditions(patientId)) { const c = keywords.filter(k => searchText(r).includes(k)).length; if (c > 0) allResources.push({ ...r, _matchScore: c, _searchHit: 'condition' }); }
  for (const r of store.searchAllMedications(patientId)) { const c = keywords.filter(k => searchText(r).includes(k)).length; if (c > 0) allResources.push({ ...r, _matchScore: c, _searchHit: 'medication' }); }
  for (const r of store.searchObservations(patientId)) { const c = keywords.filter(k => searchText(r).includes(k)).length; if (c > 0) allResources.push({ ...r, _matchScore: c, _searchHit: 'observation' }); }

  allResources.sort((a, b) => b._matchScore - a._matchScore);
  return { type: 'fallback', matches: allResources, keywords };
}

function buildFallbackAnswer(patientName, result, patientId) {
  const { matches } = result;
  if (matches.length === 0) {
    const allergies = store.searchAllAllergies(patientId);
    const conditions = store.searchConditions(patientId);
    const meds = store.searchAllMedications(patientId);
    const allCitations = [...allergies, ...conditions, ...meds].map(r => generateCitation(r));
    if (allCitations.length === 0) return { answer: `No information found for ${patientName}.`, citations: [], hasMatch: false, confidence: 0 };
    const activeMeds = meds.filter(m => m.status === 'active');
    let overview = `${patientName} has ${conditions.length} condition(s), ${allergies.length} allergy record(s), ${meds.length} medication(s). `;
    if (activeMeds.length > 0) overview += `Active: ${activeMeds.map(m => m.medicationCodeableConcept?.text || 'unknown').join(', ')}. `;
    if (conditions.length > 0) overview += `Diagnoses: ${conditions.map(c => c.code?.text || 'unknown').join(', ')}.`;
    return { answer: overview.trim(), citations: allCitations, hasMatch: true, confidence: 0.2 };
  }
  const top = matches.slice(0, 10);
  const citations = top.map(r => generateCitation(r));
  const grouped = {};
  for (const m of top) { const t = m._searchHit || m.resourceType; if (!grouped[t]) grouped[t] = []; grouped[t].push(m); }
  let answer = `Found ${top.length} matching record(s). `;
  for (const [type, items] of Object.entries(grouped)) {
    const labels = items.map(i => {
      if (type === 'allergy') return i.code?.text || i.code?.coding?.[0]?.display || 'unknown';
      if (type === 'condition') return i.code?.text || i.code?.coding?.[0]?.display || 'unknown';
      if (type === 'medication') return i.medicationCodeableConcept?.text || 'unknown';
      if (type === 'observation') return `${i.code?.text || '?'}: ${i.valueQuantity?.value || i.valueString || 'N/A'}`;
      return 'unknown';
    });
    answer += `${type}s: ${labels.join(', ')}. `;
  }
  return { answer: answer.trim(), citations, hasMatch: true, confidence: 0.3 };
}

async function processQuery(question, patientId, userId, patientName, sourceIp) {
  const startTime = Date.now();
  const user = getUserById(userId);
  const userRole = user ? user.role : 'unknown';
  const userName = user ? user.name : 'Unknown User';

  const allResourceTypes = ['AllergyIntolerance', 'MedicationRequest', 'Observation', 'Condition', 'Patient'];
  const permResult = validatePermissions(userId, patientId, allResourceTypes);
  if (!permResult.allowed) {
    return { success: false, error: permResult.reason, permissions: permResult, audit: { userId, userRole, userName, patientId, patientName, queryText: question, resourcesQueried: allResourceTypes, resourcesAccessed: [], resourcesReturned: 0, dataFiltered: false, filteredReason: null, responseSummary: permResult.reason, citationsCount: 0, authMechanism: 'rbac', scopesApplied: [], sourceIp, responseTimeMs: Date.now() - startTime, success: false, errorReason: permResult.reason, purposeOfUse: 'TREATMENT' } };
  }

  // LLM first — handles any phrasing
  let resolution = null;
  const llmResult = await llmParseQuery(question);
  if (llmResult && llmResult.query_type && llmResult.query_type !== 'unknown') {
    resolution = { intent: llmResult.query_type, params: llmResult.parameters || {}, parsedBy: 'llm' };
  }

  // Regex fallback if LLM couldn't handle it
  if (!resolution) {
    resolution = regexParseQuestion(question);
  }

  const intent = findIntent(resolution.intent);

  // Intent found — run its search + answer handlers
  if (intent) {
    const searchResult = intent.search(patientId, resolution.params, question);
    const answer = intent.answer(patientName, searchResult, resolution.params, question);
    const enforced = enforceNoSourceNoAnswer(answer, answer.citations, true);
    const responseTimeMs = Date.now() - startTime;

    return {
      success: true, question, answer: enforced.answer, citations: enforced.citations,
      hasMatch: enforced.hasMatch, confidence: enforced.confidence, policy: enforced.policy,
      permissions: permResult, responseTimeMs, parsed: resolution,
      audit: { userId, userRole: permResult.role, userName: permResult.userName, patientId, patientName, queryText: question, queryIntent: resolution.intent, queryParams: resolution, resourcesQueried: intent.resourceTypes, resourcesAccessed: answer.citations.map(c => ({ type: c.sourceType, id: c.sourceId })), resourcesReturned: answer.citations.length, dataFiltered: false, filteredReason: null, responseSummary: enforced.answer.substring(0, 500), citationsCount: enforced.citations.length, authMechanism: 'rbac', scopesApplied: permResult.scopes, sourceIp, responseTimeMs, success: true, errorReason: null, purposeOfUse: 'TREATMENT' },
    };
  }

  // Fallback keyword search
  const fallbackResult = keywordSearchFallback(patientId, question);
  const answer = buildFallbackAnswer(patientName, fallbackResult, patientId);
  const enforced = enforceNoSourceNoAnswer(answer, answer.citations, true);
  const responseTimeMs = Date.now() - startTime;

  return {
    success: true, question, answer: enforced.answer, citations: enforced.citations,
    hasMatch: enforced.hasMatch, confidence: enforced.confidence, policy: enforced.policy,
    permissions: permResult, responseTimeMs, parsed: resolution,
    audit: { userId, userRole: permResult.role, userName: permResult.userName, patientId, patientName, queryText: question, queryIntent: 'fallback_keyword', queryParams: resolution, resourcesQueried: allResourceTypes, resourcesAccessed: fallbackResult.matches.slice(0, 10).map(m => ({ type: m.resourceType, id: m.id })), resourcesReturned: answer.citations.length, dataFiltered: false, responseSummary: enforced.answer.substring(0, 500), citationsCount: enforced.citations.length, authMechanism: 'rbac', scopesApplied: permResult.scopes, sourceIp, responseTimeMs, success: true, errorReason: null, purposeOfUse: 'TREATMENT' },
  };
}

function enforceNoSourceNoAnswer(answer, citations, searched) {
  if (citations.length === 0 && !searched) return { ...answer, answer: 'Unable to provide an answer — no source data was found in the patient record. This system operates under a "no source, no answer" policy.', policy: 'no_source_no_answer' };
  if (citations.length === 0 && searched) return { ...answer, policy: 'negative_findings' };
  return { ...answer, policy: 'all_cited' };
}

module.exports = { processQuery, generateLLMPrompt, generateCitation, INTENTS };
