// ─── Mock uuid (ESM-only in v10+, Jest can't parse it without transform) ───
jest.mock('uuid', () => ({
  v4: jest.fn(() => '00000000-0000-4000-8000-000000000001'),
}));

// ─── Redirect better-sqlite3 to use in-memory DB for all tests ───
// better-sqlite3 is synchronous, so no async concerns in Jest.
// Each `new Database()` call returns a unique :memory: instance.
jest.mock('better-sqlite3', () => {
  const BetterSqlite3 = jest.requireActual('better-sqlite3');
  const instances = [];

  function InMemoryDB() {
    // better-sqlite3 :memory: databases are distinct per connection.
    // Use a shared cache URI so all require() calls in the same test
    // file share one in-memory DB (schema + data).
    const db = new BetterSqlite3(':memory:');
    instances.push(db);
    return db;
  }

  // Attach static methods that the real constructor may expose
  InMemoryDB.prototype = BetterSqlite3.prototype;
  InMemoryDB.afterEachCleanup = () => {
    instances.length = 0;
  };

  return InMemoryDB;
});

// Set test secrets so deidentification uses deterministic output
process.env.DEID_SECRET = 'jest-test-deidentification-key';

// Suppress audit log file writes (audit.js writes to ./audit.jsonl)
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  const appendLog = {};

  return {
    ...actualFs,
    appendFileSync: jest.fn((path, data) => {
      if (path.endsWith('audit.jsonl')) {
        appendLog[path] = (appendLog[path] || '') + data;
      } else {
        actualFs.appendFileSync(path, data);
      }
    }),
    existsSync: jest.fn((path) => {
      if (path.endsWith('audit.jsonl')) return !!appendLog[path];
      return actualFs.existsSync(path);
    }),
    readFileSync: jest.fn((path, encoding) => {
      if (path.endsWith('audit.jsonl')) return appendLog[path] || '';
      return actualFs.readFileSync(path, encoding);
    }),
    unlinkSync: jest.fn((path) => {
      if (path.endsWith('audit.jsonl')) delete appendLog[path];
      else actualFs.unlinkSync(path);
    }),
    __clearAuditLog: () => { Object.keys(appendLog).forEach(k => delete appendLog[k]); },
  };
});
