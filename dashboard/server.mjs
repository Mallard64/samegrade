import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The upshift backend (this folder's parent repo). Reports and live run results are read from it; nothing is written.
// UPSHIFT_DIR overrides the location; the old SAMEGRADE_DIR name still works.
const BACKEND = path.resolve(process.env.UPSHIFT_DIR || process.env.SAMEGRADE_DIR || path.join(here, '..'));
const files = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/demo-views.js':'demo-views.js','/styles.css':'styles.css','/results.json':'results.json'};
const types = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json'};
const port = Number(process.env.PORT || 4173);

// ---- Reports -----------------------------------------------------------------------------
// A report is reports/<name>/dashboard.json (agent reports), or reports/<name>/migration.json when it is
// already in the dashboard's migration shape (NER migrate.py output), or reports/<name>/results.json in the v1
// shape with a `demo` block (results_demo.py).
const ORDER = ['migration_agent', 'demo_e2e', 'migration_ner'];
async function listReports() {
  const dir = path.join(BACKEND, 'reports');
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    for (const file of ['dashboard.json', 'migration.json', 'results.json']) {
      const full = path.join(dir, name, file);
      try {
        const raw = JSON.parse(await readFile(full, 'utf8'));
        if (file === 'results.json') {
          if (raw.schema_version !== 1 || !raw.demo || !Array.isArray(raw.candidates)) continue;
          out.push({id: name, title: raw.pr?.title || name, task: 'agent', group: 'Demo',
                    label: `Demo · ${raw.demo.pair.old} → ${raw.demo.pair.new} (real runs)`, updated: (await stat(full)).mtimeMs, file: full});
          break;
        }
        if (!raw.comparison || !Array.isArray(raw.candidates)) continue;
        out.push({id: name, title: raw.pr?.title || name, task: raw.task, group: raw.group || 'Migrations',
                  label: raw.label || null, updated: (await stat(full)).mtimeMs, file: full});
        break;
      } catch { /* not present or not a dashboard report */ }
    }
  }
  const rank = id => { if (id === 'demo') return -1; const i = ORDER.findIndex(p => id.startsWith(p)); return i < 0 ? ORDER.length : i; };
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

// ---- Live results ------------------------------------------------------------------------
// Polls results/*.jsonl once a second and streams rows appended after the server started.
// Files present at startup are history (read from their end); files created later stream from the start.
const clients = new Set(), offsets = new Map(), recent = [];
let started = false;
function summarize(file, row) {
  const ents = Array.isArray(row.output) ? row.output.map(e => `${e.text}/${e.label}`).join(', ') : null;
  const label = file.startsWith('judge__') ? `judge: ${row.winner ?? '?'}`
    : row.task === 'agent' ? `${row.category ?? '?'} / ${row.decision?.action ?? '?'}`
    : row.task === 'textcat' ? String(row.gold_score?.pred ?? '') : ents;
  return {file, at: Date.now(), task: row.task || (file.startsWith('judge__') ? 'judge' : null),
    input_id: row.input_id ?? null, run: row.run ?? null, model: row.config || row.model || null, label,
    passed: typeof row.passed_all === 'boolean' ? row.passed_all : null,
    score: typeof row.gold_score?.score === 'number' ? row.gold_score.score : null,
    error: row.error ? String(row.error).slice(0, 240) : null};
}
function send(res, event, payload) { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
async function scan() {
  const dir = path.join(BACKEND, 'results');
  let names = [];
  try { names = (await readdir(dir)).filter(n => n.endsWith('.jsonl')); } catch { return; }
  for (const name of names) {
    const full = path.join(dir, name);
    let size;
    try { size = (await stat(full)).size; } catch { continue; }
    if (!offsets.has(name)) offsets.set(name, started ? 0 : size);
    const from = offsets.get(name);
    if (size < from) { offsets.set(name, size); continue; }
    if (size === from) continue;
    const fh = await open(full, 'r');
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    await fh.close();
    const text = buf.toString('utf8'), end = text.lastIndexOf('\n');
    if (end < 0) continue;                                              // wait for a complete line
    offsets.set(name, from + Buffer.byteLength(text.slice(0, end + 1)));
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const ev = summarize(name, row);
      recent.push(ev); if (recent.length > 300) recent.shift();
      for (const res of clients) send(res, 'row', ev);
    }
  }
  started = true;
}
await scan();
setInterval(scan, 1000);
// Reports appear or change when a run (or an export) writes them: tell open pages.
let reportsSig = '';
async function watchReports() {
  const list = (await listReports()).map(({file, ...r}) => r);
  const sig = JSON.stringify(list.map(r => [r.id, r.updated]));
  if (reportsSig && sig !== reportsSig) for (const res of clients) send(res, 'reports', list);
  reportsSig = sig;
}
await watchReports();
setInterval(watchReports, 2000);
setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 15000);

// ---- Replays of recorded runs -----------------------------------------------------------------
// The runs behind a report (its compare_*.json baseline/candidate files) can be streamed back through the
// live feed at their recorded pacing. No model calls: this is how the dashboard shows "live" runs offline.
let replay = null;   // {file, total, sent, timer, state}
async function reportRuns(id) {
  const hit = (await listReports()).find(r => r.id === id);
  if (!hit) return [];
  const dir = path.dirname(hit.file), seen = new Map();
  for (const name of await readdir(dir)) {
    if (!/^compare_.*\.json$/.test(name)) continue;
    let rep; try { rep = JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    const repaired = name.includes('fix') || name.includes('edit');
    const roles = [[rep.candidate_file, repaired ? `fix re-run (${name.replace(/^compare_|\.json$/g, '')})` : 'candidate run']];
    for (const f of String(rep.baseline_file || '').split(' + ')) roles.push([f.trim(), 'baseline run']);
    for (const [file, role] of roles) if (file && !seen.has(file)) seen.set(file, role);
  }
  const out = [];
  for (const [file, role] of seen) {
    try { const n = (await readFile(path.join(BACKEND, 'results', file), 'utf8')).split('\n').filter(Boolean).length; out.push({file, role, rows: n}); }
    catch { /* run file not present */ }
  }
  const order = {'baseline run': 0, 'candidate run': 1};
  return out.sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2) || a.file.localeCompare(b.file));
}
function broadcast(event, payload) { for (const res of clients) send(res, event, payload); }
function publicReplay() { return replay && {file: replay.file, total: replay.total, sent: replay.sent, state: replay.state,
  speed: replay.speed, recorded_seconds: replay.recorded_seconds}; }
function stopReplay(state = 'stopped') {
  if (!replay) return;
  clearTimeout(replay.timer);
  replay.state = state;
  broadcast('replay', publicReplay());
  replay = null;
}
async function startReplay(file, seconds) {
  const text = await readFile(path.join(BACKEND, 'results', file), 'utf8');
  const rows = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Recorded time a row was finished: its start (ts) plus the pipeline's own latency.
  const done = r => Date.parse(r.ts || 0) + 1000 * ((r.steps || []).reduce((t, s) => t + (s.replayed ? 0 : s.latency_s || 0), 0) || r.latency_s || 0);
  rows.sort((a, b) => done(a) - done(b));
  const t0 = done(rows[0]), span = Math.max(1, done(rows.at(-1)) - t0);
  const scale = seconds ? (seconds * 1000) / span : 1;          // 0 = real time
  replay = {file, total: rows.length, sent: 0, state: 'running', speed: seconds ? `${seconds} s` : 'real time',
            recorded_seconds: Math.round(span / 1000), timer: null};
  broadcast('replay', publicReplay());
  const startAt = Date.now();
  const step = () => {
    if (!replay || replay.file !== file) return;
    while (replay.sent < rows.length && (done(rows[replay.sent]) - t0) * scale <= Date.now() - startAt) {
      const ev = {...summarize(file, rows[replay.sent]), file: `replay: ${file}`, at: Date.now(), replay: true};
      replay.sent++;
      recent.push(ev); if (recent.length > 300) recent.shift();
      broadcast('row', ev);
    }
    if (replay.sent >= rows.length) return stopReplay('done');
    replay.timer = setTimeout(step, 100);
  };
  step();
}
let prBusy = false;
function createPR(payload) {
  // One at a time; open_pr.py clones, commits, pushes and runs `gh pr create`, then prints JSON.
  if (prBusy) return Promise.resolve({error: 'a pull request is already being created'});
  prBusy = true;
  const venv = path.join(BACKEND, '.venv', 'bin', 'python');
  const py = existsSync(venv) ? venv : 'python3';
  return new Promise(resolve => {
    const child = spawn(py, [path.join(BACKEND, 'open_pr.py')], {cwd: BACKEND});
    let out = '';
    const timer = setTimeout(() => child.kill(), 180000);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); prBusy = false; resolve({error: `could not start open_pr.py: ${e.message}`}); });
    child.on('close', () => {
      clearTimeout(timer); prBusy = false;
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({error: 'open_pr.py gave no answer (offline, or gh not logged in?)'}); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
// ---- Live runs (paid) -------------------------------------------------------------------------
// "Run live" on the dashboard: live_run.py calls the real models for the chosen option and prints one JSON line per
// finished (test case, run); each is kept here and streamed to the page as a `liverun` event. One run at a time,
// and a hard per-run spend cap (LIVE_MAX_USD, default $2). Needs OPENAI_API_KEY in this server's environment.
const LIVE_MAX_USD = Math.min(Number(process.env.LIVE_MAX_USD) || 2, 5);
const LIVE_SETS = ['dev', 'hard', 'holdout2', 'fresh3', 'all'];
let liveRun = null;   // {option, label, state, total, ids, runs, rows, spent_usd, error, started, child}
const publicLive = () => liveRun && Object.fromEntries(Object.entries(liveRun).filter(([k]) => k !== 'child'));
// Keys come from this server's environment, or from the repo's .env (only the names below; never logged or sent to the page).
async function liveEnv() {
  const env = {...process.env};
  try {
    for (const line of (await readFile(path.join(BACKEND, '.env'), 'utf8')).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?(OPENAI_API_KEY|OLLAMA_BASE)\s*=\s*['"]?([^'"#\s]+)/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* no .env */ }
  return env;
}
// Problems the reviewer can fix are reported before anything starts, in the dialog that asked.
async function liveProblem(option, env) {
  if (!env.OPENAI_API_KEY) return 'No OpenAI key found. Put OPENAI_API_KEY in the .env file next to the dashboard folder, or start the server with it set, then try again.';
  if (option === 'cheap') {
    const base = env.OLLAMA_BASE || 'http://localhost:11434';
    try { const r = await fetch(`${base}/api/tags`, {signal: AbortSignal.timeout(3000)}); if (!r.ok) throw new Error(); }
    catch { return `The cheap mix runs its tone step on a local model, but Ollama isn't answering at ${base}. Start Ollama (ollama serve), or choose the gpt-5.6-sol option.`; }
  }
  return null;
}
async function startLive({option, sets, cases, runs}) {
  if (liveRun?.state === 'running') return {error: 'a live run is already in progress'};
  const env = await liveEnv();
  const problem = await liveProblem(option, env);
  if (problem) return {error: problem};
  const args = [path.join(BACKEND, 'live_run.py'), '--option', option, '--runs', String(runs), '--max-usd', String(LIVE_MAX_USD)];
  if (cases.length) args.push('--cases', cases.join(','));
  else args.push('--sets', sets);
  const venv = path.join(BACKEND, '.venv', 'bin', 'python');
  const child = spawn(existsSync(venv) ? venv : 'python3', args, {cwd: BACKEND, env});
  liveRun = {option, state: 'running', total: 0, ids: [], runs, rows: [], spent_usd: 0, error: null, started: Date.now(), child};
  const run = liveRun;
  let buf = '';
  const handle = ev => {
    if (ev.event === 'start') Object.assign(run, {label: ev.label, total: ev.total, ids: ev.ids, file: ev.file, models: ev.models, max_usd: ev.max_usd});
    if (ev.event === 'row') { run.rows.push(ev); run.spent_usd = ev.spent_usd; }
    if (ev.event === 'done') Object.assign(run, {state: ev.stopped_on_budget ? 'budget' : 'done', spent_usd: ev.spent_usd});
    if (ev.event === 'error') Object.assign(run, {state: 'error', error: ev.message});
    broadcast('liverun', {...ev, state: run.state});
  };
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { handle(JSON.parse(line)); } catch { /* not a status line */ }
    }
  });
  child.on('error', e => { run.state = 'error'; run.error = `could not start live_run.py: ${e.message}`; broadcast('liverun', {event: 'error', message: run.error, state: 'error'}); });
  child.on('close', code => {
    if (run.state === 'running') {
      run.state = run.stopping ? 'stopped' : 'error';
      if (!run.stopping) run.error = 'the live run ended unexpectedly';
      broadcast('liverun', {event: run.stopping ? 'stopped' : 'error', message: run.error, state: run.state});
    }
  });
  return {ok: true};
}

function sameOrigin(req) {
  // Only the dashboard page itself may start or stop replays (blocks cross-site requests and DNS rebinding).
  const ok = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!ok.includes(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  return !origin || ok.some(h => origin === `http://${h}`);
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 10000) break; }
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

// ---- Server ------------------------------------------------------------------------------
function sendJSON(res, status, body) {
  res.writeHead(status, {'Content-Type': types.json, 'Cache-Control': 'no-store'});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/reports') {
    return sendJSON(res, 200, (await listReports()).map(({file, ...r}) => r));
  }
  if (url.pathname === '/api/report') {
    const hit = (await listReports()).find(r => r.id === url.searchParams.get('id'));   // whitelist: no paths
    if (!hit) return sendJSON(res, 404, {error: 'unknown report'});
    try { return sendJSON(res, 200, await readFile(hit.file, 'utf8')); }
    catch { return sendJSON(res, 500, {error: 'could not read report'}); }
  }
  if (url.pathname === '/api/replays') {
    return sendJSON(res, 200, {runs: await reportRuns(url.searchParams.get('report') || ''), active: publicReplay()});
  }
  if (url.pathname === '/api/create-pr') {
    // Opens a real pull request in the app repo (config/target_repo.yml) via open_pr.py; slide 4's button.
    if (req.method !== 'POST' || !sameOrigin(req) || !String(req.headers['content-type']).startsWith('application/json'))
      return sendJSON(res, 403, {error: 'pull requests can only be created from the dashboard page'});
    const body = await readBody(req);
    const changes = Array.isArray(body?.changes) ? body.changes.slice(0, 10).map(c => ({
      id: String(c?.id || '').slice(0, 20), decision: String(c?.decision || '').slice(0, 20),
      ...(c?.text != null ? {text: String(c.text).slice(0, 2000)} : {})})) : null;
    if (!changes) return sendJSON(res, 400, {error: 'expected {changes: [...]}'});
    const out = await createPR({changes, option: body?.option === 'sol' ? 'sol' : 'cheap'});
    return sendJSON(res, out.error ? 502 : 200, out);
  }
  if (url.pathname === '/api/replay' || url.pathname === '/api/replay/stop') {
    if (req.method !== 'POST' || !sameOrigin(req) || !String(req.headers['content-type']).startsWith('application/json'))
      return sendJSON(res, 403, {error: 'replays can only be started from the dashboard page'});
    if (url.pathname.endsWith('/stop')) { stopReplay(); return sendJSON(res, 200, {ok: true}); }
    const body = await readBody(req);
    const runs = await reportRuns(String(body?.report || ''));
    const pick = runs.find(r => r.file === body?.file);                                  // whitelist: no paths
    if (!pick) return sendJSON(res, 404, {error: 'unknown run for this report'});
    const seconds = [0, 20, 60].includes(body?.seconds) ? body.seconds : 20;
    stopReplay();
    await startReplay(pick.file, seconds);
    return sendJSON(res, 200, {ok: true, file: pick.file, rows: pick.rows});
  }
  if (url.pathname === '/api/live-run' && req.method === 'GET') return sendJSON(res, 200, {run: publicLive(), max_usd: LIVE_MAX_USD});
  if (url.pathname === '/api/live-run/stop') {
    if (req.method !== 'POST' || !sameOrigin(req)) return sendJSON(res, 403, {error: 'only the dashboard page can stop a live run'});
    if (liveRun?.state === 'running') { liveRun.stopping = true; liveRun.child.kill(); }
    return sendJSON(res, 200, {ok: true});
  }
  if (url.pathname === '/api/live-run') {
    if (req.method !== 'POST' || !sameOrigin(req) || !String(req.headers['content-type']).startsWith('application/json'))
      return sendJSON(res, 403, {error: 'live runs can only be started from the dashboard page'});
    const body = await readBody(req);
    const cases = Array.isArray(body?.cases) ? body.cases.slice(0, 60).map(String).filter(x => /^t\d{1,3}$/.test(x)) : [];
    const sets = LIVE_SETS.includes(body?.sets) ? body.sets : '';
    if (!cases.length && !sets) return sendJSON(res, 400, {error: 'choose a set of test cases'});
    const out = await startLive({option: body?.option === 'sol' ? 'sol' : 'cheap', sets, cases, runs: [1, 3].includes(body?.runs) ? body.runs : 1});
    return sendJSON(res, out.error ? 409 : 200, out);
  }
  if (url.pathname === '/api/live') {
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
    send(res, 'hello', {backend: BACKEND, recent: recent.slice(-60), replay: publicReplay()});
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const file = files[url.pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(new URL(file, import.meta.url));
    res.writeHead(200, {'Content-Type': types[file.split('.').pop()], 'Cache-Control': 'no-store'});
    res.end(body);
  } catch { res.writeHead(500); res.end('Could not read project file'); }
}).listen(port, '127.0.0.1', () => console.log(`Upshift preview: http://localhost:${port}  (backend: ${BACKEND})`));
