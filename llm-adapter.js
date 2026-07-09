const deepseekKey = process.env.DEEPSEEK_API_KEY || null;
const openaiKey = process.env.OPENAI_API_KEY || null;
const cloudKey = deepseekKey || openaiKey;

const LLM_CONFIG = {
  deepseekKey,
  openaiKey,

  cloudProvider: deepseekKey ? 'deepseek' : (openaiKey ? 'openai' : null),
  cloudEndpoint: deepseekKey
    ? 'https://api.deepseek.com/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions',
  cloudModel: deepseekKey
    ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat')
    : (process.env.OPENAI_MODEL || 'gpt-4o-mini'),

  ollamaEndpoint: process.env.LLM_ENDPOINT || 'http://localhost:11434',
  ollamaModel: process.env.LLM_MODEL || 'medgemma:4b',
  ollamaFallback: process.env.LLM_FALLBACK || 'qwen2.5:3b',

  enabled: !!(cloudKey || process.env.LLM_ENDPOINT),
  provider: cloudKey ? (deepseekKey ? 'deepseek' : 'openai') : (process.env.LLM_ENDPOINT ? 'ollama' : 'none'),
  timeout: parseInt(process.env.LLM_TIMEOUT || '10000'),
  temperature: 0,
};

const SYSTEM_PROMPT = `You are a clinical query parser. Extract structured information from natural language medical queries about patient records.

Return ONLY valid JSON. No explanations, no markdown.

{
  "medication": string|null,
  "query_type": "allergy_check"|"medication_list"|"lab_query"|"allergy_list"|"unknown",
  "parameters": {
    "drug_name": string|null,
    "drug_class": string|null,
    "lab_name": string|null,
    "date_range": string|null,
    "allergen": string|null,
    "condition": string|null
  }
}

Examples:
Q: "Does the patient have any allergies to penicillin?"
A: {"medication":"penicillin","query_type":"allergy_check","parameters":{"drug_name":"penicillin","allergen":"penicillin","drug_class":null,"lab_name":null,"date_range":null,"condition":null}}

Q: "Show me all medications prescribed in the last 30 days"
A: {"medication":null,"query_type":"medication_list","parameters":{"drug_name":null,"drug_class":null,"lab_name":null,"date_range":"30 days","allergen":null,"condition":null}}

Q: "What was the patient's last A1C result?"
A: {"medication":null,"query_type":"lab_query","parameters":{"drug_name":null,"drug_class":null,"lab_name":"A1C","date_range":null,"allergen":null,"condition":null}}

Q: "What allergies does the patient have?"
A: {"medication":null,"query_type":"allergy_list","parameters":{"drug_name":null,"drug_class":null,"lab_name":null,"date_range":null,"allergen":null,"condition":null}}

Q: "What color is the sky?"
A: {"medication":null,"query_type":"unknown","parameters":{"drug_name":null,"drug_class":null,"lab_name":null,"date_range":null,"allergen":null,"condition":null}}`;

function extractJSON(text) {
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try { return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1)); }
  catch { return null; }
}

async function callCloud(prompt) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_CONFIG.timeout);

    const resp = await fetch(LLM_CONFIG.cloudEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cloudKey}`,
      },
      body: JSON.stringify({
        model: LLM_CONFIG.cloudModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: LLM_CONFIG.temperature,
        max_tokens: 256,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

async function callOllama(model, prompt) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_CONFIG.timeout);

    const resp = await fetch(`${LLM_CONFIG.ollamaEndpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt,
        stream: false,
        options: { temperature: LLM_CONFIG.temperature, num_predict: 256 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.response || null;
  } catch {
    return null;
  }
}

async function llmParseQuery(question) {
  if (!LLM_CONFIG.enabled) return null;
  const userPrompt = `Q: "${question}"\nA:`;

  let response;
  let which;

  if (LLM_CONFIG.cloudProvider) {
    response = await callCloud(userPrompt);
    which = LLM_CONFIG.cloudProvider;
  } else if (LLM_CONFIG.provider === 'ollama') {
    response = await callOllama(LLM_CONFIG.ollamaModel, `${SYSTEM_PROMPT}\n\n${userPrompt}`);
    which = 'ollama';

    if (!extractJSON(response || '') && LLM_CONFIG.ollamaFallback !== LLM_CONFIG.ollamaModel) {
      response = await callOllama(LLM_CONFIG.ollamaFallback, `${SYSTEM_PROMPT}\n\n${userPrompt}`);
      which = 'ollama-fallback';
    }
  }

  const parsed = extractJSON(response || '');
  if (!parsed || !parsed.query_type || parsed.query_type === 'unknown') return null;
  parsed._provider = which;
  return parsed;
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
  /allergic\s+to\s+anything/i,
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

function regexParseQuery(question) {
  const q = question.trim();
  for (const pattern of ALLERGY_QUERY_PATTERNS) {
    const match = q.match(pattern);
    if (match) return { type: 'allergy_check', medication: match[1].trim(), intent: `Check for adverse reaction/allergy to ${match[1].trim()}` };
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
  return { type: 'unknown', intent: 'Unrecognized query pattern' };
}

async function parseQuery(question) {
  const llmResult = await llmParseQuery(question);

  if (llmResult) {
    const typeMap = {
      allergy_check: 'allergy_check',
      medication_list: 'medication_list',
      lab_query: 'abnormal_labs',
      allergy_list: 'allergy_list',
    };

    const type = typeMap[llmResult.query_type] || llmResult.query_type;
    const medication = llmResult.parameters?.drug_name || llmResult.parameters?.allergen || llmResult.medication || null;

    return {
      type, medication,
      intent: llmResult.query_type,
      parsedBy: 'llm',
      llmProvider: llmResult._provider || LLM_CONFIG.provider,
      llmRaw: llmResult,
    };
  }

  const regexResult = regexParseQuery(question);
  return { ...regexResult, parsedBy: 'regex' };
}

module.exports = { parseQuery, llmParseQuery, regexParseQuery, LLM_CONFIG, SYSTEM_PROMPT };
