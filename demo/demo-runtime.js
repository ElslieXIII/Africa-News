/*
 * Africa News — demo runtime
 *
 * In the real app, the page runs inside Claude and gets three things from
 * window.claude.use(...):
 *   - "db"  : a small shared database (sources, articles, newsletters, saved, ...)
 *   - "mcp" : connectors (Gmail → get_thread for the newsletter reader,
 *             Claude Code Remote → fire_trigger for the Refresh button)
 *
 * This file provides stand-ins for both so the page runs as a plain static
 * site (e.g. GitHub Pages):
 *   - the database is in memory, seeded from data/sample-data.json and saved
 *     to localStorage so your saves, folders and ideas survive a reload
 *   - "Gmail" returns the sample newsletter bodies from the same JSON
 *   - "Refresh" simulates a run: it marks the feed as refreshing, then adds
 *     one sample article after a few seconds
 *
 * Sample dates are stored as "daysAgo" / "hoursAgo" and turned into real
 * timestamps on first load, so the 14-day window always has content.
 * Add ?reset to the URL to clear local changes and reload the sample data.
 */
(function () {
  "use strict";

  var STORE_KEY = "africa-news-demo:v1";
  var DATA_URL = "data/sample-data.json";
  var listeners = []; // { path, cb, opts }
  var state = null;   // { collections: { name: { id: doc } } }
  var ready = null;

  // ---------- helpers ----------
  var clone = function (x) { return x == null ? x : JSON.parse(JSON.stringify(x)); };
  function isoFromOffset(v) {
    var ms = 0;
    if (typeof v.daysAgo === "number") ms += v.daysAgo * 864e5;
    if (typeof v.hoursAgo === "number") ms += v.hoursAgo * 36e5;
    return new Date(Date.now() - ms).toISOString();
  }
  // Replace {"daysAgo":n,"hoursAgo":m} objects with ISO strings, recursively.
  function resolveDates(x) {
    if (Array.isArray(x)) return x.map(resolveDates);
    if (x && typeof x === "object") {
      var keys = Object.keys(x);
      if (keys.length && keys.every(function (k) { return k === "daysAgo" || k === "hoursAgo"; })) return isoFromOffset(x);
      var out = {};
      keys.forEach(function (k) { out[k] = resolveDates(x[k]); });
      return out;
    }
    return x;
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode: keep in memory */ }
  }
  function load() {
    if (ready) return ready;
    ready = (async function () {
      var reset = /[?&]reset\b/.test(location.search);
      if (!reset) {
        try {
          var saved = localStorage.getItem(STORE_KEY);
          if (saved) { state = JSON.parse(saved); return; }
        } catch (e) { /* ignore */ }
      }
      var res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load " + DATA_URL);
      var raw = await res.json();
      state = { collections: resolveDates(raw.collections || {}), emails: raw.emails || {}, refreshQueue: resolveDates(raw.refreshQueue || []) };
      persist();
      if (reset) history.replaceState(null, "", location.pathname + location.hash);
    })();
    return ready;
  }
  function coll(name) { return state.collections[name] || (state.collections[name] = {}); }

  // ---------- snapshots ----------
  function querySnap(name, opts) {
    var docs = Object.keys(coll(name)).map(function (id) { return { id: id, v: coll(name)[id] }; });
    if (opts && opts.orderBy) {
      var f = opts.orderBy.field, dir = opts.orderBy.dir === "desc" ? -1 : 1;
      docs.sort(function (a, b) { return String(a.v[f] || "").localeCompare(String(b.v[f] || "")) * dir; });
    }
    if (opts && opts.limit) docs = docs.slice(0, opts.limit);
    return {
      metadata: { fromCache: false },
      size: docs.length,
      empty: !docs.length,
      docs: docs.map(function (d) { return { id: d.id, exists: true, data: function () { return clone(d.v); } }; })
    };
  }
  function docSnap(name, id) {
    var v = coll(name)[id];
    return { id: id, exists: v !== undefined, metadata: { fromCache: false }, data: function () { return clone(v); } };
  }
  function notify(name) {
    listeners.forEach(function (l) {
      if (l.coll !== name) return;
      try { l.cb(l.docId ? docSnap(name, l.docId) : querySnap(name, l.opts)); } catch (e) { console.error(e); }
    });
  }
  function listen(entry) {
    listeners.push(entry);
    load().then(function () { notify(entry.coll); })
      .catch(function (e) { if (entry.err) entry.err(e); });
    return function () { listeners = listeners.filter(function (l) { return l !== entry; }); };
  }

  // ---------- Firestore-like API used by the page ----------
  function docRef(name, id) {
    return {
      id: id,
      set: async function (data) { await load(); coll(name)[id] = clone(data); persist(); notify(name); },
      update: async function (data) { await load(); coll(name)[id] = Object.assign({}, coll(name)[id] || {}, clone(data)); persist(); notify(name); },
      delete: async function () { await load(); delete coll(name)[id]; persist(); notify(name); },
      get: async function () { await load(); return docSnap(name, id); },
      onSnapshot: function (cb, err) { return listen({ coll: name, docId: id, cb: cb, err: err }); }
    };
  }
  function query(name, opts) {
    opts = opts || {};
    return {
      orderBy: function (field, dir) { return query(name, Object.assign({}, opts, { orderBy: { field: field, dir: dir || "asc" } })); },
      limit: function (n) { return query(name, Object.assign({}, opts, { limit: n })); },
      doc: function (id) { return docRef(name, id); },
      get: async function () { await load(); return querySnap(name, opts); },
      onSnapshot: function (cb, err) { return listen({ coll: name, opts: opts, cb: cb, err: err }); }
    };
  }
  var db = {
    collection: function (name) { return query(name); },
    doc: function (path) { var p = String(path).split("/"); return docRef(p[0], p[1]); }
  };

  // ---------- connector stand-ins ----------
  function simulateRefresh() {
    var meta = coll("meta").feed || {};
    setTimeout(async function () {
      await load();
      var next = (state.refreshQueue || []).shift();
      var added = 0;
      if (next && next.id) {
        var doc = Object.assign({}, next.data, { publishedAt: new Date(Date.now() - 20 * 60000).toISOString() });
        coll("articles")[next.id] = doc; added = 1; notify("articles");
      }
      coll("meta").feed = Object.assign({}, coll("meta").feed || meta, {
        status: "done", lastRefresh: new Date().toISOString(),
        added: { articles: added, newsletters: 0 }, removed: 0, note: "Demo refresh"
      });
      persist(); notify("meta");
    }, 4000);
  }
  var mcp = {
    callTool: async function (server, tool, args) {
      await load();
      if (server === "Gmail" && tool === "get_thread") {
        var email = state.emails[args && args.threadId];
        if (!email) { var e = new Error("Not found in demo data"); e.code = "empty"; throw e; }
        return { payload: { messages: [Object.assign({ id: args.threadId }, email)] } };
      }
      if (server === "Claude Code Remote" && tool === "fire_trigger") {
        simulateRefresh();
        return { payload: { ok: true } };
      }
      var err = new Error("Not available in the demo"); err.code = "not_granted"; throw err;
    }
  };

  window.claude = window.claude || {};
  window.claude.use = async function (name) {
    if (name === "db") { await load(); return db; }
    if (name === "mcp") return mcp;
    return null;
  };
  window.claude.demo = {
    reset: function () { try { localStorage.removeItem(STORE_KEY); } catch (e) {} location.reload(); }
  };
})();
