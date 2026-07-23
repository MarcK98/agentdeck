/* ─────────────────────────────────────────────────────────────────────────
   AgentDeck marketing site — behavior.
   Ports the design build's scroll-reveal, count-up, and bar-grow effects to
   vanilla JS (no framework), fits the live-map canvas, honors reduced motion,
   and drives the subscribe page's plan picker + PayPal subscription checkout.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Relay base URL — where the billing endpoints (/billing/config, /billing/activate)
  // live. Override by setting window.RELAY_BASE before this script loads.
  var RELAY_BASE = (window.RELAY_BASE || 'https://spawn-relay.duckdns.org').replace(/\/+$/, '');

  /* ── Scroll reveal + count-up + bar grow ──────────────────────────────── */
  function count(el) {
    var to = parseFloat(el.dataset.count),
        dec = parseInt(el.dataset.dec || '0', 10),
        pre = el.dataset.pre || '',
        suf = el.dataset.suf || '';
    if (reduce) {
      el.textContent = pre + to.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
      return;
    }
    var t0 = performance.now(), dur = 1500;
    function tick(t) {
      var p = Math.min(1, (t - t0) / dur),
          v = to * (1 - Math.pow(1 - p, 3));
      el.textContent = pre + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function activate(el, instant) {
    if (!instant) {
      el.style.transition = 'opacity .8s cubic-bezier(.2,.7,.3,1), transform .8s cubic-bezier(.2,.7,.3,1)';
      el.style.opacity = '1';
      el.style.transform = 'none';
    }
    el.querySelectorAll('[data-count]').forEach(count);
    el.querySelectorAll('[data-grow]').forEach(function (g, i) {
      setTimeout(function () {
        g.style.transition = 'transform .9s cubic-bezier(.2,.7,.3,1)';
        g.style.transform = 'none';
      }, 150 + i * 80);
    });
  }

  // Prime bar-grow elements to their collapsed state before reveal.
  document.querySelectorAll('[data-grow]').forEach(function (g) {
    var horizontal = g.parentElement && g.parentElement.style.overflow === 'hidden';
    g.style.transformOrigin = horizontal ? 'left' : 'bottom';
    g.style.transform = horizontal ? 'scaleX(0)' : 'scaleY(0)';
  });

  var reveals = [].slice.call(document.querySelectorAll('[data-reveal]'));
  if (reduce) {
    reveals.forEach(function (el) { activate(el, true); });
  } else {
    reveals.forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.85) {
        activate(el, true);
      } else {
        el.style.opacity = '0';
        el.style.transform = 'translateY(28px)';
      }
    });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          activate(e.target, false);
        });
      }, { threshold: 0.15 });
      reveals.forEach(function (el) {
        if (el.style.opacity === '0') io.observe(el);
      });
    } else {
      reveals.forEach(function (el) { activate(el, true); });
    }
  }

  /* ── Fit the live-map canvas to its container ─────────────────────────── */
  function fitMap() {
    var c = document.querySelector('[data-map-canvas]');
    if (!c || !c.parentElement) return;
    var s = Math.min(1, (c.parentElement.clientWidth - 20) / 585);
    c.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
  }
  fitMap();
  window.addEventListener('resize', fitMap);

  /* ── Copy-to-clipboard buttons (self-host command) ────────────────────── */
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText(btn.dataset.copy || '').then(function () {
        var prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = prev; }, 1500);
      }).catch(function () {});
    });
  });

  /* ── Subscribe page: plan picker + PayPal subscription checkout ────────── */
  var checkout = document.querySelector('[data-checkout]');
  if (checkout) initCheckout(checkout);

  function initCheckout(root) {
    var PLANS = {
      hosted:    { name: 'Hosted',    was: 30,  price: 20,  off: 10  },
      concierge: { name: 'Concierge', was: 200, price: 100, off: 100 }
    };
    var qp = (new URLSearchParams(window.location.search).get('plan') || '').toLowerCase();
    var state = { plan: PLANS[qp] ? qp : 'hosted' };
    var SEL = '#59d8ff', UN = '#23264a';

    var picks = root.querySelectorAll('[data-plan]');
    var out = {
      name:  root.querySelector('[data-out="name"]'),
      was:   root.querySelector('[data-out="was"]'),
      off:   root.querySelector('[data-out="off"]'),
      price: root.querySelector('[data-out="price"]'),
      renew: root.querySelector('[data-out="renew"]')
    };

    function render() {
      picks.forEach(function (p) {
        var on = p.dataset.plan === state.plan;
        p.style.borderColor = on ? SEL : UN;
        var dot = p.querySelector('[data-dot]');
        if (dot) { dot.style.borderColor = on ? SEL : UN; dot.firstElementChild.style.background = on ? SEL : 'transparent'; }
      });
      var pl = PLANS[state.plan];
      if (out.name)  out.name.textContent  = 'AgentDeck ' + pl.name;
      if (out.was)   out.was.textContent   = '$' + pl.was + '/mo';
      if (out.off)   out.off.textContent   = '−$' + pl.off + '/mo';
      if (out.price) out.price.textContent = '$' + pl.price;
      if (out.renew) out.renew.textContent = '$' + pl.price;
    }

    picks.forEach(function (p) {
      p.addEventListener('click', function () { state.plan = p.dataset.plan; render(); syncButtons(); });
    });
    render();

    /* ── PayPal subscription checkout ───────────────────────────────────────
       Fetch the relay's public billing config → inject the PayPal JS SDK →
       render subscription buttons for the selected plan. Buttons re-render when
       the plan or the email's validity changes. On approval we hand PayPal's
       subscription id to the relay, which re-verifies it server-side, then swap
       the order card for a "You're subscribed" confirmation. If the relay has no
       client-id yet we show a friendly "configuring" state — never broken buttons. */
    var form       = root.querySelector('[data-pay-form]');
    var summary    = root.querySelector('[data-summary-card]');
    var emailInput = form && form.querySelector('input[type="email"]');
    var btnHost    = root.querySelector('[data-paypal-buttons]');
    var statusEl   = root.querySelector('[data-pay-status]');

    var cfg = null;       // { clientId, plans, env } from the relay
    var sdkReady = false; // PayPal JS SDK loaded
    var buttons = null;   // live paypal.Buttons instance
    var lastSig = null;   // plan + email-validity signature we last rendered for
    var done = false;     // subscribed — freeze the buttons

    function setStatus(msg, tone) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = tone === 'error' ? '#ff8f8f' : tone === 'ok' ? '#59d8ff' : '#9ba0d4';
    }
    function planId() { return cfg && cfg.plans ? cfg.plans[state.plan] : ''; }
    function emailValue() { return ((emailInput && emailInput.value) || '').trim(); }
    function emailValid() { return !!emailInput && emailInput.checkValidity() && !!emailValue(); }

    function loadSdk(clientId) {
      return new Promise(function (resolve, reject) {
        if (window.paypal) { resolve(); return; }
        var s = document.createElement('script');
        s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&vault=true&intent=subscription';
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error('paypal sdk failed to load')); };
        document.head.appendChild(s);
      });
    }

    function renderButtons() {
      if (done || !sdkReady || !btnHost || !window.paypal) return;
      if (buttons && buttons.close) { try { buttons.close(); } catch (e) {} }
      btnHost.innerHTML = '';
      var pid = planId();
      if (!pid) { setStatus('This plan isn\'t available for checkout yet.', 'error'); return; }
      if (!emailValid()) { setStatus('Enter your email above to continue.', ''); return; }
      setStatus('Pay with PayPal to start your ' + PLANS[state.plan].name + ' subscription.', '');
      buttons = window.paypal.Buttons({
        style: { shape: 'pill', color: 'gold', layout: 'vertical', label: 'subscribe' },
        createSubscription: function (data, actions) {
          return actions.subscription.create({ plan_id: planId() });
        },
        onApprove: function (data) { finishSubscription(data.subscriptionID); },
        onError: function () { setStatus('Payment couldn\'t be started. Please try again.', 'error'); }
      });
      buttons.render(btnHost).catch(function () {
        setStatus('Couldn\'t load PayPal. Refresh and try again.', 'error');
      });
    }

    // Only re-render when the effective inputs (plan + email validity) change, so
    // typing an email doesn't tear the iframe down on every keystroke.
    function syncButtons() {
      if (done || !sdkReady) return;
      var sig = state.plan + '|' + (emailValid() ? 'y' : 'n');
      if (sig === lastSig) return;
      lastSig = sig;
      renderButtons();
    }

    function finishSubscription(subscriptionID) {
      done = true;
      var pl = PLANS[state.plan];
      var email = emailValue();
      setStatus('Confirming your subscription…', 'ok');
      // The subscription already exists on PayPal; the relay re-verifies + records
      // it. Show success either way — a network hiccup here doesn't undo the sub.
      fetch(RELAY_BASE + '/billing/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionID: subscriptionID, plan: state.plan, email: email })
      }).then(function () { showSuccess(pl, email); }, function () { showSuccess(pl, email); });
    }

    function showSuccess(pl, email) {
      if (!summary) return;
      summary.innerHTML =
        '<div style="text-align:center; padding:8px 4px 4px">' +
          '<div style="width:52px; height:52px; margin:0 auto 16px; border-radius:50%; background:linear-gradient(140deg,#8f88ff,#59d8ff); display:flex; align-items:center; justify-content:center; color:#0b0c1a; font-size:26px; font-weight:700">✓</div>' +
          '<div style="font-size:19px; font-weight:700; letter-spacing:-.01em">You\'re subscribed.</div>' +
          '<p style="font-size:13px; line-height:1.6; color:#9ba0d4; margin:12px 0 0">Your <b style="color:#dfe1f5">AgentDeck ' + pl.name + '</b> subscription is active at <b style="color:#dfe1f5">$' + pl.price + '/mo</b>, price locked while you stay subscribed. We\'ll email <span style="font-family:\'JetBrains Mono\',monospace; color:#59d8ff">' + escapeHtml(email || 'your inbox') + '</span> the moment your VPS is provisioned.</p>' +
          '<div style="margin-top:16px; font:400 10.5px \'JetBrains Mono\',monospace; color:#5c6094">subscription active · managed securely via PayPal</div>' +
          '<a href="index.html" style="display:inline-block; margin-top:18px; border:1px solid #303359; padding:10px 20px; border-radius:8px; font-size:13.5px" class="btn-ghost">Back to site</a>' +
        '</div>';
      summary.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    }

    function showUnconfigured() {
      if (btnHost) btnHost.innerHTML = '';
      setStatus('Payments are being configured — check back soon, or email us and we\'ll set you up.', '');
    }

    if (btnHost && statusEl) {
      if (emailInput) emailInput.addEventListener('input', syncButtons);
      setStatus('Loading secure PayPal checkout…', '');
      fetch(RELAY_BASE + '/billing/config')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          cfg = data || {};
          if (!cfg.clientId) { showUnconfigured(); return; }
          return loadSdk(cfg.clientId).then(function () { sdkReady = true; syncButtons(); });
        })
        .catch(function () { showUnconfigured(); });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
