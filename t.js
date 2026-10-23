/*! Sparti Tracking — first-party capture SDK + consent-gated tag container.
 *  Loaded on storefronts via brands.tracking_head. Configure with:
 *    <script>window.spartiTrackingConfig={token:"sp_..."}</script>
 *    <script async src="https://www.sparti.ai/t.js"></script>
 *  Optional config: { host, key, autocapture:false, record:true,
 *                     consent:true, googleAds:"AW-…", metaPixel:"123…",
 *                     gtm:"GTM-…" }
 *  Programmatic API once loaded: window.sparti.capture(event, props),
 *  window.sparti.identify(id, props), window.sparti.showConsent(),
 *  window.sparti.flush() (send the queued events now, kept alive across a page leave).
 *
 *  Acts like a lightweight GTM: it OWNS the child marketing tags (Google Ads,
 *  Meta Pixel, and a nested GTM container) and its own first-party capture, and
 *  — when consent:true — fires
 *  NONE of them until the visitor accepts in the shared Sparti cookie banner
 *  (block-all-until-consent, GDPR). With consent:false it behaves exactly as a
 *  plain first-party tracker (immediate capture; pixels, if configured, load
 *  immediately — the brand's own legal basis).
 */
(function () {
  if (window.__spartiTracking) return;
  var CFG = window.spartiTrackingConfig || {};

  var tokens = [];
  function addToken(tok) { if (tok && tokens.indexOf(tok) === -1) tokens.push(tok); }
  if (CFG.token) addToken(CFG.token);
  if (Array.isArray(CFG.tokens)) CFG.tokens.forEach(addToken);

  var HOST = (CFG.host || 'https://cloud.sparti.ai').replace(/\/$/, '');
  var KEY = CFG.key || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZW11bW9keW5rYWVvanJya2JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDcwMzYyOTcsImV4cCI6MjA2MjYxMjI5N30.xI2Hkw7OZIPOR2jwGh8EkSF3p3lEpTYeKKVTGF5G8vM';
  var INGEST = HOST + '/functions/v1/track-ingest?apikey=' + encodeURIComponent(KEY);
  var REMOTE_TAGS = CFG.remoteTags !== false;
  var AUTOCAPTURE = CFG.autocapture !== false;
  var RECORD = CFG.record === true;

  // Consent-gated tag container config.
  var CONSENT = CFG.consent === true;           // show banner + block until accept
  var GOOGLE_ADS = CFG.googleAds || null;        // 'AW-…' / 'G-…'
  var META_PIXEL = CFG.metaPixel || null;        // Meta Pixel id
  var GTM = CFG.gtm || null;                     // Google Tag Manager container 'GTM-…'

  // First-party event → Meta standard event map. The pixel fires PageView on
  // init; this also reports the commerce funnel (view → cart → checkout →
  // purchase) and the conversion events, so the pixel tracks real outcomes, not
  // just traffic. Each forwarded event carries the same event_id the server-side
  // CAPI dispatch uses (properties.event_id), so Meta collapses our browser pixel
  // event and our server event into ONE. Override/extend via
  // window.spartiTrackingConfig.metaEvents = { '$thankyou': null, … }.
  var META_EVENT_MAP = {
    '$form_submit': 'Lead',
    '$thankyou': 'Lead',
    'view_item': 'ViewContent',
    'search': 'Search',
    'add_to_cart': 'AddToCart',
    'begin_checkout': 'InitiateCheckout',
    'add_payment_info': 'AddPaymentInfo',
    'purchase': 'Purchase',
  };
  if (CFG.metaEvents && typeof CFG.metaEvents === 'object') {
    for (var mek in CFG.metaEvents) {
      if (CFG.metaEvents[mek]) META_EVENT_MAP[mek] = CFG.metaEvents[mek];
      else delete META_EVENT_MAP[mek]; // explicit null/'' disables a default
    }
  }
  var GADS_CONVERSION_MAP = CFG.googleAdsConversions || {};
  var CC_JS = 'https://www.sparti.ai/media/storage/sdk/cookieconsent.umd.js';
  var CC_CSS = 'https://www.sparti.ai/media/storage/sdk/cookieconsent.css';

  // Master gate: no first-party event is queued until this is true. With
  // consent:true it stays false until the visitor accepts Analytics.
  var captureEnabled = !CONSENT;

  function uid() { return 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function getDid() {
    try {
      var d = localStorage.getItem('sp_did');
      // Cross-domain hand-off: a landing passes its visitor id in the link (?sp_did=), so a checkout on another domain adopts the SAME visitor.
      var incoming = null;
      try { incoming = new URLSearchParams(location.search).get('sp_did'); } catch (e) {}
      if (incoming && /^[A-Za-z0-9_-]{6,80}$/.test(incoming) && !d) { localStorage.setItem('sp_did', incoming); return incoming; }
      if (!d) { d = uid(); localStorage.setItem('sp_did', d); }
      return d;
    } catch (e) { return uid(); }
  }
  function getSid() {
    try {
      var now = Date.now();
      var sid = sessionStorage.getItem('sp_sid');
      var ts = +sessionStorage.getItem('sp_sid_ts') || 0;
      if (!sid || now - ts > 30 * 60 * 1000) { sid = uid(); sessionStorage.setItem('sp_sid', sid); }
      sessionStorage.setItem('sp_sid_ts', String(now));
      return sid;
    } catch (e) { return uid(); }
  }

  function ua() {
    var u = navigator.userAgent || '';
    var browser = /Edg/.test(u) ? 'Edge' : /OPR|Opera/.test(u) ? 'Opera'
      : /Chrome/.test(u) ? 'Chrome' : /Firefox/.test(u) ? 'Firefox'
      : /Safari/.test(u) ? 'Safari' : 'Other';
    var os = /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'macOS'
      : /Android/.test(u) ? 'Android' : /(iPhone|iPad|iPod)/.test(u) ? 'iOS'
      : /Linux/.test(u) ? 'Linux' : 'Other';
    var device = /iPad|Tablet/.test(u) ? 'Tablet'
      : /Mobi|Android|iPhone|iPod/.test(u) ? 'Mobile' : 'Desktop';
    return { browser: browser, os: os, device_type: device };
  }

  function utm() {
    var out = {};
    try {
      var p = new URLSearchParams(location.search);
      ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (k) {
        var v = p.get('utm_' + k); if (v) out['utm_' + k] = v;
      });
    } catch (e) {}
    return out;
  }

  // First-touch attribution for form notification emails (session-scoped).
  // Persisted even before analytics consent so submit can stamp Source without
  // racing the ~5s tracking flush. Labels mirror tracking_source_label SQL.
  function referrerHost() {
    try {
      if (!document.referrer) return '';
      var a = document.createElement('a');
      a.href = document.referrer;
      return (a.hostname || '').replace(/^www\./i, '');
    } catch (e) { return ''; }
  }
  // Referral exclusion (GA semantics): the site's own host and payment
  // providers are internal hops, never a traffic source. Without this the
  // submit stamp degrades to the brand's own domain on multi-page visits.
  function ownHost() {
    return (location.hostname || '').toLowerCase().replace(/^www\./, '').split(':')[0];
  }
  function excludedReferrer() {
    var r = referrerHost();
    if (!r) return '';
    var n = r.toLowerCase().replace(/^www\./, '').split(':')[0];
    return (isPaymentHost(r) || n === ownHost()) ? '' : r;
  }
  function persistFirstTouch() {
    try {
      // First-touch is scoped to the tracking session: a fresh sp_sid (30-min
      // inactivity) is a new visit, so a later ad click must re-stamp the
      // origin instead of inheriting a stale internal one.
      if (sessionStorage.getItem('sp_ft_set') && sessionStorage.getItem('sp_ft_sid') === getSid()) return;
      var u = utm();
      sessionStorage.setItem('sp_ft_utm', u.utm_source || '');
      sessionStorage.setItem('sp_ft_medium', u.utm_medium || '');
      sessionStorage.setItem('sp_ft_ref', excludedReferrer());
      sessionStorage.setItem('sp_ft_url', location.href || '');
      sessionStorage.setItem('sp_ft_sid', getSid());
      sessionStorage.setItem('sp_ft_set', '1');
    } catch (e) {}
  }
  var CLICK_ID_RE = /[?&](gclid|gbraid|wbraid|fbclid|msclkid|ttclid|twclid|li_fat_id)=/i;

  // ── Google click id, kept past the visit ───────────────────────────────────────
  // sp_ft_url lives in sessionStorage for ONE visit, but the buyer is often a later visit than the one that clicked
  // (Art in Bloom: 61 of 221 purchases carried a click id; Escandelle: Google credited ~23 orders, Sparti had an id for 9
  // of 50). Google counts a click for 30 days on the upload action and keeps its own copy for 90 (_gcl_aw / _gcl_gb), so
  // after analytics consent the newest Google click is kept for the same 30 days, as a MINIMAL url: the click id and the
  // UTMs on the landing page's path, nothing else from the query. Cleared when analytics consent is withdrawn.
  var GCLK_KEY = 'sp_gclk';
  var GCLK_TTL_MS = 30 * 86400000;
  function googleClickIn(url) {
    var m = /[?&](gclid|gbraid|wbraid)=([A-Za-z0-9_-]{20,512})(?=[&#]|$)/i.exec(url || '');
    return m ? { k: m[1].toLowerCase(), v: m[2] } : null;
  }
  function rememberGoogleClick() {
    if (!captureEnabled) return;
    try {
      var c = googleClickIn(location.href);
      if (!c) return;
      var q = c.k + '=' + c.v;
      var p = new URLSearchParams(location.search);
      ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (n) {
        var x = p.get('utm_' + n); if (x) q += '&utm_' + n + '=' + encodeURIComponent(x.slice(0, 256));
      });
      localStorage.setItem(GCLK_KEY, JSON.stringify({ u: location.origin + location.pathname + '?' + q, t: Date.now() }));
    } catch (e) {}
  }
  function forgetGoogleClick() {
    try { localStorage.removeItem(GCLK_KEY); } catch (e) {}
  }
  function rememberedGoogleClickUrl() {
    try {
      var s = JSON.parse(localStorage.getItem(GCLK_KEY) || 'null');
      if (s && typeof s.u === 'string' && Date.now() - Number(s.t) < GCLK_TTL_MS && googleClickIn(s.u)) return s.u;
    } catch (e) {}
    return '';
  }
  // Google's own first-party cookies, GCL.<unix seconds>.<click id>: written by Google's tag, so only when Google may store it.
  function googleCookieClickUrl() {
    var names = [['_gcl_aw', 'gclid'], ['_gcl_gb', 'gbraid']];
    for (var i = 0; i < names.length; i++) {
      var m = /^GCL\.(\d+)\.([A-Za-z0-9_-]{20,512})/.exec(readCookie(names[i][0]) || '');
      if (m && Date.now() - Number(m[1]) * 1000 < GCLK_TTL_MS) return location.origin + '/?' + names[i][1] + '=' + m[2];
    }
    return '';
  }

  // Ad click IDs land on the FIRST pageview, but the conversion fires later on
  // /thank-you — so server-side conversion upload (Google Ads / Meta CAPI) has
  // no route back to the click unless the landing URL rides along. Stamped only
  // when it actually carries a click ID and differs from the current URL, so
  // ordinary event payloads stay lean. A visit with NO click of its own (and not on a
  // click URL now) falls back to the Google click kept from an earlier visit, then to
  // Google's cookies; a visit that came from another platform's click is left as it was.
  function landingClickUrl() {
    var u = '';
    try { u = sessionStorage.getItem('sp_ft_url') || ''; } catch (e) {}
    if (u && u !== location.href && CLICK_ID_RE.test(u)) return u;
    if (CLICK_ID_RE.test(u) || CLICK_ID_RE.test(location.href)) return '';
    return rememberedGoogleClickUrl() || googleCookieClickUrl();
  }
  function utmMediumFromUrl(url) {
    try { return new URL(url).searchParams.get('utm_medium') || ''; }
    catch (e) {
      var m = /[?&]utm_medium=([^&]+)/i.exec(url || '');
      return m ? decodeURIComponent(m[1]) : '';
    }
  }
  function isPaidMedium(medium) {
    var m = (medium || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    return m === 'cpc' || m === 'cpm' || m === 'ppc' || m === 'paid' || m === 'paidsocial'
      || m === 'paid_social' || m === 'paid-social' || m === 'display' || m === 'retargeting'
      || m === 'ads' || m === 'ad';
  }
  function isMetaPaidMedium(medium) {
    var m = (medium || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    if (isPaidMedium(m)) return true;
    if (m === 'social' || m === 'instagram' || m === 'facebook' || m === 'an'
        || m === 'msg' || m === 'messenger') return true;
    return /instagram|facebook_desktop|facebook_mobile|audience_network/.test(m);
  }
  function isPaymentHost(host) {
    var h = (host || '').toLowerCase().replace(/^www\./, '');
    return /(^|\.)hit-?pay|(^|\.)stripe\.com$|(^|\.)paypal\.com$|checkout\.shopify|pay\.shopify|(^|\.)squareup\.com$|(^|\.)square\.link|(^|\.)adyen\.com$|(^|\.)razorpay|(^|\.)omise\.co$|(^|\.)xendit|pay\.google\.com|payments\.google\.com/.test(h);
  }
  function isMetaSurface(r, u, href) {
    return u === 'fb' || u === 'facebook' || u === 'meta' || u === 'facebook-ads' || u === 'fb-ads'
      || u === 'facebook_ads' || u === 'meta-ads' || u === 'meta_ads' || u === 'metaads'
      || u === 'ig' || u === 'instagram' || u === 'insta'
      || /[?&]fbclid=/i.test(href) || r.indexOf('facebook.') !== -1 || r.indexOf('fb.') !== -1
      || r.indexOf('fb.me') !== -1 || r.indexOf('m.facebook') === 0 || r.indexOf('l.facebook') === 0
      || r.indexOf('instagram.') !== -1 || r.indexOf('l.instagram') === 0;
  }
  // Keep in sync with public.tracking_source_label + src/lib/formTrafficSource.ts
  function classifyTrafficSource(ref, utmSrc, url, medium) {
    var r = (ref || '').toLowerCase();
    var u = (utmSrc || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    var href = url || '';
    var m = ((medium || utmMediumFromUrl(href) || '') + '').toLowerCase().replace(/^\s+|\s+$/g, '');
    var paid = isPaidMedium(m);
    if (/[?&](gclid|gbraid|wbraid)=/i.test(href) || r.indexOf('googleadservices') !== -1
        || r.indexOf('doubleclick.') !== -1 || r.indexOf('googlesyndication') !== -1
        || u === 'adwords' || u === 'google-ads' || u === 'gads' || u === 'googleads' || u === 'google_ads'
        || (u === 'google' && paid)) return 'Google Ads';
    if (/[?&]msclkid=/i.test(href)
        || ((u === 'bing' || u === 'microsoft' || r.indexOf('bing.') !== -1) && paid)) return 'Bing Ads';
    if (u === 'facebook-ads' || u === 'fb-ads' || u === 'facebook_ads' || u === 'meta-ads'
        || u === 'meta_ads' || u === 'metaads' || u === 'meta'
        || (isMetaSurface(r, u, href) && isMetaPaidMedium(m))) return 'Meta Ads';
    if (u === 'fb' || u === 'facebook'
        || /[?&]fbclid=/i.test(href) || r.indexOf('facebook.') !== -1 || r.indexOf('fb.') !== -1
        || r.indexOf('fb.me') !== -1 || r.indexOf('m.facebook') === 0 || r.indexOf('l.facebook') === 0) return 'Facebook';
    if (u === 'ig' || u === 'instagram' || u === 'insta' || r.indexOf('instagram.') !== -1
        || r.indexOf('l.instagram') === 0) return 'Instagram';
    if (u === 'google' || r.indexOf('google.') !== -1 || r === 'google') return 'Google';
    if (u === 'bing' || u === 'microsoft' || r.indexOf('bing.') !== -1) return 'Bing';
    var tiktokSurface = u === 'tiktok' || u === 'tt' || r.indexOf('tiktok.') !== -1;
    if (/[?&]ttclid=/i.test(href) || u === 'tiktok-ads' || u === 'tiktok_ads' || u === 'tiktokads'
        || (tiktokSurface && paid)) return 'TikTok Ads';
    if (tiktokSurface) return 'TikTok';
    var linkedinSurface = u === 'linkedin' || u === 'li' || r.indexOf('linkedin.') !== -1 || r.indexOf('lnkd.in') !== -1;
    if (/[?&]li_fat_id=/i.test(href) || u === 'linkedin-ads' || u === 'linkedin_ads'
        || (linkedinSurface && paid)) return 'LinkedIn Ads';
    if (linkedinSurface) return 'LinkedIn';
    var xSurface = u === 'twitter' || u === 'x' || r.indexOf('t.co') !== -1 || r.indexOf('twitter.') !== -1 || r.indexOf('x.com') !== -1;
    if (/[?&]twclid=/i.test(href) || (xSurface && paid)) return 'X Ads';
    if (xSurface) return 'X (Twitter)';
    if (u === 'youtube' || u === 'yt' || r.indexOf('youtube.') !== -1 || r.indexOf('youtu.be') !== -1) return 'YouTube';
    if (u === 'whatsapp' || r.indexOf('whatsapp') !== -1 || r.indexOf('wa.me') !== -1) return 'WhatsApp';
    if (r.indexOf('duckduckgo.') !== -1) return 'DuckDuckGo';
    if (r.indexOf('yahoo.') !== -1) return 'Yahoo';
    if (r.indexOf('reddit.') !== -1) return 'Reddit';
    if (r.indexOf('pinterest.') !== -1) return 'Pinterest';
    if (utmSrc) return utmSrc.charAt(0).toUpperCase() + utmSrc.slice(1).toLowerCase();
    if (ref) return ref;
    return 'Direct';
  }
  function trafficSource() {
    persistFirstTouch();
    try {
      return classifyTrafficSource(
        sessionStorage.getItem('sp_ft_ref') || '',
        sessionStorage.getItem('sp_ft_utm') || '',
        sessionStorage.getItem('sp_ft_url') || location.href || '',
        sessionStorage.getItem('sp_ft_medium') || ''
      );
    } catch (e) {
      var u = utm();
      return classifyTrafficSource(referrerHost(), (u.utm_source || ''), location.href || '', u.utm_medium || '');
    }
  }
  persistFirstTouch();

  var device = ua();
  // Geo signals: the ingest fn derives the visitor country from the browser
  // timezone (Europe/Paris → FR) — CDN geo headers don't survive the hop to it.
  var tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) {}
  var locale = (navigator.languages && navigator.languages[0]) || navigator.language || null;
  var identity = null; // set via identify()

  function base() {
    return {
      distinct_id: identity || getDid(),
      session_id: getSid(),
      ts: new Date().toISOString(),
      url: location.href,
      pathname: location.pathname,
      host: location.host,
      referrer: document.referrer || null,
      browser: device.browser,
      os: device.os,
      device_type: device.device_type,
      tz: tz,
      locale: locale,
      screen_w: (window.screen && screen.width) || null,
      screen_h: (window.screen && screen.height) || null,
    };
  }

  // ── transport (batched; beacon on unload) ──────────────────────────────────
  var queue = [];
  var replayQueue = [];
  var timer = null;

  function send(payload, beacon) {
    var body = JSON.stringify(payload);
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(INGEST, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
        return;
      }
    } catch (e) {}
    try {
      fetch(INGEST, {
        method: 'POST', body: body, keepalive: true,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      }).catch(function () {});
    } catch (e) {}
  }
  function flush(beacon) {
    if (!queue.length && !replayQueue.length) return;
    var batch = queue.splice(0, 300);
    var replay = replayQueue.splice(0, 50);
    // sendBeacon silently drops bodies ≳64KB — FullSnapshots are often larger,
    // so never beacon when replay chunks are present (use fetch+keepalive).
    var useBeacon = !!beacon && !replay.length;
    for (var i = 0; i < tokens.length; i++) {
      var payload = { token: tokens[i], batch: batch };
      if (i === 0 && replay.length) payload.replay = replay;
      if (!batch.length && !(payload.replay && payload.replay.length)) continue;
      send(payload, useBeacon);
    }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; flush(false); }, 5000);
  }
  // First-party ingest does not share Meta's 5-minute Lead dedup. CMS forms
  // fire $form_submit twice (SDK autocapture on native submit, then
  // useFormSubmit after the DB insert). Thank-you reloads (WhatsApp back)
  // fire $thankyou again. Collapse those bursts here; keep the copy with
  // form_id when both land in the same flush window.
  var THANKYOU_DEDUP_MS = 5 * 60 * 1000;
  var FORM_SUBMIT_COALESCE_MS = 2000;
  function formIdOf(ev) {
    var p = ev && ev.properties;
    return (p && (p.form_id || p.formId)) || '';
  }
  function shouldEnqueue(ev) {
    if (!ev || !ev.event) return false;
    if (ev.event === '$thankyou') {
      try {
        var tk = 'sp_fp_$thankyou';
        var ts = +sessionStorage.getItem(tk) || 0;
        if (Date.now() - ts < THANKYOU_DEDUP_MS) return false;
        sessionStorage.setItem(tk, String(Date.now()));
      } catch (e) {}
      return true;
    }
    if (ev.event !== '$form_submit') return true;
    var newId = formIdOf(ev);
    var newTs = Date.parse(ev.ts) || Date.now();
    for (var i = queue.length - 1; i >= 0; i--) {
      var q = queue[i];
      if (q.event !== '$form_submit') continue;
      if ((q.session_id || '') !== (ev.session_id || '')) continue;
      var oldTs = Date.parse(q.ts) || 0;
      if (Math.abs(newTs - oldTs) > FORM_SUBMIT_COALESCE_MS) continue;
      var oldId = formIdOf(q);
      if (!oldId && newId) queue.splice(i, 1);
      else return false;
    }
    return true;
  }
  // Ad hierarchy for a later Meta send. Ids live on the landing URL, not the
  // thank-you page, so read both. Meta has no keyword; Google uses ad group.
  function queryParam(url, key) {
    try {
      var v = new URL(url, 'https://local.invalid').searchParams.get(key);
      return v || '';
    } catch (e) {
      var m = new RegExp('[?&]' + key + '=([^&#]*)', 'i').exec(url || '');
      if (!m || !m[1]) return '';
      try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e2) { return m[1]; }
    }
  }
  function firstParam(urls, keys) {
    for (var i = 0; i < urls.length; i++) {
      for (var j = 0; j < keys.length; j++) {
        var v = queryParam(urls[i], keys[j]);
        if (v) return v;
      }
    }
    return '';
  }
  function adHierarchy() {
    var urls = [];
    try { if (location.href) urls.push(location.href); } catch (e) {}
    try {
      var landing = sessionStorage.getItem('sp_ft_url') || '';
      if (landing) urls.push(landing);
    } catch (e) {}
    var spec = [
      ['campaign_id', ['campaign_id', 'utm_id', 'gad_campaignid']],
      ['google_campaign_id', ['gad_campaignid']],
      ['adset_id', ['adset_id']],
      ['ad_id', ['ad_id', 'creative']],
      ['adgroup_id', ['adgroupid']],
      ['keyword', ['keyword']],
      ['match_type', ['matchtype']],
      ['placement', ['placement']],
      ['site_source', ['site_source_name']],
      ['network', ['network']],
      ['device', ['device']],
    ];
    var out = {};
    for (var i = 0; i < spec.length; i++) {
      var val = firstParam(urls, spec[i][1]);
      if (val) out[spec[i][0]] = val.slice(0, 256);
    }
    return out;
  }
  function stampAdHierarchy(ev) {
    var ids = adHierarchy();
    if (!ev.properties || typeof ev.properties !== 'object') ev.properties = {};
    for (var k in ids) {
      if (ev.properties[k] == null || ev.properties[k] === '') ev.properties[k] = ids[k];
    }
  }
  function enqueue(ev) {
    if (!captureEnabled) return; // consent gate — nothing leaves the page pre-consent
    if (!shouldEnqueue(ev)) return;
    stampAdHierarchy(ev);
    queue.push(ev);
    if (queue.length >= 20) flush(false); else schedule();
  }

  // ── thank-you / conversion detection ───────────────────────────────────────
  // Commerce /order-confirmed is purchase-only (tenant theme fires purchase);
  // do not treat it as $thankyou/Lead. order-confirmation / order-received etc. remain.
  var TY_PATTERN = /(^|\/)(merci|thank-?you|thank_you|thanks|danke|gracias|grazie|obrigad[oa]?|bedankt|success|confirmation|confirmed|order-?(confirmation|received|complete|success))(\/|$)/i;
  var TY_CUSTOM = Array.isArray(CFG.thankYouPaths)
    ? CFG.thankYouPaths.map(function (s) { return String(s).toLowerCase(); }).filter(Boolean)
    : null;
  function isThankYouPath(path) {
    var p = (path || '').toLowerCase();
    // HitPay's wait page contains "confirmation" but has no order total.
    // Counting it uses up the thank-you and drops the real order page.
    if (p.indexOf('/module/hitpay/') !== -1) return false;
    if (TY_CUSTOM) {
      for (var i = 0; i < TY_CUSTOM.length; i++) {
        if (p.indexOf(TY_CUSTOM[i]) !== -1) return true;
      }
      return false;
    }
    return TY_PATTERN.test(p);
  }
  function inferConversionValue() {
    try {
      var checkout = window.Shopify && window.Shopify.checkout;
      if (checkout && checkout.total_price != null && checkout.total_price !== '') {
        var shopifyVal = Number(checkout.total_price);
        if (isFinite(shopifyVal) && shopifyVal > 0) return shopifyVal;
      }
    } catch (e) {}
    try {
      var nodes = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < nodes.length; i++) {
        var parsed = JSON.parse(nodes[i].textContent || 'null');
        var arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        for (var j = 0; j < arr.length; j++) {
          var item = arr[j];
          if (!item || typeof item !== 'object') continue;
          var price = item.price || item.totalPrice || (item.offers && item.offers.price);
          if (price != null) {
            var n = Number(price);
            if (isFinite(n) && n > 0) return n;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  // ── capture API ────────────────────────────────────────────────────────────
  // Forward a mapped first-party event to the Meta Pixel as a standard event.
  // Self-guards on pixel load (so it respects the marketing-consent gate) and
  // dedups per Meta event within the session, so a form-submit that redirects
  // to a thank-you page reports a single Lead rather than two.
  function metaRecentlySent(metaEvent) {
    try {
      var k = 'sp_fbq_' + metaEvent;
      var ts = +sessionStorage.getItem(k) || 0;
      if (Date.now() - ts < 5 * 60 * 1000) return true;
      sessionStorage.setItem(k, String(Date.now()));
      return false;
    } catch (e) { return false; }
  }
  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[$]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  // Meta click id. Meta's own pixel writes the _fbc cookie, but not when an ad blocker or an in-app browser stops it:
  // 274 of 394 Meta click sessions on Art in Bloom kept no fbc in the 3 days to 14 Oct 2026. The click id is in the
  // landing URL anyway, so build the value Meta documents, fb.1.<ms the click was first seen>.<fbclid>, and keep it
  // for the session (the order-feed join reads the click time from it). A cookie the pixel did write stays first choice.
  function fbcFromUrl() {
    try {
      var kept = sessionStorage.getItem('sp_fbc');
      if (kept) return kept;
      var re = /[?&]fbclid=([A-Za-z0-9_-]{8,})/;
      var m = re.exec(location.href || '') || re.exec(sessionStorage.getItem('sp_ft_url') || '');
      if (!m) return '';
      var v = 'fb.1.' + Date.now() + '.' + m[1];
      sessionStorage.setItem('sp_fbc', v);
      return v;
    } catch (e) { return ''; }
  }
  function newEventId() {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return 'e' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function forwardMeta(event, props, stableId) {
    if (!metaLoaded || !window.fbq) return;
    var mapped = META_EVENT_MAP[event];
    if (!mapped) return;
    // A caller-supplied (deterministic) id is deduped by Meta and by track-ingest, so it
    // must never be session-suppressed: two products viewed in one session are two
    // ViewContent. Only the id-less Lead pair (form submit → thank-you redirect) is
    // collapsed, per mapped event.
    if (!stableId && metaRecentlySent(mapped)) return;
    var params = {};
    if (props && props.value != null) { params.value = props.value; params.currency = props.currency || 'USD'; }
    if (props && props.content_ids) { params.content_ids = props.content_ids; params.content_type = props.content_type || 'product'; }
    if (props && props.num_items) params.num_items = props.num_items;
    if (props && props.search_string) params.search_string = props.search_string;
    if (props && props.content_name) params.content_name = props.content_name;
    var eventId = props && props.event_id;
    try {
      if (eventId) window.fbq('track', mapped, params, { eventID: eventId });
      else window.fbq('track', mapped, params);
    } catch (e) {}
  }
  function gadsRecentlySent(label) {
    try {
      var k = 'sp_gtag_' + label;
      var ts = +sessionStorage.getItem(k) || 0;
      if (Date.now() - ts < 5 * 60 * 1000) return true;
      sessionStorage.setItem(k, String(Date.now()));
      return false;
    } catch (e) { return false; }
  }
  function forwardGoogleAds(event, props) {
    if (!gadsLoaded || !window.gtag) return;
    var label = GADS_CONVERSION_MAP[event];
    if (!label || gadsRecentlySent(label)) return;
    var params = { send_to: label };
    if (props && props.value != null) {
      params.value = props.value;
      params.currency = props.currency || 'USD';
    }
    if (props && props.event_id) params.transaction_id = props.event_id;
    try { window.gtag('event', 'conversion', params); } catch (e) {}
  }

  function capture(event, props) {
    var p = props ? Object.assign({}, props) : {};
    var stableId = !!p.event_id; // a caller-supplied id is the one the server dispatch sends too
    if (!p.event_id) p.event_id = newEventId();
    var fbp = readCookie('_fbp');
    var fbc = readCookie('_fbc') || fbcFromUrl();
    if (fbp && !p.fbp) p.fbp = fbp;
    if (fbc && !p.fbc) p.fbc = fbc;
    if (!p.landing_url) {
      var lu = landingClickUrl();
      if (lu) p.landing_url = lu;
    }
    forwardMeta(event, p, stableId); // marketing pixel — independent of analytics capture gate
    forwardGoogleAds(event, p);
    var ev = base();
    ev.event = event;
    ev.properties = p;
    enqueue(ev);
  }
  function pageview() {
    rememberGoogleClick();
    var ev = base();
    ev.event = '$pageview';
    var u = utm();
    for (var k in u) ev[k] = u[k];
    ev.properties = { title: document.title };
    enqueue(ev);
    if (isThankYouPath(location.pathname)) {
      var tyProps = { path: location.pathname, title: document.title };
      var tyVal = inferConversionValue();
      if (tyVal != null) tyProps.value = tyVal;
      psOrderOnThankYou(tyProps);
      capture('$thankyou', tyProps);
      // The Meta pixel needs a real Purchase too, keyed the way the order feed keys it.
      psPurchaseOnOrder(tyProps);
    }
  }
  function identify(id, props) {
    if (!id) return;
    identity = String(id);
    try { localStorage.setItem('sp_did', identity); } catch (e) {}
    capture('$identify', props || {});
  }

  // ── PrestaShop buyer email, hashed ─────────────────────────────────────────
  // A PrestaShop order reaches Sparti from the store's API, with no browser behind it, so the
  // visit's click id / fbp / fbc / UTMs cannot ride along. At checkout we send a SHA-256 hash of the
  // buyer's email (never the address) as `email_captured`; the order feed hashes the order's email
  // the same way and recovers the visit from this event. Only on PrestaShop checkout pages.
  var PS_EMAIL_PAGES = { checkout: 1, cart: 1, authentication: 1, registration: 1 };
  function psEmailPage() {
    try {
      var ps = window.prestashop;
      var name = ps && ps.page && ps.page.page_name;
      return !!(name && PS_EMAIL_PAGES[name]);
    } catch (e) { return false; }
  }
  function captureEmailHash(raw, source) {
    try {
      if (!psEmailPage()) return;
      var email = String(raw || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
      if (!window.crypto || !crypto.subtle || !window.TextEncoder) return;
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)).then(function (buf) {
        var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
        var k = 'sp_em_' + hex.slice(0, 16);
        try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch (e) {}
        var p = { email_hash: hex, source: source };
        var ft = '';
        try { ft = sessionStorage.getItem('sp_ft_url') || ''; } catch (e) {}
        if (ft) p.first_touch_url = ft.slice(0, 2048);
        capture('email_captured', p);
      }).catch(function () {});
    } catch (e) {}
  }
  function psLoggedInEmail() {
    try {
      var c = window.prestashop && window.prestashop.customer;
      if (c && c.email) captureEmailHash(c.email, 'prestashop_customer');
    } catch (e) {}
  }
  function isEmailField(t) {
    return !!(t && t.tagName === 'INPUT' && (t.type === 'email' || t.name === 'email'));
  }
  document.addEventListener('change', function (e) {
    try { if (isEmailField(e.target)) captureEmailHash(e.target.value, 'prestashop_form'); } catch (err) {}
  }, true);
  document.addEventListener('submit', function (e) {
    try {
      var f = e.target;
      if (!f || f.tagName !== 'FORM' || !f.querySelectorAll) return;
      var fields = f.querySelectorAll('input[type="email"],input[name="email"]');
      for (var i = 0; i < fields.length; i++) captureEmailHash(fields[i].value, 'prestashop_form');
    } catch (err) {}
  }, true);
  psLoggedInEmail();
  window.addEventListener('load', psLoggedInEmail);

  // ── PrestaShop order value, read before the buyer leaves for the payment page ─────────
  // PrestaShop's order-confirmation page has no total t.js can read, so `$thankyou` carried no value and
  // the checkout had no revenue event at all (the order feed has the final total, but arrives later and
  // without a browser). The cart is on every page (`window.prestashop.cart`): at checkout we read its total
  // (tax included, shipping once chosen), keep the latest one in localStorage, send it once per session as
  // `begin_checkout`, and the confirmation page (`?id_order=...`) takes it back as the value of `$thankyou`.
  var PS_CK_KEY = 'sp_ck';
  var PS_CK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  function psNum(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function psCheckoutPage() {
    try {
      var ps = window.prestashop;
      return !!(ps && ps.page && ps.page.page_name === 'checkout');
    } catch (e) { return false; }
  }
  function psCartSnapshot() {
    try {
      var ps = window.prestashop, cart = ps && ps.cart;
      if (!cart || !cart.totals) return null;
      var t = cart.totals.total_including_tax || cart.totals.total;
      var amount = t ? psNum(t.amount) : null;
      if (amount == null || amount <= 0) return null;
      var cur = ps.currency && ps.currency.iso_code ? String(ps.currency.iso_code).toUpperCase() : '';
      var ids = [], contents = [], qty = 0;
      var rows = Array.isArray(cart.products) ? cart.products : [];
      for (var i = 0; i < rows.length && i < 50; i++) {
        var r = rows[i] || {};
        var pid = r.id_product != null ? String(r.id_product) : '';
        if (!pid) continue;
        var attr = psNum(r.id_product_attribute);
        var id = attr && attr > 0 ? pid + '-' + attr : pid;
        var q = psNum(r.cart_quantity != null ? r.cart_quantity : r.quantity) || 1;
        var price = psNum(r.price_wt != null ? r.price_wt : r.price_with_reduction);
        ids.push(id);
        qty += q;
        var line = { id: id, quantity: q };
        if (price != null) line.item_price = Math.round(price * 100) / 100;
        contents.push(line);
      }
      var snap = { value: Math.round(amount * 100) / 100, currency: cur, num_items: qty || rows.length };
      if (ids.length) { snap.content_ids = ids; snap.contents = contents; }
      return snap;
    } catch (e) { return null; }
  }
  function psSaveSnapshot() {
    // Same gate as every first-party event: nothing is stored before consent.
    if (!captureEnabled || !psCheckoutPage()) return null;
    var snap = psCartSnapshot();
    if (!snap) return null;
    try { snap.ts = Date.now(); localStorage.setItem(PS_CK_KEY, JSON.stringify(snap)); } catch (e) {}
    return snap;
  }
  function psTakeSnapshot() {
    try {
      var snap = JSON.parse(localStorage.getItem(PS_CK_KEY) || 'null');
      localStorage.removeItem(PS_CK_KEY); // one order per snapshot
      if (!snap || !snap.ts || Date.now() - snap.ts > PS_CK_MAX_AGE_MS) return null;
      return snap;
    } catch (e) { return null; }
  }
  function psBeginCheckout() {
    try {
      var snap = psSaveSnapshot();
      if (!snap) return;
      try { if (sessionStorage.getItem('sp_bc')) return; sessionStorage.setItem('sp_bc', '1'); } catch (e) {}
      var p = { value: snap.value, source: 'prestashop_cart' };
      if (snap.currency) p.currency = snap.currency;
      if (snap.num_items) p.num_items = snap.num_items;
      if (snap.content_ids) { p.content_ids = snap.content_ids; p.contents = snap.contents; p.content_type = 'product'; }
      capture('begin_checkout', p);
    } catch (e) {}
  }
  /** The confirmation page names the order in its URL; the value comes from the checkout snapshot. */
  function psOrderOnThankYou(props) {
    try {
      if (!window.prestashop) return;
      var q = new URLSearchParams(location.search || '');
      var orderId = q.get('id_order'), cartId = q.get('id_cart');
      if (orderId && /^\d{1,12}$/.test(orderId)) props.order_id = orderId;
      if (cartId && /^\d{1,12}$/.test(cartId)) props.cart_id = cartId;
      var cur = window.prestashop.currency && window.prestashop.currency.iso_code;
      if (cur && !props.currency) props.currency = String(cur).toUpperCase();
      if (props.value != null) return;
      var snap = psTakeSnapshot();
      if (!snap || !(snap.value > 0)) return;
      props.value = snap.value;
      if (snap.currency) props.currency = snap.currency;
      if (snap.num_items) props.num_items = snap.num_items;
      if (snap.content_ids) { props.content_ids = snap.content_ids; props.contents = snap.contents; props.content_type = 'product'; }
      props.value_source = 'checkout_snapshot';
    } catch (e) {}
  }
  /**
   * The order-confirmation page also reports a real `purchase`. Its event_id is the order feed's
   * own key (`purchase.<id_order>`), so Meta collapses our browser pixel event and our server
   * event into ONE, and track-ingest stores a single row for our own reports.
   */
  function psPurchaseOnOrder(props) {
    try {
      var id = props && props.order_id;
      if (!id || !/^\d{1,12}$/.test(String(id))) return;
      var p = { event_id: 'purchase.' + id, order_id: String(id), source: 'prestashop_order_page' };
      if (props.value != null) p.value = props.value;
      if (props.currency) p.currency = props.currency;
      if (props.num_items) p.num_items = props.num_items;
      if (props.content_ids) { p.content_ids = props.content_ids; p.contents = props.contents; p.content_type = 'product'; }
      capture('purchase', p);
    } catch (e) {}
  }
  function psCartId() {
    try {
      var c = window.prestashop && window.prestashop.cart;
      var id = c && (c.id != null ? c.id : c.id_cart);
      return id != null && /^\d{1,12}$/.test(String(id)) ? String(id) : null;
    } catch (e) { return null; }
  }
  /** `add_to_cart` when the cart grows. Keyed `add_to_cart.<id_cart>`, the feed's own key. */
  function psCartTick() {
    try {
      var id = psCartId();
      if (!id) return;
      var snap = psCartSnapshot();
      if (!snap || !snap.num_items) return;
      var raw = sessionStorage.getItem('sp_cart_qty');
      sessionStorage.setItem('sp_cart_qty', String(snap.num_items));
      if (raw === null) return;              // first look of the session: prime only
      if (!(snap.num_items > +raw)) return;  // a removal, or no change
      var p = { event_id: 'add_to_cart.' + id, source: 'prestashop_cart' };
      if (snap.value) p.value = snap.value;
      if (snap.currency) p.currency = snap.currency;
      if (snap.num_items) p.num_items = snap.num_items;
      if (snap.content_ids) { p.content_ids = snap.content_ids; p.contents = snap.contents; p.content_type = 'product'; }
      capture('add_to_cart', p);
    } catch (e) {}
  }
  /**
   * The product on a PrestaShop product page. Themes differ: some put `id_product` and `price` on
   * `prestashop.page`; Art in Bloom's does not, but its page carries the product in
   * `#product-details[data-product]` and in a hidden `input[name=id_product]`. That block shows the
   * price tax-excluded with the tax `rate`, so the tax is added back (it then equals the cart's total).
   */
  function psProduct() {
    var ps = window.prestashop, page = (ps && ps.page) || {};
    var pid = page.id_product != null ? String(page.id_product) : '';
    var price = psNum(page.price);
    var data = null;
    try {
      var el = document.getElementById('product-details') || document.querySelector('[data-product]');
      var raw = el && el.getAttribute('data-product');
      if (raw) data = JSON.parse(raw);
    } catch (e) {}
    if (!/^\d{1,12}$/.test(pid) && data && data.id_product != null) pid = String(data.id_product);
    if (!/^\d{1,12}$/.test(pid)) {
      var input = document.querySelector('input[name="id_product"]');
      if (input && input.value) pid = String(input.value);
    }
    if (!/^\d{1,12}$/.test(pid)) return null;
    if (!(price > 0) && data) {
      var base = psNum(data.price_amount), rate = psNum(data.rate);
      if (base > 0) price = rate > 0 ? Math.round(base * (1 + rate / 100) * 100) / 100 : base;
    }
    return { id: pid, price: price };
  }
  /** `view_item` on a product page, one per product per session (`view_item.<id_product>.<sid>`). */
  function psViewItem() {
    try {
      var ps = window.prestashop;
      if (!ps || !ps.page || ps.page.page_name !== 'product') return;
      var prod = psProduct();
      if (!prod) return;
      var p = { event_id: 'view_item.' + prod.id + '.' + getSid(), source: 'prestashop_product_page', content_ids: [prod.id], content_type: 'product' };
      var cur = ps.currency && ps.currency.iso_code;
      if (cur) p.currency = String(cur).toUpperCase();
      if (prod.price > 0) p.value = prod.price;
      capture('view_item', p);
    } catch (e) {}
  }
  if (psCartId()) {
    psCartTick();
    try {
      if (window.prestashop && typeof window.prestashop.on === 'function') {
        window.prestashop.on('updateCart', function () { psCartTick(); });
      }
    } catch (e) {}
  }
  // The product block is in the page body: wait for it when t.js runs before the page has been parsed.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', psViewItem);
  else psViewItem();

  // ---- Shopify storefront funnel (2026-10-13) ----
  // `view_item` on a product page and `search` on a search page, read from Shopify's own page data (ShopifyAnalytics.meta).
  // Only storefront pages run theme scripts: the checkout is Shopify-hosted, so add_payment_info / begin_checkout / purchase come
  // from the store webhooks (lib/shopifyTrackingEvents.js). The shape is what the store's own Facebook pixel sends, checked on
  // escandelle.com: content_ids = the PRODUCT id, content_type product_group, value in major units (Shopify gives cents), so
  // catalog matching still holds when Sparti is the only Meta sender. Silent on any page that is not a Shopify storefront.
  function shopifyPage() {
    try {
      var m = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      return m && m.page ? m : null;
    } catch (e) { return null; }
  }
  function shopifyCurrency(m) {
    try {
      var c = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || (m && m.currency);
      return c ? String(c).toUpperCase() : '';
    } catch (e) { return ''; }
  }
  /** `view_item`, one per product per session (`view_item.<product id>.<sid>`); the price is the viewed variant's (?variant=), else the first. */
  function shopifyViewItem(m) {
    try {
      if (!m || m.page.pageType !== 'product' || !m.product || !m.product.id) return;
      var pid = String(m.product.id);
      var variants = m.product.variants || [];
      var want = '';
      try { want = new URLSearchParams(location.search).get('variant') || ''; } catch (e) {}
      var v = variants.filter(function (x) { return String(x.id) === want; })[0] || variants[0] || {};
      var p = { event_id: 'view_item.' + pid + '.' + getSid(), source: 'shopify_storefront', content_ids: [pid], content_type: 'product_group' };
      var cur = shopifyCurrency(m);
      if (cur) p.currency = cur;
      var cents = Number(v.price);
      if (cents > 0) p.value = Math.round(cents) / 100;
      capture('view_item', p);
    } catch (e) {}
  }
  /** `search` on the search results page, one per query per session (`search.<sid>.<query>`). */
  function shopifySearch(m) {
    try {
      if (!m || m.page.pageType !== 'searchresults') return;
      var q = '';
      try { q = String(new URLSearchParams(location.search).get('q') || '').trim().slice(0, 128); } catch (e) {}
      if (!q) return;
      capture('search', { event_id: 'search.' + getSid() + '.' + encodeURIComponent(q).slice(0, 80), source: 'shopify_storefront', search_string: q });
    } catch (e) {}
  }
  function shopifyFunnel() {
    var m = shopifyPage();
    if (!m) return;
    shopifyViewItem(m);
    shopifySearch(m);
  }
  // One tick later when the page is already parsed: the marketing pixel is loaded at the bottom of this file, and a view_item
  // sent before that would reach the server but never the browser pixel (so Meta would not see the browser/server pair).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', shopifyFunnel);
  else setTimeout(shopifyFunnel, 0);

  if (psCheckoutPage()) {
    psBeginCheckout();
    // The total changes while the buyer picks delivery and a voucher: keep the latest one (30 minutes at most).
    var psCkTicks = 0;
    var psCkTimer = setInterval(function () {
      if (++psCkTicks > 600) { clearInterval(psCkTimer); return; }
      var s = psSaveSnapshot();
      if (s) psBeginCheckout();
    }, 3000);
    window.addEventListener('pagehide', function () { psSaveSnapshot(); });
  }

  // ── autocapture clicks + form submits (gated by captureEnabled via enqueue) ──
  if (AUTOCAPTURE) {
    document.addEventListener('click', function (e) {
      try {
        var t = e.target;
        var node = t && t.closest ? t.closest('a,button,[role="button"],input[type="submit"],[data-track]') : null;
        if (!node) return;
        var props = { tag: node.tagName.toLowerCase(), text: (node.innerText || node.value || '').trim().slice(0, 120) };
        if (node.id) props.id = node.id;
        var href = node.getAttribute && node.getAttribute('href');
        if (href) props.href = href;
        var cls = node.className && node.className.toString ? node.className.toString().slice(0, 120) : '';
        if (cls) props.classes = cls;
        capture('$autocapture', props);
      } catch (err) {}
    }, true);

    document.addEventListener('submit', function (e) {
      try {
        var f = e.target;
        if (!f || f.tagName !== 'FORM') return;
        var props = {};
        if (f.id) props.form_id = f.id;
        if (f.getAttribute && f.getAttribute('name')) props.form_name = f.getAttribute('name');
        var action = f.getAttribute && f.getAttribute('action');
        if (action) props.form_action = action;
        capture('$form_submit', props);
      } catch (err) {}
    }, true);
  }

  // ── SPA route changes ──────────────────────────────────────────────────────
  function hook(type) {
    var orig = history[type];
    if (!orig) return;
    history[type] = function () {
      var r = orig.apply(this, arguments);
      try { window.dispatchEvent(new Event('sp:locationchange')); } catch (e) {}
      return r;
    };
  }
  hook('pushState'); hook('replaceState');
  window.addEventListener('popstate', function () {
    try { window.dispatchEvent(new Event('sp:locationchange')); } catch (e) {}
  });
  var lastPath = location.pathname;
  window.addEventListener('sp:locationchange', function () {
    if (location.pathname !== lastPath) { lastPath = location.pathname; pageview(); }
  });

  // ── flush on tab hide / unload ─────────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', function () { flush(true); });

  // ── session replay (rrweb, opt-in; only once Analytics is allowed) ──────────
  // FullSnapshot (type 2) is required for the player to paint the page. A single
  // oversized Meta+FullSnapshot+incrementals payload used to be dropped silently
  // (sendBeacon / edge body limits), leaving only type-3 crumbs → blank canvas.
  var recordingStarted = false;
  var RRWEB_CHUNK_BYTES = 160000;
  function startRecording() {
    if (recordingStarted || !RECORD) return;
    recordingStarted = true;
    var rrBuf = [], rrSeq = 0;

    function pushReplayChunks(events) {
      if (!events || !events.length) return;
      var chunk = [];
      var size = 2;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var piece = 0;
        try { piece = JSON.stringify(ev).length + 1; } catch (err) { continue; }
        if (chunk.length && size + piece > RRWEB_CHUNK_BYTES) {
          replayQueue.push({
            session_id: getSid(), distinct_id: identity || getDid(),
            seq: rrSeq++, events: chunk,
          });
          chunk = [];
          size = 2;
        }
        if (!chunk.length && piece > RRWEB_CHUNK_BYTES) {
          // Oversized FullSnapshot alone — still attempt (fetch, not beacon).
          replayQueue.push({
            session_id: getSid(), distinct_id: identity || getDid(),
            seq: rrSeq++, events: [ev],
          });
          continue;
        }
        chunk.push(ev);
        size += piece;
      }
      if (chunk.length) {
        replayQueue.push({
          session_id: getSid(), distinct_id: identity || getDid(),
          seq: rrSeq++, events: chunk,
        });
      }
      flush(false);
    }

    // rrweb@2.0.0-alpha.14 logs a DEPRECATION NOTICE through console.error
    // whenever its departed `mirror` shim is touched ("Please stop import mirror
    // directly …"). It is third-party noise, not a page fault — but the tenant
    // JS-mount deploy canary treats any console error as a broken page, so it
    // failed on every brand with recording on and auto-rolled back EVERY
    // frontend promote (2026-10-12, smooy.sg). Drop that ONE exact line for the
    // page; every other console error still surfaces. Installed before the
    // recorder script so the notice never reaches the console.
    var SPARTI_RRWEB_MIRROR_NOTICE = 'Please stop import mirror directly';
    (function () {
      var origConsoleError = console.error;
      console.error = function () {
        var first = arguments[0];
        if (typeof first === 'string' && first.indexOf(SPARTI_RRWEB_MIRROR_NOTICE) !== -1) return;
        return origConsoleError.apply(console, arguments);
      };
    })();

    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.14/dist/rrweb.min.js';
    s.async = true;
    s.onload = function () {
      try {
        if (!window.rrweb || typeof window.rrweb.record !== 'function') return;
        window.rrweb.record({
          emit: function (ev, isCheckout) {
            rrBuf.push(ev);
            // Flush Meta (4) / FullSnapshot (2) immediately so the base DOM
            // isn't lost if a later incremental batch fails or the tab closes.
            if (ev && (ev.type === 2 || ev.type === 4 || isCheckout)) {
              pushReplayChunks(rrBuf.splice(0));
            }
          },
          checkoutEveryNms: 30000,
          sampling: { mousemove: 100, scroll: 150 },
          maskAllInputs: true,
          slimDOMOptions: true,
        });
        setInterval(function () {
          if (!rrBuf.length) return;
          pushReplayChunks(rrBuf.splice(0));
        }, 4000);
      } catch (e) {}
    };
    document.head.appendChild(s);
  }

  // ── child marketing tags — loaded only when Marketing is allowed ────────────
  var gadsLoaded = false;
  function loadGoogleAds(id) {
    if (gadsLoaded || !id) return;
    gadsLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    window.gtag('js', new Date());
    window.gtag('config', id);
  }
  var metaLoaded = false;
  function loadMetaPixel(id) {
    if (metaLoaded || !id) return;
    metaLoaded = true;
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = !0; n.version = '2.0';
      n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', id);
    window.fbq('track', 'PageView');
  }
  var gtmLoaded = false;
  function loadGtm(id) {
    if (gtmLoaded || !id) return;
    gtmLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
  }

  // ── capture lifecycle ───────────────────────────────────────────────────────
  var captureStarted = false;
  function startCapture() {
    if (captureStarted || !captureEnabled) return;
    captureStarted = true;
    pageview();          // initial pageview
    startRecording();    // no-op unless RECORD
  }

  // ── shared Sparti cookie banner (vanilla-cookieconsent, self-hosted) ─────────
  function applyConsent() {
    var cc = window.CookieConsent;
    if (!cc) return;
    var analytics = cc.acceptedCategory('analytics');
    var marketing = cc.acceptedCategory('marketing');
    captureEnabled = analytics;          // forward-looking: stops new capture on revoke
    if (!analytics) forgetGoogleClick();
    if (analytics) startCapture();
    if (marketing) { loadGoogleAds(GOOGLE_ADS); loadMetaPixel(META_PIXEL); loadGtm(GTM); }
  }

  function runConsent() {
    if (!window.CookieConsent) return;
    window.CookieConsent.run({
      guiOptions: {
        consentModal: { layout: 'box', position: 'middle center', equalWeightButtons: true, flipButtons: false },
        preferencesModal: { layout: 'box', equalWeightButtons: true, flipButtons: false },
      },
      categories: {
        necessary: { readOnly: true, enabled: true },
        analytics: {},
        marketing: {},
      },
      language: {
        default: 'en',
        translations: {
          en: {
            consentModal: {
              title: 'We value your privacy',
              description: 'We use cookies to measure traffic and the performance of our ads. Nothing non-essential runs until you choose. You can change this anytime.',
              acceptAllBtn: 'Accept all',
              acceptNecessaryBtn: 'Reject all',
              showPreferencesBtn: 'Manage preferences',
            },
            preferencesModal: {
              title: 'Cookie preferences',
              acceptAllBtn: 'Accept all',
              acceptNecessaryBtn: 'Reject all',
              savePreferencesBtn: 'Save preferences',
              closeIconLabel: 'Close',
              sections: [
                { title: 'Strictly necessary', description: 'Required for the site to work. Always on.', linkedCategory: 'necessary' },
                { title: 'Analytics', description: 'Lets us understand how visitors use the site, so we can improve it.', linkedCategory: 'analytics' },
                { title: 'Marketing', description: 'Lets us measure and personalise advertising (Google Ads, Meta).', linkedCategory: 'marketing' },
              ],
            },
          },
        },
      },
      onConsent: applyConsent,
      onChange: applyConsent,
    });
  }

  function loadConsentBanner() {
    try {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = CC_CSS;
      document.head.appendChild(l);
    } catch (e) {}
    var s = document.createElement('script');
    s.src = CC_JS; s.async = true;
    s.onload = function () { try { runConsent(); } catch (e) {} };
    document.head.appendChild(s);
  }

  function isNestedLoader(node) {
    if (node.nodeType === 8) return /Sparti Tracking/i.test(node.textContent || '');
    if (node.nodeName !== 'SCRIPT') return false;
    var src = (node.getAttribute && node.getAttribute('src')) || '';
    var text = node.textContent || '';
    return /(?:^|\/)t\.js(?:[?#]|$)/i.test(src) || /spartiTrackingConfig/.test(text);
  }
  function injectSnippet(code, target, prepend) {
    if (!code || !String(code).trim() || !target) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = code;
    var nodes = Array.prototype.slice.call(tpl.content.childNodes);
    var anchor = prepend ? target.firstChild : null;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (isNestedLoader(node)) continue;
      var toInsert = node;
      if (node.nodeName === 'SCRIPT') {
        var orig = node;
        var s = document.createElement('script');
        var attrs = orig.attributes || [];
        for (var a = 0; a < attrs.length; a++) s.setAttribute(attrs[a].name, attrs[a].value);
        s.text = orig.textContent || '';
        toInsert = s;
      }
      if (toInsert.nodeType === 1) toInsert.setAttribute('data-sparti-remote-tags', '');
      target.insertBefore(toInsert, anchor);
    }
  }
  function loadRemoteTags() {
    if (!REMOTE_TAGS || !tokens.length) return;
    if (document.querySelector('[data-sparti-remote-tags]')) return;
    var url = INGEST + '&token=' + encodeURIComponent(tokens[0]);
    fetch(url, { credentials: 'omit' }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json();
    }).then(function (cfg) {
      if (!cfg) return;
      var custom = String(cfg.custom || cfg.head || '').trim();
      var legacyBody = String(cfg.body || '').trim();
      if (legacyBody) custom = custom ? custom + '\n' + legacyBody : legacyBody;
      injectSnippet(custom, document.head, false);
    }).catch(function () {});
  }

  window.__spartiTracking = true;
  window.sparti = {
    capture: capture, identify: identify, pageview: pageview, addToken: addToken,
    trafficSource: trafficSource,
    flush: function () { flush(false); },
    showConsent: function () { try { if (window.CookieConsent) window.CookieConsent.showPreferences(); } catch (e) {} },
  };

  if (CONSENT) {
    // Block-all-until-accept: the banner decides when capture + pixels start.
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', loadConsentBanner);
    else loadConsentBanner();
  } else {
    // No banner → plain first-party tracker. Capture immediately; load any
    // configured pixels immediately (brand's own legal basis).
    if (GOOGLE_ADS) loadGoogleAds(GOOGLE_ADS);
    if (META_PIXEL) loadMetaPixel(META_PIXEL);
    if (GTM) loadGtm(GTM);
    if (document.readyState === 'complete' || document.readyState === 'interactive') startCapture();
    else window.addEventListener('DOMContentLoaded', startCapture);
  }
  if (REMOTE_TAGS) {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', loadRemoteTags);
    else loadRemoteTags();
  }
})();
