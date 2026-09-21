(function () {
  'use strict';

  const cfg = window.LYMAN_CONFIG || {};
  const API = (cfg.apiUrl || '').trim();
  const DEMO = !API;
  const DURATIONS = [1, 2, 3, 4, 5, 6, 7, 10, 14];
  const STORE_KEY = 'lyman-materials:borrower';

  const $ = (id) => document.getElementById(id);
  const els = {
    banner: $('banner'),
    summary: $('summary'),
    list: $('items'),
    dialog: $('request-dialog'),
    form: $('request-form'),
    item: $('f-item'),
    start: $('f-start'),
    days: $('f-days'),
    returnBy: $('f-return'),
    conflict: $('f-conflict'),
    error: $('f-error'),
    submit: $('f-submit'),
    success: $('request-success'),
    successText: $('success-text'),
  };

  const state = {
    items: [],
    today: fromDate(new Date()),
    maxDays: 14,
    maxDaysAhead: 90,
    filter: 'all',
  };

  // ---- Dates: YYYY-MM-DD strings, which compare correctly as text ----

  function toDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function fromDate(d) {
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function addDays(s, n) {
    const d = toDate(s);
    d.setDate(d.getDate() + n);
    return fromDate(d);
  }
  function fmt(s, withWeekday) {
    const opts = withWeekday ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' };
    return toDate(s).toLocaleDateString('en-US', opts);
  }
  const maxYmd = (a, b) => (a > b ? a : b);

  // ---- Tiny DOM helper ----

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c != null && c !== false) el.append(c);
    }
    return el;
  }

  // ---- Availability ----

  function itemState(item) {
    const current = item.bookings.find((b) => b.start <= state.today);
    const upcoming = item.bookings.filter((b) => b.start > state.today);
    return { current, upcoming, available: !current, overdue: !!current && current.end < state.today };
  }

  // Overdue items are still out today, so their booking effectively runs until today.
  function findClash(item, start, end) {
    return item.bookings.find((b) => start <= maxYmd(b.end, state.today) && end >= b.start);
  }

  function firstFreeDate(item) {
    for (let i = 0; i <= state.maxDaysAhead; i++) {
      const d = addDays(state.today, i);
      if (!findClash(item, d, addDays(d, 1))) return d;
    }
    return state.today;
  }

  // ---- Rendering ----

  function card(item) {
    const s = itemState(item);
    let badge;
    if (s.available) badge = h('span', { class: 'badge badge--ok' }, 'Available');
    else if (s.overdue) badge = h('span', { class: 'badge badge--late' }, 'Checked out');
    else badge = h('span', { class: 'badge badge--out' }, 'Checked out');

    const meta = [];
    if (s.current) {
      meta.push(h('li', null, s.overdue ? 'Was due back ' : 'Due back ', h('strong', null, fmt(s.current.end, true))));
    }
    s.upcoming.slice(0, 3).forEach((b) => {
      meta.push(h('li', null, 'Reserved ', h('strong', null, fmt(b.start) + ' – ' + fmt(b.end))));
    });
    if (s.upcoming.length > 3) meta.push(h('li', null, '+' + (s.upcoming.length - 3) + ' more reservations'));

    return h('li', { class: 'card' + (s.available ? '' : ' card--out') },
      h('div', { class: 'card-top' }, h('h3', null, item.name), badge),
      item.description && h('p', { class: 'desc' }, item.description),
      meta.length > 0 && h('ul', { class: 'meta' }, meta),
      h('div', { class: 'card-actions' },
        h('button', {
          type: 'button',
          class: 'btn ' + (s.available ? 'btn--primary' : 'btn--secondary'),
          onclick: () => openRequest(item.name),
        }, s.available ? 'Request' : 'Reserve for later')
      )
    );
  }

  function render() {
    const rows = state.items.map((item) => ({ item, s: itemState(item) }));
    const available = rows.filter((r) => r.s.available).length;
    els.summary.textContent = rows.length
      ? available + ' of ' + rows.length + ' items available today'
      : 'No items listed yet';

    const shown = rows.filter((r) =>
      state.filter === 'all' || (state.filter === 'available' ? r.s.available : !r.s.available));
    if (!shown.length && rows.length) {
      const msg = state.filter === 'available' ? 'Everything is checked out right now.' : 'Nothing is checked out right now.';
      els.list.replaceChildren(h('li', { class: 'empty' }, msg));
    } else {
      els.list.replaceChildren(...shown.map((r) => card(r.item)));
    }
  }

  function renderError() {
    els.summary.textContent = 'Couldn’t load items';
    els.list.replaceChildren(h('li', { class: 'empty' },
      'The item list didn’t load. Refresh to try again, or email ',
      h('a', { href: 'mailto:' + cfg.contactEmail }, cfg.contactEmail), '.'));
  }

  // ---- Data ----

  function demoData() {
    const t = fromDate(new Date());
    return {
      ok: true, today: t, maxDays: 14, maxDaysAhead: 90,
      items: [
        { name: 'Cooler', description: '', bookings: [] },
        { name: 'Frisbee', description: '', bookings: [] },
        { name: 'Ice cream machine', description: '', bookings: [{ start: addDays(t, 5), end: addDays(t, 7) }] },
        { name: 'Projector', description: '', bookings: [{ start: addDays(t, -2), end: addDays(t, 1) }] },
      ],
    };
  }

  async function load() {
    try {
      const data = DEMO ? demoData() : await fetch(API, { cache: 'no-store' }).then((r) => r.json());
      if (!data.ok) throw new Error(data.error || 'Bad response');
      state.items = data.items || [];
      state.today = data.today || state.today;
      state.maxDays = data.maxDays || state.maxDays;
      state.maxDaysAhead = data.maxDaysAhead || state.maxDaysAhead;
      render();
    } catch (err) {
      console.error(err);
      renderError();
    }
  }

  // ---- Request form ----

  function fillSelects() {
    els.item.replaceChildren(...state.items.map((i) => h('option', { value: i.name }, i.name)));
    els.days.replaceChildren(...DURATIONS.filter((d) => d <= state.maxDays).map((d) =>
      h('option', { value: String(d) }, d === 7 ? '1 week' : d === 14 ? '2 weeks' : d + (d === 1 ? ' day' : ' days'))));
  }

  function currentItem() {
    return state.items.find((i) => i.name === els.item.value);
  }

  function updateDates() {
    const start = els.start.value;
    const days = Number(els.days.value);
    const item = currentItem();
    els.conflict.hidden = true;
    els.submit.disabled = false;
    if (!start || !days) {
      els.returnBy.textContent = 'Choose a pickup date to see the return date.';
      return;
    }
    const end = addDays(start, days);
    els.returnBy.replaceChildren('Return by ', h('strong', null, fmt(end, true)));
    const clash = item && findClash(item, start, end);
    if (clash) {
      els.conflict.textContent = 'The ' + item.name + ' is already booked ' + fmt(clash.start) + ' – ' +
        fmt(clash.end) + '. Try ' + (clash.start > start ? 'a shorter loan, or ' : '') +
        'a pickup date after ' + fmt(maxYmd(clash.end, state.today)) + '.';
      els.conflict.hidden = false;
      els.submit.disabled = true;
    }
  }

  function openRequest(name) {
    fillSelects();
    els.item.value = name;
    els.start.min = state.today;
    els.start.max = addDays(state.today, state.maxDaysAhead);
    els.start.value = firstFreeDate(currentItem());
    els.days.value = '1';
    els.error.hidden = true;
    els.form.hidden = false;
    els.success.hidden = true;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const k of ['name', 'email', 'unit']) {
        if (saved[k] && !els.form.elements[k].value) els.form.elements[k].value = saved[k];
      }
    } catch (e) { /* storage unavailable; fine */ }
    updateDates();
    els.dialog.showModal();
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }

  async function submit(e) {
    e.preventDefault();
    els.error.hidden = true;
    if (DEMO) {
      showError('This is a preview — requests aren’t connected yet. Email ' + cfg.contactEmail + ' in the meantime.');
      return;
    }
    const payload = Object.fromEntries(new FormData(els.form).entries());
    payload.days = Number(payload.days);

    els.submit.disabled = true;
    els.submit.textContent = 'Sending…';
    try {
      // Plain-text body keeps this a "simple" request, which Apps Script accepts cross-origin.
      const res = await fetch(API, { method: 'POST', body: JSON.stringify(payload) });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || 'Something went wrong. Please try again.');

      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ name: payload.name, email: payload.email, unit: payload.unit }));
      } catch (err) { /* storage unavailable; fine */ }

      const end = addDays(payload.start, payload.days);
      els.successText.textContent = 'Your request for the ' + payload.item + ' (' + fmt(payload.start) + ' – ' +
        fmt(end) + ') is in. A confirmation is on its way to ' + payload.email +
        ', and the community associate will follow up about pickup.';
      els.form.hidden = true;
      els.success.hidden = false;
      els.form.elements.notes.value = '';
      load();
    } catch (err) {
      showError(err instanceof TypeError
        ? 'Couldn’t reach the server. Check your connection and try again.'
        : err.message);
    } finally {
      els.submit.disabled = false;
      els.submit.textContent = 'Send request';
    }
  }

  // ---- Wiring ----

  els.form.addEventListener('submit', submit);
  els.item.addEventListener('change', () => {
    els.start.value = firstFreeDate(currentItem());
    updateDates();
  });
  els.start.addEventListener('change', updateDates);
  els.days.addEventListener('change', updateDates);

  els.dialog.addEventListener('click', (e) => {
    if (e.target === els.dialog || e.target.closest('[data-close]')) els.dialog.close();
  });

  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      render();
    });
  });

  if (cfg.contactEmail) {
    const a = $('contact');
    a.href = 'mailto:' + cfg.contactEmail;
    a.textContent = cfg.contactEmail;
  }

  if (DEMO) {
    els.banner.textContent = 'Preview mode: showing sample data. Requests turn on once the Google Sheet backend is connected.';
    els.banner.hidden = false;
  }

  load();
})();
