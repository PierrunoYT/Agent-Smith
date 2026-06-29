const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runPlanningPhase } = require('../src/code/loop/planningPhase.js');
const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');

function depsFor(root) {
    const ledger = new ChangeLedger(path.join(root, '.ledger'));
    return {
        sessionId: 'plan-test',
        projectContext,
        editEngine: new EditEngine(ledger, projectContext),
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: p => path.relative(root, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ran' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
}

test('planning phase accepts a native submit_code_plan tool call', async () => {
    const session = {
        id: 'plan-test',
        goal: 'Create a Pac-Man browser game',
        messages: [{ role: 'user', content: 'Create the game' }]
    };
    const events = [];
    const plan = await runPlanningPhase({
        session,
        apiBaseUrl: 'http://x',
        emit: event => events.push(event),
        execDeps: {},
        model: 'qwen/qwen3-14b',
        streamCompletion: async () => ({
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'plan-call',
                    type: 'function',
                    function: {
                        name: 'submit_code_plan',
                        arguments: {
                            goal: session.goal,
                            steps: ['Create game files', 'Implement gameplay', 'Verify in browser']
                        }
                    }
                }]
            },
            finishReason: 'tool_calls'
        })
    });

    assert.equal(plan.steps.length, 3);
    assert.equal(session.status, 'awaiting_approval');
    assert.deepEqual(session.messages, [{ role: 'user', content: 'Create the game' }]);
    assert.equal(events.filter(e => e.type === 'planning_turn').length, 1);
    assert.ok(events.some(e => e.type === 'plan_submitted' && !e.fallback));
});

test('planning phase refuses write tools before plan approval', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-deny-'));
    projectContext.setRoot(root);
    const session = {
        id: 'plan-deny',
        goal: 'Create a file',
        messages: [{ role: 'user', content: 'Create a file' }]
    };
    const events = [];
    let turn = 0;
    const plan = await runPlanningPhase({
        session,
        apiBaseUrl: 'http://x',
        emit: event => events.push(event),
        execDeps: depsFor(root),
        model: 'qwen/qwen3-14b',
        streamCompletion: async () => {
            turn++;
            if (turn === 1) {
                return {
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'write-call',
                            type: 'function',
                            function: { name: 'write_file', arguments: { path: 'preapproval.txt', content: 'nope\n' } }
                        }]
                    },
                    finishReason: 'tool_calls'
                };
            }
            return {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'plan-call',
                        type: 'function',
                        function: { name: 'submit_code_plan', arguments: { goal: session.goal, steps: ['Write file', 'Verify'] } }
                    }]
                },
                finishReason: 'tool_calls'
            };
        }
    });

    assert.equal(plan.steps.length, 2);
    assert.equal(fs.existsSync(path.join(root, 'preapproval.txt')), false);
    assert.ok(events.some(e => e.type === 'tool_result' && e.name === 'write_file' && /not allowed/i.test(e.result.error)));
    assert.equal(events.some(e => e.type === 'tool_start' && e.name === 'write_file'), false);
});
