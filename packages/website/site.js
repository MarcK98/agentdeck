/* ─────────────────────────────────────────────────────────────────────────
   AgentDeck marketing site — behavior.
   Ports the design build's scroll-reveal, count-up, and bar-grow effects to
   vanilla JS (no framework), fits the live-map canvas, honors reduced motion,
   and drives the subscribe page's plan picker + mock checkout.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  /* ── Subscribe page: plan picker + mock checkout ──────────────────────── */
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
      p.addEventListener('click', function () { state.plan = p.dataset.plan; render(); });
    });
    render();

    // Mock checkout — no real charge. Validate the form, then swap the order
    // card for a success confirmation. This is a demo funnel: nothing is sent.
    var form = root.querySelector('[data-pay-form]');
    var payBtn = root.querySelector('[data-pay]');
    var summary = root.querySelector('[data-summary-card]');
    if (payBtn && form && summary) {
      payBtn.addEventListener('click', function () {
        if (!form.reportValidity()) return;
        var pl = PLANS[state.plan];
        var email = (form.querySelector('input[type="email"]') || {}).value || 'your inbox';
        summary.innerHTML =
          '<div style="text-align:center; padding:8px 4px 4px">' +
            '<div style="width:52px; height:52px; margin:0 auto 16px; border-radius:50%; background:linear-gradient(140deg,#8f88ff,#59d8ff); display:flex; align-items:center; justify-content:center; color:#0b0c1a; font-size:26px; font-weight:700">✓</div>' +
            '<div style="font-size:19px; font-weight:700; letter-spacing:-.01em">You\'re on the list.</div>' +
            '<p style="font-size:13px; line-height:1.6; color:#9ba0d4; margin:12px 0 0">Early access to <b style="color:#dfe1f5">AgentDeck ' + pl.name + '</b> at <b style="color:#dfe1f5">$' + pl.price + '/mo</b>, price locked while you stay subscribed. We\'ll email <span style="font-family:\'JetBrains Mono\',monospace; color:#59d8ff">' + escapeHtml(email) + '</span> the moment your VPS is provisioned.</p>' +
            '<div style="margin-top:16px; font:400 10.5px \'JetBrains Mono\',monospace; color:#5c6094">demo checkout · no card was charged</div>' +
            '<a href="index.html" style="display:inline-block; margin-top:18px; border:1px solid #303359; padding:10px 20px; border-radius:8px; font-size:13.5px" class="btn-ghost">Back to site</a>' +
          '</div>';
        summary.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
