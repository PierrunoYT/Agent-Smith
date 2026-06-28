/**
 * Early stop detector — halt run on repeated failures or stagnation.
 */
'use strict';

class EarlyStopDetector {
    constructor(opts = {}) {
        this.maxTurns = opts.maxTurns || 40;
        this.maxConsecutiveErrors = opts.maxConsecutiveErrors || 5;
        this.maxDuplicateTools = opts.maxDuplicateTools || 8;
        // Code Mode is a build/edit loop. If it churns through this many turns without
        // writing ANY file (e.g. read-only exploration that never commits to a change),
        // stop early instead of burning the whole turn budget.
        this.maxNoWriteTurns = opts.maxNoWriteTurns || Number(process.env.XK_CODE_MAX_NOWRITE_TURNS) || 12;
        this.turn = 0;
        this.consecutiveErrors = 0;
        this.duplicateCount = 0;
        this.noWriteTurns = 0;
        this.lastFileCount = 0;
    }

    onTurn() {
        this.turn++;
        if (this.turn >= this.maxTurns) {
            return { stop: true, reason: `Max turns (${this.maxTurns}) reached` };
        }
        return { stop: false };
    }

    /**
     * Stagnation guard tied to actual deliverables. Call once per turn with the number
     * of distinct files written so far (filesTouched). Resets when that grows OR when
     * opts.hadEdit is true (patch/append to an existing file still counts as progress).
     */
    onProgress(fileCount, opts = {}) {
        if (fileCount > this.lastFileCount) {
            this.lastFileCount = fileCount;
            this.noWriteTurns = 0;
        } else if (opts.hadEdit) {
            this.noWriteTurns = 0;
        } else {
            this.noWriteTurns++;
            if (this.noWriteTurns >= this.maxNoWriteTurns) {
                return {
                    stop: true,
                    reason: `No files written in ${this.maxNoWriteTurns} turns — stopping. `
                        + 'Code Mode builds and edits files; for analysis or Q&A use Chat or Agent mode, '
                        + 'or restate this as a concrete build/edit task.'
                };
            }
        }
        return { stop: false };
    }

    onToolResult(ok, wasDuplicate) {
        if (ok) {
            this.consecutiveErrors = 0;
        } else if (!wasDuplicate) {
            // A duplicate-skip is NOT a tool error — it has its own `duplicateCount`
            // budget below. Counting it toward consecutiveErrors used to kill runs that
            // were merely repeating a call while trying to recover from a real failure.
            this.consecutiveErrors++;
            if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                return { stop: true, reason: `${this.maxConsecutiveErrors} consecutive tool errors` };
            }
        }
        if (wasDuplicate) {
            this.duplicateCount++;
            if (this.duplicateCount >= this.maxDuplicateTools) {
                return { stop: true, reason: 'Too many duplicate tool calls' };
            }
        }
        return { stop: false };
    }
}

module.exports = { EarlyStopDetector };
