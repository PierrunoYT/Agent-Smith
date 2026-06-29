/**
 * IPC domain: change ledger (diff / revert-all).
 *
 * Registered via registerLedgerIpc(ipcMain, { changeLedger, state }). `state`
 * is the shared mutable object owned by main.js; `state.currentPlanId` is the
 * fallback plan id when the renderer does not pass one explicitly.
 */
module.exports = function registerLedgerIpc(ipcMain, deps) {
    const { changeLedger, state } = deps;

    const resolvePlanId = (planId) => planId || state?.currentPlanId;

    ipcMain.handle('ledger-diff', async (event, planId) => {
        const pid = resolvePlanId(planId);
        if (!pid) return { error: 'No active plan' };
        return changeLedger.diff(pid);
    });

    ipcMain.handle('ledger-revert-all', async (event, planId) => {
        const pid = resolvePlanId(planId);
        if (!pid) return { error: 'No active plan' };
        return changeLedger.revertAll(pid);
    });
};
