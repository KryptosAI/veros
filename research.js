async function searchResearch(query, limit = 3) {
  try {
    // Step 1: Search PubMed for IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json&sort=relevance`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];
    const searchJson = await searchRes.json();
    const ids = searchJson.esearchresult?.idlist || [];
    if (!ids.length) return [];

    // Step 2: Get summaries
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
    const summaryRes = await fetch(summaryUrl);
    if (!summaryRes.ok) return [];
    const summaryJson = await summaryRes.json();

    return ids.map(id => {
      const r = summaryJson.result?.[id] || {};
      return {
        title: r.title || 'Unknown',
        authors: (r.authors || []).map(a => a.name).join(', '),
        journal: r.fulljournalname || r.source || 'Unknown',
        year: r.pubdate?.split(' ').pop() || 'N/A',
        snippet: '',
        pmid: id,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      };
    }).filter(p => p.title !== 'Unknown');
  } catch {
    return [];
  }
}

module.exports = { searchResearch };
