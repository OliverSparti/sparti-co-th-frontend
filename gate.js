/*! Sparti gate embed: the robot check for ANY website (WordPress, Shopify, a custom domain), one line to add.
 *
 *   <script src="https://www.sparti.ai/gate.js" data-brand="<brand id>" defer></script>
 *   <a href="#contact" data-sparti-gate="whatsapp">Message us on WhatsApp</a>
 *   <a href="#contact-email" data-sparti-gate="email">Email us</a>
 *
 * A click on such a link opens a pop-up that shows only the Cloudflare box, framed from https://www.sparti.ai/gate
 * (the widget only works on a sparti.ai hostname, so every website shares ONE widget and one setup). Cloudflare
 * approves a real visitor by itself; after the server check the framed page sends this page the WhatsApp link or
 * the mailto and the visitor is sent on. Nothing about the contact is in this page before that. Escape or a click
 * outside the box closes it. Optional: data-brand on a single link overrides the script's, data-title names the
 * pop-up for screen readers, and data-gate-message on a WhatsApp link is the text the chat opens with (at most 1500
 * characters; the page puts it on the link after the check, it never travels through the frame). A form that has to
 * validate first can open the gate itself: window.dispatchEvent(new CustomEvent('sparti-gate-open',
 * { detail: { target: 'whatsapp', message: 'Hello' } })). Same contract as src/features/gate (a test keeps them equal).
 *
 * Tracking, on this page's own Sparti tracker (the visitor's identity, UTMs and ad click ids live here):
 * `gate_opened` when the pop-up opens (the click) and `Successful` only after the server confirmed the Cloudflare
 * check and the visitor is being sent on (the verified redirect). Neither is mapped to an ad platform. A Sparti page
 * framed inside this page can ask for the same two events to be counted here. */
(function () {
  if (window.__spartiGate) return;
  window.__spartiGate = true;

  var ORIGIN = 'https://www.sparti.ai';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var script = document.currentScript;
  var defaultBrand = script ? script.getAttribute('data-brand') : null;
  var label = (script && script.getAttribute('data-title')) || 'Security check';
  var current = null;

  var MESSAGE_MAX = 1500;

  // Same rules as cleanGateMessage / applyGateMessage in src/features/gate/model/gateCore.ts.
  function cleanMessage(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/^\s+|\s+$/g, '').slice(0, MESSAGE_MAX);
  }

  function withMessage(url, message) {
    var text = cleanMessage(message);
    if (!text) return url;
    try {
      var link = new URL(url);
      if (link.protocol !== 'https:' || (link.hostname !== 'wa.me' && link.hostname !== 'api.whatsapp.com')) return url;
      link.searchParams.delete('text');
      var rest = link.searchParams.toString();
      link.search = '';
      return link.toString() + '?' + (rest ? rest + '&' : '') + 'text=' + encodeURIComponent(text);
    } catch (e) {
      return url;
    }
  }

  function safe(target, url) {
    if (typeof url !== 'string') return null;
    if (target === 'whatsapp') return /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(url) ? url : null;
    return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+/.test(url) ? url : null;
  }

  function node(tag, css) {
    var el = document.createElement(tag);
    if (css) el.style.cssText = css;
    return el;
  }

  function track(name, props) {
    try {
      if (window.sparti && window.sparti.capture) {
        window.sparti.capture(name, props);
        // Send it now: the page may be left a moment later, and the tracker only sends every few seconds on its own.
        if (window.sparti.flush) window.sparti.flush();
      }
    } catch (e) {}
    try {
      if (window.dataLayer && window.dataLayer.push) {
        var row = { event: name };
        for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) row[k] = props[k];
        window.dataLayer.push(row);
      }
    } catch (e) {}
  }

  function close() {
    if (!current) return;
    document.removeEventListener('keydown', current.onKey, true);
    window.removeEventListener('message', current.onMessage);
    if (current.timer) clearTimeout(current.timer);
    if (current.root.parentNode) current.root.parentNode.removeChild(current.root);
    var opener = current.opener;
    current = null;
    if (opener && opener.focus) opener.focus();
  }

  function go(url) {
    try {
      window.top.location.href = url;
    } catch (e) {
      window.location.href = url;
    }
  }

  function open(target, brand, opener, message) {
    close();
    track('gate_opened', { channel: target });
    var root = node('div', 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);');
    var box = node('div', 'box-sizing:border-box;width:min(22rem,calc(100vw - 2rem));padding:16px;border-radius:16px;background:#fff;box-shadow:0 20px 50px rgba(0,0,0,.3);');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label);
    box.tabIndex = -1;
    var frame = node('iframe', 'display:block;width:100%;height:80px;border:0;');
    frame.title = label;
    frame.src = ORIGIN + '/gate?brand_id=' + encodeURIComponent(brand) + '&target=' + encodeURIComponent(target);
    box.appendChild(frame);
    root.appendChild(box);
    root.addEventListener('click', function (e) {
      if (e.target === root) close();
    });

    var state = { root: root, opener: opener, timer: 0, done: false };
    state.onKey = function (e) {
      if (e.key === 'Escape') close();
    };
    state.onMessage = function (e) {
      if (e.origin !== ORIGIN || state.done) return;
      var d = e.data;
      if (!d || d.type !== 'sparti-gate' || d.ok !== true || d.target !== target) return;
      var url = safe(target, d.url);
      if (!url) return;
      state.done = true;
      if (target === 'whatsapp') url = withMessage(url, message);
      track('Successful', { channel: target, method: 'turnstile' });
      state.timer = setTimeout(function () {
        close();
        go(url);
      }, 350);
    };
    document.addEventListener('keydown', state.onKey, true);
    window.addEventListener('message', state.onMessage);
    current = state;
    document.body.appendChild(root);
    box.focus();
  }

  // A Sparti page framed inside this page (a landing in a WordPress page) has no tracker of its own and asks this
  // page to count its gate events here. Only these two names, only from www.sparti.ai, never anything else.
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.type !== 'sparti-gate-event') return;
    if (d.name !== 'gate_opened' && d.name !== 'Successful') return;
    var p = d.props || {};
    var props = { channel: p.channel === 'email' ? 'email' : 'whatsapp' };
    if (d.name === 'Successful') props.method = 'turnstile';
    track(d.name, props);
  });

  document.addEventListener(
    'click',
    function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-sparti-gate]') : null;
      if (!el) return;
      var target = el.getAttribute('data-sparti-gate');
      if (target !== 'whatsapp' && target !== 'email') return;
      var brand = el.getAttribute('data-brand') || defaultBrand;
      if (!brand || !UUID.test(brand)) return;
      e.preventDefault();
      open(target, brand, el, el.getAttribute('data-gate-message'));
    },
    true
  );

  // A form (or any code) that has to check something first opens the gate itself.
  window.addEventListener('sparti-gate-open', function (e) {
    var d = e.detail;
    if (!d || (d.target !== 'whatsapp' && d.target !== 'email')) return;
    if (!defaultBrand || !UUID.test(defaultBrand)) return;
    open(d.target, defaultBrand, document.activeElement, d.message);
  });
})();
