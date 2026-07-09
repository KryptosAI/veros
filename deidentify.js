const crypto = require('crypto');

const DEID_SECRET = process.env.DEID_SECRET || 'openchart-deid-secret-change-me';

const DEFAULT_RULES = [
  { path: 'Patient.name', method: 'redact' },
  { path: 'Patient.identifier', method: 'cryptoHash' },
  { path: 'Patient.telecom', method: 'redact' },
  { path: 'Patient.address', method: 'redact' },
  { path: 'Patient.contact', method: 'redact' },
  { path: 'Patient.photo', method: 'redact' },
  { path: 'Patient.generalPractitioner', method: 'cryptoHash' },
  { path: 'Patient.managingOrganization', method: 'cryptoHash' },
  { path: 'Patient.link', method: 'redact' },
  { path: 'Practitioner.name', method: 'redact' },
  { path: 'Practitioner.identifier', method: 'cryptoHash' },
  { path: 'Practitioner.telecom', method: 'redact' },
  { path: 'Practitioner.address', method: 'redact' },
  { path: 'Practitioner.photo', method: 'redact' },
  { path: 'Observation.performer', method: 'cryptoHash' },
  { path: 'AllergyIntolerance.recorder', method: 'cryptoHash' },
  { path: 'AllergyIntolerance.asserter', method: 'cryptoHash' },
  { path: 'MedicationRequest.requester', method: 'cryptoHash' },
  { path: 'Condition.recorder', method: 'cryptoHash' },
  { path: 'Condition.asserter', method: 'cryptoHash' },
  { path: '*.note[*].authorReference', method: 'cryptoHash' },
  { path: '*.note[*].text', method: 'keep' },
];

function cryptoHashValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => cryptoHashValue(item));
  if (typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'value' && typeof v === 'string') {
        result[k] = crypto.createHmac('sha256', DEID_SECRET).update(v).digest('hex').substring(0, 16);
      } else if (k === 'system' || k === 'code') {
        result[k] = v;
      } else {
        result[k] = cryptoHashValue(v);
      }
    }
    return result;
  }
  if (typeof value === 'string') {
    return crypto.createHmac('sha256', DEID_SECRET).update(value).digest('hex').substring(0, 16);
  }
  return value;
}

function setValueByPath(obj, path, newValue) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const bracketMatch = part.match(/^(\w+)\[(\d+|\*)\]$/);
    if (bracketMatch) {
      if (bracketMatch[2] === '*') {
        for (const item of current[bracketMatch[1]]) {
          setValueByPath(item, parts.slice(i + 1).join('.'), newValue);
        }
        return;
      }
      current = current[bracketMatch[1]][parseInt(bracketMatch[2])];
    } else {
      if (!current[part] && newValue !== undefined) current[part] = {};
      current = current[part];
    }
  }
  const lastPart = parts[parts.length - 1];
  const lastBracket = lastPart.match(/^(\w+)\[(\d+|\*)\]$/);
  if (lastBracket) {
    if (lastBracket[2] === '*') {
      for (const item of current[lastBracket[1]] || []) {
        if (newValue === undefined) { delete current[lastBracket[1]]; }
        else { current = { ...item }; }
      }
    } else {
      current[lastBracket[1]][parseInt(lastBracket[2])] = newValue;
    }
    return;
  }
  if (newValue === undefined) {
    delete current[lastPart];
  } else {
    current[lastPart] = newValue;
  }
}

function getValueByPath(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      current = current?.[bracketMatch[1]]?.[parseInt(bracketMatch[2])];
    } else {
      current = current?.[part];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function matchRule(rule, resourceType) {
  const ruleType = rule.path.split('.')[0];
  if (rule.path.startsWith('*.')) return true;
  if (ruleType === resourceType) return true;
  return false;
}

function deidentifyResource(resource, rules = DEFAULT_RULES) {
  const r = JSON.parse(JSON.stringify(resource));
  const rType = r.resourceType;

  for (const rule of rules) {
    if (!matchRule(rule, rType)) continue;

    const fieldPath = rule.path.includes('.') ? rule.path.substring(rule.path.indexOf('.') + 1) : null;
    if (!fieldPath) continue;

    const value = getValueByPath(r, fieldPath);
    if (value === undefined) continue;

    if (rule.method === 'redact') {
      setValueByPath(r, fieldPath, undefined);
    } else if (rule.method === 'cryptoHash') {
      setValueByPath(r, fieldPath, cryptoHashValue(value));
    }
  }

  if (!r.meta) r.meta = {};
  if (!r.meta.security) r.meta.security = [];
  r.meta.security.push({
    system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue',
    code: 'REDACTED',
    display: 'redacted',
  });

  return r;
}

function deidentifyBundle(bundle, rules) {
  if (bundle.resourceType === 'Bundle' && bundle.entry) {
    return {
      ...bundle,
      entry: bundle.entry.map(e => ({
        ...e,
        resource: e.resource ? deidentifyResource(e.resource, rules) : undefined,
      })),
    };
  }
  return deidentifyResource(bundle, rules);
}

module.exports = { deidentifyResource, deidentifyBundle, DEFAULT_RULES, DEID_SECRET };
