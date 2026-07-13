/**
 * CPI Explorer - Backend API
 * ---------------------------
 * Wraps the existing metadata.json search logic in a small REST API,
 * so the Chrome extension can call GET /search?q=... without ever
 * touching your CPI credentials or the local filesystem directly.
 *
 * SETUP
 *   npm install express cors
 *   node server.js
 *
 * The sync itself (node cpi-search.js sync) still runs separately -
 * this server just serves whatever is currently in metadata.json.
 * Re-run the sync script periodically (cron, or manually) to refresh it.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const METADATA_FILE = path.join(__dirname, '..', 'data', 'metadata.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors()); // allows the extension (different origin) to call this API

app.get('/search', (req, res) => {
  const term = (req.query.q || '').toLowerCase().trim();

  if (!term) {
    return res.status(400).json({ error: 'Missing query param: q' });
  }

  if (!fs.existsSync(METADATA_FILE)) {
    return res.status(500).json({ error: 'metadata.json not found. Run sync first.' });
  }

  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  const results = [];

  for (const flow of metadata) {
    for (const adapter of flow.adapters || []) {
      for (const property of adapter.properties || []) {
        const key = String(property.key || '').toLowerCase();
        const value = String(property.value || '').toLowerCase();

        if (key.includes(term) || value.includes(term)) {
          results.push({
            package: flow.package,
            iflow: flow.iflow,
            iflowId: flow.id,
            adapter: adapter.name,
            direction: adapter.direction,
            propertyKey: property.key,
            propertyValue: property.value,
          });
        }
      }
    }
  }

  res.json({ term, count: results.length, results });
});

app.get('/health', (req, res) => {
  const exists = fs.existsSync(METADATA_FILE);
  res.json({
    status: 'ok',
    metadataAvailable: exists,
    lastModified: exists ? fs.statSync(METADATA_FILE).mtime : null,
  });
});

app.listen(PORT, () => {
  console.log(`CPI Explorer backend running at http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/search?q=sftp`);
});
