const BASE = 'https://clinicaltrials.gov/api/v2/studies';

async function searchTrials(conditions, patientContext = {}, limit = 5) {
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
      const eligibility = p.eligibilityModule || {};
      const ageMatch = checkAgeEligibility(patientContext.age, eligibility);
      const genderMatch = checkGenderEligibility(patientContext.gender, eligibility);

      return {
        nctId: p.identificationModule?.nctId || 'N/A',
        title: p.identificationModule?.briefTitle || 'Unknown',
        status: p.statusModule?.overallStatus || 'Unknown',
        conditions: p.conditionsModule?.conditions || [],
        phases: p.designModule?.phases || [],
        enrollment: p.designModule?.enrollmentInfo?.count || null,
        eligibilityCriteria: eligibility.eligibilityCriteria || '',
        minAge: eligibility.minimumAge || null,
        maxAge: eligibility.maximumAge || null,
        gender: eligibility.sex || 'ALL',
        patientMatches: { age: ageMatch, gender: genderMatch },
        locations: (p.contactsLocationsModule?.locations || []).map(l => ({
          facility: l.facility, city: l.city, state: l.state,
          country: l.country, status: l.status,
        })).slice(0, 3),
        lastUpdated: p.statusModule?.lastUpdatePostDateStruct?.date || 'N/A',
        url: `https://clinicaltrials.gov/study/${p.identificationModule?.nctId || ''}`,
      };
    });
  } catch {
    return [];
  }
}

function checkAgeEligibility(patientAge, eligibility) {
  if (!patientAge) return 'unknown';
  const minStr = eligibility.minimumAge || '';
  const maxStr = eligibility.maximumAge || '';
  const min = parseAge(minStr);
  const max = parseAge(maxStr);
  if (min !== null && patientAge < min) return 'too_young';
  if (max !== null && patientAge > max) return 'too_old';
  if (min !== null || max !== null) return 'matches';
  return 'not_specified';
}

function checkGenderEligibility(patientGender, eligibility) {
  if (!patientGender) return 'unknown';
  const sex = (eligibility.sex || 'ALL').toUpperCase();
  if (sex === 'ALL') return 'matches';
  const pGender = patientGender.toUpperCase();
  if (sex === 'FEMALE' && pGender === 'FEMALE') return 'matches';
  if (sex === 'MALE' && pGender === 'MALE') return 'matches';
  if (sex === 'FEMALE' && pGender === 'MALE') return 'gender_mismatch';
  if (sex === 'MALE' && pGender === 'FEMALE') return 'gender_mismatch';
  return 'matches';
}

function parseAge(ageStr) {
  if (!ageStr) return null;
  const match = ageStr.match(/(\d+)\s*(?:Years?|Yrs?)?/i);
  return match ? parseInt(match[1]) : null;
}

module.exports = { searchTrials };

