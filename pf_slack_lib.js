/* ProjectFlow Slack helpers, shared by projectflow_slack.pb.js.
   Plain CommonJS with no PocketBase globals, so it is unit-tested in Node (tests/server/slack-lib.test.js).
   PocketBase hooks cannot see variables outside their own function, so the hook file require()s this module. */
'use strict';

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var OD_MAX = 10;   // overdue tasks listed per person; the rest are counted (same as the app)

function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function idOk(v) { return typeof v === 'string' && /^[UW][A-Z0-9]{6,20}$/.test(v); }
function urlOk(u) { return typeof u === 'string' && /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9\/_-]+$/.test(u); }
function appUrlOk(u) { return typeof u === 'string' && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(u); }

/* ---- time: the team works on UK time. BST runs from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC ---- */
function lastSunday(y, m) { var d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); }
function london(now) {
  var t = now.getTime(), y = now.getUTCFullYear();
  var bst = t >= lastSunday(y, 2) && t < lastSunday(y, 9);
  var l = new Date(t + (bst ? 3600000 : 0));
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return { iso: l.getUTCFullYear() + '-' + pad(l.getUTCMonth() + 1) + '-' + pad(l.getUTCDate()), dow: l.getUTCDay(), hour: l.getUTCHours(), min: l.getUTCMinutes(), ms: Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) };
}
function addDays(iso, n) { var d = new Date(Date.parse(iso) + n * 864e5); return d.toISOString().slice(0, 10); }
function fmtD(s) {
  if (!s) return '';
  var d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
function weekKey(iso) {   // ISO week of a yyyy-mm-dd date, e.g. 2026-W45
  var dt = new Date(Date.parse(iso)), day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  var y = dt.getUTCFullYear(), wn = Math.ceil(((dt.getTime() - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return y + '-W' + (wn < 10 ? '0' : '') + wn;
}

/* ---- links ---- */
function link(appUrl, kind, id) { return String(appUrl || '').replace(/\/+$/, '') + '/' + (kind === 'task' ? '?task=' : kind === 'run' ? '?run=' : '?project=') + encodeURIComponent(String(id)); }

/* ---- the weekly digest: the same words as the app's old in-browser digest (parity-tested) ---- */
function digestParts(S, appUrl, now) {
  var today = london(now || new Date()).iso, wk = addDays(today, 7);
  var projects = S.projects || [], tasks = S.tasks || [];
  var byId = {}; projects.forEach(function (p) { byId[p.id] = p; });
  var lines = ['*\uD83D\uDCCB ProjectFlow weekly digest*'], ids = {};   // ids: line number -> task, so a Done button can sit beside it
  var live = projects.filter(function (p) { return p.status !== 'completed' && p.startDate && p.endDate && p.startDate <= today && p.endDate >= today; });
  if (live.length) lines.push('*Happening now:* ' + live.map(function (p) { return esc(p.name); }).join(', '));
  (S.members || []).forEach(function (m) {
    var mine = tasks.filter(function (t) { return !t.done && (t.assignees || []).indexOf(m.id) >= 0 && byId[t.projectId]; });
    var od = mine.filter(function (t) { return t.endDate && t.endDate < today; });
    var wkT = mine.filter(function (t) { return t.endDate && t.endDate >= today && t.endDate <= wk; });
    var bl = mine.filter(function (t) { return t.kStatus === 'blocked'; });
    if (!od.length && !wkT.length && !bl.length) return;
    var bit = [], who = idOk(m.slackId) ? '<@' + m.slackId + '>' : '*' + esc(m.name) + '*';
    if (od.length) bit.push('\uD83D\uDD34 ' + od.length + ' overdue');
    if (wkT.length) bit.push('\uD83D\uDDD3 ' + wkT.length + ' due this week' + (wkT.length <= 3 ? ' (' + wkT.map(function (t) { return esc(t.name); }).join('; ') + ')' : ''));
    if (bl.length) bit.push('\uD83D\uDEAB ' + bl.length + ' blocked');
    lines.push(who + ': ' + bit.join(' \u00B7 '));
    od.sort(function (a, b) { return a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0; }).slice(0, OD_MAX).forEach(function (t) {
      var pr = byId[t.projectId], days = Math.round((Date.parse(today) - Date.parse(t.endDate)) / 864e5);
      lines.push('      \u2022 <' + link(appUrl, 'task', t.id) + '|' + esc(String(t.name || 'Task').slice(0, 80)) + '>' + (pr ? ' (' + esc(String(pr.name || '').slice(0, 40)) + ')' : '') + ' \u00B7 due ' + fmtD(t.endDate) + ', ' + days + ' day' + (days === 1 ? '' : 's') + ' late');
      ids[lines.length - 1] = t.id;
    });
    if (od.length > OD_MAX) lines.push('      \u2026 and ' + (od.length - OD_MAX) + ' more');
  });
  if (lines.length === 1) lines.push('Nothing overdue or due this week. \uD83C\uDF89');
  return { lines: lines, ids: ids };
}
function digestText(S, appUrl, now) { return digestParts(S, appUrl, now).lines.join('\n'); }

/* ---- the reminder to the team channel: who has something overdue or due in the next 2 days ---- */
var ALERT_DAYS = { 0: [], 1: [1], 2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5] };   // older "messages per week" setting: weekdays (Mon=1)
function num(v, lo, hi, dflt) { var n = parseInt(v, 10); return isNaN(n) || n < lo || n > hi ? dflt : n; }
/* every reminder option, read from the shared settings and clamped, so a bad value can never break the job */
function alertOpts(S) {
  var st = (S && S.settings) || {}, days;
  if (Array.isArray(st.alertDays)) days = st.alertDays.map(function (d) { return num(d, 0, 6, -1); }).filter(function (d) { return d >= 0; });   // 0 = Sunday ... 6 = Saturday
  else { var r = parseInt(st.alertRate, 10); days = !isNaN(r) && ALERT_DAYS[r] ? ALERT_DAYS[r] : ALERT_DAYS[3]; }   // chosen before release 220, or never chosen: 3 a week
  return { days: days, hour: num(st.alertHour, 0, 23, 9), soon: num(st.alertSoon, 0, 14, 2), overdue: st.alertOverdue !== false, blocked: st.alertBlocked === true, max: num(st.alertMax, 1, 30, 10) };
}
function alertParts(S, appUrl, now, only) {   // only: one person's own reminder (for a private message)
  var o = alertOpts(S), today = london(now || new Date()).iso, soon = addDays(today, o.soon), tasks = S.tasks || [], byId = {};
  (S.projects || []).forEach(function (p) { byId[p.id] = p; });
  var byDate = function (a, b) { return a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0; };
  var lines = [only ? '*\u23F0 Your ProjectFlow reminder*' : '*\u23F0 ProjectFlow reminder*'], ids = {};
  (S.members || []).forEach(function (m) {
    if (only && m.id !== only) return;
    var mine = tasks.filter(function (t) { return !t.done && (t.assignees || []).indexOf(m.id) >= 0 && byId[t.projectId]; });
    var od = o.overdue ? mine.filter(function (t) { return t.endDate && t.endDate < today; }).sort(byDate) : [];
    var sn = mine.filter(function (t) { return t.endDate && t.endDate >= today && t.endDate <= soon; }).sort(byDate);
    var bl = o.blocked ? mine.filter(function (t) { return t.kStatus === 'blocked' && od.indexOf(t) < 0 && sn.indexOf(t) < 0; }) : [];
    if (!od.length && !sn.length && !bl.length) return;
    var bit = [], who = idOk(m.slackId) ? '<@' + m.slackId + '>' : '*' + esc(m.name) + '*';
    if (od.length) bit.push('\uD83D\uDD34 ' + od.length + ' overdue');
    if (sn.length) bit.push('\u23F3 ' + sn.length + ' due ' + (o.soon === 0 ? 'today' : 'in the next ' + o.soon + ' day' + (o.soon === 1 ? '' : 's')));
    if (bl.length) bit.push('\uD83D\uDEAB ' + bl.length + ' blocked');
    lines.push((only ? '' : who + ': ') + bit.join(' \u00B7 '));
    od.slice(0, o.max).forEach(function (t) {
      var days = Math.round((Date.parse(today) - Date.parse(t.endDate)) / 864e5);
      lines.push('      \u2022 ' + taskRef(t, byId, appUrl) + ' \u00B7 due ' + fmtD(t.endDate) + ', ' + days + ' day' + (days === 1 ? '' : 's') + ' late');
      ids[lines.length - 1] = t.id;
    });
    if (od.length > o.max) lines.push('      \u2026 and ' + (od.length - o.max) + ' more overdue');
    sn.slice(0, o.max).forEach(function (t) {
      var d = Math.round((Date.parse(t.endDate) - Date.parse(today)) / 864e5);
      lines.push('      \u2022 ' + taskRef(t, byId, appUrl) + ' \u00B7 due ' + (d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days') + ' (' + fmtD(t.endDate) + ')');
      ids[lines.length - 1] = t.id;
    });
    if (sn.length > o.max) lines.push('      \u2026 and ' + (sn.length - o.max) + ' more due soon');
    bl.slice(0, o.max).forEach(function (t) { lines.push('      \u2022 ' + taskRef(t, byId, appUrl) + ' \u00B7 blocked'); ids[lines.length - 1] = t.id; });
    if (bl.length > o.max) lines.push('      \u2026 and ' + (bl.length - o.max) + ' more blocked');
  });
  return lines.length === 1 ? null : { lines: lines, ids: ids };   // nobody has anything: no message at all
}
function alertText(S, appUrl, now) { var a = alertParts(S, appUrl, now); return a ? a.lines.join('\n') : ''; }
function taskRef(t, byId, appUrl) {   // "<link|name> (project)", escaped for Slack
  var pr = byId[t.projectId];
  return '<' + link(appUrl, 'task', t.id) + '|' + esc(String(t.name || 'Task').slice(0, 80)) + '>' + (pr ? ' (' + esc(String(pr.name || '').slice(0, 40)) + ')' : '');
}

/* ---- a guest wrote a comment: one channel message with the comment text, @mentioning the people on the task ---- */
function guestCommentText(S, c, appUrl) {
  var task = null, pr = null, mem = {};
  (S.tasks || []).forEach(function (t) { if (t && t.id === c.task) task = t; });
  (S.projects || []).forEach(function (p) { if (p && task && p.id === task.projectId) pr = p; });
  (S.members || []).forEach(function (m) { if (m) mem[m.id] = m; });
  var who = esc(String(c.who || 'A guest').slice(0, 60));
  var head = '*\uD83D\uDCAC New comment from ' + who + '* (guest)';
  if (task) head += ' on <' + link(appUrl, 'task', task.id) + '|' + esc(String(task.name || 'Task').slice(0, 80)) + '>' + (pr ? ' (' + esc(String(pr.name || '').slice(0, 40)) + ')' : '');
  var text = esc(String(c.text || '').slice(0, 500)).replace(/\r?\n/g, '\n> ');
  var cc = [];
  if (task) (task.assignees || []).forEach(function (id) { var m = mem[id]; if (m && idOk(m.slackId) && cc.length < 5) cc.push('<@' + m.slackId + '>'); });
  return head + '\n> ' + text + (cc.length ? '\n' + cc.join(' ') : '');
}

/* ---- a guest suggested a task (release 269): one channel message naming the project, the title, the note and the date, @mentioning the project owner ---- */
function guestSuggestText(S, c, appUrl) {
  var pr = null, own = null;
  (S.projects || []).forEach(function (p) { if (p && p.id === c.project) pr = p; });
  (S.members || []).forEach(function (m) { if (m && pr && m.id === pr.ownerId) own = m; });
  var b = {}; try { b = JSON.parse(c.body || '{}') || {}; } catch (e) { b = {}; }
  var who = esc(String(c.who || 'A guest').slice(0, 60));
  var head = '*\uD83D\uDCA1 ' + who + ' (guest) suggested a task*';
  if (pr) head += ' for <' + link(appUrl, 'project', pr.id) + '|' + esc(String(pr.name || 'Project').slice(0, 60)) + '>';
  var lines = ['> *' + esc(String(b.t || 'Untitled').slice(0, 120)) + '*'];
  if (b.n) lines.push('> ' + esc(String(b.n).slice(0, 400)).replace(/\r?\n/g, '\n> '));
  if (/^\d{4}-\d\d-\d\d$/.test(String(b.d || ''))) lines.push('> Wanted by ' + String(b.d));
  var tail = 'Accept or decline it on the project page.';
  if (own && idOk(own.slackId)) tail = '<@' + own.slackId + '> ' + tail;
  return head + '\n' + lines.join('\n') + '\n' + tail;
}
/* ---- guest ticks that have waited over a day (release 269): the team app applies them, so the channel gets one note a day ---- */
function waitingText(n, appUrl) {
  var a = String(appUrl || '').replace(/\/+$/, '');
  return '*\u23F3 ' + n + ' guest tick' + (n === 1 ? ' has' : 's have') + ' waited over a day.* They are applied when someone on the team opens ' + (a ? '<' + a + '|Airwiggles HQ>' : 'Airwiggles HQ') + '.';
}

/* ---- Done buttons. The button carries only the task id; who may press it is decided on the server when it is pressed ---- */
var ID_OK = /^[\w-]{1,60}$/;
function doneButton(id) {
  if (!ID_OK.test(String(id))) return null;
  return { type: 'button', action_id: 'pf_done', style: 'primary', text: { type: 'plain_text', text: 'Done', emoji: true }, value: String(id) };
}
/* text lines + {line number: task id} -> Slack blocks: a Done button beside each task line. Slack allows 50 blocks and 3000 characters per
   text block, so past 48 blocks the rest goes into one last plain block without buttons. */
function linesToBlocks(lines, ids) {
  var out = [], buf = [], flush = function () { if (buf.length) { out.push({ type: 'section', text: { type: 'mrkdwn', text: buf.join('\n').slice(0, 2900) } }); buf = []; } };
  for (var i = 0; i < lines.length; i++) {
    var b = ids && ids[i] ? doneButton(ids[i]) : null;
    if (out.length >= 48) { buf.push(lines[i].replace(/^\s+/, '')); continue; }
    if (b) { flush(); out.push({ type: 'section', text: { type: 'mrkdwn', text: lines[i].replace(/^\s+/, '').slice(0, 2900) }, accessory: b }); }
    else buf.push(lines[i]);
    if (buf.join('\n').length > 2000) flush();
  }
  flush();
  return out.slice(0, 50);
}

/* ---- link previews: what Slack shows under a pasted ProjectFlow link (task, project or workflow run) ---- */
var KS = { 'todo': 'To do', 'in-progress': 'In progress', 'review': 'In progress', 'blocked': 'Blocked', 'done': 'Done' };
function dueLine(end, today, done) {
  if (!end) return '';
  var d = Math.round((Date.parse(end) - Date.parse(today)) / 864e5), t = '\uD83D\uDCC5 Due ' + fmtD(end);
  if (done || isNaN(d)) return t;
  return t + (d < 0 ? ' \u00B7 \uD83D\uDD34 ' + (-d) + ' day' + (d === -1 ? '' : 's') + ' late' : d === 0 ? ' \u00B7 today' : d === 1 ? ' \u00B7 tomorrow' : ' \u00B7 in ' + d + ' days');
}
function sec(text) { return { type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2900) } }; }
function unfurlTask(S, t, appUrl, buttons, now) {
  var today = london(now || new Date()).iso, tasks = S.tasks || [], pr = null, names = [];
  (S.projects || []).forEach(function (p) { if (p.id === t.projectId) pr = p; });
  var mem = {}; (S.members || []).forEach(function (m) { mem[m.id] = m.name; });
  (t.assignees || []).forEach(function (i) { if (mem[i] && names.length < 5) names.push(esc(String(mem[i]).slice(0, 40))); });
  var kids = tasks.filter(function (x) { return x.parentId === t.id; }), kd = kids.filter(function (x) { return x.done; }).length;
  var st = t.done ? 'Done' : (KS[t.kStatus] || 'To do');
  var l1 = '*<' + link(appUrl, 'task', t.id) + '|' + esc(String(t.name || 'Task').slice(0, 120)) + '>*';
  var l2 = [pr ? '\uD83D\uDCC1 ' + esc(String(pr.name || '').slice(0, 60)) : '', (t.done ? '\u2705 ' : '\u23F3 ') + st].filter(Boolean).join('  \u00B7  ');
  var lines = [l1, l2];
  if (names.length) lines.push('\uD83D\uDC65 ' + names.join(', '));
  var dl = dueLine(t.endDate, today, t.done); if (dl) lines.push(dl);
  if (kids.length) lines.push('\u2611\uFE0F ' + kd + ' of ' + kids.length + ' subtask' + (kids.length === 1 ? '' : 's') + ' done');
  var out = [sec(lines.join('\n'))];
  if (buttons && !t.done) { var b = doneButton(t.id); if (b) out.push({ type: 'actions', elements: [b] }); }
  return out;
}
function unfurlProject(S, pr, appUrl, now) {
  var today = london(now || new Date()).iso, ts = (S.tasks || []).filter(function (t) { return t.projectId === pr.id && !t.parentId; });
  var done = ts.filter(function (t) { return t.done; }).length, late = ts.filter(function (t) { return !t.done && t.endDate && t.endDate < today; });
  var by = {}, mem = {}; (S.members || []).forEach(function (m) { mem[m.id] = m.name; });
  late.forEach(function (t) { (t.assignees || []).forEach(function (i) { if (mem[i]) by[i] = (by[i] || 0) + 1; }); });
  var behind = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).slice(0, 3).map(function (i) { return esc(String(mem[i]).slice(0, 40)) + ' (' + by[i] + ')'; });
  var lines = ['*<' + link(appUrl, 'project', pr.id) + '|' + esc(String(pr.name || 'Project').slice(0, 120)) + '>*', '\uD83D\uDCC1 ' + (pr.status === 'completed' ? 'Completed' : pr.status === 'archived' ? 'Archived' : 'Active') + (pr.startDate && pr.endDate ? '  \u00B7  \uD83D\uDCC5 ' + fmtD(pr.startDate) + ' to ' + fmtD(pr.endDate) : '')];
  lines.push('\uD83D\uDCCA ' + done + ' of ' + ts.length + ' tasks done' + (ts.length ? ' (' + Math.round(100 * done / ts.length) + '%)' : ''));
  if (late.length) lines.push('\uD83D\uDD34 ' + late.length + ' overdue' + (behind.length ? '  \u00B7  most behind: ' + behind.join(', ') : ''));
  return [sec(lines.join('\n'))];
}
function unfurlRun(S, pb, run, appUrl, now) {
  var ts = (S.tasks || []).filter(function (t) { return t.pbRun && t.pbRun.run === run.id && !t.parentId; });
  var done = ts.filter(function (t) { return t.done; }).length, steps = {}, pr = null;
  (pb.steps || []).forEach(function (x) { if (x && typeof x === 'object' && x.id) steps[x.id] = x.name; });
  (S.projects || []).forEach(function (p) { if (p.id === run.projectId) pr = p; });
  var next = ts.filter(function (t) { return !t.done && steps[t.pbRun.step]; }).slice(0, 3).map(function (t) { return esc(String(steps[t.pbRun.step]).slice(0, 60)); });
  var lines = ['*<' + link(appUrl, 'run', run.id) + '|' + esc(String(run.name || pb.name || 'Workflow').slice(0, 120)) + '>*', '\uD83D\uDD01 Workflow: ' + esc(String(pb.name || '').slice(0, 80)) + (pr ? '  \u00B7  \uD83D\uDCC1 ' + esc(String(pr.name || '').slice(0, 60)) : '')];
  lines.push('\uD83D\uDCCA ' + done + ' of ' + ts.length + ' steps done' + (run.started ? '  \u00B7  started ' + fmtD(run.started) : ''));
  if (next.length) lines.push('\u27A1\uFE0F Next: ' + next.join(', '));
  else if (ts.length && done >= ts.length) lines.push('\u2705 All steps done');
  return [sec(lines.join('\n'))];
}
/* a pasted address -> preview blocks, or null. Only addresses on the app's own host with ?task= / ?project= / ?run= and an id that exists. */
function unfurlFor(S, url, appUrl, buttons, now) {
  var host = /^https:\/\/([^\/?#]+)/i.exec(String(appUrl || '')), m = /^https:\/\/([^\/?#]+)\/?(?:index\.html)?\?([^#]*)/i.exec(String(url || ''));
  if (!host || !m || m[1].toLowerCase() !== host[1].toLowerCase()) return null;
  var q = {}; m[2].split('&').slice(0, 8).forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) { try { var k = kv.slice(0, i); if (k === 'task' || k === 'project' || k === 'run') q[k] = decodeURIComponent(kv.slice(i + 1)); } catch (e) {} } });
  var i, x;
  if (q.task && ID_OK.test(q.task)) { x = (S.tasks || []).filter(function (t) { return t.id === q.task; })[0]; return x ? unfurlTask(S, x, appUrl, buttons, now) : null; }
  if (q.project && ID_OK.test(q.project)) { x = (S.projects || []).filter(function (p) { return p.id === q.project; })[0]; return x ? unfurlProject(S, x, appUrl, now) : null; }
  if (q.run && ID_OK.test(q.run)) {
    var pbs = S.playbooks || [];
    for (i = 0; i < pbs.length; i++) { var rs = Array.isArray(pbs[i].runs) ? pbs[i].runs : []; for (var j = 0; j < rs.length; j++) if (rs[j] && rs[j].id === q.run) return unfurlRun(S, pbs[i], rs[j], appUrl, now); }
  }
  return null;
}

/* ---- per-task messages (manual reminders, "due in 3 days", Monday "due this week") ---- */
function taskBlocks(S, t, label, appUrl, buttons) {
  var members = {}, projects = {};
  (S.members || []).forEach(function (m) { members[m.id] = m; });
  (S.projects || []).forEach(function (p) { projects[p.id] = p; });
  var names = (t.assignees || []).map(function (id) { return members[id] ? members[id].name : null; }).filter(Boolean);
  var owner = t.ownerId && members[t.ownerId] ? members[t.ownerId].name : null;
  var who = owner || (names.length ? names[0] : null), p = projects[t.projectId];
  var lines = ['*<' + link(appUrl, 'task', t.id) + '|' + esc(t.name) + '>*  --  ' + label];
  if (p) lines.push('\uD83D\uDCC1  Project: ' + esc(p.name));
  if (who) lines.push('\uD83D\uDC64  Owner: ' + esc(who));
  if (names.length) lines.push('\uD83D\uDC65  Assigned: ' + esc(names.join(', ')));
  if (t.endDate) lines.push('\uD83D\uDCC5  Due: ' + fmtD(t.endDate));
  if (t.slackReminder && t.slackReminder.message) lines.push('\uD83D\uDCDD  _' + esc(t.slackReminder.message) + '_');
  var sec = { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } };
  if (buttons && !t.done) { var b = doneButton(t.id); if (b) sec.accessory = b; }
  return [sec, { type: 'divider' }];
}

/* What is due to go out right now? Returns a list of {key, header, fallback, blocks|text}; the caller sends each and records the key
   in the sent-log only after Slack accepted it, so a failed send is retried five minutes later. */
function plan(S, sentLog, now, opts) {
  opts = opts || {};
  var appUrl = opts.appUrl, bt = !!opts.buttons, out = [], lt = london(now), tasks = S.tasks || [];
  // 1. manual per-task reminders (set from the bell on a task); dedupe key includes the chosen time so changing it sends again
  tasks.forEach(function (t) {
    var r = t.slackReminder;
    if (!r || !r.datetime) return;
    var at = new Date(r.datetime);
    if (isNaN(at.getTime()) || at > now) return;
    var key = 'manual_' + t.id + '_' + r.datetime;
    if (sentLog[key] || r.sent) return;   // r.sent: already sent by an older browser-based version
    if (opts.bellChan === false) out.push({ key: key, silent: true });   // the channel copy is switched off: only remember that it was due
    else out.push({ key: key, header: 'Reminder', fallback: 'Reminder: ' + t.name, blocks: taskBlocks(S, t, 'Reminder', appUrl, bt) });
  });
  // 2. Monday from 08:00 UK: the weekly digest (switch in Settings), once per week
  if (lt.dow === 1 && lt.hour >= 8 && S.settings && S.settings.digestAuto) {
    var dk = 'digest_' + weekKey(lt.iso);
    if (!sentLog[dk] && !(S.settings.digestLast === lt.iso)) { var dp = digestParts(S, appUrl, now); out.push({ key: dk, text: dp.lines.join('\n'), kind: 'digest', lines: bt ? dp.lines : null, ids: dp.ids }); }
  }
  // 2b. the team reminder: on the chosen days from the chosen hour (UK time) for 8 hours, once a day; on a Monday the weekly digest already covers it
  var ao = alertOpts(S);
  if (opts.alertChan !== false && ao.days.indexOf(lt.dow) >= 0 && lt.hour >= ao.hour && lt.hour < Math.min(24, ao.hour + 8) && !(lt.dow === 1 && S.settings && S.settings.digestAuto)) {
    var ak = 'alert_' + lt.iso;
    if (!sentLog[ak]) { var ap = alertParts(S, appUrl, now); if (ap) out.push({ key: ak, text: ap.lines.join('\n'), kind: 'alert', lines: bt ? ap.lines : null, ids: ap.ids }); }
  }
  // 3. Monday "due this week", per task (kept as it was)
  if (lt.dow === 1 && !(S.settings && S.settings.msgWeek === false)) {
    var wkk = weekKey(lt.iso);
    tasks.forEach(function (t) {
      if (t.done || !t.endDate) return;
      var d = Math.round((Date.parse(t.endDate) - lt.ms) / 864e5);
      if (d < 0 || d > 6) return;
      var key = 'week_' + t.id + '_' + wkk;
      if (!sentLog[key]) out.push({ key: key, header: 'Tasks Due This Week', fallback: 'Due this week: ' + t.name, blocks: taskBlocks(S, t, 'Due this week', appUrl, bt) });
    });
  }
  // 4. "due in 3 days"
  if (!(S.settings && S.settings.msg3day === false)) tasks.forEach(function (t) {
    if (t.done || !t.endDate) return;
    if (Math.round((Date.parse(t.endDate) - lt.ms) / 864e5) !== 3) return;
    var key = '3day_' + t.id + '_' + lt.iso;
    if (!sentLog[key]) out.push({ key: key, header: 'Due in 3 Days', fallback: 'Due in 3 days: ' + t.name, blocks: taskBlocks(S, t, 'Due in 3 days', appUrl, bt) });
  });
  return out;
}

/* Private messages (a bot token is needed). Returns {key, to, ...message} items: each person's own reminder on the chosen days, and the
   task reminders set with the bell, sent to the people assigned. */
function planDm(S, sentLog, now, opts) {
  var out = [], st = (S && S.settings) || {}, lt = london(now), appUrl = opts.appUrl, bt = !!opts.buttons, mem = S.members || [];
  var okm = function (m) { return m && ID_OK.test(String(m.id)) && idOk(m.slackId); };
  if (st.alertDm === true) {
    var ao = alertOpts(S);
    if (ao.days.indexOf(lt.dow) >= 0 && lt.hour >= ao.hour && lt.hour < Math.min(24, ao.hour + 8)) {
      mem.forEach(function (m) {
        if (!okm(m)) return;
        var key = 'dmalert_' + lt.iso + '_' + m.id;
        if (sentLog[key]) return;
        var a = alertParts(S, appUrl, now, m.id);
        if (a) out.push({ key: key, to: m.slackId, text: a.lines.join('\n'), lines: bt ? a.lines : null, ids: a.ids });
      });
    }
  }
  if (st.bellDm === true) {
    (S.tasks || []).forEach(function (t) {
      var r = t.slackReminder;
      if (!r || !r.datetime || t.done) return;
      var at = new Date(r.datetime);
      if (isNaN(at.getTime()) || at > now || now.getTime() - at.getTime() > 864e5) return;   // due, and not older than a day (a switch turned on later must not send old ones)
      (t.assignees || []).forEach(function (id) {
        var m = null; mem.forEach(function (x) { if (x.id === id) m = x; });
        if (!okm(m) || !ID_OK.test(String(t.id))) return;
        var key = 'dmmanual_' + t.id + '_' + r.datetime + '_' + m.id;
        if (!sentLog[key]) out.push({ key: key, to: m.slackId, header: 'Reminder', fallback: 'Reminder: ' + t.name, blocks: taskBlocks(S, t, 'Reminder', appUrl, bt) });
      });
    });
  }
  return out;
}
/* "You were assigned": a person-and-task pair seen for the first time. The first run only remembers what already exists, and pairs are
   remembered even while the switch is off, so turning it on later never sends a flood about old assignments. */
function planAssign(S, h, now, opts) {
  var st = (S && S.settings) || {}, items = [], on = st.assignDm === true && !!h.d.init, nowIso = now.toISOString(), cur = {}, mem = {};
  (S.members || []).forEach(function (m) { mem[m.id] = m; });
  (S.tasks || []).forEach(function (t) {
    if (!t || !ID_OK.test(String(t.id))) return;
    (t.assignees || []).forEach(function (id) {
      if (!ID_OK.test(String(id))) return;
      var k = t.id + ':' + id; cur[k] = 1;
      if (h.d.p[k]) return;
      var m = mem[id];
      if (on && !t.done && m && idOk(m.slackId)) items.push({ asg: true, key: k, to: m.slackId, header: 'Assigned to you', fallback: 'You were assigned: ' + t.name, blocks: taskBlocks(S, t, 'Assigned to you', opts.appUrl, !!opts.buttons) });
      else h.d.p[k] = nowIso;
    });
  });
  Object.keys(h.d.p).forEach(function (k) { if (!cur[k]) delete h.d.p[k]; });   // unassigned: assigning again later tells them again
  h.d.init = true;
  return items;
}

/* Slack message body for a plan item */
function payload(item) {
  if (item.text && item.lines) return { text: item.text.slice(0, 3000), blocks: linesToBlocks(item.lines, item.ids) };
  if (item.text) return { text: item.text };
  return { text: item.fallback, blocks: [{ type: 'header', text: { type: 'plain_text', text: item.header, emoji: true } }].concat(item.blocks) };
}

/* keep the sent-log from growing for ever: forget entries older than 60 days */
function trimLog(log, now) {
  var cut = now.getTime() - 60 * 864e5, n = 0;
  Object.keys(log).forEach(function (k) { var t = Date.parse(log[k]); if (!isNaN(t) && t < cut) { delete log[k]; n++; } });
  return n;
}

/* Settings the server reads from its environment. get = name => string. Nothing here is ever sent to the browser. */
function config(get, S) {
  var env = (get('PF_SLACK_WEBHOOK') || '').trim(), legacy = (S && S.slackWebhook) || '';
  var webhook = urlOk(env) ? env : (urlOk(legacy) ? legacy : '');
  var appUrl = (get('PF_APP_URL') || (S && S.settings && S.settings.appUrl) || '').trim().replace(/\/+$/, '');
  if (!appUrlOk(appUrl)) appUrl = 'https://airwiggleshq.com';
  return { webhook: webhook, source: urlOk(env) ? 'server' : (urlOk(legacy) ? 'workspace' : 'none'), appUrl: appUrl };
}


/* ---- release 340: making a task from Slack (the "Make a ProjectFlow task" message shortcut and the /task command) ----
   Pure helpers, unit-tested. Nothing here writes anything: the runtime queues the new task and the app adds it. */
var WDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function isoOk(d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return false; var t = new Date(d + 'T00:00:00Z'); return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; }
function plain(t, n) { return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function normName(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function liveProjects(S) { return (S.projects || []).filter(function (p) { return p && typeof p.id === 'string' && p.status !== 'completed' && p.status !== 'archived' && !p.light; }); }
function teamMembers(S) { return (S.members || []).filter(function (m) { return m && typeof m.id === 'string' && !m.isGuest; }); }
/* a project from "#AirCon27", "aircon 27" or a Slack channel name: exact (ignoring case and spaces) first, then one that starts with it */
function findProject(S, word) {
  var w = normName(word); if (w.length < 2) return null;
  var L = liveProjects(S), ex = L.filter(function (p) { return normName(p.name) === w; });
  if (ex.length) return ex[0];
  var pre = L.filter(function (p) { return normName(p.name).indexOf(w) === 0; });
  return pre.length === 1 ? pre[0] : null;
}
/* a due date from one or two words, on UK time: today, tomorrow, a weekday (the next one), next week (Monday),
   25/12, 25/12/2026, 2026-12-25, 25 dec, dec 25 */
function parseDue(words, now) {
  var L = london(now), today = L.iso, w = String(words || '').toLowerCase().replace(/[.,]$/, '');
  if (w === 'today') return today;
  if (w === 'tomorrow' || w === 'tmrw' || w === 'tmw') return addDays(today, 1);
  if (w === 'next week') return addDays(today, ((8 - L.dow) % 7) || 7);
  var wd = WDAYS.indexOf(w.slice(0, 3));
  if (wd >= 0 && /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|rsday|urday)?$/.test(w)) return addDays(today, ((wd - L.dow + 7) % 7) || 7);
  var m, y = parseInt(today.slice(0, 4), 10), pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var mk = function (yy, mm, dd, guessYear) { var d = yy + '-' + pad(mm) + '-' + pad(dd); if (!isoOk(d)) return ''; if (guessYear && d < today) d = (yy + 1) + d.slice(4); return isoOk(d) ? d : ''; };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w))) return mk(+m[1], +m[2], +m[3], false);
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(w))) return mk(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : y, +m[2], +m[1], !m[3]);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*$/.exec(w)) && MON3.indexOf(m[2]) >= 0) return mk(y, MON3.indexOf(m[2]) + 1, +m[1], true);
  if ((m = /^([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?$/.exec(w)) && MON3.indexOf(m[1]) >= 0) return mk(y, MON3.indexOf(m[1]) + 1, +m[2], true);
  return '';
}
/* "/task Book the mic list @Ann friday #AirCon27" -> name, assignees, due date, project. Slack sends people as <@U123|ann> and
   channels as <#C123|aircon27> when "Escape channels, users, and links" is ticked; plain @Ann and #AirCon27 work too. */
function parseTaskText(S, text, me, now) {
  var out = { name: '', projectId: '', assignees: [], due: '', misses: [] }, rest = [];
  var toks = String(text || '').slice(0, 1000).replace(/[\u0000-\u001f]/g, ' ').match(/<[^>]{1,120}>|\S+/g) || [];
  var mem = teamMembers(S), addWho = function (m) { if (m && out.assignees.indexOf(m.id) < 0 && out.assignees.length < 5) out.assignees.push(m.id); };
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i], m;
    if ((m = /^<@([UW][A-Z0-9]{6,20})(?:\|[^>]*)?>$/.exec(t))) { var who = mem.filter(function (x) { return x.slackId === m[1]; })[0]; if (who) addWho(who); else out.misses.push('someone mentioned is not linked to a ProjectFlow person'); continue; }
    if ((m = /^@([A-Za-z][\w.'-]{0,40})$/.exec(t))) {
      var n = m[1].toLowerCase(), hit = mem.filter(function (x) { var nm = String(x.name || '').toLowerCase(); return nm === n || nm.split(/\s+/)[0] === n; });
      if (hit.length === 1) { addWho(hit[0]); continue; }
      out.misses.push('@' + m[1].slice(0, 30) + (hit.length ? ' matches more than one person' : ' is not a ProjectFlow person')); continue;
    }
    if ((m = /^<#[CG][A-Z0-9]{6,20}\|([^>]{1,80})>$/.exec(t)) || (m = /^#([^\s#]{2,60})$/.exec(t))) {
      var pr = findProject(S, m[1]); if (pr && !out.projectId) { out.projectId = pr.id; continue; }
      if (!pr) { out.misses.push('#' + plain(m[1], 30) + ' does not match a project'); continue; }
    }
    var two = i + 1 < toks.length ? parseDue(t + ' ' + toks[i + 1], now) : '';
    if (two && !out.due) { out.due = two; i++; continue; }
    var one = parseDue(t, now);
    if (one && !out.due) { out.due = one; continue; }
    rest.push(t.replace(/^<(https?:[^|>]+)\|([^>]+)>$/, '$2 ($1)').replace(/^<(https?:[^>]+)>$/, '$1'));
  }
  out.name = plain(rest.join(' '), 150);
  if (!out.assignees.length && me) out.assignees.push(me.id);
  return out;
}
/* the Slack window for a new task (message shortcut, or /task on its own) */
function taskModal(S, me, name, meta) {
  var opt = function (id, txt) { return { text: { type: 'plain_text', text: plain(txt, 75) || 'Untitled', emoji: true }, value: id }; };
  var projs = liveProjects(S).slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }).slice(0, 100).map(function (p) { return opt(p.id, p.name); });
  var mems = teamMembers(S).slice(0, 100).map(function (m) { return opt(m.id, m.name); });
  var mine = me ? mems.filter(function (o) { return o.value === me.id; }) : [];
  var blocks = [
    { type: 'input', block_id: 'b_name', label: { type: 'plain_text', text: 'Task' }, element: { type: 'plain_text_input', action_id: 'a', max_length: 150, initial_value: plain(name, 150) } },
    { type: 'input', block_id: 'b_proj', optional: true, label: { type: 'plain_text', text: 'Project' }, element: projs.length ? { type: 'static_select', action_id: 'a', placeholder: { type: 'plain_text', text: 'No project' }, options: projs } : { type: 'plain_text_input', action_id: 'a', placeholder: { type: 'plain_text', text: 'No projects yet' } } },
    { type: 'input', block_id: 'b_who', optional: true, label: { type: 'plain_text', text: 'For' }, element: Object.assign({ type: 'multi_static_select', action_id: 'a', max_selected_items: 5, placeholder: { type: 'plain_text', text: 'Nobody yet' }, options: mems.length ? mems : [opt('none', 'Nobody')] }, mine.length ? { initial_options: mine } : {}) },
    { type: 'input', block_id: 'b_due', optional: true, label: { type: 'plain_text', text: 'Due' }, element: { type: 'datepicker', action_id: 'a' } },
    { type: 'input', block_id: 'b_note', optional: true, label: { type: 'plain_text', text: 'Notes' }, element: { type: 'plain_text_input', action_id: 'a', multiline: true, max_length: 1000 } }
  ];
  if (!blocks[1].element.initial_value) delete blocks[1].element.initial_value;
  if (!blocks[0].element.initial_value) delete blocks[0].element.initial_value;
  return { type: 'modal', callback_id: 'pf_task_new', title: { type: 'plain_text', text: 'New ProjectFlow task' }, submit: { type: 'plain_text', text: 'Add task' }, close: { type: 'plain_text', text: 'Cancel' }, private_metadata: String(meta || '').slice(0, 2900), blocks: blocks };
}
/* a link back to the Slack message a task was made from */
function msgLink(channel, ts) { return /^[CGD][A-Z0-9]{6,20}$/.test(String(channel)) && /^\d{9,12}\.\d{1,8}$/.test(String(ts)) ? 'https://slack.com/archives/' + channel + '/p' + String(ts).replace('.', '') : ''; }
/* turn <@U123|ann>, <#C1|chan> and <https://x|text> in a Slack message into plain words for a task name */
function slackPlain(t, S) {
  var mem = teamMembers(S || {});
  return String(t || '').replace(/<@([UW][A-Z0-9]{6,20})(?:\|([^>]*))?>/g, function (x, id, lab) { var m = mem.filter(function (y) { return y.slackId === id; })[0]; return '@' + (m ? m.name : (lab || 'someone')); })
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1').replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2').replace(/<(https?:[^>]+)>/g, '$1').replace(/<!([a-z]+)[^>]*>/g, '@$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/* ---- the part that talks to PocketBase and Slack. g = {app, http, os, Record}: the PocketBase globals, passed in so tests can fake them ---- */
function runtime(g) {
  var db = typeof g.app.dao === 'function' ? g.app.dao() : g.app;   // 0.22 keeps these on $app.dao(), 0.23+ on $app
  function find(ws) { try { return db.findFirstRecordByFilter('workspace_state', 'workspace = "' + ws + '"'); } catch (e) { return null; } }
  function state() {
    var rec = find('airwiggles'); if (!rec) return null;
    try { return JSON.parse(rec.getString('data') || '{}'); } catch (e) { return null; }
  }
  function logRec() {   // the server's own record: the app never reads or writes it
    var rec = find('airwiggles-sr-sent'), log = {};
    if (rec) { try { log = JSON.parse(rec.getString('data') || '{}'); } catch (e) { log = {}; } }
    return { rec: rec, log: log };
  }
  function saveLog(h) {
    if (!h.rec) { h.rec = new g.Record(db.findCollectionByNameOrId('workspace_state')); h.rec.set('workspace', 'airwiggles-sr-sent'); }
    h.rec.set('data', JSON.stringify(h.log));
    if (typeof g.app.save === 'function') g.app.save(h.rec); else db.saveRecord(h.rec);
  }
  function deliver(webhook, body) {
    try {
      var r = g.http.send({ url: webhook, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 10 });
      return { ok: r.statusCode === 200, status: r.statusCode };
    } catch (e) { return { ok: false, status: 0, error: String(e).replace(/https?:\/\/\S*/gi, '[address]').slice(0, 120) }; /* Go errors quote the address (it holds the Slack secret): never keep it */ }
  }
  function botToken() { var t = (g.os.getenv('PF_SLACK_BOT_TOKEN') || '').trim(); return /^xox[bp]-[\w-]{10,200}$/.test(t) ? t : ''; }
  function slackApi(token, method, body) {   // Slack answers 200 even for errors; the reason is in the body. Only the error name is ever kept.
    try {
      var r = g.http.send({ url: 'https://slack.com/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), timeout: 8 });
      var j = {}; try { j = r.json || JSON.parse(String(r.raw || '{}')); } catch (e) {}
      if (r.statusCode === 200 && j && j.ok === true) return { ok: true };
      return { ok: false, error: String((j && j.error) || ('status ' + r.statusCode)).replace(/[^\w .:-]/g, '').slice(0, 60) };
    } catch (e) { return { ok: false, error: 'request failed' }; }
  }
  function asgRec() {
    var rec = find('airwiggles-sr-assigned'), d = {};
    if (rec) { try { d = JSON.parse(rec.getString('data') || '{}'); } catch (e) { d = {}; } }
    if (!d || typeof d !== 'object' || Array.isArray(d)) d = {};
    if (!d.p || typeof d.p !== 'object' || Array.isArray(d.p)) d.p = {};
    return { rec: rec, d: d };
  }
  function saveAsg(h) {
    if (!h.rec) { h.rec = new g.Record(db.findCollectionByNameOrId('workspace_state')); h.rec.set('workspace', 'airwiggles-sr-assigned'); }
    h.rec.set('data', JSON.stringify(h.d));
    if (typeof g.app.save === 'function') g.app.save(h.rec); else db.saveRecord(h.rec);
  }
  function hasSecret() { return !!(g.os.getenv('PF_SLACK_SIGNING_SECRET') || ''); }
  function conf(S) { return config(function (k) { return g.os.getenv(k) || ''; }, S || {}); }
  /* ---- Slack ticks waiting for the app. The server never edits tasks itself: it queues "done by X" in its own record and the app
     completes the task with its own code. All queue changes run inside a database transaction so two requests cannot overwrite each other. ---- */
  var QWS = 'airwiggles-sr-done', ID_OK = /^[\w-]{1,60}$/;
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
        if (typeof g.app.runInTransaction === 'function') g.app.runInTransaction(body); else g.app.dao().runInTransaction(body);
        return out;
      } catch (e) { last = e; }
    }
    throw last;
  }
  function qLoad(find, now) {
    var rec = find(QWS), q = {};
    if (rec) { try { q = JSON.parse(rec.getString('data') || '{}'); } catch (e) { q = {}; } }
    if (!q || !Array.isArray(q.items)) q = { items: [] };
    var cut = now.getTime() - 60 * 864e5;   // anything nobody applied for 60 days is dropped (14 until release 269)
    q.items = q.items.filter(function (x) { return x && ID_OK.test(String(x.id)) && ID_OK.test(String(x.taskId)) && Date.parse(x.at) > cut; });
    return { rec: rec, q: q };
  }
  function qSave(h, save, t) {
    if (!h.rec) { h.rec = new g.Record(t.findCollectionByNameOrId('workspace_state')); h.rec.set('workspace', QWS); }
    h.rec.set('data', JSON.stringify(h.q));
    save(h.rec);
  }
  /* a person ticked a task in Slack: add it once */
  function queueAdd(entry, now) {
    now = now || new Date();
    if (!entry || !ID_OK.test(String(entry.taskId)) || !ID_OK.test(String(entry.memberId))) return { added: false, why: 'bad id' };
    var kind = entry.kind === 'undo' ? 'undo' : 'done';   // "done": tick it. "undo": a tick made in Slack was taken back, reopen it
    return qtx(function (find, save, t) {
      var h = qLoad(find, now);
      for (var i = 0; i < h.q.items.length; i++) if (h.q.items[i].taskId === entry.taskId && (h.q.items[i].kind || 'done') === kind) return { added: false, why: 'already queued' };
      h.q.items.push({ id: 'q' + now.getTime().toString(36) + Math.floor(Math.random() * 1679616).toString(36), kind: kind, taskId: entry.taskId, memberId: entry.memberId, slackId: idOk(entry.slackId) ? entry.slackId : '', at: now.toISOString() });
      qSave(h, save, t);
      return { added: true };
    });
  }
  /* release 340: a task made in Slack. It waits here, with an id chosen now, until an open ProjectFlow window adds it (the
     same id every time, so a second window or a retry can never add it twice). At most 200 waiting. */
  function queueTask(e, now) {
    now = now || new Date();
    if (!e || !ID_OK.test(String(e.memberId))) return { added: false, why: 'bad id' };
    var name = plain(e.name, 150); if (!name) return { added: false, why: 'no name' };
    var item = { id: 'q' + now.getTime().toString(36) + Math.floor(Math.random() * 1679616).toString(36), kind: 'add', taskId: 'sk' + now.getTime().toString(36) + Math.floor(Math.random() * 1679616).toString(36),
      memberId: e.memberId, slackId: idOk(e.slackId) ? e.slackId : '', at: now.toISOString(), name: name,
      projectId: ID_OK.test(String(e.projectId || '')) ? e.projectId : '', due: isoOk(e.due) ? e.due : '',
      assignees: (Array.isArray(e.assignees) ? e.assignees : []).filter(function (a) { return ID_OK.test(String(a)); }).slice(0, 5),
      note: String(e.note || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 1000), src: /^https:\/\/slack\.com\/archives\/[A-Z0-9]+\/p\d+$/.test(String(e.src || '')) ? e.src : '' };
    return qtx(function (find, save, t) {
      var h = qLoad(find, now);
      if (h.q.items.filter(function (x) { return x.kind === 'add'; }).length >= 200) return { added: false, why: 'full' };
      h.q.items.push(item);
      qSave(h, save, t);
      return { added: true, taskId: item.taskId };
    });
  }
  /* the app takes what is waiting. Each item is handed to one window at a time (a two minute lease), so two open windows never complete the same task twice. */
  function queueClaim(now, withAdds) {
    now = now || new Date();
    return qtx(function (find, save, t) {
      var h = qLoad(find, now), out = [];
      h.q.items.forEach(function (x) {
        if (out.length >= 20) return;
        if (x.kind === 'add' && !withAdds) return;   // a window from before release 340 would not know what to do with it: it waits for a newer one
        var c = Date.parse(x.claimedAt || '');
        if (!isNaN(c) && now.getTime() - c < 120000) return;
        x.claimedAt = now.toISOString();
        if (x.kind === 'add') { out.push({ id: x.id, kind: 'add', taskId: x.taskId, memberId: x.memberId, slackId: x.slackId || '', at: x.at, name: x.name, projectId: x.projectId || '', assignees: x.assignees || [], due: x.due || '', note: x.note || '', src: x.src || '' }); x.claimedAt = now.toISOString(); return; }
        out.push({ id: x.id, kind: x.kind === 'undo' ? 'undo' : x.kind === 'status' ? 'status' : 'done', status: x.kind === 'status' && (x.status === 'in-progress' || x.status === 'todo') ? x.status : '', taskId: x.taskId, memberId: x.memberId, slackId: x.slackId, at: x.at, via: x.via === 'guest' ? 'guest' : '', who: typeof x.who === 'string' ? x.who.slice(0, 60) : '' });
      });
      if (out.length) qSave(h, save, t);
      return out;
    });
  }
  /* the app finished with these */
  function queueAck(ids, now) {
    now = now || new Date();
    var set = {};
    (Array.isArray(ids) ? ids : []).slice(0, 50).forEach(function (i) { if (ID_OK.test(String(i))) set[i] = true; });
    if (!Object.keys(set).length) return { removed: 0 };
    return qtx(function (find, save, t) {
      var h = qLoad(find, now), before = h.q.items.length;
      h.q.items = h.q.items.filter(function (x) { return !set[x.id]; });
      if (h.q.items.length !== before) qSave(h, save, t);
      return { removed: before - h.q.items.length };
    });
  }
  function queuePending(now, kind) {   // task ids with a tick (or, kind "undo", an undo) waiting: reminders treat them as already changed
    var rec = find(QWS), out = {};
    if (!rec) return out;
    try { var q = JSON.parse(rec.getString('data') || '{}'); (q.items || []).forEach(function (x) { if (x && x.kind !== 'add' && ID_OK.test(String(x.taskId)) && (x.kind === 'undo' ? 'undo' : x.kind === 'status' ? 'status' : 'done') === (kind || 'done')) out[x.taskId] = true; }); } catch (e) {}
    return out;
  }
  /* Undo pressed while the tick still waits: take it out of the queue so the app never ticks it. If a window already took it, say so (an undo is queued instead). */
  function queueCancel(taskId, now) {
    now = now || new Date();
    if (!ID_OK.test(String(taskId))) return { cancelled: false };
    return qtx(function (find, save, t) {
      var h = qLoad(find, now), hit = false, keep = [];
      h.q.items.forEach(function (x) {
        var c = Date.parse(x.claimedAt || '');
        if (x.taskId === taskId && (x.kind || 'done') === 'done' && (isNaN(c) || now.getTime() - c >= 120000)) hit = true; else keep.push(x);
      });
      if (hit) { h.q.items = keep; qSave(h, save, t); }
      return { cancelled: hit };
    });
  }
  /* the five-minute job */
  function tick(now) {
    now = now || new Date();
    var S = state(); if (!S) return { sent: 0, why: 'no workspace' };
    var c = conf(S), tok = botToken(), st = S.settings || {};
    var dmOn = !!tok && (st.alertDm === true || st.bellDm === true), ag = tok ? asgRec() : null, agBefore = ag ? JSON.stringify(ag.d) : '';   // without a bot token there is nothing to remember yet: the first run with one only learns what already exists
    if (!c.webhook && !tok) return { sent: 0, why: 'no webhook' };
    var pend = queuePending(now), und = queuePending(now, 'undo');
    if (Object.keys(pend).length || Object.keys(und).length) S.tasks = (S.tasks || []).map(function (t) { return und[t.id] ? Object.assign({}, t, { done: false }) : pend[t.id] ? Object.assign({}, t, { done: true }) : t; });
    var h = logRec(), sent = 0, dirty = false, bt = hasSecret();
    var items = c.webhook ? plan(S, h.log, now, { appUrl: c.appUrl, buttons: bt, alertChan: st.alertChan !== false, bellChan: st.bellChan !== false }) : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].silent) { h.log[items[i].key] = now.toISOString(); dirty = true; continue; }
      var r = deliver(c.webhook, payload(items[i]));
      if (r.ok) { h.log[items[i].key] = now.toISOString(); h.log._lastOk = now.toISOString(); delete h.log._lastErr; sent++; dirty = true; }
      else { h.log._lastErr = now.toISOString() + ' status ' + r.status + (r.error ? ' ' + r.error : ''); dirty = true; break; }   // stop; the next run retries
    }
    // private messages (at most 15 per run; one that fails is tried again after an hour)
    var dmSent = 0;
    if (tok) {
      var dm = dmOn ? planDm(S, h.log, now, { appUrl: c.appUrl, buttons: bt }) : [];
      var as = planAssign(S, ag, now, { appUrl: c.appUrl, buttons: bt }), all = dm.concat(as);
      for (var d = 0; d < all.length && dmSent < 15; d++) {
        var it = all[d], fk = '_f_' + it.key, ft = Date.parse(h.log[fk] || '');
        if (!isNaN(ft) && now.getTime() - ft < 3600e3) continue;
        var dr = slackApi(tok, 'chat.postMessage', Object.assign({ channel: it.to }, payload(it)));
        if (dr.ok) { if (it.asg) ag.d.p[it.key] = now.toISOString(); else h.log[it.key] = now.toISOString(); delete h.log[fk]; dmSent++; dirty = true; }
        else { h.log[fk] = now.toISOString(); h.log._dmErr = now.toISOString() + ' ' + dr.error; dirty = true; }
      }
      if (JSON.stringify(ag.d) !== agBefore) { try { saveAsg(ag); } catch (e) { return { sent: sent + dmSent, why: 'assignment memory save failed: ' + e }; } }
    }
    if (trimLog(h.log, now)) dirty = true;
    if (dirty) { try { saveLog(h); } catch (e) { return { sent: sent + dmSent, why: 'log save failed: ' + e }; } }
    return { sent: sent + dmSent };
  }
  /* guest comments -> the channel. Runs every minute. The first run only learns "now" so old comments are never posted; a comment is
     marked as sent only after Slack accepted it. Off when Settings > Slack has the switch cleared (guestCommentChan === false). */
  function commentTick(now) {
    now = now || new Date();
    var S = state(); if (!S) return { sent: 0, why: 'no workspace' };
    var c = conf(S); if (!c.webhook) return { sent: 0, why: 'no webhook' };
    /* its own small record, so this minute-by-minute job never rewrites the sent-log the five-minute reminders use.
       m = the newest comment already handled, w = the London date of the last "ticks are waiting" note */
    var rec = find('airwiggles-sr-cm'), mark = '', wday = '';
    if (rec) { try { var o = JSON.parse(rec.getString('data') || '{}') || {}; mark = String(o.m || ''); wday = String(o.w || ''); } catch (e) { mark = ''; } }
    function put(m, w) {
      if (!rec) { rec = new g.Record(db.findCollectionByNameOrId('workspace_state')); rec.set('workspace', 'airwiggles-sr-cm'); }
      rec.set('data', JSON.stringify(w ? { m: m, w: w } : { m: m }));
      if (typeof g.app.save === 'function') g.app.save(rec); else db.saveRecord(rec);
    }
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(mark)) { try { put(now.toISOString().replace('T', ' '), wday); } catch (e) {} return { sent: 0, why: 'learned the start time' }; }
    var on = !(S.settings && S.settings.guestCommentChan === false), sent = 0, last = '';
    var recs = [];
    try { recs = db.findRecordsByFilter('pf_comments', '(kind = "guest" || kind = "suggest") && created > {:t}', 'created', 10, 0, { t: mark }); } catch (e) { recs = []; }   // no comments collection yet
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i], at = String(r.getString('created') || '');
      if (on) {
        var txt = r.getString('kind') === 'suggest'
          ? guestSuggestText(S, { project: r.getString('project'), who: r.getString('author'), body: r.getString('body') }, c.appUrl)
          : guestCommentText(S, { task: r.getString('task'), who: r.getString('author'), text: r.getString('body') }, c.appUrl);
        var d = deliver(c.webhook, { text: txt });
        if (!d.ok) break;   // the next run tries again
        sent++;
      }
      last = at;
    }
    /* once a day, from 9am London: guest ticks older than a day that the team app has not applied yet */
    var lo = london(now), w2 = wday;
    if (on && wday !== lo.iso && lo.hour >= 9) {
      var waiting = 0, cut = now.getTime() - 864e5;
      try {
        var qr = find(QWS), q = qr ? JSON.parse(qr.getString('data') || '{}') : {};
        (Array.isArray(q && q.items) ? q.items : []).forEach(function (x) { if (x && x.via === 'guest' && (x.kind || 'done') === 'done' && Date.parse(x.at) < cut) waiting++; });
      } catch (e) { waiting = 0; }
      if (waiting) { var dw = deliver(c.webhook, { text: waitingText(waiting, c.appUrl) }); if (dw.ok) { sent++; w2 = lo.iso; } }   // one small record read a minute until a note goes out that day
    }
    if (last || w2 !== wday) { try { put(last || mark, w2); } catch (e) { return { sent: sent, why: 'marker save failed: ' + e }; } }
    return { sent: sent };
  }
  /* what the Settings screen shows: never the webhook itself */
  function status() {
    var S = state() || {}, c = conf(S), h = logRec(), manual = {};
    Object.keys(h.log).forEach(function (k) { var m = /^manual_(.+?)_(\d{4}-.*)$/.exec(k); if (m) manual[m[1]] = m[2]; });   // which task reminders went out (so the reminder window can say so)
    return { manualSent: manual, configured: !!c.webhook, source: c.source, appUrl: c.appUrl, lastOk: h.log._lastOk || '', lastErr: h.log._lastErr || '', digestAuto: !!(S.settings && S.settings.digestAuto), buttons: hasSecret(), dms: !!botToken(), dmErr: h.log._dmErr || '', unfurls: hasSecret() && /^xox[bp]-/.test((g.os.getenv('PF_SLACK_BOT_TOKEN') || '').trim()) };
  }
  /* buttons in Settings: kind is "test", "digest" or "alert", nothing else */
  function sendNow(kind, now, to) {
    now = now || new Date();
    if (kind === 'dmtest') {   // a private test message to one linked team member
      var S0 = state() || {}, tk = botToken();
      if (!tk) return { code: 409, ok: false, error: 'Private messages are not set up on the server yet (PF_SLACK_BOT_TOKEN)' };
      var ok0 = idOk(to) && (S0.members || []).some(function (m) { return m && m.slackId === to; });
      if (!ok0) return { code: 400, ok: false, error: 'That Slack ID is not saved for anyone in Team' };
      var h0 = logRec(), l0 = Date.parse(h0.log._ui || '');
      if (!isNaN(l0) && now.getTime() - l0 < 10000) return { code: 429, ok: false, error: 'Please wait a few seconds' };
      var r0 = slackApi(tk, 'chat.postMessage', { channel: to, text: '\u2713 ProjectFlow test: private messages from Airwiggles HQ work.' });
      h0.log._ui = now.toISOString(); if (!r0.ok) h0.log._dmErr = now.toISOString() + ' ' + r0.error;
      try { saveLog(h0); } catch (e) {}
      return { code: r0.ok ? 200 : 502, ok: r0.ok, error: r0.ok ? '' : 'Slack said: ' + r0.error + (r0.error === 'missing_scope' ? ' (add the chat:write and im:write permissions to the Slack app and reinstall it)' : '') };
    }
    if (kind !== 'test' && kind !== 'digest' && kind !== 'alert') return { code: 400, ok: false, error: 'unknown kind' };
    var S = state() || {}, c = conf(S);
    if (!c.webhook) return { code: 409, ok: false, error: 'Slack is not set up on the server yet' };
    var h = logRec(), last = Date.parse(h.log._ui || '');
    if (!isNaN(last) && now.getTime() - last < 10000) return { code: 429, ok: false, error: 'Please wait a few seconds' };
    var body, pt = null;
    if (kind === 'test') body = { text: '\u2713 ProjectFlow test message from Airwiggles HQ (sent by the server)' };
    else {
      pt = kind === 'alert' ? alertParts(S, c.appUrl, now) : digestParts(S, c.appUrl, now);
      if (!pt) body = { text: '*\u23F0 ProjectFlow reminder*\nNothing needs attention right now. \uD83C\uDF89' };
      else body = payload({ text: pt.lines.join('\n'), lines: hasSecret() ? pt.lines : null, ids: pt.ids });
    }
    var r = deliver(c.webhook, body);
    h.log._ui = now.toISOString();
    if (r.ok) { h.log._lastOk = now.toISOString(); delete h.log._lastErr; } else h.log._lastErr = now.toISOString() + ' status ' + r.status;
    try { saveLog(h); } catch (e) {}
    return { code: r.ok ? 200 : 502, ok: r.ok, error: r.ok ? '' : 'Slack did not accept the message (status ' + r.status + ')' };
  }
  /* ---- a button was pressed in Slack. Slack calls this with a signed request; nothing is trusted until the signature checks out ---- */
  function slackReply(url, body) {   // only ever to Slack's own reply address
    if (!/^https:\/\/hooks\.slack\.com\/actions\/[A-Za-z0-9\/_-]{1,200}$/.test(String(url))) return;
    try { g.http.send({ url: url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 5 }); } catch (e) {}
  }
  function verify(raw, ts, sig, now, secret) {   // null when the request really comes from Slack
    if (typeof raw !== 'string' || raw.length > 262144) return { code: 413 };
    ts = String(ts || ''); sig = String(sig || '');
    if (!/^\d{1,12}$/.test(ts) || Math.abs(now.getTime() / 1000 - parseInt(ts, 10)) > 300) return { code: 401 };   // too old: a copied request cannot be replayed
    var want = 'v0=' + g.security.hs256('v0:' + ts + ':' + raw, secret);
    return g.security.equal(want, sig) ? null : { code: 401 };
  }
  /* Slack tells us a ProjectFlow link was pasted (event "link_shared"): answer with a preview. Same signature check as the buttons. */
  function events(raw, ts, sig, retry, now) {
    now = now || new Date();
    var secret = g.os.getenv('PF_SLACK_SIGNING_SECRET') || '';
    if (!secret) return { code: 503 };
    var bad = verify(raw, ts, sig, now, secret); if (bad) return bad;
    var b; try { b = JSON.parse(raw); } catch (e) { return { code: 400 }; }
    if (b && b.type === 'url_verification' && typeof b.challenge === 'string' && b.challenge.length < 200) return { code: 200, challenge: b.challenge };
    if (retry) return { code: 200 };   // Slack repeats a request it thinks was slow: the first one already did the work
    var ev = b && b.type === 'event_callback' ? b.event : null, token = (g.os.getenv('PF_SLACK_BOT_TOKEN') || '').trim();
    if (!ev || ev.type !== 'link_shared' || !Array.isArray(ev.links) || !/^xox[bp]-[\w-]{10,200}$/.test(token)) return { code: 200 };
    var S = state(); if (!S) return { code: 200 };
    var c = conf(S), un = {}, n = 0;
    ev.links.slice(0, 10).forEach(function (l) {
      var u = l && typeof l.url === 'string' && l.url.length < 500 ? l.url : '', bl = u ? unfurlFor(S, u, c.appUrl, hasSecret(), now) : null;
      if (bl) { un[u] = { blocks: bl }; n++; }
    });
    if (!n) return { code: 200 };
    var body = { unfurls: un };
    if (typeof ev.unfurl_id === 'string' && /^[\w.-]{1,100}$/.test(ev.unfurl_id) && (ev.source === 'conversations_history' || ev.source === 'composer')) { body.unfurl_id = ev.unfurl_id; body.source = ev.source; }
    else if (typeof ev.channel === 'string' && /^[A-Z0-9]{5,20}$/.test(ev.channel) && typeof ev.message_ts === 'string' && /^\d{9,12}\.\d{1,8}$/.test(ev.message_ts)) { body.channel = ev.channel; body.ts = ev.message_ts; }
    else return { code: 200 };
    try {
      var r = g.http.send({ url: 'https://slack.com/api/chat.unfurl', method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), timeout: 5 });
      var j = {}; try { j = r.json || JSON.parse(String(r.raw || '{}')); } catch (e) {}
      return { code: 200, unfurled: n, error: j && j.ok === false ? String(j.error || 'failed').slice(0, 60) : '' };
    } catch (e) { return { code: 200, error: 'request failed' }; }
  }
  /* ---- release 340: tasks from Slack ---- */
  function form(raw) { var o = {}; String(raw).split('&').slice(0, 40).forEach(function (kv) { var i = kv.indexOf('='); if (i < 1) return; try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) {} }); return o; }
  function memberFor(S, slackId) { return idOk(slackId) ? teamMembers(S).filter(function (x) { return x.slackId === slackId; })[0] || null : null; }
  var NOT_LINKED = 'Your Slack account is not linked to a ProjectFlow person yet. Ask an admin to add your Slack member ID in Team.';
  var WAIT_NOTE = 'It shows up in ProjectFlow as soon as someone on the team has it open.';
  function doneText(S, it, appUrl) {
    var pr = (S.projects || []).filter(function (p) { return p && p.id === it.projectId; })[0], names = it.assignees.map(function (id) { var m = (S.members || []).filter(function (x) { return x && x.id === id; })[0]; return m ? esc(plain(m.name, 40)) : ''; }).filter(Boolean);
    return '\u2705 Added *<' + link(appUrl, 'task', it.taskId) + '|' + esc(it.name) + '>*' + (names.length ? ' for ' + names.join(', ') : '') + (it.due ? ', due ' + fmtD(it.due) : '') + (pr ? ', in ' + esc(plain(pr.name, 60)) : ', with no project') + '. ' + WAIT_NOTE;
  }
  function slashTask(raw, now) {
    var f = form(raw), say = function (t) { return { code: 200, body: { response_type: 'ephemeral', text: String(t).slice(0, 2900) } }; };
    var S = state(); if (!S) return say('ProjectFlow could not be reached just now. Please try again in a minute.');
    var me = memberFor(S, f.user_id); if (!me) return say(NOT_LINKED);
    var text = String(f.text || '').trim();
    if (!text || /^(new|form)$/i.test(text)) { var w = openTaskWindow({ trigger_id: f.trigger_id, user: { id: f.user_id } }, now, ''); return w.error ? say(w.error) : { code: 200 }; }
    if (/^(help|\?)$/i.test(text)) return say('*Make a ProjectFlow task*\n`/task Book the mic list @Ann friday #AirCon27`\n\u2022 *@name*: who it is for (yourself if nobody is named)\n\u2022 *#project*: the project, by name\n\u2022 a due date: today, tomorrow, friday, next week, 25/12 or 25 dec\n`/task` on its own opens a form. You can also use *Make a ProjectFlow task* in any message\'s \u22ef menu.');
    var x = parseTaskText(S, text, me, now);
    if (!x.name) return say('What is the task? For example: `/task Book the mic list @Ann friday #AirCon27`');
    var r; try { r = queueTask({ memberId: me.id, slackId: f.user_id, name: x.name, projectId: x.projectId, assignees: x.assignees, due: x.due, note: '' }, now); } catch (e) { return say('Could not save that just now. Please try again.'); }
    if (!r.added) return say(r.why === 'full' ? 'Too many tasks are waiting for ProjectFlow to be opened. Open it once, then try again.' : 'Could not save that just now. Please try again.');
    var it = { taskId: r.taskId, name: x.name, projectId: x.projectId, assignees: x.assignees, due: x.due };
    return say(doneText(S, it, conf(S).appUrl) + (x.misses.length ? '\n_Not used: ' + esc(x.misses.slice(0, 3).join('; ')) + '._' : ''));
  }
  function openTaskWindow(p, now, nameIn) {
    var S = state(), tok = botToken(), uid = p && p.user ? p.user.id : '';
    var fail = function (t) { if (p.response_url) slackReply(p.response_url, { response_type: 'ephemeral', replace_original: false, text: t }); return { code: 200, error: t }; };
    if (!S) return fail('ProjectFlow could not be reached just now. Please try again in a minute.');
    var me = memberFor(S, uid); if (!me) return fail(NOT_LINKED);
    if (!tok) return fail('The ProjectFlow Slack app needs its bot token on the server for this. Use `/task` with the task written out instead.');
    if (!/^[\w.-]{5,200}$/.test(String(p.trigger_id || ''))) return { code: 200 };
    var msg = p.message || {}, src = msgLink(p.channel && p.channel.id, msg.ts);
    var name = nameIn != null && nameIn !== '' ? nameIn : slackPlain(msg.text, S);
    var r = slackApi(tok, 'views.open', { trigger_id: p.trigger_id, view: taskModal(S, me, name, JSON.stringify({ s: src })) });
    return r.ok ? { code: 200 } : fail('Slack would not open the form (' + r.error + '). Use `/task` with the task written out instead.');
  }
  function submitTask(p, now) {
    var S = state(), uid = p.user ? p.user.id : '', v = (p.view && p.view.state && p.view.state.values) || {};
    var errs = function (o) { return { code: 200, body: { response_action: 'errors', errors: o } }; };
    if (!S) return errs({ b_name: 'ProjectFlow could not be reached just now. Please try again in a minute.' });
    var me = memberFor(S, uid); if (!me) return errs({ b_name: NOT_LINKED });
    var val = function (b) { var x = v[b] && v[b].a; return x || {}; };
    var name = plain(val('b_name').value, 150); if (!name) return errs({ b_name: 'Give the task a name.' });
    var pid = (val('b_proj').selected_option || {}).value || '', proj = (S.projects || []).filter(function (x) { return x && x.id === pid; })[0];
    var ids = (val('b_who').selected_options || []).map(function (o) { return o && o.value; }), team = teamMembers(S);
    var who = team.filter(function (m) { return ids.indexOf(m.id) >= 0; }).map(function (m) { return m.id; }).slice(0, 5);
    var due = val('b_due').selected_date || ''; if (due && !isoOk(due)) return errs({ b_due: 'That date is not valid.' });
    var meta = {}; try { meta = JSON.parse(String(p.view.private_metadata || '{}')) || {}; } catch (e) { meta = {}; }
    var r; try { r = queueTask({ memberId: me.id, slackId: uid, name: name, projectId: proj ? proj.id : '', assignees: who, due: due, note: val('b_note').value || '', src: meta.s || '' }, now); } catch (e) { return errs({ b_name: 'Could not save that just now. Please press Add task again.' }); }
    if (!r.added) return errs({ b_name: r.why === 'full' ? 'Too many tasks are waiting for ProjectFlow to be opened. Open it once, then try again.' : 'Could not save that just now.' });
    var it = { taskId: r.taskId, name: name, projectId: proj ? proj.id : '', assignees: who, due: due };
    return { code: 200, body: { response_action: 'update', view: { type: 'modal', title: { type: 'plain_text', text: 'Task added' }, close: { type: 'plain_text', text: 'Done' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: doneText(S, it, conf(S).appUrl).slice(0, 2900) } }] } } };
  }
  function interact(raw, ts, sig, now) {
    now = now || new Date();
    var secret = g.os.getenv('PF_SLACK_SIGNING_SECRET') || '';
    if (!secret) return { code: 503 };
    var bad = verify(raw, ts, sig, now, secret); if (bad) return bad;
    if (/(?:^|&)command=/.test(raw) && !/(?:^|&)payload=/.test(raw)) return slashTask(raw, now);   // the /task command (release 340) posts plain form fields
    var m = /(?:^|&)payload=([^&]*)/.exec(raw), p;
    try { p = JSON.parse(decodeURIComponent(m[1].replace(/\+/g, ' '))); } catch (e) { return { code: 400 }; }
    if (p && (p.type === 'message_action' || p.type === 'shortcut') && (p.callback_id === 'pf_task_msg' || p.callback_id === 'pf_task_new')) return openTaskWindow(p, now);
    if (p && p.type === 'view_submission' && p.view && p.view.callback_id === 'pf_task_new') return submitTask(p, now);
    var a = p && p.type === 'block_actions' && Array.isArray(p.actions) ? p.actions[0] : null;
    var undo = !!a && a.action_id === 'pf_undo';
    if (!a || (a.action_id !== 'pf_done' && !undo) || !ID_OK.test(String(a.value)) || !p.user || !idOk(p.user.id)) return { code: 200 };   // not ours: ignore quietly
    var say = function (t) { slackReply(p.response_url, { response_type: 'ephemeral', replace_original: false, text: t }); return { code: 200 }; };
    var S = state(); if (!S) return say('ProjectFlow could not be reached just now. Please try again in a minute.');
    var task = null, me = null, byId = {};
    (S.tasks || []).forEach(function (t) { byId[t.id] = t; if (t.id === a.value) task = t; });
    (S.members || []).forEach(function (x) { if (!me && x.slackId === p.user.id) me = x; });
    if (!me) return say('Your Slack account is not linked to a ProjectFlow person yet. Ask an admin to add your Slack member ID in Team.');
    if (!task) return say('That task no longer exists.');
    var pend = queuePending(now), und = queuePending(now, 'undo');
    var mayTick = (task.assignees || []).indexOf(me.id) >= 0 || !!me.isDirector;
    if (undo) {   // take a tick back: cancel it if it still waits, otherwise queue a reopen for the app
      if (!mayTick) return say('Only the people assigned to this task, or admins, can undo this.');
      try {
        if (pend[task.id]) { if (!queueCancel(task.id, now).cancelled) queueAdd({ kind: 'undo', taskId: task.id, memberId: me.id, slackId: p.user.id }, now); }
        else if (task.done && !und[task.id]) queueAdd({ kind: 'undo', taskId: task.id, memberId: me.id, slackId: p.user.id }, now);
      } catch (e) { return say('Could not save that just now. Please press Undo again.'); }
      var back = p.message && Array.isArray(p.message.blocks) ? p.message.blocks.slice(0, 50).map(function (b) {   // same message with the Done button back
        if (b && b.type === 'section' && b.accessory && b.accessory.action_id === 'pf_undo' && b.accessory.value === task.id && b.text && typeof b.text.text === 'string')
          return { type: 'section', text: { type: 'mrkdwn', text: b.text.text.replace(/\n\u2705 done by <@[A-Z0-9]+>$/, '') }, accessory: doneButton(task.id) };
        return b;
      }) : null;
      if (back) slackReply(p.response_url, { replace_original: true, text: String((p.message && p.message.text) || 'ProjectFlow').slice(0, 3000), blocks: back });
      else say('Undone. ProjectFlow will update the next time someone has it open.');
      return { code: 200 };
    }
    if (task.done && !pend[task.id] && !und[task.id]) return say('That task is already done.');
    if (!pend[task.id]) {
      if (!mayTick) return say('Only the people assigned to this task, or admins, can tick it off.');
      if ((task.blockedBy || []).some(function (b) { return byId[b] && !byId[b].done; })) return say('That task is waiting on another task that is not finished yet.');
      var r; try { r = queueAdd({ taskId: task.id, memberId: me.id, slackId: p.user.id }, now); } catch (e) { return say('Could not save that just now. Please press Done again.'); }
      if (!r.added && r.why !== 'already queued') return say('Could not save that just now.');
    }
    var hit = false, blocks = p.message && Array.isArray(p.message.blocks) ? p.message.blocks.slice(0, 50).map(function (b) {   // same message, this task marked
      if (b && b.type === 'section' && b.accessory && b.accessory.action_id === 'pf_done' && b.accessory.value === task.id && b.text && typeof b.text.text === 'string' && (hit = true))
        return { type: 'section', text: { type: 'mrkdwn', text: (b.text.text + '\n\u2705 done by <@' + p.user.id + '>').slice(0, 2950) }, accessory: { type: 'button', action_id: 'pf_undo', text: { type: 'plain_text', text: 'Undo', emoji: true }, value: task.id } };
      return b;
    }) : null;
    if (blocks && hit) slackReply(p.response_url, { replace_original: true, text: String((p.message && p.message.text) || 'ProjectFlow').slice(0, 3000), blocks: blocks });
    else {   // a Done button that is not in one of our own messages (a link preview): a private note with an Undo button
      slackReply(p.response_url, { response_type: 'ephemeral', replace_original: false, text: 'Ticked off: ' + String(task.name || 'Task').slice(0, 80), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*<' + link(conf(S).appUrl, 'task', task.id) + '|' + esc(String(task.name || 'Task').slice(0, 120)) + '>*\n\u2705 done by <@' + p.user.id + '>' }, accessory: { type: 'button', action_id: 'pf_undo', text: { type: 'plain_text', text: 'Undo', emoji: true }, value: task.id } }] });
    }
    return { code: 200 };
  }
  return { commentTick: commentTick, events: events, interact: interact, queueTask: queueTask, tick: tick, status: status, sendNow: sendNow, state: state, queueAdd: queueAdd, queueCancel: queueCancel, queueClaim: queueClaim, queueAck: queueAck, queuePending: queuePending };
}
module.exports = { parseTaskText: parseTaskText, parseDue: parseDue, taskModal: taskModal, slackPlain: slackPlain, msgLink: msgLink, guestCommentText: guestCommentText, guestSuggestText: guestSuggestText, waitingText: waitingText, unfurlFor: unfurlFor, digestParts: digestParts, alertParts: alertParts, linesToBlocks: linesToBlocks, doneButton: doneButton, runtime: runtime,  esc: esc, idOk: idOk, urlOk: urlOk, appUrlOk: appUrlOk, london: london, weekKey: weekKey, fmtD: fmtD, link: link, digestText: digestText, alertText: alertText, alertOpts: alertOpts, ALERT_DAYS: ALERT_DAYS, taskBlocks: taskBlocks, plan: plan, payload: payload, trimLog: trimLog, config: config, OD_MAX: OD_MAX };
