/* ProjectFlow guest access helpers, shared by projectflow_guest.pb.js.
   Plain CommonJS with no PocketBase globals, so it is unit-tested in Node (tests/server/guest-lib.test.js).
   A guest is an account in its own `guests` collection (never in `users`). It holds a short list of grants: one per shared
   project, event or ongoing item. A guest never reads the workspace record; the server answers from it, a slice at a time.
   Needs PocketBase 0.23 or newer (one-time email codes). Plain ASCII only (the deploy check requires it). */
'use strict';

var ID_OK = /^[\w-]{1,60}$/;
var TYPES = ['event', 'ongoing', 'improvement', 'admin'];   // the app's project kinds (PROJ_TYPES)
var KSTATUS = ['todo', 'blocked', 'in-progress', 'done'];   // the board columns
var PRIOS = ['High', 'Medium', 'Low'];
var PHASES = ['Planning', 'Pre-launch', 'Live', 'Post-event'];
var MAX_TASKS = 3000;     // tasks sent for one shared project
var ID_OK = /^[\w-]{1,60}$/;
var MAX_QUEUE = 300;      // ticks waiting for the team app, all sources together
var MAX_MINE = 50;        // ticks one guest can have waiting
var MAX_UPDATES = 30;     // status updates sent for one shared project (newest first)
var MAX_GRANTS = 50;      // projects one guest can be given
var MAX_GUESTS = 200;     // guest accounts in total

function idOk(v) { return typeof v === 'string' && ID_OK.test(v) && v !== '__proto__' && v !== 'constructor' && v !== 'prototype'; }

function normEmail(v) {
  if (typeof v !== 'string') return '';
  var e = v.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return '';
  return /^[^\s@<>"',;:()\[\]\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : '';
}

function cleanName(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

/* Who may share: a team account whose page permissions list is empty (empty means every page, as in the app). */
function canShare(perms) {
  if (perms == null || perms === '') return true;
  if (typeof perms === 'string') { try { perms = JSON.parse(perms); } catch (e) { return false; } }
  return perms == null || (Array.isArray(perms) && perms.length === 0);
}

function cleanGrants(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = []; } }
  if (!Array.isArray(v)) return [];
  var seen = Object.create(null), out = [];
  v.forEach(function (g) {
    if (!g || typeof g !== 'object' || !idOk(g.p) || seen[g.p] || out.length >= MAX_GRANTS) return;
    seen[g.p] = 1;
    out.push({ p: g.p, by: idOk(g.by) ? g.by : '', at: typeof g.at === 'string' ? g.at.slice(0, 30) : '' });
  });
  return out;
}

function hasGrant(grants, pid) { return cleanGrants(grants).some(function (g) { return g.p === pid; }); }

function addGrant(grants, pid, by, nowIso) {
  var list = cleanGrants(grants);
  if (!idOk(pid)) return { ok: false, why: 'bad project', grants: list };
  if (list.some(function (g) { return g.p === pid; })) return { ok: true, added: false, grants: list };
  if (list.length >= MAX_GRANTS) return { ok: false, why: 'too many', grants: list };
  list.push({ p: pid, by: idOk(by) ? by : '', at: String(nowIso || '').slice(0, 30) });
  return { ok: true, added: true, grants: list };
}

function removeGrant(grants, pid) {
  return cleanGrants(grants).filter(function (g) { return g.p !== pid; });
}

/* The little the app knows about a shared item: id, name, kind. Nothing else leaves the server in stage 2. */
function projectBrief(S, pid) {
  if (!S || !Array.isArray(S.projects) || !idOk(pid)) return null;
  for (var i = 0; i < S.projects.length; i++) {
    var p = S.projects[i];
    if (p && p.id === pid) return { id: p.id, name: String(p.name == null ? '' : p.name).slice(0, 120), type: TYPES.indexOf(p.type) >= 0 ? p.type : 'event' };   // same rule as the app: no type means an event
  }
  return null;
}


function str(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
function dateOk(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }

/* What a guest is allowed to see of one shared project. A whitelist: every field is picked by name, so anything added to the app
   later (money, links, sponsors, emails, Slack ids, notes) stays on the server until it is added here on purpose.
   Assignees and labels are sent as plain names, never ids, emails or Slack ids. */
function shapeProject(S, pid, pend) {
  pend = pend || {};
  var brief = projectBrief(S, pid);
  if (!brief) return null;
  var p = null, i;
  for (i = 0; i < S.projects.length; i++) if (S.projects[i] && S.projects[i].id === pid) { p = S.projects[i]; break; }
  var mem = Object.create(null), lab = Object.create(null);
  (Array.isArray(S.members) ? S.members : []).forEach(function (m) { if (m && idOk(m.id)) mem[m.id] = str(m.name, 60); });
  (Array.isArray(S.labels) ? S.labels : []).forEach(function (l) { if (l && idOk(l.id)) lab[l.id] = str(l.name, 40); });
  var names = function (ids, map, max) {
    var out = [];
    (Array.isArray(ids) ? ids : []).forEach(function (x) { if (out.length < max && typeof x === 'string' && map[x]) out.push(map[x]); });
    return out;
  };
  var tasks = [], all = Array.isArray(S.tasks) ? S.tasks : [];
  for (i = 0; i < all.length && tasks.length < MAX_TASKS; i++) {
    var t = all[i];
    if (!t || t.projectId !== pid || !idOk(t.id)) continue;
    tasks.push({
      id: t.id, name: str(t.name, 200), description: str(t.description, 2000),
      parentId: idOk(t.parentId) ? t.parentId : '',
      done: t.done === true,
      kStatus: KSTATUS.indexOf(t.kStatus) >= 0 ? t.kStatus : (t.done === true ? 'done' : 'todo'),
      priority: PRIOS.indexOf(t.priority) >= 0 ? t.priority : '',
      phase: PHASES.indexOf(t.phase) >= 0 ? t.phase : '',
      startDate: dateOk(t.startDate), endDate: dateOk(t.endDate),
      labels: names(t.labels, lab, 10), assignees: names(t.assignees, mem, 5),
      pending: t.done !== true && !!pend[t.id],            // a tick from a guest or Slack that the team app has not applied yet
      canUndo: t.done !== true && !!pend[t.id] && pend[t.id].mine === true   // only the guest who made it can take it back
    });
  }
  /* status updates (read only for guests): date, first name of the author and the text; newest first */
  var upd = [];
  (Array.isArray(p.updates) ? p.updates : []).forEach(function (u) {
    if (!u || typeof u !== 'object' || !idOk(u.id)) return;
    upd.push({ id: u.id, d: dateOk(u.d), at: typeof u.at === 'number' && isFinite(u.at) ? u.at : 0, by: str(u.by, 40), text: str(u.text, 1000) });
  });
  upd.sort(function (a, b) { return (b.d || '').localeCompare(a.d || '') || (b.at - a.at); });
  upd = upd.slice(0, MAX_UPDATES);
  return {
    project: { id: brief.id, name: brief.name, type: brief.type, description: str(p.description, 600), startDate: dateOk(p.startDate), endDate: dateOk(p.endDate), status: str(p.status, 20) },
    tasks: tasks,
    updates: upd
  };
}

/* ---- the part that talks to PocketBase. g = {app, Record, Collection, security}: the PocketBase globals, passed in so tests can fake them ---- */
function runtime(g) {
  var db = g.app;

  function state() {
    try {
      var rec = db.findFirstRecordByFilter('workspace_state', 'workspace = "airwiggles"');
      return JSON.parse(rec.getString('data') || '{}');
    } catch (e) { return null; }
  }

  function ensureCollection() {
    try { if (db.findCollectionByNameOrId('guests')) return 'exists'; } catch (e) { /* not there yet: create it below */ }
    var c = new g.Collection({
      type: 'auth', name: 'guests',
      listRule: 'id = @request.auth.id', viewRule: 'id = @request.auth.id',
      createRule: null, updateRule: null, deleteRule: null,       // only the server (and the PocketBase admin) can change a guest
      passwordAuth: { enabled: false },
      otp: { enabled: true, duration: 600, length: 6 },
      fields: [
        { type: 'text', name: 'name', max: 60 },
        { type: 'json', name: 'grants', maxSize: 20000 },
        { type: 'autodate', name: 'created', onCreate: true },
        { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true }
      ]
    });
    db.save(c);
    return 'created';
  }

  function byEmail(email) {
    try { return db.findFirstRecordByFilter('guests', 'email = {:e}', { e: email }); } catch (e) { return null; }
  }
  function byId(id) {
    if (!idOk(id)) return null;
    try { return db.findRecordById('guests', id); } catch (e) { return null; }
  }
  function count() {
    try { return db.countRecords('guests'); } catch (e) { return 0; }
  }
  function grantsOf(rec) { return cleanGrants(rec.getString('grants') || '[]'); }
  function putGrants(rec, list) { rec.set('grants', JSON.stringify(list)); db.save(rec); }

  /* team: give a guest (made on the spot if new) access to one project */
  function grant(by, body, now) {
    var email = normEmail(body && body.email), pid = body && body.project;
    if (!email) return { code: 400, body: { ok: false, error: 'a valid email is needed' } };
    var S = state(); if (!S) return { code: 503, body: { ok: false, error: 'workspace not found' } };
    var brief = projectBrief(S, pid);
    if (!brief) return { code: 404, body: { ok: false, error: 'project not found' } };
    var rec = byEmail(email), made = false;
    if (!rec) {
      if (count() >= MAX_GUESTS) return { code: 409, body: { ok: false, error: 'too many guests' } };
      rec = new g.Record(db.findCollectionByNameOrId('guests'));
      var pw = g.security.randomString(40);
      rec.set('email', email); rec.set('password', pw); rec.set('passwordConfirm', pw); rec.set('verified', true);
      rec.set('name', cleanName(body.name)); rec.set('grants', '[]');
      made = true;
    } else if (!rec.getString('name') && cleanName(body.name)) rec.set('name', cleanName(body.name));
    var r = addGrant(rec.getString('grants') || '[]', pid, by, now.toISOString());
    if (!r.ok) return { code: 409, body: { ok: false, error: r.why === 'too many' ? 'this guest already has the most projects allowed' : 'bad project' } };
    putGrants(rec, r.grants);
    return { code: 200, body: { ok: true, id: rec.id, created: made, added: r.added, project: brief } };
  }

  /* team: take one project away from a guest, or delete the guest completely (all:true) */
  function revoke(body) {
    var rec = byId(body && body.id);
    if (!rec) return { code: 404, body: { ok: false, error: 'guest not found' } };
    if (body.all === true) { db.delete(rec); return { code: 200, body: { ok: true, deleted: true } }; }
    if (!idOk(body.project)) return { code: 400, body: { ok: false, error: 'a project is needed' } };
    putGrants(rec, removeGrant(rec.getString('grants') || '[]', body.project));
    return { code: 200, body: { ok: true, deleted: false } };
  }

  /* team: who can see a project (or, without one, every guest and how many projects each has) */
  function list(pid) {
    var recs = [];
    try { recs = db.findRecordsByFilter('guests', 'id != ""', '-created', MAX_GUESTS, 0); } catch (e) { recs = []; }
    var out = [];
    recs.forEach(function (r) {
      var gr = grantsOf(r);
      if (pid && !gr.some(function (x) { return x.p === pid; })) return;
      out.push({ id: r.id, email: r.getString('email'), name: r.getString('name'), projects: gr.length });
    });
    return { guests: out };
  }


  /* ---- ticks: a guest never edits a task. The tick waits in the same server-only queue that Slack ticks use (record
     airwiggles-sr-done); the team app completes it with its own code (recurring tasks, blockers, parents and Workflows behave as
     when the team ticks). Queue changes run inside a database transaction. ---- */
  var QWS = 'airwiggles-sr-done', LEASE_MS = 120000;
  function qtx(fn) {
    var last;
    for (var i = 0; i < 4; i++) {
      try {
        var out;
        var body = function (t) {
          var find = function (ws) { try { return t.findFirstRecordByFilter('workspace_state', 'workspace = "' + ws + '"'); } catch (e) { return null; } };
          var save = function (rec) { if (typeof t.save === 'function') t.save(rec); else t.saveRecord(rec); };
          out = fn(find, save, t);
        };
        if (typeof db.runInTransaction === 'function') db.runInTransaction(body); else db.dao().runInTransaction(body);
        return out;
      } catch (e) { last = e; }
    }
    throw last;
  }
  function qLoad(find, now) {
    var rec = find(QWS), q = {};
    if (rec) { try { q = JSON.parse(rec.getString('data') || '{}'); } catch (e) { q = {}; } }
    if (!q || !Array.isArray(q.items)) q = { items: [] };
    var cut = now.getTime() - 14 * 864e5;
    q.items = q.items.filter(function (x) { return x && ID_OK.test(String(x.id)) && ID_OK.test(String(x.taskId)) && Date.parse(x.at) > cut; });
    return { rec: rec, q: q };
  }
  function qSave(h, save, t) {
    if (!h.rec) { h.rec = new g.Record(t.findCollectionByNameOrId('workspace_state')); h.rec.set('workspace', QWS); }
    h.rec.set('data', JSON.stringify(h.q));
    save(h.rec);
  }
  /* which tasks have a tick waiting, and whether this guest made it */
  function pendingMap(guestId) {
    var out = {};
    try {
      var rec = db.findFirstRecordByFilter('workspace_state', 'workspace = "' + QWS + '"');
      var q = JSON.parse(rec.getString('data') || '{}');
      (Array.isArray(q.items) ? q.items : []).forEach(function (x) {
        if (x && ID_OK.test(String(x.taskId)) && (x.kind || 'done') === 'done') out[x.taskId] = { mine: x.via === 'guest' && x.memberId === guestId };
      });
    } catch (e) { /* no queue yet */ }
    return out;
  }
  function blockersOf(S, t) {
    var names = [], ids = Array.isArray(t.blockedBy) ? t.blockedBy : [];
    (Array.isArray(S.tasks) ? S.tasks : []).forEach(function (x) {
      if (x && ids.indexOf(x.id) >= 0 && x.done !== true && names.length < 3) names.push(str(x.name, 80));
    });
    return names;
  }
  /* guest: tick a task (done:true) or take back a tick that still waits (done:false) */
  function tick(rec, body, now) {
    var pid = body && body.project, tid = body && body.task, want = !(body && body.done === false);
    if (!idOk(pid) || !idOk(tid)) return { code: 400, body: { ok: false, error: 'bad request' } };
    var S = state();
    if (!S || !hasGrant(rec.getString('grants') || '[]', pid)) return { code: 404, body: { ok: false, error: 'not found' } };
    var task = null, all = Array.isArray(S.tasks) ? S.tasks : [];
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === tid) { task = all[i]; break; }
    if (!task || task.projectId !== pid) return { code: 404, body: { ok: false, error: 'not found' } };
    now = now || new Date();
    if (want) {
      if (task.done === true) return { code: 200, body: { ok: true, already: true } };
      var by = blockersOf(S, task);
      if (by.length) return { code: 409, body: { ok: false, error: 'blocked', by: by } };
      var r = qtx(function (find, save, t) {
        var h = qLoad(find, now), mine = 0;
        for (var k = 0; k < h.q.items.length; k++) {
          var x = h.q.items[k];
          if (x.taskId === tid && (x.kind || 'done') === 'done') return { added: false };
          if (x.via === 'guest' && x.memberId === rec.id) mine++;
        }
        if (h.q.items.length >= MAX_QUEUE || mine >= MAX_MINE) return { full: true };
        h.q.items.push({ id: 'q' + now.getTime().toString(36) + Math.floor(Math.random() * 1679616).toString(36), kind: 'done', taskId: tid, memberId: rec.id, slackId: '', via: 'guest', who: cleanName(rec.getString('name') || rec.getString('email')).slice(0, 60), at: now.toISOString() });
        qSave(h, save, t);
        return { added: true };
      });
      if (r.full) return { code: 429, body: { ok: false, error: 'too many ticks are waiting; try again in a little while' } };
      return { code: 200, body: { ok: true, pending: true } };
    }
    var c = qtx(function (find, save, t) {
      var h = qLoad(find, now), hit = false, keep = [];
      h.q.items.forEach(function (x) {
        var cl = Date.parse(x.claimedAt || '');
        if (x.taskId === tid && (x.kind || 'done') === 'done' && x.via === 'guest' && x.memberId === rec.id && (isNaN(cl) || now.getTime() - cl >= LEASE_MS)) hit = true; else keep.push(x);
      });
      if (hit) { h.q.items = keep; qSave(h, save, t); }
      return { cancelled: hit };
    });
    return c.cancelled ? { code: 200, body: { ok: true, cancelled: true } } : { code: 409, body: { ok: false, error: 'applied' } };
  }

  /* guest: who am I and what has been shared with me (names only) */
  function me(rec) {
    var S = state() || {}, items = [];
    grantsOf(rec).forEach(function (x) { var b = projectBrief(S, x.p); if (b) items.push(b); });
    return { name: rec.getString('name'), email: rec.getString('email'), projects: items };
  }

  /* guest: the tasks of one shared project. A project the guest does not have answers exactly like one that does not exist. */
  function project(rec, pid) {
    var S = state();
    if (!S || !hasGrant(rec.getString('grants') || '[]', pid)) return { code: 404, body: { ok: false, error: 'not found' } };
    var out = shapeProject(S, pid, pendingMap(rec.id));
    return out ? { code: 200, body: out } : { code: 404, body: { ok: false, error: 'not found' } };
  }

  return { ensureCollection: ensureCollection, project: project, grant: grant, revoke: revoke, list: list, me: me, tick: tick };
}

module.exports = { idOk: idOk, normEmail: normEmail, cleanName: cleanName, canShare: canShare, cleanGrants: cleanGrants, hasGrant: hasGrant, addGrant: addGrant, removeGrant: removeGrant, projectBrief: projectBrief, shapeProject: shapeProject, runtime: runtime, MAX_GRANTS: MAX_GRANTS, MAX_GUESTS: MAX_GUESTS, MAX_TASKS: MAX_TASKS, MAX_UPDATES: MAX_UPDATES, MAX_QUEUE: MAX_QUEUE, MAX_MINE: MAX_MINE };
