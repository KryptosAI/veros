const Database = require('better-sqlite3');
const path = require('path');

let db;
const DB_PATH = path.join(__dirname, 'openchart.db');

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS fhir_resources (
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        patient_id TEXT,
        resource_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (resource_type, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_resources_patient ON fhir_resources(patient_id);
      CREATE INDEX IF NOT EXISTS idx_resources_type ON fhir_resources(resource_type);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        patient_id TEXT,
        api_key TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    `);
  }
  return db;
}

function addResource(resource) {
  const d = getDb();
  const json = JSON.stringify(resource);
  const patientId = extractPatientId(resource);
  d.prepare(`
    INSERT OR REPLACE INTO fhir_resources (resource_type, resource_id, patient_id, resource_json)
    VALUES (?, ?, ?, ?)
  `).run(resource.resourceType, resource.id, patientId, json);
}

function addResources(resources) {
  const d = getDb();
  const insert = d.prepare(`
    INSERT OR REPLACE INTO fhir_resources (resource_type, resource_id, patient_id, resource_json)
    VALUES (?, ?, ?, ?)
  `);
  const tx = d.transaction((items) => {
    for (const r of items) {
      insert.run(r.resourceType, r.id, extractPatientId(r), JSON.stringify(r));
    }
  });
  tx(resources);
}

function extractPatientId(resource) {
  const ref = resource.subject?.reference || resource.patient?.reference || '';
  const parts = ref.split('/');
  return parts[parts.length - 1] || null;
}

function getResource(type, id) {
  const row = getDb().prepare('SELECT resource_json FROM fhir_resources WHERE resource_type = ? AND resource_id = ?').get(type, id);
  return row ? JSON.parse(row.resource_json) : null;
}

function searchByPatient(type, patientId) {
  const rows = getDb().prepare('SELECT resource_json FROM fhir_resources WHERE resource_type = ? AND patient_id = ?').all(type, patientId);
  return rows.map(r => JSON.parse(r.resource_json));
}

function searchAllergiesByMedication(patientId, medicationNames) {
  const allergies = searchByPatient('AllergyIntolerance', patientId);
  const lowerNames = medicationNames.map(n => n.toLowerCase());

  return allergies.filter(allergy => {
    if (allergy.verificationStatus?.coding?.[0]?.code === 'refuted') return false;
    const codeText = (allergy.code?.text || '').toLowerCase();
    const displayTexts = (allergy.code?.coding || []).map(c => (c.display || '').toLowerCase());
    return lowerNames.some(name =>
      codeText.includes(name) ||
      displayTexts.some(d => d.includes(name)) ||
      (allergy.reaction || []).some(r =>
        (r.substance?.text || '').toLowerCase().includes(name) ||
        (r.substance?.coding || []).some(c => (c.display || '').toLowerCase().includes(name))
      )
    );
  });
}

function searchMedicationRequests(patientId, medicationNames) {
  const requests = searchByPatient('MedicationRequest', patientId);
  const lowerNames = medicationNames.map(n => n.toLowerCase());
  return requests.filter(req => {
    const medText = (req.medicationCodeableConcept?.text || '').toLowerCase();
    const medDisplay = (req.medicationCodeableConcept?.coding || []).map(c => (c.display || '').toLowerCase());
    return lowerNames.some(name => medText.includes(name) || medDisplay.some(d => d.includes(name)));
  });
}

function searchAllAllergies(patientId) {
  return searchByPatient('AllergyIntolerance', patientId)
    .filter(a => a.verificationStatus?.coding?.[0]?.code !== 'refuted');
}

function searchAllMedications(patientId) {
  return searchByPatient('MedicationRequest', patientId);
}

function searchObservations(patientId, loincCodes) {
  const all = searchByPatient('Observation', patientId);
  if (!loincCodes || loincCodes.length === 0) return all;
  const codeSet = new Set(loincCodes);
  return all.filter(obs => {
    return (obs.code?.coding || []).some(c => codeSet.has(c.code));
  });
}

function searchConditions(patientId) {
  return searchByPatient('Condition', patientId);
}

function resourceCount() {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) as cnt FROM fhir_resources').get();
  return row.cnt || 0;
}

function patientCount() {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) as cnt FROM fhir_resources WHERE resource_type = ?').get('Patient');
  return row.cnt || 0;
}

function countByType(type) {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) as cnt FROM fhir_resources WHERE resource_type = ?').get(type);
  return row.cnt || 0;
}

function countResources() {
  const d = getDb();
  const rows = d.prepare('SELECT resource_type, COUNT(*) as cnt FROM fhir_resources GROUP BY resource_type').all();
  const result = {};
  for (const r of rows) result[r.resource_type] = r.cnt;
  return result;
}

function clearAll() {
  getDb().exec('DELETE FROM fhir_resources');
}

function importFHIRBundle(bundle) {
  const d = getDb();
  const insert = d.prepare('INSERT OR REPLACE INTO fhir_resources (resource_type, resource_id, patient_id, resource_json) VALUES (?, ?, ?, ?)');
  let count = 0;
  const tx = d.transaction((entries) => {
    for (const e of entries) {
      const r = e.resource || e;
      if (r.resourceType && r.id) {
        insert.run(r.resourceType, r.id, extractPatientId(r), JSON.stringify(r));
        count++;
      }
    }
  });
  if (bundle.entry) tx(bundle.entry);
  else if (Array.isArray(bundle)) tx(bundle.map(r => ({ resource: r })));
  return count;
}

module.exports = {
  getDb, addResource, addResources, getResource,
  searchByPatient, searchAllergiesByMedication, searchMedicationRequests,
  searchAllAllergies, searchAllMedications, searchObservations, searchConditions,
  resourceCount, patientCount, countByType, countResources, clearAll,
  importFHIRBundle, extractPatientId,
};
