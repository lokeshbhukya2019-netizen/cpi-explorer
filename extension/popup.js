const API_BASE = 'http://localhost:3000';

const searchBox = document.getElementById('searchBox');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');

let debounceTimer = null;

searchBox.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(searchBox.value.trim()), 300);
});

async function runSearch(term) {
  if (!term) {
    resultsEl.innerHTML = '';
    statusEl.textContent = '';
    return;
  }

  statusEl.textContent = 'Searching...';

  try {
    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(term)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = `Error: ${err.error || res.statusText}`;
      resultsEl.innerHTML = '';
      return;
    }

    const data = await res.json();
    statusEl.textContent = `${data.count} match(es)`;
    renderResults(data.results);
  } catch (e) {
    statusEl.textContent = 'Cannot reach backend. Is server.js running on localhost:3000?';
    resultsEl.innerHTML = '';
  }
}

function renderResults(results) {
  if (!results || results.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No matches found.</div>';
    return;
  }

  resultsEl.innerHTML = results
    .map(
      (r) => `
      <div class="result">
        <div class="iflow">${escapeHtml(r.iflow)}</div>
        <div class="pkg">${escapeHtml(r.package)} &middot; ${escapeHtml(r.adapter)} (${escapeHtml(r.direction)})</div>
        <div class="prop">${escapeHtml(r.propertyKey)} = ${escapeHtml(r.propertyValue)}</div>
      </div>
    `
    )
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
