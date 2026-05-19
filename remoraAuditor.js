/**
 * RemoraHQ - Auditor Role MeshCentral plugin.
 *
 * Two responsibilities:
 *
 * 1. Auditor membership storage (since 0.1.0): a shared list of user-ids
 *    granted read-only access to audit + reports + alerts. Storage at
 *    `<datapath>/remora-auditor-state.json` (atomic temp+rename, serialised
 *    through a Promise chain). Every `set` broadcasts
 *    `{action:'plugin', plugin:'remoraAuditor', pluginaction:'changed',
 *    auditorUserIds}` to all admins.
 *
 * 2. `audit.write` emitter (since 0.2.0): client-driven audit row for
 *    residual gaps left after the 12.5.3.3 re-survey — actions that Mesh
 *    native audit (server-side DispatchEvent + agentlog channel) does not
 *    cover. Currently: Files mkdir, Desktop get-clipboard, Desktop input-lock
 *    toggles, usergroup rename/desc. Validated msgid range 9000..9999
 *    (reserved for RemoraHQ), msg ≤ 4096. Dispatched as
 *    `{etype:'remora-audit', action, msgid, msg, nodeid?, meshid?, userid,
 *    username, domain}` so existing audit feed + dedup pipeline picks it up
 *    without code changes.
 *
 * Wire protocol:
 *   client → server: { action:'plugin', plugin:'remoraAuditor',
 *                      pluginaction:'list'|'set'|'audit.write', tag,
 *                      responseid, ... }
 *   server → client: same envelope echoed, plus {result:'ok'|'error', ...}.
 */

'use strict';

var path = require('path');
var fs = require('fs');

var PLUGIN_SHORT_NAME = 'remoraAuditor';
var PLUGIN_VERSION = '0.2.0';
var REMORA_MSGID_MIN = 9000;
var REMORA_MSGID_MAX = 9999;
var REMORA_MSG_MAX_LEN = 4096;

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
                case 'audit.write': {
                    // Validate msgid in reserved RemoraHQ range and msg length.
                    var msgid = command.msgid;
                    if (typeof msgid !== 'number' || msgid < REMORA_MSGID_MIN || msgid > REMORA_MSGID_MAX) {
                        return replyError(session, command, 'invalid_msgid');
                    }
                    var msg = (typeof command.msg === 'string') ? command.msg : '';
                    if (msg.length === 0 || msg.length > REMORA_MSG_MAX_LEN) {
                        return replyError(session, command, 'invalid_msg');
                    }
                    var auditAction = (typeof command.auditAction === 'string') ? command.auditAction : '';
                    if (!auditAction) return replyError(session, command, 'missing_auditAction');

                    // Resolve actor + domain from the session user. dbGet/ws shape
                    // mirrors what Mesh passes to other plugin pluginactions; user
                    // info hangs off session.user (set by meshuser.js before
                    // routing to plugin handlers).
                    var actor = session && session.user;
                    var userid = actor && actor._id;
                    var username = actor && actor.name;
                    var domain = (actor && actor.domain) || '';

                    var event = {
                        etype: 'remora-audit',
                        action: auditAction,
                        msgid: msgid,
                        msg: msg,
                        domain: domain
                    };
                    if (Array.isArray(command.msgArgs)) event.msgArgs = command.msgArgs;
                    if (typeof command.nodeid === 'string') event.nodeid = command.nodeid;
                    if (typeof command.meshid === 'string') event.meshid = command.meshid;
                    if (userid) { event.userid = userid; }
                    if (username) { event.username = username; }
                    if (command.metadata && typeof command.metadata === 'object') {
                        event.metadata = command.metadata;
                    }

                    try {
                        if (obj.meshServer && typeof obj.meshServer.DispatchEvent === 'function') {
                            // Target audience: all admins + the actor. Mirrors what
                            // meshuser.js does for accountchange — server-users gets
                            // the broadcast, actor sees their own action.
                            var targets = ['*', 'server-users'];
                            if (userid) targets.push(userid);
                            obj.meshServer.DispatchEvent(targets, obj, event);
                        }
                    } catch (e) {
                        console.log('[remoraAuditor] audit.write dispatch failed:', e.message);
                        return replyError(session, command, 'dispatch_failed');
                    }
                    reply(session, command, {});
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
