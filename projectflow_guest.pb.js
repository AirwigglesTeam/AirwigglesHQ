/// <reference path="../pb_data/types.d.ts" />
/*
 ProjectFlow guest access (runs on the server)
 ---------------------------------------------
 * On start it makes sure a separate `guests` collection exists. Guests sign in with a one-time code sent by email and
   can never read the workspace record: they only get what the endpoints below hand back.
 * Team endpoints (team accounts with full page access only): POST /api/pf/guest/grant, POST /api/pf/guest/revoke, GET /api/pf/guest/list
 * Guest endpoints (a signed-in guest only): GET /api/pf/guest/me, GET /api/pf/guest/project?id=<project> (the tasks of one shared project),
   POST /api/pf/guest/tick (tick a task, or take back a tick that still waits: the tick is queued and the team app applies it),
   POST /api/pf/guest/comment (write a comment on a task of a shared project; the project answer carries the comments)
 * Team endpoints for groups (full access only): GET /api/pf/guest/groups, POST group-save, group-delete, grant-group (share one project with every member of a saved group)
 * Team endpoints for comments: GET /api/pf/guest/feed (newest guest comments, for the bell), GET /api/pf/guest/comments?task=<task>, POST /api/pf/guest/comment-team, POST /api/pf/guest/comment-handled (mark a guest comment Handled), POST /api/pf/guest/comment-del (full access only)
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
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security, TextField: TextField }).me(e.auth));
    } catch (err) { return e.json(500, { ok: false, error: "me failed" }); }
  }, $apis.requireAuth("guests"));

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
