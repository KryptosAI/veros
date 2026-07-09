const BASE = 'https://clinicaltrials.gov/api/v2/studies';

async function searchTrials(conditions, limit = 5) {
  try {
    const query = Array.isArray(conditions) ? conditions.join(' OR ') : conditions;
    const params = new URLSearchParams({
      'query.cond': query,
      'filter.overallStatus': 'RECRUITING|NOT_YET_RECRUITING',
      pageSize: String(limit),
      countTotal: 'true',
      sort: 'LastUpdatePostDate:desc',
    });
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.studies || []).map(s => {
      const p = s.protocolSection || {};
      return {
        nctId: p.identificationModule?.nctId || 'N/A',
        title: p.identificationModule?.briefTitle || 'Unknown',
        status: p.statusModule?.overallStatus || 'Unknown',
        conditions: p.conditionsModule?.conditions || [],
        phases: p.designModule?.phases || [],
        enrollment: p.designModule?.enrollmentInfo?.count || null,
        locations: (p.contactsLocationsModule?.locations || []).map(l => ({
          facility: l.facility,
          city: l.city,
          state: l.state,
          country: l.country,
          status: l.status,
        })).slice(0, 5),
        lastUpdated: p.statusModule?.lastUpdatePostDateStruct?.date || 'N/A',
        url: `https://clinicaltrials.gov/study/${p.identificationModule?.nctId || ''}`,
      };
    });
  } catch {
    return [];
  }
}

module.exports = { searchTrials };
