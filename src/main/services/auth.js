const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class AuthManager {
    constructor(userDataPath) {
        this.usersFile = path.join(userDataPath, 'users_v32.json');
        this.sessions = new Map(); // token -> username
        this.users = this.loadUsers();
    }

    loadUsers() {
        if (fs.existsSync(this.usersFile)) {
            try {
                const users = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
                // Normalize legacy/hand-edited records so downstream `user.permissions.x`
                // access can never throw (which would hang the web request handler).
                for (const u of Object.values(users || {})) {
                    if (u && typeof u === 'object' && (!u.permissions || typeof u.permissions !== 'object')) {
                        u.permissions = { canUseApp: u.role === 'admin', canUseTools: u.role === 'admin' };
                    }
                }
                return users || {};
            } catch (e) {
                console.error('Failed to load users:', e);
                return {};
            }
        }
        return {};
    }

    saveUsers() {
        // Throw on failure so a non-writable userData dir surfaces as a real error
        // instead of silently "creating" an account that vanishes on next launch.
        try {
            fs.writeFileSync(this.usersFile, JSON.stringify(this.users, null, 2));
        } catch (e) {
            console.error('Failed to save users:', e);
            throw new Error(`Could not save account (${e.code || e.message}). Check write permissions for ${this.usersFile}`);
        }
    }

    /** True when at least one account can actually get in (admin + canUseApp). */
    hasUsableAdmin() {
        return Object.values(this.users).some(
            u => u.role === 'admin' && u.permissions && u.permissions.canUseApp
        );
    }

    async register(username, password) {
        username = String(username || '').trim();
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
            throw new Error('Username must be 1-64 letters, numbers, dots, dashes, or underscores');
        }
        if (this.users[username]) {
            throw new Error('User already exists');
        }
        // The first account is always the admin. Also self-heal a locked-out state:
        // if no usable admin exists (e.g. a stale users file with only non-admin
        // entries), promote the next account to admin so the app can never become
        // permanently unreachable.
        const isFirst = Object.keys(this.users).length === 0;
        const makeAdmin = isFirst || !this.hasUsableAdmin();
        const hashedPassword = await bcrypt.hash(password, 10);
        this.users[username] = {
            password: hashedPassword,
            role: makeAdmin ? 'admin' : 'user',
            permissions: {
                canUseApp: makeAdmin,   // standard (non-first) users start denied
                canUseTools: makeAdmin  // only an admin gets tools by default
            }
        };
        this.saveUsers();
        return true;
    }

    async login(username, password) {
        const user = this.users[username];
        if (!user) {
            throw new Error('Invalid username or password');
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            throw new Error('Invalid username or password');
        }
        if (!user.permissions.canUseApp) {
            throw new Error('Account pending admin approval');
        }
        const token = crypto.randomBytes(32).toString('hex');
        this.sessions.set(token, username);
        return token;
    }

    verifyToken(token) {
        const username = this.sessions.get(token);
        if (!username) return null;
        const user = this.users[username];
        if (!user) return null;
        return { username, role: user.role, permissions: user.permissions };
    }

    logout(token) {
        this.sessions.delete(token);
    }
    
    hasUsers() {
        return Object.keys(this.users).length > 0;
    }

    getAllUsers(requesterUsername) {
        const requester = this.users[requesterUsername];
        if (!requester || requester.role !== 'admin') throw new Error('Unauthorized');
        
        const userList = [];
        for (const [uname, data] of Object.entries(this.users)) {
            userList.push({
                username: uname,
                role: data.role,
                permissions: data.permissions
            });
        }
        return userList;
    }

    updateUserPermissions(requesterUsername, targetUsername, permissions) {
        const requester = this.users[requesterUsername];
        if (!requester || requester.role !== 'admin') throw new Error('Unauthorized');
        if (!this.users[targetUsername]) throw new Error('User not found');
        
        this.users[targetUsername].permissions = { 
            ...this.users[targetUsername].permissions, 
            ...permissions 
        };
        this.saveUsers();
        return true;
    }
}

module.exports = AuthManager;
