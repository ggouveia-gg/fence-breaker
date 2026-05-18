'use strict';
const https = require('https');

// Update this to your GitHub repo after publishing releases
const GITHUB_REPO = 'ggouveia-gg/fence-breaker';

function semverGt(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function fetchLatest() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'FenceBreaker', 'Accept': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkForUpdates(currentVersion) {
  try {
    const release = await fetchLatest();
    if (!release?.tag_name) return null;
    const latest = release.tag_name.replace(/^v/, '');
    if (semverGt(latest, currentVersion)) {
      return { version: latest, url: release.html_url };
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { checkForUpdates };
