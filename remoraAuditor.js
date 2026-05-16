/**
 * RemoraHQ - Auditor Role MeshCentral plugin.
 *
 * Storage for the RemoraHQ Auditor role: a shared list of user-ids granted
 * read-only access to audit + reports + alerts (no mutations). Membership is
 * orthogonal to Mesh `siteadmin` and to the operator/viewer marker usergroups
 * — auditor takes priority over those when resolving role on the client.
 *
 * Storage: `<datapath>/remora-auditor-state.json` with atomic temp+rename
 * writes serialised through a Promise chain.
 *
 * Real-time: every `set` broadcasts `{action:'plugin', plugin:'remoraAuditor',
 * pluginaction:'changed', auditorUserIds}` to all admins via DispatchEvent.
 * Clients invalidate the users + auditor queries on receipt.
 *
 * Wire protocol:
 *   client → server: { action:'plugin', plugin:'remoraAuditor',
 *                      pluginaction:'list'|'set', tag, responseid,
 *                      userId?, isAuditor? }
 *   server → client: same envelope echoed, plus {result:'ok', auditorUserIds}.
 */

'use strict';

var path = require('path');
var fs = require('fs');

var PLUGIN_SHORT_NAME = 'remoraAuditor';
var PLUGIN_VERSION = '0.1.0';

module.exports.remoraAuditor = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;

    obj.exports = ['serveraction'];

    /** @type {string[]} */
    var auditorUserIds = [];
    var storePath = null;
    var writeQueue = Promise.resolve();

    function resolveStorePath() {
        var datapath = (obj.meshServer && obj.meshServer.datapath) || process.cwd();
        return path.join(datapath, 'remora-auditor-state.json');
    }

    function loadFromDisk() {
        try {
            if (!storePath) storePath = resolveStorePath();
            if (!fs.existsSync(storePath)) return;
            var raw = fs.readFileSync(storePath, 'utf8');
            var parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.auditorUserIds)) {
                auditorUserIds = parsed.auditorUserIds.filter(function (id) { return typeof id === 'string'; });
            }
        } catch (e) {
            console.log('[remoraAuditor] load failed:', e.message);
        }
    }

    function persist() {
        var snapshot = JSON.stringify({ auditorUserIds: auditorUserIds });
        writeQueue = writeQueue.then(function () {
            return new Promise(function (resolve) {
                if (!storePath) storePath = resolveStorePath();
                var tmp = storePath + '.tmp';
                fs.writeFile(tmp, snapshot, 'utf8', function (err) {
                    if (err) {
                        console.log('[remoraAuditor] tmp write failed:', err.message);
                        return resolve();
                    }
                    fs.rename(tmp, storePath, function (err2) {
                        if (err2) console.log('[remoraAuditor] rename failed:', err2.message);
                        resolve();
                    });
                });
            });
        });
        return writeQueue;
    }

    function broadcast() {
        try {
            if (!obj.meshServer || typeof obj.meshServer.DispatchEvent !== 'function') return;
            obj.meshServer.DispatchEvent(['*', 'server-users'], obj, {
                action: 'plugin',
                plugin: PLUGIN_SHORT_NAME,
                pluginaction: 'changed',
                etype: 'plugin',
                nolog: 1,
                auditorUserIds: auditorUserIds
            });
        } catch (e) {
            console.log('[remoraAuditor] broadcast failed:', e.message);
        }
    }

    function reply(session, command, payload) {
        var body = Object.assign({
            action: 'plugin',
            plugin: PLUGIN_SHORT_NAME,
            pluginaction: command.pluginaction,
            tag: command.tag,
            responseid: command.responseid || command.tag,
            result: 'ok'
        }, payload || {});
        try { session.send(body); } catch (e) { /* ignore */ }
    }

    function replyError(session, command, error) {
        try {
            session.send({
                action: 'plugin',
                plugin: PLUGIN_SHORT_NAME,
                pluginaction: command.pluginaction || 'unknown',
                tag: command.tag,
                responseid: command.responseid || command.tag,
                result: 'error',
                error: String(error || 'remora_auditor_failed')
            });
        } catch (e) { /* ignore */ }
    }

    obj.server_startup = function () {
        loadFromDisk();
        console.log('[remoraAuditor] v' + PLUGIN_VERSION + ' loaded. Storage: ' + (storePath || '(uninitialised)'));
        console.log('[remoraAuditor] tracking ' + auditorUserIds.length + ' auditor(s).');
    };

    obj.serveraction = function (command, dbGet, ws) {
        var session = dbGet || ws;
        if (!session || typeof session.send !== 'function') return;

        var action = String(command.pluginaction || '');
        try {
            switch (action) {
                case 'list': {
                    reply(session, command, { auditorUserIds: auditorUserIds });
                    return;
                }
                case 'set': {
                    var userId = (command.userId != null) ? String(command.userId) : null;
                    if (!userId) return replyError(session, command, 'missing_userId');
                    var isAuditor = command.isAuditor === true;
                    var ix = auditorUserIds.indexOf(userId);
                    var changed = false;
                    if (isAuditor && ix === -1) { auditorUserIds.push(userId); changed = true; }
                    if (!isAuditor && ix !== -1) { auditorUserIds.splice(ix, 1); changed = true; }
                    if (changed) {
                        persist();
                        broadcast();
                    }
                    reply(session, command, { auditorUserIds: auditorUserIds });
                    return;
                }
                default: {
                    return replyError(session, command, 'unknown_pluginaction');
                }
            }
        } catch (e) {
            console.log('[remoraAuditor] action error:', e.message);
            replyError(session, command, 'internal_error');
        }
    };

    return obj;
};
