function sanitizeUserInput(text, maxLength = 2000) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\u200b-\u200f\u2028-\u202f\u2060-\u2064\uFEFF]/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/```/g, '\\`\\`\\`');
  cleaned = cleaned.replace(/<user_input>|<\/user_input>/gi, '');
  cleaned = cleaned.replace(/\n\s*(?:SYSTEM|ASSISTANT|HUMAN):/gi, '\n[SANITIZED]:');
  return cleaned.length > maxLength ? cleaned.substring(0, maxLength).replace(/\s+\S*$/, '') : cleaned.trim();
}

function detectInjection(text) {
  if (!text) return { suspicious: false, score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  const patterns = [
    { regex: /ignore\s+(?:all\s+)?(?:previous|prior|above|these)\s+(?:instructions?|prompts?|commands?)/i, weight: 9 },
    { regex: /pretend\s+(?:you\s+(?:are|were)|to\s+be)/i, weight: 7 },
    { regex: /(?:output|print|show|reveal|display)\s+the\s+(?:system\s+prompt|instructions?|api.?key)/i, weight: 9 },
    { regex: /what\s+(?:are|is|were)\s+(?:your|the)\s+(?:instructions?|system\s+prompt)/i, weight: 5 },
    { regex: /DEEPSEEK_API_KEY|OPENAI_API_KEY|API.?KEY\s*[=:]/i, weight: 9 },
    { regex: /```[a-z]*\s*\n\s*(?:SYSTEM|ASSISTANT):/i, weight: 7 },
  ];
  for (const p of patterns) {
    if (p.regex.test(text)) { reasons.push(p.regex.source.substring(0, 40)); score += p.weight; }
  }
  return { suspicious: score >= 10, score, reasons };
}

module.exports = { sanitizeUserInput, detectInjection };
