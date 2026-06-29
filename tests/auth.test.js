/**
 * AuthManager — the "first account becomes admin" guarantee and its self-heal, so the
 * app can never lock everyone out with an unapprovable account.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AuthManager = require('../src/main/services/auth.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smith-auth-')); }

test('first account becomes admin and can log in immediately', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');
    const token = await auth.login('alice', 'pw'); // must NOT throw "pending approval"
    assert.equal(typeof token, 'string');
    assert.equal(auth.verifyToken(token).role, 'admin');
    assert.equal(auth.verifyToken(token).permissions.canUseApp, true);
});

test('second account is a standard user, pending approval until an admin enables it', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');   // admin
    await auth.register('bob', 'pw');     // standard
    await assert.rejects(() => auth.login('bob', 'pw'), /pending admin approval/i);
    // admin can approve, then bob gets in
    auth.updateUserPermissions('alice', 'bob', { canUseApp: true });
    assert.equal(typeof await auth.login('bob', 'pw'), 'string');
});

test('SELF-HEAL: with a stale users file that has NO usable admin, the next signup is promoted', async () => {
    const dir = tmp();
    // Simulate the lockout: a users_v32.json whose only account is a denied standard user
    // (the exact state that made every new account "pending approval" with nobody to approve).
    fs.writeFileSync(path.join(dir, 'users_v32.json'), JSON.stringify({
        ghost: { password: 'x', role: 'user', permissions: { canUseApp: false, canUseTools: false } }
    }));
    const auth = new AuthManager(dir);
    assert.equal(auth.hasUsableAdmin(), false, 'precondition: no usable admin exists');

    await auth.register('rescuer', 'pw');
    const token = await auth.login('rescuer', 'pw'); // must succeed, not "pending approval"
    assert.equal(auth.verifyToken(token).role, 'admin', 'next signup self-heals to admin when locked out');
});

test('legacy/hand-edited user records (no permissions) are normalized, not crashed on', async () => {
    const dir = tmp();
    // An old record with a role but no `permissions` object — accessing user.permissions.x
    // used to throw (and hang the web request handler).
    fs.writeFileSync(path.join(dir, 'users_v32.json'), JSON.stringify({
        legacyadmin: { password: 'x', role: 'admin' },
        legacyuser: { password: 'y', role: 'user' }
    }));
    const auth = new AuthManager(dir);
    const admin = auth.verifyToken('nope'); // just exercise the records are well-formed now
    assert.equal(admin, null);
    // admin record normalized to usable; a standard record normalized to denied.
    assert.equal(auth.users.legacyadmin.permissions.canUseApp, true);
    assert.equal(auth.users.legacyuser.permissions.canUseApp, false);
    assert.equal(auth.hasUsableAdmin(), true, 'a normalized admin counts as usable');
});

test('admin-only operations reject non-admins and missing targets', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');  // admin
    await auth.register('bob', 'pw');    // standard user
    assert.throws(() => auth.getAllUsers('bob'), /unauthorized/i, 'non-admin cannot list users');
    assert.throws(() => auth.updateUserPermissions('bob', 'alice', { canUseApp: true }), /unauthorized/i,
        'non-admin cannot change permissions');
    assert.throws(() => auth.updateUserPermissions('alice', 'ghost', { canUseApp: true }), /not found/i,
        'admin updating a non-existent user errors');
    // admin CAN list and update
    assert.ok(Array.isArray(auth.getAllUsers('alice')));
    assert.equal(auth.updateUserPermissions('alice', 'bob', { canUseApp: true }), true);
});

test('login surfaces the real reasons (bad password vs unknown user)', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');
    await assert.rejects(() => auth.login('alice', 'wrong'), /invalid username or password/i);
    await assert.rejects(() => auth.login('nobody', 'pw'), /invalid username or password/i);
});

test('registration rejects usernames that could inject admin markup', async () => {
    const auth = new AuthManager(tmp());
    await assert.rejects(() => auth.register('<img src=x onerror=alert(1)>', 'pw'), /username must/i);
    await assert.rejects(() => auth.register('bad"name', 'pw'), /username must/i);
    await auth.register('safe.name-1', 'pw');
    assert.ok(auth.users['safe.name-1']);
});
