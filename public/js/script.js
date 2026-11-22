/*! Minilytics tracker — <script defer data-website-id="SITE_ID" src="https://YOUR-HOST/js/script.js"></script> */
(function () {
  'use strict';
  var w = window, d = document, loc = w.location, nav = w.navigator;
  var script = d.currentScript;
  if (!script) return;

  var siteId = script.getAttribute('data-website-id');
  var endpoint = script.getAttribute('data-api') || new URL(script.src).origin + '/api/event';
  var allowLocal = script.hasAttribute('data-allow-localhost');
  var cookieDomain = script.getAttribute('data-domain');
  // No cookies at all: the server counts a visitor from a daily-salted hash of IP and user agent instead.
  // Needs requests to reach the Minilytics worker directly (a proxy hides the visitor's IP).
  var cookieless = script.hasAttribute('data-cookieless');
  var VID = 'ml_vid', SID = 'ml_sid', YEAR = 31536000, SESSION = 1800;
  // Page quality signals can be switched off one by one: data-disable="errors, forms, vitals, scroll, 404".
  var disabled = (script.getAttribute('data-disable') || '').toLowerCase().split(/[\s,]+/);
  function on(feature) { return disabled.indexOf(feature) < 0; }

  var queued = (w.minilytics && w.minilytics.q) || [];
  function noop() {}

  // Opt yourself out: visit any page with ?ml_ignore=true (undo with ?ml_ignore=false).
  try {
    var ig = new URLSearchParams(loc.search).get('ml_ignore');
    if (ig === 'true') localStorage.setItem('ml_ignore', '1');
    if (ig === 'false') localStorage.removeItem('ml_ignore');
  } catch (e) {}
  var ignored = false;
  try { ignored = localStorage.getItem('ml_ignore') === '1'; } catch (e) {}
  var local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(loc.hostname) || loc.protocol === 'file:';
  if (!siteId || ignored || nav.webdriver || (local && !allowLocal)) {
    w.minilytics = noop;
    w.minilytics.attribution = function () { return {}; };
    return;
  }

  // ---- cookies (first-party, shared across subdomains so app.site.com and site.com are one visitor)
  function readCookie(name) {
    var m = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function rootDomain() {
    if (cookieDomain) return cookieDomain;
    var parts = loc.hostname.split('.');
    if (parts.length < 2 || /^\d+$/.test(parts[parts.length - 1])) return null;
    for (var i = parts.length - 2; i >= 0; i--) {
      var cand = parts.slice(i).join('.');
      d.cookie = 'ml_t=1; path=/; domain=' + cand + '; SameSite=Lax';
      if (readCookie('ml_t')) {
        d.cookie = 'ml_t=; path=/; domain=' + cand + '; max-age=0';
        return cand;
      }
    }
    return null;
  }
  var domain = cookieless ? (cookieDomain || loc.hostname.replace(/^www\./, '')) : rootDomain();
  function writeCookie(name, value, maxAge) {
    d.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax' +
      (domain ? '; domain=' + domain : '') + (loc.protocol === 'https:' ? '; Secure' : '');
  }
  function uuid() {
    if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function ids() {
    if (cookieless) return {};
    var vid = readCookie(VID) || uuid();
    var sid = readCookie(SID) || uuid();
    writeCookie(VID, vid, YEAR);
    writeCookie(SID, sid, SESSION); // sliding 30 minute session
    return { vid: vid, sid: sid };
  }

  // ---- transport
  // Personal data in URLs (e.g. ?email= on a payment return page) never leaves the browser.
  var PRIVATE_PARAM = /^(e-?mail|name|phone|password|pass|token|access_token|id_token|auth|code|secret|key|api_key|license_key|license)$/i;
  function cleanUrl(href) {
    try {
      var u = new URL(href);
      var drop = [];
      u.searchParams.forEach(function (_, k) { if (PRIVATE_PARAM.test(k)) drop.push(k); });
      for (var i = 0; i < drop.length; i++) u.searchParams.delete(drop[i]);
      return u.toString();
    } catch (e) { return href; }
  }
  function send(type, extra, beacon) {
    var id = ids();
    var body = { w: siteId, t: type, u: cleanUrl(loc.href), vid: id.vid, sid: id.sid, sw: w.screen ? screen.width : 0 };
    if (cookieless) body.c = 1;
    for (var k in extra) if (extra[k] !== undefined) body[k] = extra[k];
    var json = JSON.stringify(body);
    // text/plain keeps this a "simple" request: no CORS preflight, works with sendBeacon.
    if (beacon && nav.sendBeacon) {
      try { if (nav.sendBeacon(endpoint, new Blob([json], { type: 'text/plain' }))) return; } catch (e) {}
    }
    try {
      fetch(endpoint, { method: 'POST', body: json, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(noop);
    } catch (e) {}
  }

  // ---- page quality: how far the page was scrolled and how fast it was (Core Web Vitals).
  // Measured in the browser and sent once per page, with the time ping that goes out when the page is left.
  var startedHidden = d.visibilityState !== 'visible';
  var hardLoad = true, exitSent = false, maxScroll = 0, scrollAt = 0;
  var lcp = 0, inp = 0, cls = 0, clsWindow = 0, clsStart = 0, clsLast = 0, clsSupported = false;
  function measureScroll() {
    try {
      var doc = d.documentElement, body = d.body;
      var height = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0);
      var seen = (w.pageYOffset || doc.scrollTop || 0) + (w.innerHeight || doc.clientHeight || 0);
      var pct = height > 0 ? Math.min(100, Math.round((seen / height) * 100)) : 100;
      if (pct > maxScroll) maxScroll = pct;
    } catch (e) {}
  }
  if (on('scroll')) {
    w.addEventListener('scroll', function () {
      var now = Date.now();
      if (now - scrollAt > 250) { scrollAt = now; measureScroll(); }
    }, { passive: true });
  }
  function observe(type, each, extra) {
    try {
      // Browsers ignore a type they don't measure without saying so; only a listed type counts as measured.
      var types = PerformanceObserver.supportedEntryTypes;
      if (!types || types.indexOf(type) < 0) return false;
      var options = { type: type, buffered: true };
      for (var k in extra) options[k] = extra[k];
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) each(entries[i]);
      }).observe(options);
      return true;
    } catch (e) { return false; }
  }
  if (on('vitals') && w.PerformanceObserver) {
    observe('largest-contentful-paint', function (e) { if (hardLoad) lcp = e.startTime; });
    // Layout shift is scored as its worst burst: shifts less than 1s apart, in a window of at most 5s.
    clsSupported = observe('layout-shift', function (e) {
      if (e.hadRecentInput) return;
      if (clsWindow && e.startTime - clsLast < 1000 && e.startTime - clsStart < 5000) clsWindow += e.value;
      else { clsWindow = e.value; clsStart = e.startTime; }
      clsLast = e.startTime;
      if (clsWindow > cls) cls = clsWindow;
    });
    observe('event', function (e) { if (e.interactionId && e.duration > inp) inp = e.duration; }, { durationThreshold: 40 });
  }
  function exitMetrics(soft) {
    if (exitSent) return null;
    exitSent = true;
    var m = {}, any = false;
    // After an in-app navigation the document already shows the next page, so it is not measured again.
    if (on('scroll')) { if (!soft) measureScroll(); m.sd = maxScroll; any = true; }
    if (on('vitals')) {
      // A page opened in a background tab paints late for no fault of its own.
      if (lcp > 0 && hardLoad && !startedHidden) { m.lcp = Math.round(lcp); any = true; }
      if (inp > 0) { m.inp = Math.round(inp); any = true; }
      if (clsSupported) { m.cls = Math.round(cls * 1000); any = true; }
    }
    return any ? m : null;
  }
  function nextPage() {
    hardLoad = false; exitSent = false; maxScroll = 0; inp = 0; cls = 0; clsWindow = 0;
    formsSeen = {};
  }

  // ---- engaged time (only while the tab is visible)
  var visibleSince = d.visibilityState === 'visible' ? Date.now() : 0;
  var pending = 0, pings = 0;
  function flushTime(beacon, leaving, soft) {
    if (visibleSince) { pending += Date.now() - visibleSince; visibleSince = d.visibilityState === 'visible' ? Date.now() : 0; }
    var extra = leaving ? exitMetrics(soft) : null;
    // In a single-page app the address has already changed by now; the numbers belong to the page being left.
    if (extra && pageHref) extra.u = pageHref;
    if (pending >= 1000 || extra) {
      extra = extra || {};
      extra.d = Math.round(pending);
      send('ping', extra, beacon);
      pending = 0;
    }
  }
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'visible') visibleSince = Date.now();
    else flushTime(true, true);
  });
  w.addEventListener('pagehide', function () { flushTime(true, true); });
  setInterval(function () {
    if (d.visibilityState === 'visible' && pings < 30) { pings++; flushTime(false); }
  }, 60000);

  // ---- pageviews (including single-page-app navigation)
  var lastPage = null, firstView = true, pageHref = '';
  function pageview() {
    var page = loc.pathname + loc.search;
    if (page === lastPage) return;
    var from = lastPage === null ? (d.referrer || '').replace(/[?#].*$/, '') : loc.origin + lastPage.replace(/\?.*$/, '');
    if (lastPage !== null) { flushTime(false, true, true); nextPage(); }
    lastPage = page;
    pageHref = cleanUrl(loc.href);
    pings = 0;
    send('pageview', { r: firstView ? d.referrer : '' });
    firstView = false;
    notFound(page, from);
    // How much of the page fits on screen before any scrolling.
    if (on('scroll')) setTimeout(function () { if (page === lastPage) measureScroll(); }, 1000);
  }

  // ---- missing pages: a page that says "404" or "not found" in its title, or carries data-ml-404 /
  // <meta name="minilytics:404">. Checked a moment after the view, once single-page apps have set the title.
  function notFound(page, from) {
    if (!on('404')) return;
    setTimeout(function () {
      if (page !== lastPage) return;
      try {
        // A title that starts with 404 or says the page was not found; "Room 404" or "Order #404" is neither.
        if (d.querySelector('meta[name="minilytics:404"],[data-ml-404]') ||
            /^\W*404\b|^\W*not found\b|\berror?\W*404\b|\b404\W+(not found|error\b|page)|page not found|p[a\u00e1]gina n[a\u00e3]o encontrada|p[a\u00e1]gina no encontrada|page introuvable|seite nicht gefunden/i.test(d.title)) {
          send('error', { k: '404', p: { ref: from } });
        }
      } catch (e) {}
    }, 1500);
  }

  // ---- JavaScript errors: at most 5 different ones per page load, message and location only
  var errorCount = 0, errorsSeen = {};
  function reportError(message, source, line, col) {
    if (!on('errors') || errorCount >= 5) return;
    var msg = String(message || '').slice(0, 300);
    // "Script error." is all a browser says about another origin's script, and the ResizeObserver one is harmless.
    if (!msg || msg.indexOf('[object') === 0 || /^Script error\.?$|ResizeObserver loop/.test(msg) || errorsSeen[msg]) return;
    errorsSeen[msg] = 1;
    errorCount++;
    var where = source ? String(source).replace(/[?#].*$/, '').slice(-150) + (line ? ':' + line + (col ? ':' + col : '') : '') : '';
    send('error', { n: msg, p: { src: where } });
  }
  w.addEventListener('error', function (e) { if (e && e.message) reportError(e.message, e.filename, e.lineno, e.colno); });
  w.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    reportError(r && (r.message || r), r && r.fileName, 0, 0);
  });

  // ---- forms: who started typing and who submitted. Only the form's name is sent, never a value.
  var formsSeen = {};
  function trackedForm(el) {
    var f = el && el.closest ? el.closest('form') : null;
    if (!f || !on('forms') || f.hasAttribute('data-ml-ignore') || f.getAttribute('role') === 'search') return null;
    var action = f.getAttribute('action');
    var name = f.getAttribute('data-ml-form') || f.getAttribute('id') || f.getAttribute('name');
    if (!name && action) { try { name = new URL(action, loc.href).pathname; } catch (e) {} }
    // Per-item ids (product_form_8271) are one form, not thousands.
    return String(name || 'form').replace(/\d{2,}/g, '#').slice(0, 100);
  }
  d.addEventListener('input', function (e) {
    var name = trackedForm(e.target);
    if (!name || formsSeen[name]) return;
    formsSeen[name] = 1;
    send('form', { n: name, p: { a: 'start' } });
  }, true);
  d.addEventListener('submit', function (e) {
    var name = trackedForm(e.target);
    if (!name || formsSeen[name] === 2) return;
    formsSeen[name] = 2;
    send('form', { n: name, p: { a: 'submit' } }, true);
  }, true);
  var hist = w.history;
  if (hist && hist.pushState) {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = hist[fn];
      hist[fn] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
    });
    w.addEventListener('popstate', pageview);
  }

  // ---- goals, outbound links, Dodo / Stripe checkout links
  function goal(name, props) {
    if (!name) return;
    send('goal', { n: String(name).slice(0, 64), p: props || undefined }, true);
  }
  function attribution() {
    if (cookieless) return {};
    var id = ids();
    return { ml_visitor_id: id.vid, ml_session_id: id.sid };
  }
  // Checkout links carry the visitor: Dodo links as metadata, Stripe payment links (buy.stripe.com) in
  // client_reference_id, unless the site already sets its own. They're tagged as soon as they appear on the
  // page, not just on click, because other scripts (e.g. Umami's click tracking) may copy the href and
  // navigate before our click handler runs.
  function tagCheckoutLink(a) {
    if (cookieless) return;
    try {
      var u = new URL(a.href);
      var att = attribution();
      var q = u.searchParams;
      if (/(^|\.)dodopayments\.com$/.test(u.hostname)) {
        q.set('metadata_ml_visitor_id', att.ml_visitor_id);
        q.set('metadata_ml_session_id', att.ml_session_id);
      } else if (u.hostname === 'buy.stripe.com') {
        var ref = q.get('client_reference_id');
        if (ref && ref.indexOf('ml_') !== 0) return;
        q.set('client_reference_id', 'ml_' + att.ml_visitor_id + '__' + att.ml_session_id);
      } else return;
      var next = u.toString();
      if (a.href !== next) a.href = next;
    } catch (e) {}
  }
  function tagCheckoutLinks() {
    var links = d.querySelectorAll('a[href*="dodopayments.com"], a[href*="buy.stripe.com"]');
    for (var i = 0; i < links.length; i++) tagCheckoutLink(links[i]);
  }
  var tagQueued = false;
  function queueTag() {
    if (tagQueued) return;
    tagQueued = true;
    setTimeout(function () { tagQueued = false; tagCheckoutLinks(); }, 50);
  }
  if (w.MutationObserver) {
    new MutationObserver(queueTag).observe(d.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', tagCheckoutLinks);
  else tagCheckoutLinks();
  // Refresh right before a click starts, in case the session id rotated while the page sat idle.
  function onPress(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a) tagCheckoutLink(a);
  }
  d.addEventListener('pointerdown', onPress, true);
  d.addEventListener('keydown', function (e) { if (e.key === 'Enter') onPress(e); }, true);
  function onClick(e) {
    var el = e.target && e.target.closest ? e.target : null;
    if (!el) return;
    var g = el.closest('[data-ml-goal]');
    if (g) {
      var props = {};
      for (var i = 0; i < g.attributes.length; i++) {
        var at = g.attributes[i];
        if (at.name.indexOf('data-ml-goal-') === 0) props[at.name.slice(13)] = at.value.slice(0, 255);
      }
      goal(g.getAttribute('data-ml-goal'), Object.keys(props).length ? props : undefined);
    }
    var a = el.closest('a[href]');
    if (a) {
      tagCheckoutLink(a);
      try {
        var u = new URL(a.href, loc.href);
        if (/^https?:$/.test(u.protocol) && u.hostname !== loc.hostname && !(domain && u.hostname.slice(-domain.length) === domain)) {
          send('outbound', { n: u.origin + u.pathname }, true);
        }
      } catch (err) {}
    }
  }
  d.addEventListener('click', onClick, true);
  d.addEventListener('auxclick', onClick, true);

  // ---- public API
  function api(cmd, a, b) {
    if (cmd === 'goal' || cmd === 'track') goal(a, b);
    else if (cmd === 'identify' && a && !cookieless) send('identify', { p: { user_id: a.user_id || a.id, email: a.email, name: a.name } });
    else if (cmd === 'pageview') { lastPage = null; pageview(); }
  }
  api.attribution = attribution;
  w.minilytics = api;

  pageview();
  for (var q = 0; q < queued.length; q++) api.apply(null, queued[q]);
})();
