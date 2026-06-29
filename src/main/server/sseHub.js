/**
 * SSE hub — fan-out main→renderer push events to connected web/mobile clients.
 * Desktop Electron still uses ipcRenderer.on; this path is for LAN web UI only.
 */
'use strict';

const { RECEIVE_CHANNELS } = require('../../shared/ipcChannels.js');

function createSseHub() {
    /** @type {Set<import('http').ServerResponse>} */
    const clients = new Set();

    function addClient(res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write(': connected\n\n');
        clients.add(res);
        const onClose = () => {
            clients.delete(res);
            res.removeListener('close', onClose);
            res.removeListener('error', onClose);
        };
        res.on('close', onClose);
        res.on('error', onClose);
    }

    /**
     * @param {string} channel — must be in RECEIVE_CHANNELS
     * @param {*} payload
     */
    function broadcast(channel, payload) {
        if (!RECEIVE_CHANNELS.includes(channel)) return;
        let data;
        try {
            data = JSON.stringify(payload);
        } catch (e) {
            return;
        }
        const frame = `event: ${channel}\ndata: ${data}\n\n`;
        for (const res of clients) {
            try {
                const ok = res.write(frame);
                if (ok === false) {
                    // Backpressure: wait for drain instead of disconnecting the client.
                    // Track in-flight state so we don't queue multiple drains for one client.
                    if (!res._draining) {
                        res._draining = true;
                        res.once('drain', () => { res._draining = false; });
                    }
                }
            } catch (e) {
                clients.delete(res);
            }
        }
    }

    return {
        addClient,
        broadcast,
        clientCount: () => clients.size
    };
}

module.exports = { createSseHub };
