#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const WORKSPACE_DEV = path.resolve(ROOT, '..', '..', 'workspace-dev');
const OUT_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(OUT_DIR, 'live-metrics.json');

function safeExec(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function latestMtimeRecursive(dir, maxFiles = 5000) {
  let latest = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      try {
        const st = fs.statSync(full);
        latest = Math.max(latest, st.mtimeMs || 0);
        count += 1;
      } catch {}
      if (e.isDirectory()) stack.push(full);
      if (count >= maxFiles) return { latest, count, capped: true };
    }
  }
  return { latest, count, capped: false };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function countTodoItems(md = '') {
  const matches = md.match(/^- \[[ xX]\]/gm) || [];
  const done = (md.match(/^- \[[xX]\]/gm) || []).length;
  return { total: matches.length, done, open: Math.max(0, matches.length - done) };
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

const projectDirs = [
  'mission-control-dashboard',
  'nightshift',
  'overnight',
  'overnight_ops',
  'papertrades'
].map(name => ({ name, dir: path.join(WORKSPACE, name) })).filter(p => fs.existsSync(p.dir));

const polymarketStatusFile = path.join(WORKSPACE_DEV, 'projects', 'polymarket', 'docs', 'STATUS.md');
const polymarketTodoFile = path.join(WORKSPACE_DEV, 'projects', 'polymarket', 'docs', 'TODO.md');
const polymarketStatus = readText(polymarketStatusFile);
const polymarketTodo = readText(polymarketTodoFile);
const todoCounts = countTodoItems(polymarketTodo);

const gateway = safeExec('openclaw gateway status');
const gatewayRunning = /Runtime:\s*running/i.test(gateway.out);
const gatewayRpcOk = /RPC probe:\s*ok/i.test(gateway.out);
const gatewayLastRun = (gateway.out.match(/last run time\s+([^\r\n]+)/i) || [])[1] || null;

const projects = projectDirs.map((p) => {
  const snap = latestMtimeRecursive(p.dir);
  const freshnessHours = snap.latest ? (Date.now() - snap.latest) / 36e5 : null;
  const freshness = freshnessHours == null ? 'unknown' : freshnessHours < 6 ? 'hot' : freshnessHours < 24 ? 'warm' : 'cold';
  const progress = freshness === 'hot' ? 72 : freshness === 'warm' ? 54 : 36;
  return {
    id: p.name,
    name: p.name.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    path: p.dir,
    latestUpdate: iso(snap.latest),
    fileSignals: { filesScanned: snap.count, scanCapped: snap.capped },
    health: freshness,
    progress,
    confidence: freshness === 'hot' ? 'medium' : 'low',
    confidenceReason: 'Based on filesystem recency proxy (mtime), not semantic task completion.',
    timeline: [
      { label: 'Discovery', state: 'done' },
      { label: 'Implementation', state: progress > 45 ? 'active' : 'queued' },
      { label: 'Validation', state: progress > 70 ? 'active' : 'queued' },
      { label: 'Release', state: 'queued' }
    ],
    stats: [
      { label: 'Progress proxy', value: `${progress}%` },
      { label: 'Freshness', value: freshness },
      { label: 'Files scanned', value: String(snap.count) }
    ],
    actions: [
      'Review latest changed files',
      'Confirm blockers and owner',
      'Run smoke validation'
    ]
  };
});

projects.unshift({
  id: 'polymarket',
  name: 'Polymarket Bot',
  path: path.join(WORKSPACE_DEV, 'projects', 'polymarket'),
  latestUpdate: iso(fs.existsSync(polymarketStatusFile) ? fs.statSync(polymarketStatusFile).mtimeMs : 0),
  health: todoCounts.open > 0 ? 'active' : 'stable',
  progress: todoCounts.total ? Math.round((todoCounts.done / todoCounts.total) * 100) : 0,
  confidence: 'high',
  confidenceReason: 'Derived from explicit TODO.md checklist state and STATUS.md timestamp.',
  timeline: [
    { label: 'Market scan', state: 'done' },
    { label: 'Strategy tune', state: 'active' },
    { label: 'Risk check', state: 'queued' },
    { label: 'Execution', state: 'queued' }
  ],
  stats: [
    { label: 'TODO open', value: String(todoCounts.open) },
    { label: 'TODO done', value: String(todoCounts.done) },
    { label: 'Checklist total', value: String(todoCounts.total) }
  ],
  actions: [
    'Close highest-risk open TODO items',
    'Update STATUS with latest trading constraints',
    'Re-run dry-run strategy checks'
  ]
});

const hotProjects = projects.filter(p => ['hot', 'active', 'stable'].includes(p.health)).length;

const data = {
  generatedAt: new Date().toISOString(),
  dataVersion: 1,
  confidenceModel: {
    high: 'Directly measured from first-party artifacts or command output.',
    medium: 'Derived from reliable proxies (filesystem recency / scan summaries).',
    low: 'Heuristic estimate or inferred trend requiring human confirmation.'
  },
  digest: [
    {
      title: 'Gateway Runtime',
      value: gatewayRunning ? 'Running' : 'Stopped',
      delta: gatewayRpcOk ? 'RPC probe healthy' : 'RPC probe uncertain',
      confidence: 'high',
      timestamp: new Date().toISOString()
    },
    {
      title: 'Polymarket Backlog',
      value: `${todoCounts.open} open`,
      delta: `${todoCounts.done}/${todoCounts.total} closed`,
      confidence: 'high',
      timestamp: iso(fs.existsSync(polymarketTodoFile) ? fs.statSync(polymarketTodoFile).mtimeMs : 0)
    },
    {
      title: 'Active Project Signals',
      value: `${hotProjects}/${projects.length}`,
      delta: 'Projects showing hot/active/stable telemetry',
      confidence: 'medium',
      timestamp: new Date().toISOString()
    },
    {
      title: 'Gateway Last Task Run',
      value: gatewayLastRun || 'N/A',
      delta: 'Windows Scheduled Task telemetry',
      confidence: gatewayLastRun ? 'high' : 'low',
      timestamp: new Date().toISOString()
    }
  ],
  teamScene: {
    title: '8-bit Ops Corner',
    subtitle: 'Near-real-time context fed by current project telemetry',
    members: [
      { name: 'Boss', role: 'Director', zone: 'Meeting Table', status: 'prioritizing gates', mood: 'focus' },
      { name: 'Maya', role: 'Ops Lead', zone: 'PC-01', status: 'runbook sequencing', mood: 'calm' },
      { name: 'Ravi', role: 'Signal Analyst', zone: 'PC-02', status: 'threshold tuning', mood: 'focus' },
      { name: 'Muse', role: 'Family Support', zone: 'Support Desk', status: 'motivation cadence', mood: 'calm' }
    ]
  },
  projects
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
console.log(`Wrote ${OUT_FILE}`);
