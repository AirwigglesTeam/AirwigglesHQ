/// <reference path="../pb_data/types.d.ts" />
/*
 ProjectFlow guest access (runs on the server)
 ---------------------------------------------
 * On start it makes sure a separate `guests` collection exists. Guests sign in with a one-time code sent by email and
   can never read the workspace record: they only get what the endpoints below hand back.
 * Team endpoints (team accounts with full page access only): POST /api/pf/guest/grant, POST /api/pf/guest/revoke, GET /api/pf/guest/list
 * Guest endpoints (a signed-in guest only): GET /api/pf/guest/me, GET /api/pf/guest/project?id=<project> (the tasks of one shared project),
   POST /api/pf/guest/tick (tick a task, or take back a tick that still waits: the tick is queued and the team app applies it),
   POST /api/pf/guest/status (ask to start, or un-start, a task assigned to them: queued like a tick and applied by the team app),
   POST /api/pf/guest/comment (write a comment on a task of a shared project; the project answer carries the comments)
 * Team endpoints for groups (full access only): GET /api/pf/guest/groups, POST group-save, group-delete, grant-group (share one project with every member of a saved group)
 * Team endpoints for comments: GET /api/pf/guest/feed (newest guest comments, for the bell), GET /api/pf/guest/comments?task=<task>, POST /api/pf/guest/comment-team, POST /api/pf/guest/comment-handled (mark a guest comment Handled), POST /api/pf/guest/comment-del (full access only)
 * Emails (release 254): every five minutes a job emails guests what is new (tasks assigned to them, team replies, tasks due tomorrow, a daily
   update summary after 08:00 UK time), through the mail settings PocketBase already uses for sign-in codes. POST /api/pf/guest/mail-pref (a guest) switches
   their own emails on or off; POST /api/pf/guest/mail-admin (the team) switches one guest or all guest emails. The first run only records what exists, so nothing old is sent. Set PF_GUEST_MAIL=off in the server's environment to stop the job.
 * Needs pf_guest_lib.js in the same folder and PocketBase 0.23 or newer. On older versions this file does nothing.
 * If this file or the library fails, nothing else in ProjectFlow is affected.
*/
if (typeof onBootstrap === "function") {
  onBootstrap((e) => {
    e.next();   // the database is ready after this
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).ensureCollection();
      if (r === "created") console.log("[pf-guest] guests collection created");
    } catch (err) { console.log("[pf-guest] error: " + err); }
  });

  // PocketBase handlers cannot see variables outside their own function, so each one carries what it needs (like the Slack hook).
  routerAdd("POST", "/api/pf/guest/grant", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).grant(e.auth.id, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "grant failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/revoke", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).revoke(body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "revoke failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/list", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let pid = "";
      try { pid = String(e.request.url.query().get("project") || ""); } catch (x) {}
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).list(pid));
    } catch (err) { return e.json(500, { ok: false, error: "list failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/me", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).me(e.auth, new Date()));
    } catch (err) { return e.json(500, { ok: false, error: "me failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("POST", "/api/pf/guest/status", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).setStatus(e.auth, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "status failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("POST", "/api/pf/guest/mail-pref", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).mailPref(e.auth, body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "mail-pref failed" }); }
  }, $apis.requireAuth("guests"));

  // Every five minutes: email guests what is new. Quiet when there is nothing. PF_GUEST_MAIL=off stops it.
  // Whatever it does (or why it does nothing) is noted for the status line in Settings > Guests.
  cronAdd("pf-guest-mail", "*/5 * * * *", () => {
    let rt = null, L = null;
    try {
      L = require(`${__hooks}/pf_guest_lib.js`);
      rt = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField });
      if (String($os.getenv("PF_GUEST_MAIL") || "").toLowerCase() === "off") { rt.mailNote(Date.now(), { why: "switched off (PF_GUEST_MAIL=off)" }); return; }
      const meta = $app.settings().meta;
      const from = { address: String(meta.senderAddress || ""), name: String(meta.senderName || "ProjectFlow") };
      if (!from.address) { rt.mailNote(Date.now(), { why: "no sender address in the PocketBase mail settings" }); return; }
      let url = String($os.getenv("PF_APP_URL") || meta.appURL || "");
      if (!/^https:\/\//.test(url)) url = "";
      const send = (m) => {
        const msg = new MailerMessage({ from: from, to: [{ address: m.to, name: m.name || "" }], subject: m.subject, html: m.html, text: m.text });
        $app.newMailClient().send(msg);
        return true;
      };
      const r = rt.mailTick(new Date(), send, url);
      rt.mailNote(Date.now(), { sent: r.sent, why: r.why });
      if (r.sent) console.log("[pf-guest] emails sent: " + r.sent);
      else if (r.why && r.why !== "no data" && r.why !== "busy") console.log("[pf-guest] " + r.why);
    } catch (err) {
      console.log("[pf-guest] mail error: " + err);
      try { if (rt) rt.mailNote(Date.now(), { err: String(err && err.message ? err.message : err) }); } catch (x) {}
    }
  });

  // Team accounts with full access: how the email job is doing, and a test mail to your own address.
  routerAdd("POST", "/api/pf/guest/mail-admin", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).mailAdmin(body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "switch failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/mail-status", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      const meta = $app.settings().meta;
      let url = String($os.getenv("PF_APP_URL") || meta.appURL || "");
      if (!/^https:\/\//.test(url)) url = "";
      const ctx = { enabled: String($os.getenv("PF_GUEST_MAIL") || "").toLowerCase() !== "off", sender: String(meta.senderAddress || ""), url: url };
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).mailStatus(new Date(), ctx));
    } catch (err) { return e.json(500, { ok: false, error: "status failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/mail-test", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      const meta = $app.settings().meta;
      const from = { address: String(meta.senderAddress || ""), name: String(meta.senderName || "ProjectFlow") };
      if (!from.address) return e.json(200, { ok: false, error: "There is no sender address in the PocketBase mail settings (Settings > Mail settings)." });
      const send = (m) => {
        const msg = new MailerMessage({ from: from, to: [{ address: m.to, name: m.name || "" }], subject: m.subject, html: m.html, text: m.text });
        $app.newMailClient().send(msg);
        return true;
      };
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).mailTest(e.auth, send, Date.now());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "test failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/project", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let pid = "";
      try { pid = String(e.request.url.query().get("id") || ""); } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).project(e.auth, pid);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "project failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("POST", "/api/pf/guest/tick", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).tick(e.auth, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "tick failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("POST", "/api/pf/guest/comment", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).guestComment(e.auth, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "comment failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("GET", "/api/pf/guest/comments", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let tid = "";
      try { tid = String(e.request.url.query().get("task") || ""); } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).teamComments(tid);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "comments failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/feed", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).feed());
    } catch (err) { return e.json(500, { ok: false, error: "feed failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/comment-team", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).teamComment(e.auth, body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "comment failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/suggest", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).guestSuggest(e.auth, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "suggest failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("GET", "/api/pf/guest/suggestions", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let v = "";
      try { v = String(e.request.url.query().get("project") || ""); } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).teamSuggestions(v);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "suggestions failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/suggestion-decide", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).suggestionDecide(e.auth, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "decide failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/comment-handled", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).commentHandled(e.auth, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "handled failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/groups", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).groupList());
    } catch (err) { return e.json(500, { ok: false, error: "groups failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/group-save", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).groupSave(body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "group failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/group-delete", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).groupDelete(body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "group failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/grant-group", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).grantGroup(e.auth.id, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "grant failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/comment-del", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).commentDelete(body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "delete failed" }); }
  }, $apis.requireAuth("users"));
}
