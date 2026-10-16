// ==UserScript==
// @name         Vasketid
// @namespace    vasketid.nikolaj
// @version      0.1.0
// @description  Mobilvenligt UI til vasketur.dk (Electrolux web booking): ledige tider, booking, afbestilling og maskinstatus.
// @match        https://web.vasketur.dk/DB0073/*
// @grant        none
// @inject-into  page
// @run-at       document-end
// @noframes
// @downloadURL  https://gist.githubusercontent.com/NsoCarve/1366244bf78ebd9ff77d9d01fbed9ec9/raw/vasketid.user.js
// @updateURL    https://gist.githubusercontent.com/NsoCarve/1366244bf78ebd9ff77d9d01fbed9ec9/raw/vasketid.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BASE = (location.pathname.match(/^\/[^/]+\//) || ['/DB0073/'])[0];
  const KEY = 'vt:';
  const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(KEY + k); } catch { /* ignore */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(KEY + k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(KEY + k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(KEY + k); } catch { /* ignore */ } },
  };

  // ---------------------------------------------------------------------------
  // Motor: snakker med ASP.NET WebForms-siderne via postbacks (samme origin).
  // ---------------------------------------------------------------------------

  class VtError extends Error {
    constructor(code, msg) { super(msg); this.code = code; }
  }

  let cur = null; // senest hentede side ({url, doc}) – bruges som udgangspunkt for postbacks
  let queue = Promise.resolve();
  function serial(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function texts(doc, root) {
    const out = [];
    const w = doc.createTreeWalker(root || doc.body || doc, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentNode && n.parentNode.nodeName;
      if (p === 'SCRIPT' || p === 'STYLE' || p === 'NOSCRIPT') continue;
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }
  const isLoginPage = (doc) => !!doc.querySelector('input[type=password]');

  function pageMessage(doc) {
    return texts(doc)
      .filter((t) => !/Version \d|Copyright|Klik her for at anvende app|^(Panel|Info|Min side|Bestille|Status|Saldo|Indstillinger|Log ud)$/.test(t))
      .join(' ')
      .slice(0, 300);
  }

  async function request(url, opts = {}, allowLogin = false) {
    let r;
    try {
      r = await fetch(url, { credentials: 'same-origin', ...opts });
    } catch (e) {
      throw new VtError('NET', 'Ingen forbindelse til vasketur.dk');
    }
    if (!r.ok) throw new VtError('HTTP', `vasketur.dk svarede ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const page = { url: r.url, doc };
    if (/\/ErrorPages\//i.test(r.url)) {
      cur = null;
      throw new VtError('SERVER', pageMessage(doc) || 'Fejl hos vasketur.dk');
    }
    if (!allowLogin && isLoginPage(doc)) {
      cur = null;
      throw new VtError('LOGIN', 'Du er ikke logget ind');
    }
    cur = page;
    return page;
  }

  function formBody(doc, extra) {
    const f = doc.forms[0];
    if (!f) throw new VtError('PARSE', 'Siden har ingen formular');
    const p = new URLSearchParams();
    for (const el of f.elements) {
      if (!el.name || el.disabled) continue;
      const type = (el.type || '').toLowerCase();
      if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      if (el.tagName === 'SELECT') {
        for (const o of el.selectedOptions) p.append(el.name, o.value);
        continue;
      }
      p.set(el.name, el.value);
    }
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }

  function post(page, extra, allowLogin = false) {
    const f = page.doc.forms[0];
    const action = new URL((f && f.getAttribute('action')) || page.url, page.url).href;
    return request(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody(page.doc, extra),
    }, allowLogin);
  }

  const postback = (page, target, arg = '') => post(page, { __EVENTTARGET: target, __EVENTARGUMENT: arg });

  function parsePostback(js) {
    const m = /__doPostBack\('([^']*)','([^']*)'\)/.exec(js || '');
    return m ? { target: m[1], arg: m[2] } : null;
  }

  // Aktiverer en knap/et link på siden, uanset om det er <input type=submit> eller et __doPostBack-link.
  function activate(page, el) {
    const pb = parsePostback(el.getAttribute('href')) || parsePostback(el.getAttribute('onclick'));
    if (el.tagName === 'INPUT' && /submit|image/i.test(el.type) && !(el.getAttribute('onclick') || '').includes('__doPostBack')) {
      return post(page, { __EVENTTARGET: '', __EVENTARGUMENT: '', [el.name]: el.value });
    }
    if (pb) return postback(page, pb.target, pb.arg);
    if (el.name) return post(page, { __EVENTTARGET: '', __EVENTARGUMENT: '', [el.name]: el.value });
    throw new VtError('PARSE', 'Kan ikke aktivere elementet');
  }
  function clickByName(page, name) {
    const el = page.doc.getElementsByName(name)[0];
    if (!el) throw new VtError('PARSE', `Fandt ikke knappen ${name}`);
    return activate(page, el);
  }

  // --- Login ---
  const creds = () => store.get('creds', null);

  async function login(user, pass) {
    const p = await request(BASE + 'Default.aspx', {}, true);
    const res = await post(p, {
      __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btOK',
      __EVENTARGUMENT: '',
      'ctl00$ContentPlaceHolder1$tbUsername': user,
      'ctl00$ContentPlaceHolder1$tbPassword': pass,
    }, true);
    if (isLoginPage(res.doc)) throw new VtError('BADLOGIN', pageMessage(res.doc).replace(/AB .*?Web booking\.?/, '').trim() || 'Forkert navn eller adgangskode');
    return res;
  }

  // Kører fn; hvis sessionen er væk og login er gemt, logges der ind igen og prøves én gang til.
  async function withSession(fn) {
    try {
      return await fn();
    } catch (e) {
      const c = creds();
      if ((e.code === 'LOGIN' || e.code === 'SERVER') && c) {
        await login(c.user, c.pass);
        return fn();
      }
      throw e;
    }
  }

  // --- Vaskerier (bestillingsterminaler) ---
  function parseTerminals(page) {
    return [...page.doc.querySelectorAll('a[href*="dgTerminaler"]')]
      .map((a) => ({ name: a.textContent.replace(/\s+/g, ' ').trim(), pb: parsePostback(a.getAttribute('href')) }))
      .filter((t) => t.name && t.pb);
  }

  async function selector() {
    // Først direkte GET; hvis det ikke giver vaskeri-listen, så via "Panel"-linket.
    let p = await request(BASE + 'Booking/TerminalSelector.aspx');
    if (parseTerminals(p).length) return p;
    const panel = p.doc.querySelector('a[href*="LinkButtonEls"]');
    if (panel) {
      p = await activate(p, panel);
      if (parseTerminals(p).length) return p;
    }
    throw new VtError('PARSE', 'Kunne ikke finde listen over vaskerier');
  }

  async function openTerminal(name) {
    const sel = await selector();
    const t = parseTerminals(sel).find((x) => x.name === name);
    if (!t) throw new VtError('PARSE', `Fandt ikke vaskeriet "${name}"`);
    return postback(sel, t.pb.target, t.pb.arg); // -> BookingMain.aspx
  }

  // --- Bookinger ("Min side") ---
  function parseBookings(page) {
    return [...page.doc.querySelectorAll('[name*="DataGridBookings"], a[href*="DataGridBookings"]')].map((el) => {
      const tr = el.closest('tr');
      const cells = tr
        ? [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter((t) => t && t !== '-' && !/^Afbestil/i.test(t))
        : [];
      const id = el.getAttribute('name') || (parsePostback(el.getAttribute('href')) || {}).target;
      return { key: cells.join(' | '), cells, id };
    }).filter((b) => b.key);
  }

  function parseDanishDate(s) {
    const m = /(\d{1,2})\.?\s+([A-Za-zæøå]{3})/i.exec(s || '');
    if (!m) return null;
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon == null) return null;
    const now = new Date();
    let d = new Date(now.getFullYear(), mon, +m[1]);
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate()) - 60 * 864e5) d = new Date(now.getFullYear() + 1, mon, +m[1]);
    return d;
  }

  // --- Kalender ---
  async function openCalendar(main, week) {
    let p = await postback(main, 'ctl00$LinkBooking');
    for (let i = 0; i < week; i++) p = await clickByName(p, 'ctl00$ContentPlaceHolder1$btCalendarNext');
    return p;
  }

  function calendarDates(doc, week) {
    const joined = texts(doc).join(' ');
    const nums = [...joined.matchAll(/\b(Man|Tir|Ons|Tor|Fre|Lør|Søn)\s+(\d{1,2})\b/g)].slice(0, 7).map((m) => +m[2]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const anchor = new Date(today.getTime() + week * 7 * 864e5);
    let first = anchor;
    if (nums.length) {
      let best = null;
      for (let off = -10; off <= 10; off++) {
        const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + off);
        if (d.getDate() === nums[0] && (best == null || Math.abs(off) < Math.abs(best.off))) best = { d, off };
      }
      if (best) first = best.d;
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      return d.getTime();
    });
  }

  function parseCalendar(page, week) {
    const days = calendarDates(page.doc, week);
    const cells = [...page.doc.querySelectorAll('input[id]')]
      .filter((e) => /^\d+,\d+,\d+,$/.test(e.id))
      .map((e) => {
        const [d, s, g] = e.id.split(',').map(Number);
        const m = /^(\d\d:\d\d)\s*-\s*(\d\d:\d\d)\s*\((.*)\)\s*$/.exec(e.title || '');
        return {
          id: e.id, d, s, g,
          from: m ? m[1] : '', to: m ? m[2] : '',
          state: m ? m[3] : (e.title || ''),
          bookable: /BookPass/.test(e.getAttribute('onclick') || '') && !e.disabled,
        };
      });
    if (!cells.length) throw new VtError('PARSE', 'Kunne ikke læse kalenderen');
    return { days, cells, at: Date.now() };
  }

  // --- Booking ---
  function parseMachineGroup(page) {
    const t = texts(page.doc).join(' ');
    const quota = (/Du har (\d+) bestillinger tilbage/i.exec(t) || [])[1];
    const options = [...page.doc.querySelectorAll('input[name*="bt2Maskingrupp"]')]
      .map((e) => ({ name: e.name, label: e.value, disabled: e.disabled }));
    const rnd = page.doc.querySelector('input[name$="btMaskingruppRandom"]');
    if (!options.length && !rnd) throw new VtError('BOOK', pageMessage(page.doc) || 'Kunne ikke vælge maskine');
    return { page, quota: quota != null ? +quota : null, options, random: rnd ? { name: rnd.name } : null };
  }

  async function startBooking(term, week, cellId) {
    const main = await openTerminal(term);
    const cal = await openCalendar(main, week);
    const cell = parseCalendar(cal, week).cells.find((c) => c.id === cellId);
    if (!cell || !cell.bookable) throw new VtError('GONE', 'Tiden er ikke længere ledig');
    const mg = await postback(cal, 'BookPass' + cellId, cellId);
    return parseMachineGroup(mg);
  }

  async function confirmBooking(mg, name) {
    const p = await clickByName(mg.page, name);
    const t = texts(p.doc).join(' ');
    if (!/Bestilling OK/i.test(t)) throw new VtError('BOOK', pageMessage(p.doc) || 'Bookingen gik ikke igennem');
    const m = /Du har bestilt\s+(.*?)\s+Du har \d+/i.exec(t);
    const left = (/Du har (\d+) bestillinger tilbage/i.exec(t) || [])[1];
    return { text: m ? m[1] : 'Booket', left: left != null ? +left : null };
  }

  async function cancelBooking(b) {
    const main = await openTerminal(b.terms[0]);
    const row = parseBookings(main).find((x) => x.key === b.key);
    if (!row) throw new VtError('GONE', 'Bookingen findes ikke længere');
    const el = main.doc.getElementsByName(row.id)[0] || main.doc.querySelector(`a[href*="${row.id}"]`);
    const p = await activate(main, el);
    if (parseBookings(p).some((x) => x.key === b.key)) throw new VtError('CANCEL', pageMessage(p.doc) || 'Afbestillingen gik ikke igennem');
    return p;
  }

  // --- Status ---
  function parseStatus(page) {
    const laundries = [];
    let L = null;
    let G = null;
    for (const t of texts(page.doc)) {
      let m;
      if ((m = /^Bestil vask\s*(.*)$/i.exec(t))) {
        L = { name: m[1] || 'Vaskeri', groups: [] };
        laundries.push(L);
        G = { type: 'Vask', machines: [] };
        L.groups.push(G);
      } else if ((m = /^Bestil (tørretumbler|tørring|tørreskab)\s*(.*)$/i.exec(t))) {
        if (!L) { L = { name: m[2] || 'Vaskeri', groups: [] }; laundries.push(L); }
        G = { type: 'Tørretumbler', machines: [] };
        L.groups.push(G);
      } else if (G && (m = /^(.{1,30}?)\s*\((.+)\)$/.exec(t))) {
        G.machines.push({ name: m[1].replace(/^(Vask|Tør)(\d)/, '$1 $2'), state: m[2].trim() });
      }
    }
    if (!laundries.length) throw new VtError('PARSE', pageMessage(page.doc) || 'Kunne ikke læse status');
    return { laundries, at: Date.now() };
  }

  async function loadStatusOnce() {
    let base = cur && cur.doc.querySelector('a[href*="LinkStatus"]') ? cur : null;
    if (!base) {
      const sel = await selector();
      const t = parseTerminals(sel)[0];
      base = await postback(sel, t.pb.target, t.pb.arg);
    }
    return parseStatus(await postback(base, 'ctl00$LinkStatus'));
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const S = {
    view: 'loading', // loading | login | app
    tab: store.get('tab', 'free'),
    week: 0,
    terms: store.get('terms', []),
    hidden: store.get('hidden', []), // vaskerier fravalgt i "Ledige"
    cal: store.get('cal', {}), // "navn|uge" -> {days, cells, at}
    bookings: store.get('bookings', []),
    bookingsAt: store.get('bookingsAt', null),
    status: store.get('status', null),
    busy: '',
    statusBusy: '',
    error: '',
    statusError: '',
    sheet: null,
    toast: '',
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shortName = (n) => n.replace(/\s+\d.*$/, '');
  const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const dayLabel = (ts) => {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 864e5);
    const name = diff === 0 ? 'I dag' : diff === 1 ? 'I morgen' : WEEKDAYS[d.getDay()][0].toUpperCase() + WEEKDAYS[d.getDay()].slice(1);
    return `${name} ${d.getDate()}/${d.getMonth() + 1}`;
  };
  const ago = (ts) => {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'lige nu' : m < 60 ? `${m} min siden` : `kl. ${hhmm(ts)}`;
  };

  function saveCache() {
    store.set('terms', S.terms);
    store.set('cal', S.cal);
    store.set('bookings', S.bookings);
    store.set('bookingsAt', S.bookingsAt);
    store.set('status', S.status);
  }

  function handleError(e, field = 'error') {
    if (e.code === 'LOGIN' && !creds()) {
      S.view = 'login';
      S.error = 'Din session er udløbet. Log ind igen.';
    } else if (e.code === 'BADLOGIN') {
      S.view = 'login';
      store.del('creds');
      S.error = e.message;
    } else {
      S[field] = e.message || String(e);
    }
    render();
  }

  // --- Data-indlæsning ---
  function mergeBookings(found) {
    // found: [{key, cells, term}] fra de vaskerier vi har besøgt
    const map = new Map();
    for (const f of found) {
      const b = map.get(f.key) || { key: f.key, cells: f.cells, terms: [] };
      if (!b.terms.includes(f.term)) b.terms.push(f.term);
      map.set(f.key, b);
    }
    return [...map.values()].sort((a, b) => {
      const da = parseDanishDate(a.cells[0]) || 0, db = parseDanishDate(b.cells[0]) || 0;
      return da - db || String(a.cells[2]).localeCompare(String(b.cells[2]));
    });
  }

  function refreshFree() {
    const week = S.week;
    S.busy = 'Henter ledige tider…';
    S.error = '';
    render();
    return serial(() => withSession(async () => {
      const sel = await selector();
      S.terms = parseTerminals(sel).map((t) => t.name);
      const found = [];
      for (const name of S.terms) {
        if (S.hidden.includes(name)) continue;
        S.busy = `Henter ${shortName(name)}…`;
        render();
        const main = await openTerminal(name);
        parseBookings(main).forEach((b) => found.push({ ...b, term: name }));
        const cal = await openCalendar(main, week);
        S.cal[name + '|' + week] = parseCalendar(cal, week);
        render();
      }
      if (!S.hidden.length) { S.bookings = mergeBookings(found); S.bookingsAt = Date.now(); }
    })).then(() => { S.busy = ''; saveCache(); render(); }, (e) => { S.busy = ''; handleError(e); });
  }

  function refreshBookings() {
    S.busy = 'Henter dine bookinger…';
    S.error = '';
    render();
    return serial(() => withSession(async () => {
      const sel = await selector();
      S.terms = parseTerminals(sel).map((t) => t.name);
      const found = [];
      for (const name of S.terms) {
        const main = await openTerminal(name);
        parseBookings(main).forEach((b) => found.push({ ...b, term: name }));
      }
      S.bookings = mergeBookings(found);
      S.bookingsAt = Date.now();
    })).then(() => { S.busy = ''; saveCache(); render(); }, (e) => { S.busy = ''; handleError(e); });
  }

  function refreshStatus() {
    S.statusError = '';
    return serial(async () => {
      let last;
      for (let attempt = 1; attempt <= 3; attempt++) {
        S.statusBusy = attempt === 1 ? 'Henter status fra vaskerierne… (vasketur.dk er langsom her, op til 20 sek.)' : `Status svarede ikke – forsøg ${attempt} af 3…`;
        render();
        try {
          S.status = await withSession(loadStatusOnce);
          return;
        } catch (e) {
          last = e;
          if (e.code === 'LOGIN' || e.code === 'BADLOGIN') break;
          await sleep(1500);
        }
      }
      throw last;
    }).then(() => { S.statusBusy = ''; saveCache(); render(); }, (e) => {
      S.statusBusy = '';
      if (e.code === 'LOGIN' && !creds()) {
        S.statusError = 'Status svarede ikke, og vasketur.dk loggede dig ud. Log ind igen – eller slå "Husk login" til, så klarer appen det selv.';
        render();
      } else handleError(e, 'statusError');
    });
  }

  function refreshTab() {
    if (S.tab === 'free') return refreshFree();
    if (S.tab === 'mine') return refreshBookings();
    return refreshStatus();
  }

  // --- Handlinger ---
  function openBooking(term, week, cellId) {
    const c = S.cal[term + '|' + week];
    const cell = c && c.cells.find((x) => x.id === cellId);
    S.sheet = { phase: 'loading', term, week, cellId, when: cell ? `${dayLabel(c.days[cell.d])} · ${cell.from}–${cell.to}` : '' };
    render();
    serial(() => withSession(() => startBooking(term, week, cellId)))
      .then((mg) => { S.sheet = { ...S.sheet, phase: 'choose', mg }; render(); })
      .catch((e) => { S.sheet = { ...S.sheet, phase: 'error', msg: e.message }; render(); });
  }

  function chooseMachine(name) {
    const sh = S.sheet;
    if (!sh || !sh.mg) return;
    S.sheet = { ...sh, phase: 'booking' };
    render();
    serial(() => confirmBooking(sh.mg, name))
      .then((res) => {
        S.sheet = { ...S.sheet, phase: 'done', msg: res.text, left: res.left };
        render();
        refreshFree();
      })
      .catch((e) => { S.sheet = { ...S.sheet, phase: 'error', msg: e.message }; render(); });
  }

  function doCancel(key) {
    const b = S.bookings.find((x) => x.key === key);
    if (!b) return;
    if (!confirm(`Afbestil ${b.cells.join(' ')}?`)) return;
    S.busy = 'Afbestiller…';
    render();
    serial(() => withSession(() => cancelBooking(b)))
      .then(() => {
        S.bookings = S.bookings.filter((x) => x.key !== key);
        S.busy = '';
        toast('Afbestilt');
        saveCache();
        render();
      }, (e) => { S.busy = ''; handleError(e); });
  }

  function doLogin(form) {
    const user = form.user.value.trim();
    const pass = form.pass.value;
    const remember = form.remember.checked;
    if (!user || !pass) return;
    S.busy = 'Logger ind…';
    S.error = '';
    render();
    serial(() => login(user, pass)).then(() => {
      if (remember) store.set('creds', { user, pass }); else store.del('creds');
      S.busy = '';
      S.view = 'app';
      render();
      refreshTab();
    }, (e) => { S.busy = ''; S.view = 'login'; S.error = e.message; render(); });
  }

  function doLogout() {
    store.del('creds');
    serial(async () => {
      const page = cur || await request(BASE + 'Booking/BookingMain.aspx').catch(() => null);
      const link = page && page.doc.querySelector('a[href*="LinkLogOut"]');
      if (link) await activate(page, link).catch(() => {});
    }).finally(() => { S.view = 'login'; render(); });
  }

  let toastTimer;
  function toast(msg) {
    S.toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2500);
  }

  // --- Rendering ---
  function renderFree() {
    const shown = S.terms.filter((t) => !S.hidden.includes(t));
    const chips = S.terms.map((t) => `<button class="chip ${S.hidden.includes(t) ? '' : 'on'}" data-act="toggle-term" data-term="${esc(t)}">${esc(shortName(t))}</button>`).join('');
    const weeks = `<div class="seg"><button class="${S.week === 0 ? 'on' : ''}" data-act="week" data-w="0">Denne uge</button><button class="${S.week === 1 ? 'on' : ''}" data-act="week" data-w="1">Næste uge</button></div>`;

    // Saml: dag -> tidsrum -> [{term, cell}]
    const byDay = new Map();
    let oldest = null;
    const now = new Date();
    for (const term of shown) {
      const c = S.cal[term + '|' + S.week];
      if (!c) continue;
      oldest = oldest == null ? c.at : Math.min(oldest, c.at);
      for (const cell of c.cells) {
        const dayTs = c.days[cell.d];
        if (dayTs == null) continue;
        const end = new Date(dayTs);
        const [h, m] = (cell.to || '23:59').split(':').map(Number);
        end.setHours(h, m);
        if (end < now) continue; // forbi
        const slotKey = `${cell.from}–${cell.to}`;
        if (!byDay.has(dayTs)) byDay.set(dayTs, new Map());
        const slots = byDay.get(dayTs);
        if (!slots.has(slotKey)) slots.set(slotKey, []);
        slots.get(slotKey).push({ term, cell });
      }
    }

    let body = '';
    if (!byDay.size) {
      body = S.busy ? '' : `<p class="empty">Ingen data endnu. Tryk ↻ for at hente.</p>`;
    }
    for (const dayTs of [...byDay.keys()].sort((a, b) => a - b)) {
      const slots = byDay.get(dayTs);
      let rows = '';
      for (const slotKey of [...slots.keys()].sort()) {
        const items = slots.get(slotKey);
        const free = items.filter((i) => i.cell.bookable);
        const btns = items.map((i) => i.cell.bookable
          ? `<button class="slot free" data-act="book" data-term="${esc(i.term)}" data-cell="${esc(i.cell.id)}">${esc(shortName(i.term))}</button>`
          : `<span class="slot taken" title="${esc(i.cell.state)}">${esc(shortName(i.term))}</span>`).join('');
        rows += `<div class="row ${free.length ? '' : 'none'}"><div class="time">${esc(slotKey)}</div><div class="slots">${btns}</div></div>`;
      }
      body += `<section class="day"><h3>${esc(dayLabel(dayTs))}</h3>${rows}</section>`;
    }
    const meta = oldest ? `<div class="meta">Opdateret ${esc(ago(oldest))}</div>` : '';
    return `<div class="chips">${chips}</div>${weeks}${meta}${body}`;
  }

  function renderMine() {
    if (!S.bookings.length) {
      return `<p class="empty">${S.bookingsAt ? 'Du har ingen bookinger.' : 'Tryk ↻ for at hente dine bookinger.'}</p>`;
    }
    const list = S.bookings.map((b) => {
      const where = b.terms.length === 1 ? shortName(b.terms[0]) : '';
      const [date, machine, from, to] = b.cells;
      return `<div class="card booking">
        <div><div class="b-date">${esc(date || '')}</div>
        <div class="b-sub">${esc([from && to ? `${from}–${to}` : b.cells.slice(2).join(' '), machine, where].filter(Boolean).join(' · '))}</div></div>
        <button class="danger" data-act="cancel" data-key="${esc(b.key)}">Afbestil</button></div>`;
    }).join('');
    return `<div class="meta">Opdateret ${esc(ago(S.bookingsAt))}</div>${list}`;
  }

  function stateClass(s) {
    if (/^ledig/i.test(s)) return 'ok';
    if (/reserv/i.test(s)) return 'res';
    if (/fejl|ude af drift|spærret|error/i.test(s)) return 'err';
    return 'run';
  }

  function renderStatus() {
    let html = '';
    if (S.statusBusy) html += `<div class="info">${esc(S.statusBusy)}</div>`;
    if (S.statusError) html += `<div class="error">${esc(S.statusError)}</div>`;
    if (S.status) {
      html += `<div class="meta">Opdateret ${esc(ago(S.status.at))}</div>`;
      for (const L of S.status.laundries) {
        const groups = L.groups.map((g) => `<div class="grp"><h4>${esc(g.type)}</h4>${g.machines.map((m) =>
          `<div class="mach ${stateClass(m.state)}"><span class="dot"></span><span class="m-name">${esc(m.name)}</span><span class="m-state">${esc(m.state)}</span></div>`).join('')}</div>`).join('');
        html += `<section class="card"><h3>${esc(L.name)}</h3>${groups}</section>`;
      }
    } else if (!S.statusBusy && !S.statusError) {
      html += `<p class="empty">Tryk ↻ for at hente status.</p>`;
    }
    return html;
  }

  function renderSheet() {
    const sh = S.sheet;
    if (!sh) return '';
    let inner = `<h3>${esc(shortName(sh.term))}</h3><div class="b-sub">${esc(sh.when)}</div>`;
    if (sh.phase === 'loading') inner += `<div class="info">Henter maskiner…</div>`;
    if (sh.phase === 'booking') inner += `<div class="info">Booker…</div>`;
    if (sh.phase === 'choose') {
      const mg = sh.mg;
      if (mg.quota != null) inner += `<div class="meta">Du har ${mg.quota} bestillinger tilbage</div>`;
      inner += `<div class="machines">${mg.options.map((o) => `<button class="big" data-act="machine" data-name="${esc(o.name)}" ${o.disabled ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>`;
      if (mg.random) inner += `<button class="big alt" data-act="machine" data-name="${esc(mg.random.name)}">Vælg for mig</button>`;
    }
    if (sh.phase === 'done') inner += `<div class="success">✓ Booket: ${esc(sh.msg)}</div>${sh.left != null ? `<div class="meta">${sh.left} bestillinger tilbage</div>` : ''}`;
    if (sh.phase === 'error') inner += `<div class="error">${esc(sh.msg)}</div>`;
    const closeLabel = sh.phase === 'done' ? 'Luk' : 'Annullér';
    const canClose = sh.phase !== 'booking';
    return `<div class="backdrop" data-act="${canClose ? 'close-sheet' : ''}"></div><div class="sheet">${inner}${canClose ? `<button class="link" data-act="close-sheet">${closeLabel}</button>` : ''}</div>`;
  }

  function renderLogin() {
    const c = creds();
    return `<div class="login card">
      <h2>Log ind</h2>
      <form data-form="login">
        <label>Navn<input name="user" autocomplete="username" value="${esc(c ? c.user : '')}"></label>
        <label>Adgangskode<input name="pass" type="password" autocomplete="current-password"></label>
        <label class="check"><input name="remember" type="checkbox" ${c ? 'checked' : ''}> Husk login på denne telefon</label>
        <p class="hint">Med "Husk login" gemmes navn og kode i browseren på denne telefon, så appen selv kan logge ind igen, når vasketur.dk smider dig ud.</p>
        <button class="big" type="submit">Log ind</button>
      </form>
      ${S.error ? `<div class="error">${esc(S.error)}</div>` : ''}
    </div>`;
  }

  let root;
  function render() {
    if (!root) return;
    let main;
    if (S.view === 'loading') main = `<p class="empty">Starter…</p>`;
    else if (S.view === 'login') main = renderLogin();
    else {
      main = '';
      if (S.busy) main += `<div class="info">${esc(S.busy)}</div>`;
      if (S.error) main += `<div class="error">${esc(S.error)}</div>`;
      main += S.tab === 'free' ? renderFree() : S.tab === 'mine' ? renderMine() : renderStatus();
      main += `<div class="foot"><button class="link" data-act="original">Vis den gamle side</button>${creds() ? `<button class="link" data-act="logout">Glem login</button>` : ''}</div>`;
    }
    const titles = { free: 'Ledige tider', mine: 'Mine bookinger', status: 'Status' };
    const busyNow = S.busy || S.statusBusy;
    root.innerHTML = `
      <header><h1>${S.view === 'app' ? titles[S.tab] : 'Vasketid'}</h1>
        ${S.view === 'app' ? `<button class="icon ${busyNow ? 'spin' : ''}" data-act="refresh" aria-label="Opdatér">↻</button>` : ''}</header>
      <main>${main}</main>
      ${S.view === 'app' ? `<nav>
        <button class="${S.tab === 'free' ? 'on' : ''}" data-act="tab" data-tab="free"><span>📅</span>Ledige</button>
        <button class="${S.tab === 'mine' ? 'on' : ''}" data-act="tab" data-tab="mine"><span>🧺</span>Mine${S.bookings.length ? ` (${S.bookings.length})` : ''}</button>
        <button class="${S.tab === 'status' ? 'on' : ''}" data-act="tab" data-tab="status"><span>⏱</span>Status</button>
      </nav>` : ''}
      ${renderSheet()}
      ${S.toast ? `<div class="toast">${esc(S.toast)}</div>` : ''}`;
  }

  function onClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act;
    if (!act) return;
    ev.preventDefault();
    switch (act) {
      case 'tab':
        S.tab = el.dataset.tab;
        store.set('tab', S.tab);
        S.error = '';
        render();
        if (S.tab === 'status' || (S.tab === 'mine' && !S.bookingsAt) || (S.tab === 'free' && !Object.keys(S.cal).some((k) => k.endsWith('|' + S.week)))) refreshTab();
        break;
      case 'refresh': if (!S.busy && !S.statusBusy) refreshTab(); break;
      case 'week':
        S.week = +el.dataset.w;
        render();
        if (S.terms.filter((t) => !S.hidden.includes(t)).some((t) => !S.cal[t + '|' + S.week])) refreshFree();
        break;
      case 'toggle-term': {
        const t = el.dataset.term;
        S.hidden = S.hidden.includes(t) ? S.hidden.filter((x) => x !== t) : [...S.hidden, t];
        store.set('hidden', S.hidden);
        render();
        if (!S.hidden.includes(t) && !S.cal[t + '|' + S.week]) refreshFree();
        break;
      }
      case 'book': openBooking(el.dataset.term, S.week, el.dataset.cell); break;
      case 'machine': chooseMachine(el.dataset.name); break;
      case 'close-sheet': S.sheet = null; render(); break;
      case 'cancel': doCancel(el.dataset.key); break;
      case 'logout': doLogout(); break;
      case 'original':
        session.set('off', '1');
        location.href = BASE + 'Booking/TerminalSelector.aspx';
        break;
    }
  }

  function onSubmit(ev) {
    const f = ev.target.closest('form[data-form="login"]');
    if (!f) return;
    ev.preventDefault();
    doLogin(f);
  }

  const CSS = `
  :root{--bg:#f4f5f7;--card:#fff;--fg:#1b1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#0b63ce;--ok:#15803d;--okbg:#dcfce7;--res:#b45309;--resbg:#fef3c7;--run:#1d4ed8;--runbg:#dbeafe;--err:#b91c1c;--errbg:#fee2e2}
  @media (prefers-color-scheme: dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2e36;--accent:#5aa2ff;--ok:#4ade80;--okbg:#12351f;--res:#fbbf24;--resbg:#3a2c0a;--run:#93c5fd;--runbg:#132a4f;--err:#fca5a5;--errbg:#3f1515}}
  html,body{margin:0!important;padding:0!important;background:var(--bg)!important}
  body>*:not(#vt-root){display:none!important}
  #vt-root{font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);min-height:100vh;padding-bottom:84px;-webkit-text-size-adjust:100%}
  #vt-root *{box-sizing:border-box}
  #vt-root header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
  #vt-root h1{font-size:20px;margin:0}
  #vt-root main{padding:12px 16px;max-width:640px;margin:0 auto}
  #vt-root button{font:inherit;color:inherit;cursor:pointer}
  #vt-root .icon{background:none;border:0;font-size:24px;width:44px;height:44px;border-radius:22px}
  #vt-root .spin{animation:vtspin 1s linear infinite}
  @keyframes vtspin{to{transform:rotate(360deg)}}
  #vt-root nav{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;background:var(--card);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
  #vt-root nav button{flex:1;background:none;border:0;padding:8px 0 10px;font-size:13px;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:2px}
  #vt-root nav button span{font-size:20px}
  #vt-root nav button.on{color:var(--accent);font-weight:600}
  #vt-root .chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:10px}
  #vt-root .chip{border:1px solid var(--line);background:var(--card);border-radius:18px;padding:6px 12px;white-space:nowrap;font-size:14px;color:var(--muted)}
  #vt-root .chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
  #vt-root .seg{display:flex;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:3px;margin-bottom:8px}
  #vt-root .seg button{flex:1;border:0;background:none;padding:8px;border-radius:8px;font-size:14px}
  #vt-root .seg button.on{background:var(--bg);font-weight:600}
  #vt-root .meta{font-size:13px;color:var(--muted);margin:4px 0 10px}
  #vt-root .day{margin-bottom:16px}
  #vt-root .day h3{font-size:15px;margin:0 0 6px;position:sticky;top:73px;background:var(--bg);padding:4px 0;z-index:2}
  #vt-root .row{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line)}
  #vt-root .row.none .time{color:var(--muted)}
  #vt-root .time{width:96px;flex:none;font-variant-numeric:tabular-nums;font-size:14px;padding-top:6px}
  #vt-root .slots{display:flex;flex-wrap:wrap;gap:6px}
  #vt-root .slot{font-size:13px;border-radius:8px;padding:6px 10px;border:0}
  #vt-root .slot.free{background:var(--okbg);color:var(--ok);font-weight:600}
  #vt-root .slot.taken{color:var(--muted);text-decoration:line-through;opacity:.6;padding:6px 4px}
  #vt-root .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
  #vt-root .card h3{margin:0 0 8px;font-size:16px}
  #vt-root .booking{display:flex;justify-content:space-between;align-items:center;gap:12px}
  #vt-root .b-date{font-weight:600}
  #vt-root .b-sub{color:var(--muted);font-size:14px}
  #vt-root .danger{background:var(--errbg);color:var(--err);border:0;border-radius:10px;padding:10px 14px;font-weight:600}
  #vt-root .grp h4{margin:10px 0 4px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  #vt-root .mach{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
  #vt-root .mach:last-child{border-bottom:0}
  #vt-root .dot{width:10px;height:10px;border-radius:5px;flex:none}
  #vt-root .m-name{flex:1}
  #vt-root .m-state{font-size:14px;padding:2px 8px;border-radius:6px}
  #vt-root .mach.ok .dot{background:var(--ok)} #vt-root .mach.ok .m-state{background:var(--okbg);color:var(--ok)}
  #vt-root .mach.res .dot{background:var(--res)} #vt-root .mach.res .m-state{background:var(--resbg);color:var(--res)}
  #vt-root .mach.run .dot{background:var(--run)} #vt-root .mach.run .m-state{background:var(--runbg);color:var(--run);font-weight:600}
  #vt-root .mach.err .dot{background:var(--err)} #vt-root .mach.err .m-state{background:var(--errbg);color:var(--err)}
  #vt-root .info{background:var(--runbg);color:var(--run);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:14px}
  #vt-root .error{background:var(--errbg);color:var(--err);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:14px}
  #vt-root .success{background:var(--okbg);color:var(--ok);border-radius:10px;padding:12px;margin:12px 0;font-weight:600}
  #vt-root .empty{color:var(--muted);text-align:center;padding:32px 0}
  #vt-root .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10}
  #vt-root .sheet{position:fixed;left:0;right:0;bottom:0;z-index:11;background:var(--card);border-radius:18px 18px 0 0;padding:20px 16px calc(16px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto}
  #vt-root .sheet h3{margin:0;font-size:18px}
  #vt-root .machines{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin:12px 0 8px}
  #vt-root .big{width:100%;background:var(--accent);color:#fff;border:0;border-radius:12px;padding:14px;font-weight:600;font-size:16px}
  #vt-root .big:disabled{opacity:.4}
  #vt-root .big.alt{background:var(--bg);color:var(--fg);border:1px solid var(--line)}
  #vt-root .link{background:none;border:0;color:var(--accent);padding:12px;width:100%;font-size:15px}
  #vt-root .foot{display:flex;flex-direction:column;margin-top:24px}
  #vt-root .foot .link{color:var(--muted);font-size:14px;padding:6px}
  #vt-root .login h2{margin:0 0 12px}
  #vt-root label{display:block;margin-bottom:12px;font-size:14px;color:var(--muted)}
  #vt-root input:not([type=checkbox]){display:block;width:100%;margin-top:4px;padding:12px;font-size:16px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
  #vt-root label.check{display:flex;gap:8px;align-items:center;color:var(--fg)}
  #vt-root .hint{font-size:13px;color:var(--muted);margin:0 0 14px}
  #vt-root .toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:20px;z-index:20;font-size:14px}
  `;

  function addViewport() {
    let m = document.querySelector('meta[name=viewport]');
    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
    m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  }

  function showReturnButton() {
    const b = document.createElement('button');
    b.textContent = 'Åbn Vasketid';
    b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;padding:12px 16px;border-radius:24px;border:0;background:#0b63ce;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = () => { session.del('off'); location.reload(); };
    document.body.appendChild(b);
  }

  async function init() {
    if (!document.body) return;
    if (session.get('off') === '1') { showReturnButton(); return; }
    addViewport();
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.id = 'vt-root';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    document.title = 'Vasketid';

    if (isLoginPage(document)) {
      const c = creds();
      if (!c) { S.view = 'login'; render(); return; }
      S.view = 'loading';
      render();
      try {
        await serial(() => login(c.user, c.pass));
      } catch (e) {
        S.view = 'login';
        S.error = e.message;
        render();
        return;
      }
    }
    S.view = 'app';
    render();
    refreshTab();
  }

  // Til test udefra (ingen effekt i normal brug).
  window.__vasketid = { S, render: () => render(), parseCalendar, parseStatus, parseBookings, parseTerminals, parseMachineGroup, selector, openTerminal, openCalendar, request };

  init();
})();
