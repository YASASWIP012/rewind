import { loadIndex } from './data.js';
import { h, setCanary } from './util.js';
import { renderOverview } from './views/overview.js';
import { renderTree } from './views/tree.js';
import { renderRun } from './views/run.js';
import { renderDiff } from './views/diff.js';
import { renderDivergence } from './views/divergence.js';

const app = document.getElementById('app');
let renderSeq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { parts, params: new URLSearchParams(query) };
}

const ROUTES = {
  '': ['overview', renderOverview],
  tree: ['tree', renderTree],
  run: ['tree', renderRun],
  diff: ['diff', renderDiff],
  divergence: ['divergence', renderDivergence],
};

async function route() {
  const seq = ++renderSeq;
  const { parts, params } = parseHash();
  const [tab, view] = ROUTES[parts[0] || ''] || ROUTES[''];
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  let data;
  try {
    data = await loadIndex();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'error-box' }, e.message));
    return;
  }
  setCanary(data.summary.canary);
  const src = document.getElementById('datasrc');
  src.textContent = data.isSample ? 'sample data' : '';
  src.title = data.isSample ? 'Showing fixtures from data-sample/' : '';
  const root = h('div');
  try {
    await view(root, data, parts.slice(1), params);
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('div', { class: 'error-box' }, String(e.message || e)));
  }
  if (seq !== renderSeq) return; // a newer navigation won
  app.replaceChildren(root);
  const target = root.querySelector('[data-scroll-target]');
  if (target) target.scrollIntoView({ block: 'center' });
  else if (!params.has('keep')) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
