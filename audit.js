const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { getDb } = require('./store');

const GENESIS_HASH = '0'.repeat(64);
const LOG_PATH = path.join(__dirname, 'audit.jsonl');
let chainHead = null;

function loadChainHead() {
  if (chainHead !== null) return chainHead;
  const d = getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS audit_chain_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const row = d.prepare('SELECT value FROM audit_chain_meta WHERE key = ?').get('chain_head');
  chainHead = row ? row.value : GENESIS_HASH;

  // If the DB was reset but old audit entries exist, clear the orphans
  if (chainHead === GENESIS_HASH && fs.existsSync(LOG_PATH)) {
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      if (lastEntry.hash !== GENESIS_HASH) {
        // DB was reset — rebuild chain_head from file
        let prev = GENESIS_HASH;
        let valid = true;
        for (const line of lines) {
          const e = JSON.parse(line);
          if (e.prev_hash !== prev) { valid = false; break; }
          prev = e.hash;
        }
        if (valid) {
          chainHead = prev;
          d.prepare('INSERT OR REPLACE INTO audit_chain_meta (key, value) VALUES (?, ?)').run('chain_head', chainHead);
        } else {
          // Chain is broken — start fresh
          fs.unlinkSync(LOG_PATH);
          chainHead = GENESIS_HASH;
        }
      }
    }
  }

  return chainHead;
}

function canonicalJson(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

function computeHash(prevHash, dataWithoutHash) {
  const prevBytes = Buffer.from(prevHash, 'utf-8');
  const dataBytes = Buffer.from(canonicalJson(dataWithoutHash), 'utf-8');
  const combined = Buffer.concat([prevBytes, dataBytes]);
  return crypto.createHash('sha256').update(combined).digest('hex');
}

function logQuery({
  userId, userRole, userName, patientId, patientName,
  queryText, queryIntent, queryParams,
  resourcesQueried, resourcesAccessed, resourcesReturned,
  dataFiltered, filteredReason,
  responseSummary, citationsCount,
  authMechanism, scopesApplied, sourceIp,
  responseTimeMs, success, errorReason, purposeOfUse,
}) {
  const prev = loadChainHead();
  const entryId = uuid();
  const timestamp = new Date().toISOString();

  const dataWithoutHash = {
    entry_id: entryId,
    timestamp,
    user_id: userId,
    user_role: userRole,
    user_name: userName || null,
    patient_id: patientId,
    patient_name: patientName || null,
    query_text: queryText,
    query_intent: queryIntent || null,
    query_params: queryParams ? JSON.stringify(queryParams) : null,
    resources_queried: resourcesQueried ? JSON.stringify(resourcesQueried) : null,
    resources_accessed: resourcesAccessed ? JSON.stringify(resourcesAccessed) : null,
    resources_returned: resourcesReturned || 0,
    data_filtered: dataFiltered ? 1 : 0,
    filtered_reason: filteredReason || null,
    response_summary: responseSummary ? responseSummary.substring(0, 500) : null,
    citations_count: citationsCount || 0,
    auth_mechanism: authMechanism || 'rbac',
    scopes_applied: scopesApplied ? JSON.stringify(scopesApplied) : null,
    source_ip: sourceIp || null,
    response_time_ms: responseTimeMs || null,
    success: success ? 1 : 0,
    error_reason: errorReason || null,
    purpose_of_use: purposeOfUse || 'TREATMENT',
    prev_hash: prev,
  };

  const hash = computeHash(prev, dataWithoutHash);
  const entry = { ...dataWithoutHash, hash };

  // Rotate audit log when it exceeds 10MB
  if (fs.existsSync(LOG_PATH)) {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > 10 * 1024 * 1024) {
      const isoDate = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = path.join(__dirname, `audit-${isoDate}.jsonl`);
      fs.renameSync(LOG_PATH, rotatedPath);
    }
  }

  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');

  const d = getDb();
  d.prepare('INSERT OR REPLACE INTO audit_chain_meta (key, value) VALUES (?, ?)').run('chain_head', hash);
  chainHead = hash;

  return entryId;
}

function verifyChain() {
  if (!fs.existsSync(LOG_PATH)) return { valid: true, entries: 0 };

  const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  let expectedPrev = GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]);

    const data = {
      entry_id: entry.entry_id,
      timestamp: entry.timestamp,
      user_id: entry.user_id,
      user_role: entry.user_role,
      user_name: entry.user_name,
      patient_id: entry.patient_id,
      patient_name: entry.patient_name,
      query_text: entry.query_text,
      query_intent: entry.query_intent,
      query_params: entry.query_params,
      resources_queried: entry.resources_queried,
      resources_accessed: entry.resources_accessed,
      resources_returned: entry.resources_returned,
      data_filtered: entry.data_filtered,
      filtered_reason: entry.filtered_reason,
      response_summary: entry.response_summary,
      citations_count: entry.citations_count,
      auth_mechanism: entry.auth_mechanism,
      scopes_applied: entry.scopes_applied,
      source_ip: entry.source_ip,
      response_time_ms: entry.response_time_ms,
      success: entry.success,
      error_reason: entry.error_reason,
      purpose_of_use: entry.purpose_of_use,
      prev_hash: entry.prev_hash,
    };

    const expectedHash = computeHash(entry.prev_hash, data);

    if (entry.prev_hash !== expectedPrev) {
      return { valid: false, broken_at: i, error: `prev_hash mismatch at entry ${i}` };
    }
    if (entry.hash !== expectedHash) {
      return { valid: false, broken_at: i, error: `hash mismatch at entry ${i}: expected ${expectedHash}, got ${entry.hash}` };
    }

    expectedPrev = entry.hash;
  }

  return { valid: true, entries: lines.length };
}

function getRecentEntries(limit = 50) {
  if (!fs.existsSync(LOG_PATH)) return [];

  const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  const entries = lines.slice(-limit).map(l => JSON.parse(l));
  entries.reverse();
  return entries.map(e => ({
    ...e,
    success: e.success === 1,
    data_filtered: e.data_filtered === 1,
    _chain_hash: e.hash,
  }));
}

function getEntriesByPatient(patientId) {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => JSON.parse(l))
    .filter(e => e.patient_id === patientId)
    .reverse();
}

module.exports = { logQuery, verifyChain, getRecentEntries, getEntriesByPatient, GENESIS_HASH };
