const fs = require('fs');
const path = require('path');
const https = require('https');

const USER = 'Med-Omrani';
const OUT = path.join(__dirname, '..', 'tailored', 'github_kb.json');
const URL = `https://api.github.com/users/${USER}/repos?per_page=100&sort=updated`;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'jobcenter-kb', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 200)}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const repos = await get(URL);
  const kb = {
    fetchedAt: new Date().toISOString(),
    user: USER,
    repos: repos.map((r) => ({
      name: r.name,
      html_url: r.html_url,
      description: r.description || '',
      language: r.language || '',
      topics: Array.isArray(r.topics) ? r.topics : [],
      updated_at: r.updated_at || '',
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(kb, null, 2));
  console.log(`github_kb.json written: ${repos.length} repos -> ${OUT}`);
})().catch((e) => {
  console.error('fetch_github_kb failed:', e.message);
  process.exit(1);
});