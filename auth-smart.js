const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { getDb } = require('./store');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
const JWT_EXPIRY = '1h';

const AUTH_CODES = new Map();

function smartConfig(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/auth/authorize`,
    token_endpoint: `${baseUrl}/auth/token`,
    introspection_endpoint: `${baseUrl}/auth/introspect`,
    revocation_endpoint: `${baseUrl}/auth/revoke`,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    scopes_supported: [
      'openid', 'fhirUser', 'launch', 'launch/patient', 'launch/encounter',
      'patient/*.rs', 'patient/*.read',
      'patient/AllergyIntolerance.rs', 'patient/AllergyIntolerance.read',
      'patient/MedicationRequest.rs', 'patient/MedicationRequest.read',
      'patient/Observation.rs', 'patient/Condition.rs',
      'patient/Patient.rs',
      'user/*.rs',
    ],
    capabilities: ['launch-standalone', 'launch-ehr', 'client-public', 'client-confidential-symmetric',
      'permission-v2', 'sso-openid-connect'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };
}

function handleAuthorize(req, res) {
  const { response_type, client_id, redirect_uri, scope, state, aud, launch } = req.query;

  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
  }

  if (!redirect_uri) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
  }

  const code = uuid();
  const requestedScopes = (scope || '').split(' ').filter(Boolean);
  const patientContext = req.query.patient || null;

  AUTH_CODES.set(code, {
    client_id: client_id || 'demo-app',
    redirect_uri,
    scopes: requestedScopes,
    patient: patientContext,
    launch: launch || null,
    created_at: Date.now(),
    used: false,
  });

  const params = new URLSearchParams({ code, state: state || '' });
  const redirectUrl = `${redirect_uri}${redirect_uri.includes('?') ? '&' : '?'}${params.toString()}`;

  if (req.accepts('html') && !req.query.no_html) {
    return res.send(`
      <!DOCTYPE html>
      <html><head><title>Veros — SMART Auth</title>
      <style>body{font-family:sans-serif;max-width:500px;margin:80px auto;padding:20px;background:#0f172a;color:#e2e8f0}
      .card{background:#1e293b;padding:24px;border-radius:8px;border:1px solid #334155}
      h2{font-size:18px;margin-bottom:16px} .info{font-size:13px;color:#94a3b8;margin-bottom:12px}
      button{padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-right:8px}
      button.deny{background:#475569} select,option{background:#0f172a;color:#e2e8f0;padding:8px;border:1px solid #334155;border-radius:4px;width:100%;margin-bottom:12px}
      </style></head><body><div class="card">
      <h2>Veros Authorization</h2>
      <p class="info">Application <strong>${client_id || 'demo-app'}</strong> is requesting access.</p>
      <p class="info">Scopes: ${requestedScopes.join(', ') || 'none'}</p>
      <form method="GET" action="/auth/authorize" style="display:none" id="approveForm">
        <input type="hidden" name="response_type" value="code">
        <input type="hidden" name="client_id" value="${client_id || ''}">
        <input type="hidden" name="redirect_uri" value="${redirect_uri}">
        <input type="hidden" name="scope" value="${scope || ''}">
        <input type="hidden" name="state" value="${state || ''}">
        <input type="hidden" name="no_html" value="1">
      </form>
      <p class="info">Select user to authorize as:</p>
      <select id="userId"><option value="">-- Select --</option></select>
      <br><button onclick="approve()">Approve</button>
      <button class="deny" onclick="window.location.href='${redirect_uri}?error=access_denied&state=${state || ''}'">Deny</button>
      </div>
      <script>
        fetch('/api/users').then(r=>r.json()).then(users=>{
          const sel=document.getElementById('userId');
          users.forEach(u=>{const o=document.createElement('option');o.value=u.id;o.textContent=u.name+' ('+u.role+')';sel.appendChild(o)});
        });
        function approve(){window.location.href=location.pathname+'?response_type=code&client_id=${client_id || ''}&redirect_uri=${encodeURIComponent('${redirect_uri}')}&scope=${encodeURIComponent(scope || '')}&state=${encodeURIComponent(state || '')}&no_html=1&patient=${patientContext || ''}&user='+document.getElementById('userId').value;}
      </script></body></html>
    `);
  }

  const userId = req.query.user;
  if (!userId) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#0f172a;color:#e2e8f0"><p>Authorization requires user selection. <a href="/auth/authorize?${new URLSearchParams(req.query).toString()}">Try HTML view</a></p></body></html>`);
  }

  AUTH_CODES.get(code).userId = userId;
  res.redirect(302, redirectUrl);
}

function handleToken(req, res) {
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = req.body;

  if (grant_type === 'refresh_token' && refresh_token) {
    try {
      const decoded = jwt.verify(refresh_token, JWT_SECRET);
      const accessToken = generateAccessToken(decoded);
      return res.json({
        access_token: accessToken.accessToken,
        token_type: 'Bearer',
        expires_in: accessToken.expiresIn,
        scope: decoded.scopes.join(' '),
        patient: decoded.patient || undefined,
      });
    } catch {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
    }
  }

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const authEntry = AUTH_CODES.get(code);
  if (!authEntry || authEntry.used) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
  }

  if (Date.now() - authEntry.created_at > 10 * 60 * 1000) {
    AUTH_CODES.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
  }

  authEntry.used = true;

  const userId = authEntry.userId;
  const user = userId ? getDb().prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(userId) : null;

  if (!user) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'No user authorized' });
  }

  const scopes = authEntry.scopes;
  const tokenPayload = {
    sub: user.id,
    fhirUser: `Practitioner/${user.id}`,
    name: user.name,
    role: user.role,
    scopes,
    patient: authEntry.patient,
    launch: authEntry.launch,
  };

  const accessToken = generateAccessToken(tokenPayload);
  const idToken = generateIdToken(tokenPayload);

  const refreshTokenJwt = jwt.sign({
    sub: user.id,
    scopes,
    patient: authEntry.patient,
  }, JWT_SECRET, { expiresIn: '24h' });

  res.json({
    access_token: accessToken.accessToken,
    token_type: 'Bearer',
    expires_in: accessToken.expiresIn,
    scope: scopes.join(' '),
    id_token: idToken,
    refresh_token: refreshTokenJwt,
    patient: authEntry.patient || undefined,
  });
}

function handleIntrospect(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ active: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({
      active: true,
      scope: (decoded.scopes || []).join(' '),
      client_id: decoded.client_id || 'demo-app',
      username: decoded.name,
      sub: decoded.sub,
      exp: decoded.exp,
      iat: decoded.iat,
    });
  } catch {
    res.json({ active: false });
  }
}

function generateAccessToken(payload) {
  const expiresIn = 3600;
  const token = jwt.sign({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresIn,
  }, JWT_SECRET);
  return { accessToken: token, expiresIn };
}

function generateIdToken(payload) {
  return jwt.sign({
    sub: payload.sub,
    fhirUser: payload.fhirUser,
    name: payload.name,
    aud: payload.client_id || 'demo-app',
    iss: 'http://localhost:3100',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { smartConfig, handleAuthorize, handleToken, handleIntrospect, authMiddleware, JWT_SECRET };
