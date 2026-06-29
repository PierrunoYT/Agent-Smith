const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
    milestoneKey,
    milestoneWorktreePath,
    milestoneBranchName,
    childSessionId,
    syncWorktreeFiles
} = require('../src/main/services/worktreeManager.js');
const projectContext = require('../src/main/services/projectContext.js');

const {
    resolveSubagentMode,
    shouldUseSubagents,
    openMilestones,
    runMilestoneSubagentOrchestrator
} = require('../src/code/loop/milestoneSubagents.js');

test('milestoneKey and paths are stable', () => {
    const key = milestoneKey('code_123_abc', 'M1');
    assert.match(key, /code_123_abc--M1/);
    const root = '/proj';
    assert.match(milestoneWorktreePath(root, 'code_123_abc', 'M1'), /worktrees.*M1/);
    assert.match(milestoneBranchName('code_123_abc', 'M1'), /agentsmith\/milestone-/);
});

test('childSessionId suffixes milestone id', () => {
    assert.equal(childSessionId('code_parent', 'M2'), 'code_parent__M2');
});

test('syncWorktreeFiles copies touched files to main', () => {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-main-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-child-'));
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'app.js'), 'module.exports = 1;\n');
    const r = syncWorktreeFiles(main, wt, ['src/app.js']);
    assert.deepEqual(r.synced, ['src/app.js']);
    assert.equal(r.errors.length, 0);
    assert.equal(fs.readFileSync(path.join(main, 'src', 'app.js'), 'utf-8'), 'module.exports = 1;\n');
});

test('resolveSubagentMode returns worktree-sequential when flags set', () => {
    const mode = resolveSubagentMode({
        parallelMilestones: true,
        milestoneWorktrees: true,
        milestoneConcurrent: false
    });
    assert.equal(mode, 'worktree-sequential');
});

test('resolveSubagentMode disables worktree concurrency until state is isolated', () => {
    const mode = resolveSubagentMode({
        parallelMilestones: true,
        milestoneWorktrees: true,
        milestoneConcurrent: true
    });
    assert.equal(mode, 'worktree-sequential');
});

test('shouldUseSubagents requires 3+ milestones', () => {
    assert.equal(shouldUseSubagents({ parallelMilestones: true }, { enabled: true, milestones: [{}, {}] }), false);
    assert.equal(shouldUseSubagents({ parallelMilestones: true }, { enabled: true, milestones: [{}, {}, {}] }), true);
});

test('openMilestones skips done entries', () => {
    const open = openMilestones({
        enabled: true,
        milestones: [{ id: 'M1', done: true }, { id: 'M2', done: false }]
    });
    assert.equal(open.length, 1);
    assert.equal(open[0].id, 'M2');
});

test('milestone worktrees are cleaned up when child loop throws', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wt-'));
    execSync('git init', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'README.md'), 'init\n');
    execSync('git add README.md', { cwd: root, stdio: 'ignore' });
    execSync('git -c user.name=Test -c user.email=test@example.com commit -m init', { cwd: root, stdio: 'ignore' });
    projectContext.setRoot(root);

    const session = {
        id: 'parent_throw',
        goal: 'build feature',
        projectRoot: root,
        filesTouched: [],
        parallelMilestones: true,
        milestoneWorktrees: true,
        milestoneConcurrent: true,
        grindMode: false,
        projectMeta: {}
    };
    const planArtifacts = {
        enabled: true,
        milestones: [{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }]
    };
    const events = [];
    const result = await runMilestoneSubagentOrchestrator({
        session,
        planArtifacts,
        parentProjectRoot: root,
        emit: e => events.push(e),
        executeTurnLoop: async () => { throw new Error('child boom'); },
        projectContext,
        planAnchor: {},
        earlyStop: {},
        qualityMonitor: {},
        trace: {},
        userDataPath: root,
        buildExecDeps: null,
        execDeps: {},
        apiBaseUrl: 'http://x',
        pluginToolSchemas: [],
        pluginToolNames: []
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, 'worktree-sequential');
    assert.equal(path.resolve(projectContext.getRoot()), path.resolve(root));
    assert.ok(events.some(e => e.type === 'subagent_error' && /child boom/.test(e.error)));
    for (const m of planArtifacts.milestones) {
        assert.equal(fs.existsSync(milestoneWorktreePath(root, session.id, m.id)), false);
    }
});
