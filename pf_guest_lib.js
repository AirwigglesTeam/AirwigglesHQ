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
var MAX_COMMENT = 1000;   // characters in one comment
var MAX_PER_TASK = 200;   // comments on one task
var MAX_FEED = 30;       // guest comments the bell can show
var MAX_SHOWN = 600;      // comments sent for one shared project (newest)
var MAX_PER_HOUR = 20;    // comments one guest can post per hour
var MAX_QUEUE = 300;      // ticks waiting for the team app, all sources together
var MAX_MINE = 50;        // ticks one guest can have waiting
var MAX_LINKS = 40;       // quick links sent for one shared project
var MAX_UPDATES = 30;     // status updates sent for one shared project (newest first)
var MAX_GRANTS = 50;      // projects one guest can be given
var MAX_GUESTS = 200;     // guest accounts in total
var GUEST_TOKEN_SECONDS = 1209600;   // how long a guest sign-in lasts: 14 days, renewed each time the guest comes back (release 249; was one day since the 238 audit)
var MAX_GROUPS = 30;      // saved groups of guests
var MAX_GROUP_MEMBERS = 100;

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

/* Saved groups of guests: [{id, name, members:[guest id]}]. Kept in one server-only record. A group is only a shortcut for sharing:
   it never grants anything by itself, so removing someone from a group does not touch what they can see. */
function cleanGroupName(v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : ''; }
function cleanGroups(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = []; } }
  if (!Array.isArray(v)) return [];
  var seen = Object.create(null), out = [];
  v.forEach(function (gr) {
    if (!gr || typeof gr !== 'object' || !idOk(gr.id) || seen[gr.id] || out.length >= MAX_GROUPS) return;
    var name = cleanGroupName(gr.name); if (!name) return;
    seen[gr.id] = 1;
    var ms = [], ms2 = Object.create(null);
    (Array.isArray(gr.members) ? gr.members : []).forEach(function (m) { if (idOk(m) && !ms2[m] && ms.length < MAX_GROUP_MEMBERS) { ms2[m] = 1; ms.push(m); } });
    out.push({ id: gr.id, name: name, members: ms });
  });
  return out;
}

/* A comment: plain text, control characters out (new lines kept, at most two in a row), trimmed, capped. Shown only as text. */
function cleanComment(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_COMMENT);
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
    var o = { p: g.p, by: idOk(g.by) ? g.by : '', at: typeof g.at === 'string' ? g.at.slice(0, 30) : '' };
    if (dateOk(g.x)) o.x = g.x;                                   // access ends after this day (release 251)
    if (typeof g.v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(g.v)) o.v = g.v.slice(0, 30);   // last time the guest opened this project
    out.push(o);
  });
  return out;
}

function todayOf(now) { return (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString().slice(0, 10); }
/* a grant that has an end date stops working the day after it */
function liveGrants(grants, now) { var t = todayOf(now); return cleanGrants(grants).filter(function (g) { return !g.x || g.x >= t; }); }
function hasGrant(grants, pid, now) { return liveGrants(grants, now).some(function (g) { return g.p === pid; }); }

function addGrant(grants, pid, by, nowIso, expires) {
  var list = cleanGrants(grants);
  if (!idOk(pid)) return { ok: false, why: 'bad project', grants: list };
  if (list.some(function (g) { return g.p === pid; })) {
    if (expires !== undefined) list.forEach(function (g) { if (g.p === pid) { if (expires) g.x = expires; else delete g.x; } });   // '' clears the end date
    return { ok: true, added: false, grants: list };
  }
  if (list.length >= MAX_GRANTS) return { ok: false, why: 'too many', grants: list };
  var ng = { p: pid, by: idOk(by) ? by : '', at: String(nowIso || '').slice(0, 30) };
  if (expires) ng.x = expires;
  list.push(ng);
  return { ok: true, added: true, grants: list };
}

/* the end date a team member may set: nothing (leave as is), '' (no end date), or a real date from today to two years ahead */
function expiryOf(v, now) {
  if (v === undefined || v === null) return { ok: true, val: undefined };
  if (v === '') return { ok: true, val: '' };
  var d = dateOk(v), t = todayOf(now);
  if (!d || isNaN(Date.parse(d + 'T00:00:00Z')) || d < t || Date.parse(d + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z') > 731 * 864e5) return { ok: false };
  return { ok: true, val: d };
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
/* A link a guest may be given: https only, ASCII only, a plain host name with a dot (no login in it, no other-language look-alike letters), at most 500 characters.
   Anything else is dropped, so a guest never gets a javascript:, data: or http: address. */
function linkUrl(v) {
  if (typeof v !== 'string') return '';
  v = v.trim();
  if (v.length > 500 || !/^https:\/\/[^\s<>"'`\\\x00-\x20\x7f-\uffff]+$/.test(v)) return '';
  var m = /^https:\/\/([^\/?#]*)/.exec(v);
  if (!m || !/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9-]+(:[0-9]{1,5})?$/.test(m[1])) return '';
  return v;
}
function dateOk(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }

/* The few numbers shown on a guest's project list: how many tasks, how many done, how many late, the next due date, and the project dates.
   Counted from the same tasks the project screen shows (a whitelist of numbers and dates, nothing else). today = 'YYYY-MM-DD'. */
function projectStats(S, pid, today) {
  var out = { total: 0, done: 0, late: 0, next: '', startDate: '', endDate: '' };
  if (!S || !Array.isArray(S.projects) || !idOk(pid)) return out;
  var i, p = null;
  for (i = 0; i < S.projects.length; i++) if (S.projects[i] && S.projects[i].id === pid) { p = S.projects[i]; break; }
  if (!p) return out;
  out.startDate = dateOk(p.startDate); out.endDate = dateOk(p.endDate);
  var all = Array.isArray(S.tasks) ? S.tasks : [], seen = 0;
  for (i = 0; i < all.length && seen < MAX_TASKS; i++) {
    var t = all[i];
    if (!t || t.projectId !== pid || !idOk(t.id)) continue;
    seen++; out.total++;
    if (t.done === true) { out.done++; continue; }
    var e = dateOk(t.endDate);
    if (!e) continue;
    if (e < today) out.late++;
    else if (!out.next || e < out.next) out.next = e;
  }
  return out;
}

/* What a guest is allowed to see of one shared project. A whitelist: every field is picked by name, so anything added to the app
   later (money, links, sponsors, emails, Slack ids, notes) stays on the server until it is added here on purpose.
   Assignees and labels are sent as plain names, never ids, emails or Slack ids. */
function shapeProject(S, pid, pend, gid) {
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
      mine: idOk(gid) && Array.isArray(t.guestAssignees) && t.guestAssignees.indexOf(gid) >= 0,   // assigned to this guest by the team (other guests' ids are never sent)
      pending: t.done !== true && !!pend[t.id],            // a tick from a guest or Slack that the team app has not applied yet
      canUndo: t.done !== true && !!pend[t.id] && pend[t.id].mine === true   // only the guest who made it can take it back
    });
  }
  /* quick links: only the ones the team has not switched off for guests (a link is shared unless it says noGuest:true); the Graphics folder and
     Event page go together (noGuestFixed:true hides both). Name, https address and category only. */
  var links = [];
  var addLink = function (nm, url, cat) {
    var u = linkUrl(url);
    if (!u || links.length >= MAX_LINKS) return;
    var c = typeof cat === 'string' ? (lab[cat] || (idOk(cat) && cat.length > 14 ? '' : str(cat, 40))) : '';
    links.push({ name: str(nm, 60).trim() || u.replace(/^https:\/\//, '').split('/')[0], url: u, category: c });
  };
  if (p.noGuestFixed !== true) { addLink('Graphics folder', p.graphicsUrl, ''); addLink('Event page', p.eventUrl, ''); }
  (Array.isArray(p.quickLinks) ? p.quickLinks : []).forEach(function (q) { if (q && typeof q === 'object' && q.noGuest !== true) addLink(q.name, q.url, q.category); });
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
    links: links,
    updates: upd
  };
}


/* ==== EMAILS TO GUESTS (release 254)
   One email at most per guest per run, batching what is new: tasks assigned to them, team replies to their comments, tasks of theirs due
   tomorrow and (once a day after 08:00 UK time) new project status updates. What was already sent is remembered in a server-only record
   (the ledger), so nothing is sent twice. The first run only records what exists, so old items never produce a flood. A guest can switch
   emails off on their own page. Everything below is plain data in, plain data out (the sending is passed in), so it is tested without a server. */
var MAIL_CAP = 5;          // emails per guest per UK day
var MAIL_PER_RUN = 30;     // emails per run
var MAIL_KEEP = 3000;      // remembered items
function mailEsc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function oneLine(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function ukDay(ms) {   // UK calendar date and hour for a time in ms (BST from the last Sunday of March to the last Sunday of October)
  var d0 = new Date(ms), y = d0.getUTCFullYear();
  var ls = function (m) { var d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); };
  var l = new Date(ms + (ms >= ls(2) && ms < ls(9) ? 3600000 : 0));
  return { iso: l.toISOString().slice(0, 10), hour: l.getUTCHours() };
}
function cleanLedger(raw) {
  var o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { o = null; }
  var L = { sent: Object.create(null), off: Object.create(null), dig: Object.create(null), day: { d: '', n: Object.create(null) } };
  if (!o || typeof o !== 'object') return L;
  var key = /^[acdu]:[A-Za-z0-9_:-]{1,200}$/;
  if (o.sent && typeof o.sent === 'object') Object.keys(o.sent).slice(0, MAIL_KEEP + 500).forEach(function (k) { if (key.test(k) && typeof o.sent[k] === 'number') L.sent[k] = o.sent[k]; });
  if (o.off && typeof o.off === 'object') Object.keys(o.off).slice(0, 5000).forEach(function (k) { if (idOk(k) && o.off[k]) L.off[k] = 1; });
  if (o.dig && typeof o.dig === 'object') Object.keys(o.dig).slice(0, 5000).forEach(function (k) { if (idOk(k) && typeof o.dig[k] === 'number') L.dig[k] = o.dig[k]; });
  if (o.day && typeof o.day === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(o.day.d || '')) {
    L.day.d = o.day.d;
    if (o.day.n && typeof o.day.n === 'object') Object.keys(o.day.n).slice(0, 5000).forEach(function (k) { if (idOk(k) && typeof o.day.n[k] === 'number') L.day.n[k] = o.day.n[k]; });
  }
  return L;
}
function ledgerOut(L, now) {   // forget old items (due-date items after two weeks) and cap the size
  var keys = Object.keys(L.sent), cut = now - 14 * 864e5;
  keys.forEach(function (k) { if (k.charAt(0) === 'd' && L.sent[k] < cut) delete L.sent[k]; });
  keys = Object.keys(L.sent);
  if (keys.length > MAIL_KEEP) {
    keys.sort(function (a, b) { return L.sent[a] - L.sent[b]; }).slice(0, keys.length - MAIL_KEEP + 500).forEach(function (k) { delete L.sent[k]; });
  }
  return JSON.stringify(L);
}
/* what to send. in = {S, guests:[{id,email,name,grants}], team:[{id,task,project,author,body,at}], guestTasks:function(gid)->{taskId:true}, ledger, now(ms), appUrl, baseline} */
function planMail(inp) {
  var S = inp.S || {}, L = inp.ledger, now = inp.now, uk = ukDay(now), tomorrow = ukDay(now + 864e5).iso;
  var projName = Object.create(null);
  (Array.isArray(S.projects) ? S.projects : []).forEach(function (p) { if (p && idOk(p.id)) projName[p.id] = oneLine(p.name, 80) || 'Project'; });
  var tasks = Array.isArray(S.tasks) ? S.tasks : [];
  var out = { mails: [], seen: [], skip: [], dig: Object.create(null) };
  inp.guests.forEach(function (gu) {
    if (!gu || !idOk(gu.id) || !normEmail(gu.email)) return;
    var live = Object.create(null), n = 0;
    liveGrants(gu.grants, new Date(now)).forEach(function (g) { if (projName[g.p]) { live[g.p] = true; n++; } });
    if (!n) return;
    var items = { assign: [], reply: [], due: [], upd: [] }, keys = [], seen = out.seen;
    var addKey = function (k) { if (!L.sent[k]) keys.push(k); return !L.sent[k]; };
    var assigned = Object.create(null);
    tasks.forEach(function (t) {
      if (!t || !idOk(t.id) || t.done === true || !live[t.projectId] || !Array.isArray(t.guestAssignees) || t.guestAssignees.indexOf(gu.id) < 0) return;
      var nm = oneLine(t.name, 120) || 'Task';
      if (addKey('a:' + t.id + ':' + gu.id)) { items.assign.push({ t: nm, p: t.projectId }); assigned[t.id] = true; }
      var due = dateOk(t.endDate);
      if (due && due === tomorrow && !assigned[t.id] && addKey('d:' + t.id + ':' + due + ':' + gu.id)) items.due.push({ t: nm, p: t.projectId, d: due });
    });
    var mine = null;
    (inp.team || []).forEach(function (c) {
      if (!c || !live[c.project] || L.sent['c:' + c.id] || !idOk(c.id)) return;
      if (!mine) mine = inp.guestTasks(gu.id) || {};
      if (!mine[c.task]) return;
      keys.push('c:' + c.id);
      var task = null; for (var i = 0; i < tasks.length; i++) if (tasks[i] && tasks[i].id === c.task) { task = tasks[i]; break; }
      items.reply.push({ t: task ? oneLine(task.name, 120) : 'a task', p: c.project, by: oneLine(c.author, 40) || 'The team', body: oneLine(c.body, 160) });
    });
    /* once a day after 08:00 UK: status updates posted since the last check */
    var lastDig = L.dig[gu.id] || 0;
    if (uk.hour >= 8 && ukDay(lastDig).iso !== uk.iso) {
      var from = lastDig || (inp.start || now);
      Object.keys(live).forEach(function (pid) {
        var p = null; for (var i = 0; i < S.projects.length; i++) if (S.projects[i] && S.projects[i].id === pid) { p = S.projects[i]; break; }
        (p && Array.isArray(p.updates) ? p.updates : []).forEach(function (u) {
          if (u && typeof u === 'object' && typeof u.at === 'number' && u.at > from && u.at <= now && typeof u.text === 'string') items.upd.push({ p: pid, by: oneLine(u.by, 40), text: oneLine(u.text, 200) });
        });
      });
      out.dig[gu.id] = now;
    }
    keys.forEach(function (k) { seen.push(k); });
    var total = items.assign.length + items.reply.length + items.due.length + items.upd.length;
    if (L.off[gu.id] && !inp.baseline) { keys.forEach(function (k) { out.skip.push(k); }); return; }   // switched off: remember them so they are not sent if it is switched back on
    if (!total || inp.baseline) return;
    if (L.day.d === uk.iso && (L.day.n[gu.id] || 0) >= MAIL_CAP) return;
    out.mails.push(renderMail(gu, items, projName, inp.appUrl, total, keys));
  });
  return out;
}
function renderMail(gu, items, projName, appUrl, total, keys) {
  var first = items.assign[0] || items.reply[0] || items.due[0] || items.upd[0];
  var one = total === 1;
  var subject = one
    ? (items.assign.length ? 'New task for you: ' + first.t : items.reply.length ? 'The team replied about: ' + first.t : items.due.length ? 'Due tomorrow: ' + first.t : 'Project update: ' + (projName[first.p] || 'Project'))
    : 'ProjectFlow: ' + total + ' things for you';
  var pids = Object.create(null); [items.assign, items.reply, items.due, items.upd].forEach(function (a) { a.forEach(function (x) { pids[x.p] = true; }); });
  var plist = Object.keys(pids);
  var link = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(appUrl || '') ? appUrl.replace(/\/+$/, '') + '/#guest' + (plist.length === 1 ? '=' + plist[0] : '') : '';
  var secs = [
    ['New tasks for you', items.assign.map(function (x) { return x.t + ' (' + (projName[x.p] || 'Project') + ')'; })],
    ['Replies from the team', items.reply.map(function (x) { return x.by + ' on ' + x.t + ': ' + x.body; })],
    ['Due tomorrow', items.due.map(function (x) { return x.t + ' (' + (projName[x.p] || 'Project') + ')'; })],
    ['Project updates', items.upd.map(function (x) { return (projName[x.p] || 'Project') + ': ' + x.text + (x.by ? ' (' + x.by + ')' : ''); })]
  ].filter(function (x) { return x[1].length; });
  var foot = 'You get these because you have been given access to a project in ProjectFlow. You can switch emails off with the Emails switch on your project page.';
  var hi = 'Hi' + (oneLine(gu.name, 60) ? ' ' + oneLine(gu.name, 60).split(' ')[0] : '') + ',';
  var text = hi + '\n\n' + secs.map(function (x) { return x[0] + '\n' + x[1].slice(0, 15).map(function (l) { return '- ' + l; }).join('\n'); }).join('\n\n') + '\n\n' + (link ? 'Open it here (sign in with this email address): ' + link + '\n\n' : '') + foot + '\n';
  var html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:560px"><p>' + mailEsc(hi) + '</p>' +
    secs.map(function (x) { return '<p style="margin:14px 0 4px"><b>' + mailEsc(x[0]) + '</b></p><ul style="margin:0;padding-left:20px">' + x[1].slice(0, 15).map(function (l) { return '<li>' + mailEsc(l) + '</li>'; }).join('') + '</ul>'; }).join('') +
    (link ? '<p style="margin:18px 0"><a href="' + mailEsc(link) + '" style="background:#62D0AA;color:#0f1a15;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open ProjectFlow</a></p><p style="font-size:13px;color:#555">Sign in with this email address; a code is sent to you.</p>' : '') +
    '<p style="font-size:12px;color:#777;margin-top:20px">' + mailEsc(foot) + '</p></div>';
  return { gid: gu.id, to: gu.email, name: oneLine(gu.name, 60), subject: oneLine(subject, 150), text: text, html: html, keys: keys };
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

  function ensureGuests() {
    try {
      var have = db.findCollectionByNameOrId('guests');
      if (have) {
        /* guests sign in with a code and have no password: PocketBase's "login from a new location" email would only confuse them */
        var dirty = false;
        if (have.authAlert && have.authAlert.enabled) { have.authAlert.enabled = false; dirty = true; }
        /* release 238 audit set a guest sign-in to one day; release 249 sets 14 days (renewed on each visit); PocketBase's default is seven */
        if (have.authToken && have.authToken.duration !== GUEST_TOKEN_SECONDS) { have.authToken.duration = GUEST_TOKEN_SECONDS; dirty = true; }
        if (dirty) db.save(have);
        return 'exists';
      }
    } catch (e) { /* not there yet: create it below */ }
    var c = new g.Collection({
      type: 'auth', name: 'guests',
      listRule: 'id = @request.auth.id', viewRule: 'id = @request.auth.id',
      createRule: null, updateRule: null, deleteRule: null,       // only the server (and the PocketBase admin) can change a guest
      passwordAuth: { enabled: false },
      otp: { enabled: true, duration: 600, length: 6 },
      authAlert: { enabled: false },
      authToken: { duration: GUEST_TOKEN_SECONDS },
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
  /* comments live in their own collection: no client rule at all, so only the endpoints below (and the PocketBase admin) can read or write */
  function ensureComments() {
    try {
      var have = db.findCollectionByNameOrId('pf_comments');
      if (have) {
        /* release 237: comments gained "seen by the team" and "handled" fields; add them to the collection made by earlier releases */
        var changed = false;
        [['seenAt', 30], ['handledAt', 30], ['handledBy', 60]].forEach(function (f) {
          var ex = null;
          try { ex = have.fields.getByName(f[0]); } catch (e) { ex = null; }
          if (!ex) { have.fields.add(new g.TextField({ name: f[0], max: f[1] })); changed = true; }
        });
        if (changed) db.save(have);
        return 'exists';
      }
    } catch (e) { /* create it below */ }
    var c = new g.Collection({
      type: 'base', name: 'pf_comments',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { type: 'text', name: 'project', max: 60 },
        { type: 'text', name: 'task', max: 60 },
        { type: 'text', name: 'kind', max: 10 },
        { type: 'text', name: 'authorId', max: 60 },
        { type: 'text', name: 'author', max: 60 },
        { type: 'text', name: 'body', max: 1200 },
        { type: 'text', name: 'seenAt', max: 30 },
        { type: 'text', name: 'handledAt', max: 30 },
        { type: 'text', name: 'handledBy', max: 60 },
        { type: 'autodate', name: 'created', onCreate: true },
        { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true }
      ],
      indexes: ['CREATE INDEX idx_pfc_task ON pf_comments (task)', 'CREATE INDEX idx_pfc_project ON pf_comments (project)']
    });
    db.save(c);
    return 'created';
  }
  function ensureCollection() {
    var a = ensureGuests(), b = ensureComments();
    return a === 'created' || b === 'created' ? 'created' : 'exists';
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
  function liveOf(rec, now) { return liveGrants(rec.getString('grants') || '[]', now); }
  function putGrants(rec, list) { rec.set('grants', JSON.stringify(list)); db.save(rec); }


  /* ---- emails to guests (release 254): the ledger is a server-only record, like the saved groups ---- */
  var MWS = 'airwiggles-sr-mail';
  function mLoad() {
    var rec = null;
    try { rec = db.findFirstRecordByFilter('workspace_state', 'workspace = "' + MWS + '"'); } catch (e) { rec = null; }
    return { rec: rec, L: cleanLedger(rec ? rec.getString('data') : null), start: rec ? Date.parse(rec.getString('created')) || 0 : 0 };
  }
  function mSave(h, now) {
    if (!h.rec) { h.rec = new g.Record(db.findCollectionByNameOrId('workspace_state')); h.rec.set('workspace', MWS); }
    h.rec.set('data', ledgerOut(h.L, now));
    db.save(h.rec);
  }
  /* run every few minutes; send(message) returns true when the mail went out. appUrl is the https address of the app. */
  function mailTick(nowDate, send, appUrl) {
    var now = nowDate.getTime(), S = state();
    if (!S) return { sent: 0, why: 'no data' };
    var h = mLoad(), first = !h.rec, map = allGuests(), guests = [];
    Object.keys(map).forEach(function (id) { var r = map[id]; guests.push({ id: id, email: r.getString('email'), name: r.getString('name'), grants: r.getString('grants') || '[]' }); });
    var team = [];
    try {
      team = db.findRecordsByFilter('pf_comments', 'kind = "team"', '-created', 200, 0).map(function (r) { return { id: r.id, task: r.getString('task'), project: r.getString('project'), author: r.getString('author'), body: r.getString('body') }; });
    } catch (e) { team = []; }
    var cache = Object.create(null);
    var guestTasks = function (gid) {
      if (cache[gid]) return cache[gid];
      var m = Object.create(null), recs = [];
      try { recs = db.findRecordsByFilter('pf_comments', 'kind = "guest" && authorId = {:a}', '-created', 200, 0, { a: gid }); } catch (e) { recs = []; }
      recs.forEach(function (r) { m[r.getString('task')] = true; });
      return (cache[gid] = m);
    };
    var plan = planMail({ S: S, guests: guests, team: team, guestTasks: guestTasks, ledger: h.L, now: now, start: h.start, appUrl: appUrl, baseline: first });
    var uk = ukDay(now), sent = 0;
    plan.seen.forEach(function (k) { if (first) h.L.sent[k] = now; });
    plan.skip.forEach(function (k) { h.L.sent[k] = now; });
    if (first) { Object.keys(plan.dig).forEach(function (gid) { h.L.dig[gid] = plan.dig[gid]; }); mSave(h, now); return { sent: 0, why: 'first run: existing items recorded' }; }
    plan.mails.slice(0, MAIL_PER_RUN).forEach(function (m) {
      var ok = false;
      try { ok = send({ to: m.to, name: m.name, subject: m.subject, text: m.text, html: m.html }) === true; } catch (e) { ok = false; }
      if (!ok) return;
      sent++;
      m.keys.forEach(function (k) { h.L.sent[k] = now; });
      if (h.L.day.d !== uk.iso) h.L.day = { d: uk.iso, n: Object.create(null) };
      h.L.day.n[m.gid] = (h.L.day.n[m.gid] || 0) + 1;
      if (plan.dig[m.gid]) h.L.dig[m.gid] = plan.dig[m.gid];
    });
    /* a guest with nothing new still moves their daily update check forward, so old updates are not sent later */
    Object.keys(plan.dig).forEach(function (gid) { if (!plan.mails.some(function (m) { return m.gid === gid; })) h.L.dig[gid] = plan.dig[gid]; });
    mSave(h, now);
    return { sent: sent };
  }
  /* guest: switch emails on or off */
  function mailPref(rec, body) {
    var on = body && body.on;
    if (on !== true && on !== false) return { code: 400, body: { ok: false, error: 'bad request' } };
    var h = mLoad();
    if (on) delete h.L.off[rec.id]; else h.L.off[rec.id] = 1;
    mSave(h, Date.now());
    return { code: 200, body: { ok: true, on: on } };
  }
  function mailOn(rec) { var h = mLoad(); return !h.L.off[rec.id]; }

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
    var ex = expiryOf(body.expires, now);
    if (!ex.ok) return { code: 400, body: { ok: false, error: 'the end date must be a date from today to two years ahead' } };
    var r = addGrant(rec.getString('grants') || '[]', pid, by, now.toISOString(), ex.val);
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
      var mine = null; gr.forEach(function (x) { if (x.p === pid) mine = x; });
      out.push({ id: r.id, email: r.getString('email'), name: r.getString('name'), projects: gr.length, ids: gr.map(function (x) { return x.p; }), at: String(r.getString('created') || ''), ends: mine ? (mine.x || '') : '', opened: mine ? (mine.v || '') : '', grants: gr.map(function (x) { return { p: x.p, x: x.x || '', v: x.v || '' }; }) });
    });
    return { guests: out };
  }


  /* ---- saved groups (team, full access) ---- */
  var GWS = 'airwiggles-sr-groups';
  function gLoad() {
    var rec = null, list = [];
    try { rec = db.findFirstRecordByFilter('workspace_state', 'workspace = "' + GWS + '"'); } catch (e) { rec = null; }
    if (rec) { try { list = cleanGroups(rec.getString('data') || '[]'); } catch (e) { list = []; } }
    return { rec: rec, list: list };
  }
  function gSave(h) {
    if (!h.rec) { h.rec = new g.Record(db.findCollectionByNameOrId('workspace_state')); h.rec.set('workspace', GWS); }
    h.rec.set('data', JSON.stringify(h.list));
    db.save(h.rec);
  }
  function allGuests() {
    var recs = [], map = Object.create(null);
    try { recs = db.findRecordsByFilter('guests', 'id != ""', '-created', MAX_GUESTS, 0); } catch (e) { recs = []; }
    recs.forEach(function (r) { map[r.id] = r; });
    return map;
  }
  function groupShape(gr, map) {
    return { id: gr.id, name: gr.name, members: gr.members.filter(function (id) { return map[id]; }).map(function (id) { return { id: id, email: map[id].getString('email'), name: map[id].getString('name') }; }) };
  }
  function groupList() {
    var h = gLoad(), map = allGuests();
    return { ok: true, groups: h.list.map(function (gr) { return groupShape(gr, map); }) };
  }
  function groupSave(body) {
    var name = cleanGroupName(body && body.name);
    if (!name) return { code: 400, body: { ok: false, error: 'a name is needed' } };
    var h = gLoad(), map = allGuests(), id = body && body.id, gr = null;
    if (id !== undefined && id !== null && id !== '') {
      if (!idOk(id)) return { code: 400, body: { ok: false, error: 'bad request' } };
      h.list.forEach(function (x) { if (x.id === id) gr = x; });
      if (!gr) return { code: 404, body: { ok: false, error: 'group not found' } };
    } else {
      if (h.list.length >= MAX_GROUPS) return { code: 409, body: { ok: false, error: 'too many groups' } };
      gr = { id: 'gr' + g.security.randomString(10).toLowerCase(), name: name, members: [] };
      h.list.push(gr);
    }
    gr.name = name;
    if (body && Array.isArray(body.members)) {
      var ms = [], seen = Object.create(null);
      body.members.forEach(function (m) { if (idOk(m) && map[m] && !seen[m] && ms.length < MAX_GROUP_MEMBERS) { seen[m] = 1; ms.push(m); } });
      gr.members = ms;
    }
    gSave(h);
    return { code: 200, body: { ok: true, group: groupShape(gr, map) } };
  }
  function groupDelete(body) {
    var id = body && body.id;
    if (!idOk(id)) return { code: 400, body: { ok: false, error: 'bad request' } };
    var h = gLoad(), n = h.list.length;
    h.list = h.list.filter(function (x) { return x.id !== id; });
    if (h.list.length === n) return { code: 404, body: { ok: false, error: 'group not found' } };
    gSave(h);
    return { code: 200, body: { ok: true } };
  }
  /* give every member of a group one project (each guest keeps their own list; the group stays only a shortcut) */
  function grantGroup(by, body, now) {
    var gid = body && body.group, pid = body && body.project;
    if (!idOk(gid) || !idOk(pid)) return { code: 400, body: { ok: false, error: 'bad request' } };
    var S = state(); if (!S) return { code: 503, body: { ok: false, error: 'workspace not found' } };
    var brief = projectBrief(S, pid); if (!brief) return { code: 404, body: { ok: false, error: 'project not found' } };
    var gr = null; gLoad().list.forEach(function (x) { if (x.id === gid) gr = x; });
    if (!gr) return { code: 404, body: { ok: false, error: 'group not found' } };
    var gex = expiryOf(body.expires, now);
    if (!gex.ok) return { code: 400, body: { ok: false, error: 'the end date must be a date from today to two years ahead' } };
    var added = 0, already = 0, failed = 0;
    gr.members.forEach(function (m) {
      var rec = byId(m); if (!rec) return;
      var r = addGrant(rec.getString('grants') || '[]', pid, by, now.toISOString(), gex.val);
      if (!r.ok) { failed++; return; }
      if (r.added) { putGrants(rec, r.grants); added++; } else already++;
    });
    return { code: 200, body: { ok: true, added: added, already: already, failed: failed, project: brief } };
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

  /* ---- comments ---- */
  function shapeComment(rec) {
    return { id: rec.id, task: rec.getString('task'), who: str(rec.getString('author'), 60), guest: rec.getString('kind') === 'guest', at: String(rec.getString('created') || ''), text: str(rec.getString('body'), MAX_COMMENT), seen: !!rec.getString('seenAt'), handled: !!rec.getString('handledAt') };
  }
  function commentsOfProject(pid) {
    var recs = [];
    try { recs = db.findRecordsByFilter('pf_comments', 'project = {:p}', '-created', MAX_SHOWN, 0, { p: pid }); } catch (e) { recs = []; }
    return recs.map(shapeComment).reverse();   // oldest first
  }
  function commentsOfTask(tid) {
    var recs = [];
    try { recs = db.findRecordsByFilter('pf_comments', 'task = {:t}', '-created', MAX_PER_TASK, 0, { t: tid }); } catch (e) { recs = []; }
    return recs.map(shapeComment).reverse();
  }
  function findTask(S, tid) {
    var all = Array.isArray(S && S.tasks) ? S.tasks : [];
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === tid) return all[i];
    return null;
  }
  function addComment(pid, tid, kind, authorId, author, text) {
    var rec = new g.Record(db.findCollectionByNameOrId('pf_comments'));
    rec.set('project', pid); rec.set('task', tid); rec.set('kind', kind); rec.set('authorId', authorId);
    rec.set('author', cleanName(author) || (kind === 'guest' ? 'Guest' : 'Team')); rec.set('body', text);
    db.save(rec);
    return rec;
  }
  /* guest: write a comment on a task of a shared project */
  function guestComment(rec, body, now) {
    var pid = body && body.project, tid = body && body.task, text = cleanComment(body && body.text);
    if (!idOk(pid) || !idOk(tid)) return { code: 400, body: { ok: false, error: 'bad request' } };
    if (!text) return { code: 400, body: { ok: false, error: 'write something first' } };
    var S = state();
    if (!S || !hasGrant(rec.getString('grants') || '[]', pid)) return { code: 404, body: { ok: false, error: 'not found' } };
    var task = findTask(S, tid);
    if (!task || task.projectId !== pid) return { code: 404, body: { ok: false, error: 'not found' } };
    now = now || new Date();
    var since = new Date(now.getTime() - 3600000).toISOString().replace('T', ' ');
    var recent = [];
    try { recent = db.findRecordsByFilter('pf_comments', 'authorId = {:a} && created > {:t}', '-created', MAX_PER_HOUR + 1, 0, { a: rec.id, t: since }); } catch (e) { recent = []; }
    if (recent.length >= MAX_PER_HOUR) return { code: 429, body: { ok: false, error: 'too many comments in the last hour' } };
    if (commentsOfTask(tid).length >= MAX_PER_TASK) return { code: 409, body: { ok: false, error: 'this task has the most comments allowed' } };
    var c = addComment(pid, tid, 'guest', rec.id, rec.getString('name') || String(rec.getString('email')).split('@')[0], text);
    return { code: 200, body: { ok: true, comment: shapeComment(c) } };
  }
  /* the thread as the team sees it. Opening it marks the guests' comments as seen (that is what a guest sees as "Seen by the team").
     handled: set by a team member with the Handled button; "by" is the name of who did it (shown to the team only). */
  function teamThread(tid, now) {
    var recs = [];
    try { recs = db.findRecordsByFilter('pf_comments', 'task = {:t}', '-created', MAX_PER_TASK, 0, { t: tid }); } catch (e) { recs = []; }
    recs.reverse().forEach(function (r) {
      if (r.getString('kind') === 'guest' && !r.getString('seenAt')) { try { r.set('seenAt', now.toISOString()); db.save(r); } catch (e) { /* not fatal: it is marked on the next open */ } }
    });
    return recs.map(function (r) { var c = shapeComment(r); if (c.handled) c.by = str(r.getString('handledBy'), 60); return c; });
  }
  function memberName(S, user) {
    var name = '', email = String(user.getString('email') || '').toLowerCase();
    (Array.isArray(S && S.members) ? S.members : []).forEach(function (m) {
      if (!name && m && (m.pbUserId === user.id || (email && typeof m.email === 'string' && m.email.toLowerCase() === email))) name = str(m.name, 60);
    });
    return name || user.getString('name') || email.split('@')[0];
  }
  /* team: mark a guest comment Handled (or take it back). Any team account, like replying. */
  function commentHandled(user, body, now) {
    var id = body && body.id;
    if (!idOk(id)) return { code: 400, body: { ok: false, error: 'bad request' } };
    var rec = null;
    try { rec = db.findRecordById('pf_comments', id); } catch (e) { rec = null; }
    if (!rec || rec.getString('kind') !== 'guest') return { code: 404, body: { ok: false, error: 'not found' } };
    now = now || new Date();
    var on = !(body && body.handled === false);
    if (on) { rec.set('handledAt', now.toISOString()); rec.set('handledBy', memberName(state() || {}, user)); if (!rec.getString('seenAt')) rec.set('seenAt', now.toISOString()); }
    else { rec.set('handledAt', ''); rec.set('handledBy', ''); }
    db.save(rec);
    var c = shapeComment(rec); if (c.handled) c.by = str(rec.getString('handledBy'), 60);
    return { code: 200, body: { ok: true, comment: c } };
  }
  /* team: the thread of one task, and whether its project is shared with anyone (the app shows the section only then) */
  function teamComments(tid) {
    if (!idOk(tid)) return { code: 400, body: { ok: false, error: 'bad request' } };
    var S = state(), task = S ? findTask(S, tid) : null;
    if (!task) return { code: 404, body: { ok: false, error: 'not found' } };
    var shared = false, recs = [];
    try { recs = db.findRecordsByFilter('guests', 'id != ""', '-created', MAX_GUESTS, 0); } catch (e) { recs = []; }
    recs.forEach(function (r) { if (!shared && hasGrant(r.getString('grants') || '[]', task.projectId)) shared = true; });
    return { code: 200, body: { ok: true, shared: shared, items: teamThread(tid, new Date()) } };
  }
  /* team: reply on a task (the author name comes from the team list, never from the request) */
  function teamComment(user, body) {
    var tid = body && body.task, text = cleanComment(body && body.text);
    if (!idOk(tid)) return { code: 400, body: { ok: false, error: 'bad request' } };
    if (!text) return { code: 400, body: { ok: false, error: 'write something first' } };
    var S = state(), task = S ? findTask(S, tid) : null;
    if (!task || !idOk(task.projectId)) return { code: 404, body: { ok: false, error: 'not found' } };
    if (commentsOfTask(tid).length >= MAX_PER_TASK) return { code: 409, body: { ok: false, error: 'this task has the most comments allowed' } };
    var c = addComment(task.projectId, tid, 'team', user.id, memberName(S, user), text);
    return { code: 200, body: { ok: true, comment: shapeComment(c) } };
  }
  /* team: the newest guest comments across all projects (for the bell). Same account rule as the task thread: any team account. */
  function feed() {
    var recs = [];
    try { recs = db.findRecordsByFilter('pf_comments', 'kind = "guest"', '-created', MAX_FEED, 0); } catch (e) { recs = []; }
    return { ok: true, items: recs.map(function (r) { var c = shapeComment(r); c.project = r.getString('project'); return c; }) };
  }
  /* team (full access): remove a comment */
  function commentDelete(body) {
    var id = body && body.id;
    if (!idOk(id)) return { code: 400, body: { ok: false, error: 'bad request' } };
    var rec = null;
    try { rec = db.findRecordById('pf_comments', id); } catch (e) { rec = null; }
    if (!rec) return { code: 404, body: { ok: false, error: 'not found' } };
    db.delete(rec);
    return { code: 200, body: { ok: true } };
  }

  /* guest: who am I and what has been shared with me (names only) */
  function me(rec, now) {
    var S = state() || {}, items = [], d = now instanceof Date ? now : new Date(), today = d.toISOString().slice(0, 10);
    liveOf(rec, d).forEach(function (x) { var b = projectBrief(S, x.p); if (b) { var st = projectStats(S, x.p, today); b.total = st.total; b.done = st.done; b.late = st.late; b.next = st.next; b.startDate = st.startDate; b.endDate = st.endDate; items.push(b); } });
    return { name: rec.getString('name'), email: rec.getString('email'), mail: mailOn(rec), projects: items };
  }

  /* remember when a guest last opened a project (the team sees it in Share and Settings); written at most once every ten minutes per guest and project */
  function touchOpened(rec, pid) {
    try {
      var list = cleanGrants(rec.getString('grants') || '[]'), now = new Date(), hit = false;
      list.forEach(function (x) { if (x.p === pid && (!x.v || now.getTime() - Date.parse(x.v) > 600000)) { x.v = now.toISOString(); hit = true; } });
      if (hit) putGrants(rec, list);
    } catch (e) { /* the page still loads */ }
  }

  /* guest: the tasks of one shared project. A project the guest does not have answers exactly like one that does not exist. */
  function project(rec, pid) {
    var S = state();
    if (!S || !hasGrant(rec.getString('grants') || '[]', pid)) return { code: 404, body: { ok: false, error: 'not found' } };
    var out = shapeProject(S, pid, pendingMap(rec.id), rec.id);
    if (out) { out.comments = commentsOfProject(pid); touchOpened(rec, pid); }
    return out ? { code: 200, body: out } : { code: 404, body: { ok: false, error: 'not found' } };
  }

  return { mailTick: mailTick, mailPref: mailPref, mailOn: mailOn, groupList: groupList, groupSave: groupSave, groupDelete: groupDelete, grantGroup: grantGroup, ensureCollection: ensureCollection, commentHandled: commentHandled, feed: feed, project: project, grant: grant, revoke: revoke, list: list, me: me, tick: tick, guestComment: guestComment, teamComments: teamComments, teamComment: teamComment, commentDelete: commentDelete };
}

module.exports = { planMail: planMail, cleanLedger: cleanLedger, ledgerOut: ledgerOut, ukDay: ukDay, MAIL_CAP: MAIL_CAP, cleanGroups: cleanGroups, MAX_GROUPS: MAX_GROUPS, MAX_GROUP_MEMBERS: MAX_GROUP_MEMBERS, MAX_FEED: MAX_FEED, cleanComment: cleanComment, MAX_COMMENT: MAX_COMMENT, MAX_PER_TASK: MAX_PER_TASK, MAX_PER_HOUR: MAX_PER_HOUR, MAX_SHOWN: MAX_SHOWN, idOk: idOk, normEmail: normEmail, cleanName: cleanName, canShare: canShare, cleanGrants: cleanGrants, hasGrant: hasGrant, liveGrants: liveGrants, expiryOf: expiryOf, addGrant: addGrant, removeGrant: removeGrant, projectBrief: projectBrief, projectStats: projectStats, shapeProject: shapeProject, runtime: runtime, MAX_GRANTS: MAX_GRANTS, MAX_GUESTS: MAX_GUESTS, MAX_TASKS: MAX_TASKS, MAX_UPDATES: MAX_UPDATES, MAX_LINKS: MAX_LINKS, linkUrl: linkUrl, MAX_QUEUE: MAX_QUEUE, MAX_MINE: MAX_MINE };
