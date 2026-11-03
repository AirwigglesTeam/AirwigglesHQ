/// <reference path="../pb_data/types.d.ts" />
/*
 ProjectFlow Slack (runs on the server, replaces slack_reminders.pb.js)
 ---------------------------------------------------------------------
 * Every five minutes: sends task reminders, "due in 3 days" and the Monday weekly digest to Slack.
 * Small endpoints for the Settings screen (signed-in users only): status, send, and the tick queue the app collects.
 * POST /api/pf/slack/interact (Done buttons) and POST /api/pf/slack/events (link previews) are for Slack itself; each is only accepted with a valid Slack signature.
 * The Slack webhook lives in the server's environment (PF_SLACK_WEBHOOK), never in the browser. See SLACK_SERVER.md.
 * Needs pf_slack_lib.js in the same folder. Works on PocketBase 0.22 and 0.23 and newer.
 * If this file or the library fails, nothing else in ProjectFlow is affected.
*/
cronAdd("pf-slack", "*/5 * * * *", () => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    const r = L.runtime({ app: $app, http: $http, os: $os, Record: Record }).tick(new Date());
    if (r.sent) console.log("[pf-slack] sent " + r.sent);
    else if (r.why && r.why !== "no webhook") console.log("[pf-slack] " + r.why);
  } catch (err) { console.log("[pf-slack] error: " + err); }
});

const _pfAuth = () => (typeof $apis.requireAuth === "function" ? $apis.requireAuth() : $apis.requireAdminOrRecordAuth());

routerAdd("GET", "/api/pf/slack/status", (e) => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    return e.json(200, L.runtime({ app: $app, http: $http, os: $os, Record: Record }).status());
  } catch (err) { return e.json(500, { ok: false, error: "status failed" }); }
}, _pfAuth());

routerAdd("POST", "/api/pf/slack/send", (e) => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    let kind = "";
    try { const b = typeof e.requestInfo === "function" ? e.requestInfo().body : $apis.requestInfo(e).data; kind = String((b || {}).kind || ""); } catch (x) {}
    const r = L.runtime({ app: $app, http: $http, os: $os, Record: Record }).sendNow(kind, new Date());
    return e.json(r.code, { ok: r.ok, error: r.error });
  } catch (err) { return e.json(500, { ok: false, error: "send failed" }); }
}, _pfAuth());

// The app collects ticks made in Slack (claim = take what is waiting, ack = finished with these).
routerAdd("POST", "/api/pf/slack/done/claim", (e) => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    return e.json(200, { items: L.runtime({ app: $app, http: $http, os: $os, Record: Record }).queueClaim(new Date()) });
  } catch (err) { return e.json(500, { items: [] }); }
}, _pfAuth());

routerAdd("POST", "/api/pf/slack/done/ack", (e) => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    let ids = [];
    try { const b = typeof e.requestInfo === "function" ? e.requestInfo().body : $apis.requestInfo(e).data; ids = (b || {}).ids || []; } catch (x) {}
    return e.json(200, L.runtime({ app: $app, http: $http, os: $os, Record: Record }).queueAck(ids, new Date()));
  } catch (err) { return e.json(500, { removed: 0 }); }
}, _pfAuth());

// Slack calls this when someone presses Done on a message. It is open to the internet on purpose: every request is checked
// against Slack's signature (PF_SLACK_SIGNING_SECRET) and rejected otherwise. Needs "Interactivity" switched on in the Slack app.
routerAdd("POST", "/api/pf/slack/interact", (e) => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    const req = typeof e.request === "function" ? e.request() : e.request;
    let raw = "";
    try { raw = typeof readerToString === "function" ? readerToString(req.body, 262144) : toString(req.body); } catch (x) { raw = ""; }
    const r = L.runtime({ app: $app, http: $http, os: $os, Record: Record, security: $security })
      .interact(raw, req.header.get("X-Slack-Request-Timestamp"), req.header.get("X-Slack-Signature"), new Date());
    return e.json(r.code, {});
  } catch (err) { return e.json(500, {}); }
});

// Slack calls this when someone pastes a ProjectFlow link (event "link_shared"); the answer is a small preview under the link.
// Open to the internet on purpose, and checked against Slack's signature like the buttons. Needs PF_SLACK_BOT_TOKEN (links:write).
routerAdd("POST", "/api/pf/slack/events", (e) => {
  try {
    const L = require(`${__hooks}/pf_slack_lib.js`);
    const req = typeof e.request === "function" ? e.request() : e.request;
    let raw = "";
    try { raw = typeof readerToString === "function" ? readerToString(req.body, 262144) : toString(req.body); } catch (x) { raw = ""; }
    const r = L.runtime({ app: $app, http: $http, os: $os, Record: Record, security: $security })
      .events(raw, req.header.get("X-Slack-Request-Timestamp"), req.header.get("X-Slack-Signature"), req.header.get("X-Slack-Retry-Num"), new Date());
    if (r.error) console.log("[pf-slack] link preview: " + r.error);
    return e.json(r.code, r.challenge ? { challenge: r.challenge } : {});
  } catch (err) { return e.json(500, {}); }
});
