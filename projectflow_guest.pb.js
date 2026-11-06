/// <reference path="../pb_data/types.d.ts" />
/*
 ProjectFlow guest access (runs on the server)
 ---------------------------------------------
 * On start it makes sure a separate `guests` collection exists. Guests sign in with a one-time code sent by email and
   can never read the workspace record: they only get what the endpoints below hand back.
 * Team endpoints (team accounts with full page access only): POST /api/pf/guest/grant, POST /api/pf/guest/revoke, GET /api/pf/guest/list
 * Guest endpoints (a signed-in guest only): GET /api/pf/guest/me, GET /api/pf/guest/project?id=<project> (the tasks of one shared project)
 * Needs pf_guest_lib.js in the same folder and PocketBase 0.23 or newer. On older versions this file does nothing.
 * If this file or the library fails, nothing else in ProjectFlow is affected.
*/
if (typeof onBootstrap === "function") {
  onBootstrap((e) => {
    e.next();   // the database is ready after this
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security }).ensureCollection();
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
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security }).grant(e.auth.id, body, new Date());
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "grant failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("POST", "/api/pf/guest/revoke", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let body = {};
      try { body = e.requestInfo().body || {}; } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security }).revoke(body);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "revoke failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/list", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      if (!L.canShare(e.auth.getString("permissions"))) return e.json(403, { ok: false, error: "not allowed" });
      let pid = "";
      try { pid = String(e.request.url.query().get("project") || ""); } catch (x) {}
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security }).list(pid));
    } catch (err) { return e.json(500, { ok: false, error: "list failed" }); }
  }, $apis.requireAuth("users"));

  routerAdd("GET", "/api/pf/guest/me", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      return e.json(200, L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security }).me(e.auth));
    } catch (err) { return e.json(500, { ok: false, error: "me failed" }); }
  }, $apis.requireAuth("guests"));

  routerAdd("GET", "/api/pf/guest/project", (e) => {
    try {
      const L = require(`${__hooks}/pf_guest_lib.js`);
      let pid = "";
      try { pid = String(e.request.url.query().get("id") || ""); } catch (x) {}
      const r = L.runtime({ app: $app, Record: Record, Collection: Collection, security: $security }).project(e.auth, pid);
      return e.json(r.code, r.body);
    } catch (err) { return e.json(500, { ok: false, error: "project failed" }); }
  }, $apis.requireAuth("guests"));
}
