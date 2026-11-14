// Isomorphic mock OfficeState generator (no Node or DOM APIs).
// Used by `node server/index.mjs --mock`, by public/world-dev.html, and by index.html?mock=1.
// Shapes follow server/contract.mjs exactly.

const ACTS = [
  ['thinking', 'Thinking'],
  ['reading', 'Read checkout.ts'],
  ['editing', 'Edit totals.ts'],
  ['running', 'Bash: npm test'],
  ['searching', 'Grep "applyPromo"'],
  ['browsing', 'Fetch docs.stripe.com/api'],
  ['editing', 'Edit CartSummary.tsx'],
  ['running', 'Bash: git diff --stat'],
  ['reading', 'Read README.md'],
  ['writing', 'Writing summary'],
];

const SAY = [
  'Found it: the promo is applied before tax, so the tier total drifts by a cent.',
  'Tests pass locally. Two snapshots needed updating.',
  'I traced the request through the gateway; the header is dropped at the proxy.',
  'Refactored the reducer into three smaller functions. No behaviour change.',
  'The migration is reversible. I added a down step and a dry-run flag.',
  'Waiting on the build. Lint is clean.',
];

const DEFS = [
  { tool: 'claude', name: 'RIKO', title: 'Port cart totals to the new API', cwd: '/Users/dev/projects/shop/graph', branch: 'totals/port', model: 'claude-fable-5-2', source: 'desktop', period: 150, offset: 5, arriveAt: 0,
    subs: [['Map every totals call site', 'Explore'], ['Write parity tests', 'general-purpose'], ['Port tax rounding', 'general-purpose'], ['Review the diff', 'general-purpose']] },
  { tool: 'claude', name: 'BENJI', title: 'Fix flaky checkout e2e test', cwd: '/Users/dev/projects/shop/big-tests', branch: 'fix/flaky-checkout', model: 'claude-sonnet-5-5', source: 'cli', period: 70, offset: 12, arriveAt: 0 },
  { tool: 'codex', name: 'MOXIE', title: 'Add guest checkout to the iOS cart', cwd: '/Users/dev/projects/shop/ios', branch: 'guest-checkout', model: 'gpt-5.2-codex', source: 'cli', period: 90, offset: 40, arriveAt: 0 },
  { tool: 'cursor', name: 'DUKE', title: 'Progress meter redesign, variant C', cwd: '/Users/dev/projects/shop/customer-ui', branch: 'meter-variants', model: 'composer-2', source: 'ide', period: 80, offset: 3, arriveAt: 0 },
  { tool: 'codex', name: 'TASHA', title: 'Audit the release pipeline', cwd: '/Users/dev/projects/shop/deploy', branch: 'main', model: 'gpt-5.2-codex', source: 'desktop', period: 200, offset: 60, arriveAt: 0,
    subs: [['Read CI recipes', 'explorer'], ['Check deploy logs', 'explorer'], ['Draft workflow fix', 'worker']] },
  { tool: 'claude', name: 'OTTO', title: 'Why is the cart page slow?', cwd: '/Users/dev/projects/shop', branch: 'main', model: 'claude-fable-5-2', source: 'cli', period: 110, offset: 80, arriveAt: 0, idles: true },
  { tool: 'cursor', name: 'PIXIE', title: 'Rename Order.status enum values', cwd: '/Users/dev/projects/shop/monolith', branch: 'chore/status-enum', model: 'composer-2', source: 'cli', period: 60, offset: 22, arriveAt: 0 },
  { tool: 'claude', name: 'GUS', title: 'Draft PR description for login refactor', cwd: '/Users/dev/projects/shop/auth', branch: 'login-refactor', model: 'claude-haiku-5-5', source: 'cli', period: 100, offset: 70, arriveAt: 0, alwaysIdle: true },
  { tool: 'codex', name: 'NELL', title: 'Investigate API token in logs', cwd: '/Users/dev/projects/shop/monolith', branch: 'fix/token-logs', model: 'gpt-5.2-codex', source: 'cli', period: 95, offset: 33, arriveAt: 0, idles: true },
  { tool: 'cursor', name: 'ZED', title: 'Storybook stories for ProgressBar', cwd: '/Users/dev/projects/shop/customer-ui', branch: 'progress-bar-stories', model: 'composer-2', source: 'ide', period: 160, offset: 110, arriveAt: 0,
    subs: [['Find existing story patterns', 'explore'], ['Write ProgressBar.stories.tsx', 'general']] },
  { tool: 'claude', name: 'HANK', title: 'Analytics event timing audit', cwd: '/Users/dev/projects/analytics', branch: 'main', model: 'claude-sonnet-5-5', source: 'cli', period: 75, offset: 50, arriveAt: 20 },
  { tool: 'codex', name: 'JUNE', title: 'Upgrade stripe-js to 4.x', cwd: '/Users/dev/projects/shop/customer-ui', branch: 'deps/stripe-js-4', model: 'gpt-5.2-codex', source: 'cli', period: 85, offset: 8, arriveAt: 45, leaveAt: 240 },
  { tool: 'claude', name: 'VERA', title: 'Shipping-rate automation research', cwd: '/Users/dev/projects/shop/shipping-rates', branch: 'main', model: 'claude-fable-5-2', source: 'desktop', period: 180, offset: 20, arriveAt: 30,
    subs: [['Survey carrier rate APIs', 'general-purpose'], ['Read carrier API docs', 'web-fetch'], ['Count manual quotes', 'Explore'], ['Model per-brand coverage', 'general-purpose'], ['Check warehouse handoff', 'Explore'], ['Summarise findings', 'general-purpose']] },
  { tool: 'cursor', name: 'SID', title: 'Quick question about tsconfig paths', cwd: '/Users/dev/projects/shop/gateway', branch: 'main', model: 'composer-2', source: 'ide', period: 50, offset: 0, arriveAt: 0, alwaysIdle: true },
];

const SUB_NAMES = ['PIP', 'DOT', 'BOLT', 'NIB', 'ACE', 'KIT', 'TAD', 'REX', 'IVY', 'LOU'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function project(cwd) {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || '~';
}

export function createMock(start = Date.now()) {
  const defs = DEFS.map((d, i) => ({ ...d, nativeId: `mock-${String(i + 1).padStart(2, '0')}` }));
  let added = 0;

  // Naming and grouping (see "Naming and grouping" in server/contract.mjs). Seeded so the demo shows it.
  const COLORS = ['gold', 'rose', 'lime', 'sky', 'plum', 'sand'];
  let groups = [
    { id: 'g-checkout', name: 'Checkout', color: 'gold', autoDirs: [], order: 1 },
    { id: 'g-ios', name: 'iOS app', color: 'sky', autoDirs: ['/Users/dev/projects/shop/ios'], order: 2 },
    { id: 'g-cleanup', name: 'Cleanup', color: 'rose', autoDirs: [], order: 3 },
  ];
  let groupSeq = 0;
  /** @type {Map<string, {label?: string, groupId?: string}>} */
  const meta = new Map([
    ['claude:mock-01', { label: 'Cart totals port', groupId: 'g-checkout' }],
    ['claude:mock-02', { groupId: 'g-checkout' }],
    ['claude:mock-06', { label: 'Cart page latency', groupId: 'g-checkout' }],
    ['cursor:mock-07', { groupId: 'g-cleanup' }],
    ['codex:mock-09', { label: 'Token log leak', groupId: 'g-cleanup' }],
  ]);
  const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const absDirs = (list) => (Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d.startsWith('/')) : []);

  function resolveGroup(id, cwd) {
    const m = meta.get(id);
    if (m?.groupId === 'none') return undefined;
    if (m?.groupId && groups.some((g) => g.id === m.groupId)) return m.groupId;
    const hit = [...groups]
      .sort((a, b) => a.order - b.order)
      .find((g) => g.autoDirs.some((d) => cwd === d || cwd.startsWith(d.replace(/\/$/, '') + '/')));
    return hit?.id;
  }

  function withMeta(session) {
    if (!session) return session;
    const m = meta.get(session.id);
    const groupId = resolveGroup(session.id, session.cwd);
    return { ...session, ...(m?.label ? { label: m.label } : {}), ...(groupId ? { groupId } : {}) };
  }

  function build(def, now) {
    const t = (now - start) / 1000;
    if (t < def.arriveAt) return null;
    if (def.leaveAt && t > def.leaveAt) return null;
    const h = hash(def.nativeId);
    const local = (t + def.offset) % def.period;
    const f = local / def.period;

    let status;
    if (def.alwaysIdle) status = 'idle';
    else if (f < 0.65) status = 'working';
    else if (f < 0.85) status = 'waiting';
    else status = def.idles ? 'idle' : 'working';

    const subagents = [];
    if (def.subs && status === 'working' && f >= 0.05 && f < 0.6) {
      def.subs.forEach(([label, agentType], i) => {
        const startF = 0.05 + i * 0.03;
        if (f < startF) return;
        const endF = 0.3 + ((h + i * 37) % 25) / 100;
        const working = f < endF;
        const startedAt = now - (f - startF) * def.period * 1000;
        const act = ACTS[(Math.floor((t + i * 3) / 4) + h + i) % ACTS.length];
        subagents.push({
          id: `sub-${i + 1}`,
          name: SUB_NAMES[(h + i) % SUB_NAMES.length],
          label,
          agentType,
          status: working ? 'working' : 'done',
          activity: working ? { kind: act[0], label: act[1] } : { kind: 'idle', label: 'Done' },
          startedAt,
          lastActivityAt: working ? now - ((h + i) % 4) * 1000 : now - (f - endF) * def.period * 1000,
          ...(working ? {} : { endedAt: now - (f - endF) * def.period * 1000 }),
        });
      });
    }
    const anyWorking = subagents.some((s) => s.status === 'working');

    let activity;
    let lastActivityAt;
    if (status === 'working') {
      const act = ACTS[(Math.floor((t + def.offset) / 4) + h) % ACTS.length];
      activity = anyWorking
        ? { kind: 'delegating', label: `Running ${subagents.filter((s) => s.status === 'working').length} agents` }
        : { kind: act[0], label: act[1] };
      lastActivityAt = now - (h % 5) * 1000;
    } else if (status === 'waiting') {
      activity = { kind: 'waiting', label: 'Waiting for you' };
      lastActivityAt = now - (f - 0.65) * def.period * 1000;
    } else {
      activity = { kind: 'idle', label: 'Idle' };
      lastActivityAt = now - (6 + (h % 40)) * 60_000;
    }

    return {
      id: `${def.tool}:${def.nativeId}`,
      tool: def.tool,
      nativeId: def.nativeId,
      name: def.name,
      title: def.title,
      cwd: def.cwd,
      project: project(def.cwd),
      branch: def.branch,
      model: def.model,
      source: def.source,
      turnState: status === 'working' ? 'mid' : 'ended',
      status,
      mode: subagents.length ? 'orchestrator' : 'solo',
      startedAt: start - (h % 50) * 60_000 + def.arriveAt * 1000,
      lastActivityAt,
      activity,
      lastMessage: SAY[h % SAY.length],
      tokens: 20_000 + (h % 400) * 1000 + Math.floor(t) * 150,
      subagents,
      ...(def.taskId ? { taskId: def.taskId } : {}),
    };
  }

  return {
    /** @returns {import('../../server/contract.mjs').OfficeState} */
    next(now = Date.now()) {
      const sessions = defs.map((d) => withMeta(build(d, now))).filter(Boolean);
      return {
        now,
        sessions,
        tasks: [],
        tools: {
          claude: { available: true, version: 'mock' },
          codex: { available: true, version: 'mock' },
          cursor: { available: true, version: 'mock' },
        },
        recentDirs: [...new Set(defs.map((d) => d.cwd))],
        groups: [...groups].sort((a, b) => a.order - b.order),
        mock: true,
      };
    },
    /** Add a fake session that walks in now. Returns its session id. */
    add({ tool, prompt, cwd, taskId, name, label, groupId }) {
      added += 1;
      const now = Date.now();
      const def = {
        tool,
        name: name || ['NOVA', 'CHIP', 'ROOK', 'FIZZ', 'TEX', 'WREN'][added % 6],
        title: String(prompt || 'New task').replace(/\s+/g, ' ').slice(0, 120),
        cwd: cwd || '/Users/dev/projects/shop',
        branch: 'main',
        model: 'mock',
        source: 'cli',
        period: 90,
        offset: -((now - start) / 1000) % 90,
        arriveAt: (now - start) / 1000,
        nativeId: `mock-new-${added}`,
        taskId,
      };
      defs.push(def);
      const id = `${tool}:${def.nativeId}`;
      if (label || groupId) this.setMeta(id, { label, groupId });
      return id;
    },
    /** label: null/'' clears. groupId: an id assigns, null removes the explicit choice, 'none' pins to no group. */
    setMeta(sessionId, { label, groupId } = {}) {
      const m = { ...(meta.get(sessionId) || {}) };
      if (label !== undefined) {
        const t = clean(label, 60);
        if (t) m.label = t;
        else delete m.label;
      }
      if (groupId !== undefined) {
        if (groupId === null || groupId === '') delete m.groupId;
        else m.groupId = groupId;
      }
      if (Object.keys(m).length) meta.set(sessionId, m);
      else meta.delete(sessionId);
      return { id: sessionId, ...m };
    },
    createGroup({ name, color, autoDirs } = {}) {
      const used = (c) => groups.filter((g) => g.color === c).length;
      const group = {
        id: `g-new-${++groupSeq}`,
        name: clean(name, 24) || 'Group',
        color: COLORS.includes(color) ? color : [...COLORS].sort((a, b) => used(a) - used(b))[0],
        autoDirs: absDirs(autoDirs),
        order: groups.reduce((n, g) => Math.max(n, g.order), 0) + 1,
      };
      groups = [...groups, group];
      return group;
    },
    updateGroup(id, patch = {}) {
      const g = groups.find((x) => x.id === id);
      if (!g) return null;
      const next = { ...g };
      if (typeof patch.name === 'string' && clean(patch.name, 24)) next.name = clean(patch.name, 24);
      if (COLORS.includes(patch.color)) next.color = patch.color;
      if (Array.isArray(patch.autoDirs)) next.autoDirs = absDirs(patch.autoDirs);
      if (Number.isFinite(patch.order)) next.order = patch.order;
      groups = groups.map((x) => (x.id === id ? next : x));
      return next;
    },
    deleteGroup(id) {
      const had = groups.some((g) => g.id === id);
      groups = groups.filter((g) => g.id !== id);
      for (const [sid, m] of meta) {
        if (m.groupId !== id) continue;
        const { groupId: _gone, ...rest } = m;
        if (Object.keys(rest).length) meta.set(sid, rest);
        else meta.delete(sid);
      }
      return had;
    },
    transcript(sessionId, limit = 60) {
      const h = hash(sessionId);
      const now = Date.now();
      const out = [];
      for (let i = 0; i < Math.min(limit, 14); i++) {
        const ts = now - (14 - i) * 45_000;
        if (i % 4 === 0) out.push({ role: 'user', text: i === 0 ? 'Can you look into this and fix it?' : 'Looks good, keep going.', ts });
        else if (i % 4 === 3) out.push({ role: 'assistant', text: SAY[(h + i) % SAY.length], ts });
        else {
          const a = ACTS[(h + i) % ACTS.length];
          out.push({ role: 'tool', text: a[1], ts, toolName: a[1].split(/[ :]/)[0] });
        }
      }
      return out;
    },
  };
}
