const BASE = 'https://api.semanticscholar.org/graph/v1/paper/search';

async function searchResearch(query, limit = 5) {
  try {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
      fields: 'title,authors,year,journal,abstract,externalIds',
    });
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map(p => ({
      title: p.title,
      authors: (p.authors || []).map(a => a.name).join(', '),
      journal: p.journal?.name || 'Unknown',
      year: p.year || 'N/A',
      snippet: (p.abstract || '').substring(0, 400),
      pmid: p.externalIds?.PubMed || null,
      doi: p.externalIds?.DOI || null,
      url: p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : null,
    }));
  } catch {
    return [];
  }
}

module.exports = { searchResearch };
