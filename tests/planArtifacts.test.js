const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PlanArtifacts, isNonTrivialTask, planPath } = require('../src/code/context/planArtifacts.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

test('isNonTrivialTask detects build prompts', () => {
    assert.equal(isNonTrivialTask('build a Pac-Man game'), true);
    assert.equal(isNonTrivialTask('hi'), false);
});

test('PlanArtifacts creates PLAN and IMPLEMENT for non-trivial tasks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-art-'));
    const pa = await PlanArtifacts.ensure(root, 'build a web game');
    assert.equal(pa.enabled, true);
    assert.ok(fs.existsSync(planPath(root)));
    assert.ok(fs.existsSync(path.join(root, '.agentsmith', 'IMPLEMENT.md')));
    assert.ok(pa.milestones.length >= 2);
});

test('PlanArtifacts parses the default Final verification milestone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-final-'));
    const pa = await PlanArtifacts.ensure(root, 'build a browser dashboard');
    const ids = pa.milestones.map(m => m.id);
    assert.deepEqual(ids, ['M1', 'M2', 'Final']);
    assert.equal(pa.milestones.find(m => m.id === 'Final').verify, 'harness completion gate');
});

test('PlanAnchor.addNote appends IMPLEMENT entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-note-'));
    const pa = await PlanArtifacts.ensure(root, 'fix the login page', { forcePlan: true });
    const anchor = new PlanAnchor('fix the login page', pa);
    await anchor.addNote('Chose patch over write_file');
    const impl = fs.readFileSync(path.join(root, '.agentsmith', 'IMPLEMENT.md'), 'utf-8');
    assert.match(impl, /Chose patch over write_file/);
});

test('PlanAnchor.toBlock includes plan excerpt when enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-block-'));
    const pa = await PlanArtifacts.ensure(root, 'create API', { forcePlan: true });
    const anchor = new PlanAnchor('create API', pa);
    const block = anchor.toBlock();
    assert.match(block, /\[PLAN ARTIFACTS\]/);
    assert.match(block, /PLAN excerpt/);
});

test('reloadMilestones keeps e2e milestones alongside em-dash verify Final', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mixed-'));
    const pa = await PlanArtifacts.ensure(root, 'build a web app', { forcePlan: true });
    const plan = planPath(root);
    fs.writeFileSync(plan, [
        '# PLAN.md',
        '',
        '## Milestones',
        '',
        '- [ ] **M1: Browser gate** | e2e: `npm run test:e2e`',
        '- [ ] **Final: all checks pass** — verify: `harness completion gate`',
        ''
    ].join('\n'), 'utf-8');
    pa.reloadMilestones();
    const ids = pa.milestones.map(m => m.id);
    assert.deepEqual(ids, ['M1', 'Final']);
    assert.equal(pa.milestones.find(m => m.id === 'M1').e2e, 'npm run test:e2e');
    assert.equal(pa.milestones.find(m => m.id === 'Final').verify, 'harness completion gate');
});
