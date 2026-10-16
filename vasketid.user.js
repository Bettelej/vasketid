// ==UserScript==
// @name         Vasketid
// @namespace    vasketid.nikolaj
// @version      0.2.0
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
  const ALL = '*';
  const NEXT_BTN = 'ctl00$ContentPlaceHolder1$btCalendarNext';

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

  let cur = null; // senest hentede side ({url, doc}) – udgangspunkt for postbacks
  let ctx = null; // hvor serveren står lige nu: {term, page: 'main'|'calendar', week}

  // Én kø, fordi serveren husker valgt vaskeri i sessionen. Brugerhandlinger (prio) springer
  // foran baggrundshentninger, som er delt op i små job (ét vaskeri ad gangen).
  const jobs = [];
  let running = false;
  function serial(fn, prio = false) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, prio };
      if (prio) {
        const i = jobs.findIndex((j) => !j.prio);
        jobs.splice(i < 0 ? jobs.length : i, 0, job);
      } else jobs.push(job);
      pump();
    });
  }
  // Mens en booking er i gang, må baggrundsjob ikke flytte serveren til et andet vaskeri.
  const paused = () => !!(S.sheet && S.sheet.kind === 'book' && ['loading', 'choose', 'booking'].includes(S.sheet.phase));
  async function pump() {
    if (running) return;
    running = true;
    render();
    for (;;) {
      const i = jobs.findIndex((j) => j.prio || !paused());
      if (i < 0) break;
      const j = jobs.splice(i, 1)[0];
      try { j.resolve(await j.fn()); } catch (e) { j.reject(e); }
    }
    running = false;
    render();
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
    ctx = null; // kalderen sætter den igen, når den ved hvor serveren står
    let r;
    try {
      r = await fetch(url, { credentials: 'same-origin', ...opts });
    } catch (e) {
      throw new VtError('NET', 'Ingen forbindelse til vasketur.dk. Tjek dit net.');
    }
    if (!r.ok) throw new VtError('HTTP', `vasketur.dk svarede med fejl ${r.status}`);
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
    if (isLoginPage(res.doc)) throw new VtError('BADLOGIN', 'Forkert navn eller adgangskode');
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
    const main = await postback(sel, t.pb.target, t.pb.arg); // -> BookingMain.aspx
    ctx = { term: name, page: 'main' };
    return main;
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
  async function openCalendar(main, week, term) {
    let p = await postback(main, 'ctl00$LinkBooking');
    for (let i = 0; i < week; i++) p = await clickByName(p, NEXT_BTN);
    ctx = { term, page: 'calendar', week };
    return p;
  }

  // Går til kalenderen for vaskeri/uge og genbruger hvor serveren allerede står, når det kan lade sig gøre.
  async function gotoCalendar(term, week) {
    if (ctx && cur && ctx.term === term) {
      if (ctx.page === 'calendar' && ctx.week === week) return cur;
      if (ctx.page === 'calendar' && ctx.week === week - 1) {
        const p = await clickByName(cur, NEXT_BTN);
        ctx = { term, page: 'calendar', week };
        return p;
      }
      if (ctx.page === 'main') return openCalendar(cur, week, term);
    }
    return openCalendar(await openTerminal(term), week, term);
  }

  function calendarDates(doc, week) {
    const joined = texts(doc).join(' ');
    const nums = [...joined.matchAll(/\b(Man|Tir|Ons|Tor|Fre|Lør|Søn)\s+(\d{1,2})\b/g)].slice(0, 7).map((m) => +m[2]);
    const anchor = dayTs(week * 7);
    let first = new Date(anchor);
    if (nums.length) {
      let best = null;
      for (let off = -10; off <= 10; off++) {
        const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + off);
        if (d.getDate() === nums[0] && (best == null || Math.abs(off) < Math.abs(best.off))) best = { d, off };
      }
      if (best) first = best.d;
    }
    return Array.from({ length: 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime());
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

  async function startBooking(term, week, cellId, retry = true) {
    try {
      const cal = await gotoCalendar(term, week);
      const cell = parseCalendar(cal, week).cells.find((c) => c.id === cellId);
      if (!cell || !cell.bookable) throw new VtError('GONE', 'Tiden er desværre lige blevet taget.');
      return parseMachineGroup(await postback(cal, 'BookPass' + cellId, cellId));
    } catch (e) {
      if (!retry || e.code === 'LOGIN' || e.code === 'GONE') throw e;
      ctx = null; // genvejen holdt ikke – tag den lange vej én gang
      return startBooking(term, week, cellId, false);
    }
  }

  async function confirmBooking(mg, name) {
    const p = await clickByName(mg.page, name);
    const t = texts(p.doc).join(' ');
    if (!/Bestilling OK/i.test(t)) throw new VtError('BOOK', pageMessage(p.doc) || 'Bookingen gik ikke igennem');
    const machine = (/Du har bestilt\s+(\S+(?:\s\d+)?)/i.exec(t) || [])[1];
    const left = (/Du har (\d+) bestillinger tilbage/i.exec(t) || [])[1];
    return { machine: machine || '', left: left != null ? +left : null };
  }

  async function cancelBooking(b) {
    const main = await openTerminal(b.term);
    const row = parseBookings(main).find((x) => x.key === b.key);
    if (!row) throw new VtError('GONE', 'Bookingen findes ikke længere');
    const el = main.doc.getElementsByName(row.id)[0] || main.doc.querySelector(`a[href*="${row.id}"]`);
    const p = await activate(main, el);
    const after = parseBookings(p);
    if (after.some((x) => x.key === b.key)) throw new VtError('CANCEL', pageMessage(p.doc) || 'Afbestillingen gik ikke igennem');
    return after;
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
        G = { type: 'Vaskemaskiner', machines: [] };
        L.groups.push(G);
      } else if ((m = /^Bestil (tørretumbler|tørring|tørreskab)\s*(.*)$/i.exec(t))) {
        if (!L) { L = { name: m[2] || 'Vaskeri', groups: [] }; laundries.push(L); }
        G = { type: 'Tørretumblere', machines: [] };
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
  // Tilstand og dataindlæsning
  // ---------------------------------------------------------------------------

  function dayTs(offset) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
  }

  const S = {
    view: 'loading', // loading | login | pick | app
    tab: store.get('tab2', 'book'), // book | status
    fav: store.get('fav', null), // vaskeriets navn eller ALL
    day: null, // valgt dag (timestamp)
    terms: store.get('terms', []),
    cal: store.get('cal', {}), // "navn|uge" -> {days, cells, at}
    bookMap: store.get('bookMap', {}), // vaskeri -> [{key, cells, term}]
    bookingsAt: store.get('bookingsAt', null),
    status: store.get('status', null),
    loading: false,
    statusBusy: '',
    error: '',
    statusError: '',
    sheet: null,
    toast: '',
  };

  // Gammel cache fra en anden dag giver forkerte datoer – smid den væk.
  for (const [k, c] of Object.entries(S.cal)) if (!c || !c.days || c.days[0] < dayTs(k.endsWith('|1') ? 7 : 0) - 864e5) delete S.cal[k];

  function saveCache() {
    store.set('terms', S.terms);
    store.set('cal', S.cal);
    store.set('bookMap', S.bookMap);
    store.set('bookingsAt', S.bookingsAt);
    store.set('status', S.status);
  }

  function bookings() {
    const all = Object.values(S.bookMap).flat();
    return all.sort((a, b) => {
      const da = +(parseDanishDate(a.cells[0]) || 0), db = +(parseDanishDate(b.cells[0]) || 0);
      return da - db || String(a.cells[2]).localeCompare(String(b.cells[2]));
    });
  }
  const targets = () => (S.fav === ALL ? S.terms : [S.fav]).filter(Boolean);

  function handleError(e, field = 'error') {
    if (e.code === 'LOGIN' && !creds()) {
      S.view = 'login';
      S.error = 'Du er blevet logget ud. Log ind igen.';
    } else if (e.code === 'BADLOGIN') {
      S.view = 'login';
      store.del('creds');
      S.error = e.message;
    } else {
      S[field] = e.message || String(e);
    }
    render();
  }

  async function loadTerms() {
    return serial(() => withSession(async () => {
      S.terms = parseTerminals(await selector()).map((t) => t.name);
      return S.terms;
    }));
  }

  // Ét job: vaskeriets forside (bookinger) + kalender for ugen.
  function loadCalendar(term, week) {
    return serial(() => withSession(async () => {
      let cal;
      if (ctx && ctx.term === term && ctx.page === 'calendar' && ctx.week === week - 1) {
        cal = await gotoCalendar(term, week);
      } else {
        const main = await openTerminal(term);
        S.bookMap[term] = parseBookings(main).map((b) => ({ ...b, term }));
        cal = await openCalendar(main, week, term);
      }
      S.cal[term + '|' + week] = parseCalendar(cal, week);
      render();
    }));
  }

  function loadBookingsFor(term) {
    return serial(() => withSession(async () => {
      S.bookMap[term] = parseBookings(await openTerminal(term)).map((b) => ({ ...b, term }));
      render();
    }));
  }

  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    S.loading = true;
    S.error = '';
    render();
    refreshing = (async () => {
      try {
        await loadTerms();
        if (S.fav !== ALL && !S.terms.includes(S.fav)) { S.view = 'pick'; return; }
        const t = targets();
        for (const term of t) await loadCalendar(term, 0);
        if (S.fav !== ALL) await loadCalendar(S.fav, 1);
        for (const term of S.terms.filter((x) => !t.includes(x))) await loadBookingsFor(term);
        S.bookingsAt = Date.now();
        saveCache();
      } catch (e) {
        handleError(e);
      } finally {
        S.loading = false;
        refreshing = null;
        render();
      }
    })();
    return refreshing;
  }

  // Henter næste uge for "alle vaskerier", når man vælger en dag i den.
  async function ensureWeek(week) {
    const missing = targets().filter((t) => !S.cal[t + '|' + week]);
    if (!missing.length) return;
    S.loading = true;
    render();
    try {
      for (const t of missing) await loadCalendar(t, week);
      saveCache();
    } catch (e) {
      handleError(e);
    } finally {
      S.loading = !!refreshing;
      render();
    }
  }

  async function refreshStatus() {
    if (S.statusBusy) return;
    S.statusError = '';
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      S.statusBusy = attempt === 1 ? 'Henter status… vasketur.dk er langsom her, det kan tage op til 20 sekunder.' : `Status svarede ikke. Prøver igen (${attempt} af 3)…`;
      render();
      try {
        S.status = await serial(() => withSession(loadStatusOnce), true);
        S.statusBusy = '';
        saveCache();
        render();
        return;
      } catch (e) {
        last = e;
        if (e.code === 'LOGIN' || e.code === 'BADLOGIN') break;
        await sleep(1500);
      }
    }
    S.statusBusy = '';
    if (last.code === 'LOGIN' && !creds()) {
      S.statusError = 'Status svarede ikke, og vasketur.dk loggede dig ud. Log ind igen – eller slå "Husk mig" til ved login, så klarer appen det selv.';
      render();
    } else handleError(last, 'statusError');
  }

  // ---------------------------------------------------------------------------
  // Handlinger
  // ---------------------------------------------------------------------------

  function openBooking(term, week, cellId) {
    const c = S.cal[term + '|' + week];
    const cell = c && c.cells.find((x) => x.id === cellId);
    if (!cell) return;
    S.sheet = {
      kind: 'book', phase: 'loading', waiting: running, term, week, cellId,
      day: c.days[cell.d], from: cell.from, to: cell.to,
    };
    render();
    serial(() => {
      if (S.sheet) { S.sheet.waiting = false; render(); }
      return withSession(() => startBooking(term, week, cellId));
    }, true)
      .then((mg) => { if (S.sheet && S.sheet.cellId === cellId) { S.sheet = { ...S.sheet, phase: 'choose', mg }; render(); } })
      .catch((e) => {
        if (e.code === 'LOGIN' && !creds()) { S.sheet = null; handleError(e); return; }
        if (S.sheet) { S.sheet = { ...S.sheet, phase: 'error', msg: e.message }; render(); }
      });
  }

  function chooseMachine(name) {
    const sh = S.sheet;
    if (!sh || !sh.mg || sh.phase !== 'choose') return;
    S.sheet = { ...sh, phase: 'booking' };
    render();
    serial(() => confirmBooking(sh.mg, name), true)
      .then((res) => {
        S.sheet = { ...S.sheet, phase: 'done', machine: res.machine, left: res.left };
        render();
        loadCalendar(sh.term, sh.week).then(saveCache, () => {});
      })
      .catch((e) => { S.sheet = { ...S.sheet, phase: 'error', msg: e.message }; render(); });
  }

  function closeSheet() {
    S.sheet = null;
    render();
    pump();
  }

  function askCancel(key) {
    const b = bookings().find((x) => x.key === key);
    if (b) { S.sheet = { kind: 'cancel', phase: 'confirm', b }; render(); }
  }

  function doCancel() {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'cancel') return;
    S.sheet = { ...sh, phase: 'cancelling' };
    render();
    serial(() => withSession(() => cancelBooking(sh.b)), true)
      .then((after) => {
        S.bookMap[sh.b.term] = after.map((x) => ({ ...x, term: sh.b.term }));
        S.sheet = null;
        toast('Vasketiden er afbestilt');
        saveCache();
        render();
        loadCalendar(sh.b.term, 0).then(saveCache, () => {});
      }, (e) => {
        if (e.code === 'LOGIN' && !creds()) { S.sheet = null; handleError(e); return; }
        S.sheet = { ...S.sheet, phase: 'error', msg: e.message };
        render();
      });
  }

  function doLogin(form) {
    const user = form.user.value.trim();
    const pass = form.pass.value;
    const remember = form.remember.checked;
    if (!user || !pass) { S.error = 'Udfyld navn og adgangskode.'; render(); return; }
    S.loggingIn = true;
    S.error = '';
    render();
    serial(() => login(user, pass), true).then(() => {
      if (remember) store.set('creds', { user, pass }); else store.del('creds');
      S.loggingIn = false;
      startApp();
    }, (e) => { S.loggingIn = false; S.view = 'login'; S.error = e.message; render(); });
  }

  function doForget() {
    store.del('creds');
    toast('Login glemt på denne telefon');
    render();
  }

  function setFav(name) {
    S.fav = name;
    store.set('fav', name);
    S.day = null;
    S.view = 'app';
    render();
    refresh();
  }

  function selectDay(ts) {
    S.day = ts;
    render();
    if (ts >= dayTs(7)) ensureWeek(1);
    const strip = root.querySelector('.days .on');
    if (strip) strip.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  let toastTimer;
  function toast(msg) {
    S.toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2500);
  }

  function startApp() {
    if (!S.fav) {
      S.view = 'pick';
      render();
      loadTerms().then(render, handleError);
      return;
    }
    S.view = 'app';
    render();
    refresh();
    if (S.tab === 'status') refreshStatus();
  }

  // ---------------------------------------------------------------------------
  // Visning
  // ---------------------------------------------------------------------------

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shortName = (n) => String(n || '').replace(/\s+\d.*$/, '');
  const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const shortTime = (t) => String(t || '').replace(/:00$/, '');
  function dayName(ts, long) {
    const d = new Date(ts);
    const diff = Math.round((ts - dayTs(0)) / 864e5);
    if (diff === 0) return 'I dag';
    if (diff === 1) return 'I morgen';
    return long ? cap(['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'][d.getDay()]) : cap(WEEKDAYS[d.getDay()]);
  }
  const dateLabel = (ts) => { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}`; };
  const ago = (ts) => {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'lige nu' : m < 60 ? `for ${m} min siden` : `kl. ${hhmm(ts)}`;
  };

  // Alle tider for en dag på tværs af de valgte vaskerier: [{from,to,items:[{term,cell,week}]}]
  function slotsFor(ts) {
    const week = ts >= dayTs(7) ? 1 : 0;
    const now = Date.now();
    const map = new Map();
    for (const term of targets()) {
      const c = S.cal[term + '|' + week];
      if (!c) continue;
      const d = c.days.indexOf(ts);
      if (d < 0) continue;
      for (const cell of c.cells.filter((x) => x.d === d)) {
        const [h, m] = (cell.to || '23:59').split(':').map(Number);
        if (new Date(ts).setHours(h, m) < now) continue; // forbi
        const k = cell.from + '–' + cell.to;
        if (!map.has(k)) map.set(k, { from: cell.from, to: cell.to, items: [] });
        map.get(k).items.push({ term, cell, week });
      }
    }
    return [...map.values()].sort((a, b) => a.from.localeCompare(b.from));
  }
  const freeCount = (ts) => slotsFor(ts).reduce((n, s) => n + s.items.filter((i) => i.cell.bookable).length, 0);
  const loaded = (ts) => targets().some((t) => S.cal[t + '|' + (ts >= dayTs(7) ? 1 : 0)]);

  function renderBookings() {
    const list = bookings();
    if (!list.length) {
      return S.bookingsAt ? '<p class="muted small">Du har ingen vasketider booket.</p>' : '';
    }
    return list.map((b) => {
      const [date, machine, from, to] = b.cells;
      const d = parseDanishDate(date);
      const when = d ? `${dayName(+d, true)} ${dateLabel(+d)}` : date;
      return `<div class="mybook">
        <div class="mb-main">
          <div class="mb-when">${esc(when)} · ${esc(shortTime(from))}–${esc(shortTime(to))}</div>
          <div class="mb-sub">${esc(machine || '')} · ${esc(shortName(b.term))}</div>
        </div>
        <button class="btn-ghost danger" data-act="cancel" data-key="${esc(b.key)}">Afbestil</button>
      </div>`;
    }).join('');
  }

  function renderBook() {
    const days = Array.from({ length: 14 }, (_, i) => dayTs(i));
    // Indtil man selv vælger en dag, vises den første dag med ledige tider.
    const day = S.day != null && days.includes(S.day) ? S.day : (days.find((ts) => loaded(ts) && freeCount(ts) > 0) || days[0]);
    const strip = days.map((ts) => {
      const n = loaded(ts) ? freeCount(ts) : null;
      const d = new Date(ts);
      const top = Math.round((ts - dayTs(0)) / 864e5) === 0 ? 'I dag' : cap(WEEKDAYS[d.getDay()]);
      return `<button class="dayb ${ts === day ? 'on' : ''} ${n === 0 ? 'full' : ''}" data-act="day" data-ts="${ts}">
        <span class="d-top">${esc(top)}</span><span class="d-num">${d.getDate()}</span>
        <span class="d-free">${n == null ? '·' : n === 0 ? 'fuldt' : `${n} ledig${n === 1 ? '' : 'e'}`}</span></button>`;
    }).join('');

    const slots = slotsFor(day);
    // Dine egne bookinger: tidsrummet kan stadig stå som ledigt (andre maskiner er fri), så de markeres for sig.
    const mine = new Map();
    for (const b of bookings()) {
      const d = parseDanishDate(b.cells[0]);
      if (d && +d === day) mine.set(b.term + '|' + b.cells[2], b);
    }
    let list;
    if (!loaded(day)) {
      list = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    } else if (!slots.length) {
      list = `<p class="empty">Ikke flere tider ${day === dayTs(0) ? 'i dag' : 'denne dag'}.</p>`;
    } else if (S.fav !== ALL) {
      list = slots.map((s) => {
        const it = s.items[0];
        const t = `<span class="s-time">${esc(shortTime(s.from))}<small>–${esc(shortTime(s.to))}</small></span>`;
        const own = mine.get(it.term + '|' + s.from);
        if (own) return `<div class="slot mine">${t}<span class="s-state">Din tid · ${esc(own.cells[1] || '')}</span><span class="s-ok">✓</span></div>`;
        return it.cell.bookable
          ? `<button class="slot free" data-act="book" data-term="${esc(it.term)}" data-week="${it.week}" data-cell="${esc(it.cell.id)}">${t}<span class="s-state">Ledig</span><span class="s-cta">Book</span></button>`
          : `<div class="slot taken">${t}<span class="s-state">Optaget</span></div>`;
      }).join('');
    } else {
      list = slots.map((s) => {
        const own = s.items.map((i) => mine.get(i.term + '|' + s.from)).find(Boolean);
        const free = own ? [] : s.items.filter((i) => i.cell.bookable);
        const t = `<span class="s-time">${esc(shortTime(s.from))}<small>–${esc(shortTime(s.to))}</small></span>`;
        if (own) return `<div class="slot mine">${t}<span class="s-state">Din tid · ${esc(own.cells[1] || '')} · ${esc(shortName(own.term))}</span><span class="s-ok">✓</span></div>`;
        const chips = free.length
          ? free.map((i) => `<button class="chip" data-act="book" data-term="${esc(i.term)}" data-week="${i.week}" data-cell="${esc(i.cell.id)}">${esc(shortName(i.term))}</button>`).join('')
          : '<span class="s-state">Alt optaget</span>';
        return `<div class="slot multi ${free.length ? '' : 'taken'}">${t}<div class="chips">${chips}</div></div>`;
      }).join('');
    }

    const c = targets().map((t) => S.cal[t + '|0']).filter(Boolean);
    const updated = c.length ? `Opdateret ${ago(Math.min(...c.map((x) => x.at)))}` : '';
    const myList = renderBookings();
    return `
      ${myList ? `<section class="block"><h2>Dine vasketider</h2>${myList}</section>` : ''}
      <section class="block">
        <h2>Book en tid</h2>
        <div class="days">${strip}</div>
        <div class="dayhead">${esc(dayName(day, true))} ${esc(dateLabel(day))}<span class="muted small">${esc(updated)}</span></div>
        <div class="slots">${list}</div>
      </section>`;
  }

  function stateClass(s) {
    if (/^ledig/i.test(s)) return 'ok';
    if (/reserv/i.test(s)) return 'res';
    if (/fejl|ude af drift|spærret|error/i.test(s)) return 'err';
    return 'run';
  }

  function renderStatus() {
    let html = '';
    if (S.statusBusy) html += `<div class="note">${esc(S.statusBusy)}</div>`;
    if (S.statusError) html += `<div class="alert">${esc(S.statusError)}<button class="btn-ghost" data-act="status-retry">Prøv igen</button></div>`;
    if (S.status) {
      const ls = [...S.status.laundries].sort((a, b) => (sameLaundry(b.name, S.fav) ? 1 : 0) - (sameLaundry(a.name, S.fav) ? 1 : 0));
      html += `<p class="muted small">Opdateret ${esc(ago(S.status.at))}. Viser kun om maskinen er ledig eller reserveret – restid vises, hvis vasketur.dk sender den.</p>`;
      for (const L of ls) {
        const groups = L.groups.map((g) => {
          const free = g.machines.filter((m) => stateClass(m.state) === 'ok').length;
          return `<div class="grp"><div class="grp-h">${esc(g.type)} <span class="muted">${free} af ${g.machines.length} ledige</span></div>
            <div class="machines">${g.machines.map((m) => `<div class="mach ${stateClass(m.state)}"><div class="m-name">${esc(m.name)}</div><div class="m-state">${esc(m.state)}</div></div>`).join('')}</div></div>`;
        }).join('');
        html += `<section class="block card ${sameLaundry(L.name, S.fav) ? 'fav' : ''}"><h2>${esc(L.name)}${sameLaundry(L.name, S.fav) ? ' <span class="tag">Dit vaskeri</span>' : ''}</h2>${groups}</section>`;
      }
    } else if (!S.statusBusy && !S.statusError) {
      html += `<p class="empty">Henter status…</p>`;
    }
    return html;
  }
  // Status-siden staver nogle navne lidt anderledes (fx "Sokkellundsvej"), så sammenlign løst.
  function sameLaundry(a, b) {
    if (!a || !b || b === ALL) return false;
    const norm = (s) => s.toLowerCase().replace(/[^a-zæøå0-9]/g, '').replace(/(.)\1+/g, '$1');
    return norm(a) === norm(b);
  }

  function renderPick() {
    const list = S.terms.length
      ? S.terms.map((t) => `<button class="pick" data-act="fav" data-term="${esc(t)}">${esc(t)}</button>`).join('') +
        `<button class="pick alt" data-act="fav" data-term="${ALL}">Jeg bruger flere vaskerier</button>`
      : `<div class="skeleton"></div><div class="skeleton"></div>`;
    return `<section class="block"><h2>Hvilket vaskeri bruger du?</h2><p class="muted">Så viser appen dine tider der. Du kan altid skifte øverst.</p>${list}</section>`;
  }

  function renderLogin() {
    const c = creds();
    return `<section class="block card login">
      <h2>Log ind</h2>
      <p class="muted small">Brug samme navn og adgangskode som på vasketur.dk.</p>
      <form data-form="login">
        <label>Navn<input name="user" autocomplete="username" inputmode="numeric" value="${esc(c ? c.user : '')}"></label>
        <label>Adgangskode<input name="pass" type="password" autocomplete="current-password"></label>
        <label class="check"><input name="remember" type="checkbox" checked> Husk mig på denne telefon</label>
        <button class="btn-primary" type="submit" ${S.loggingIn ? 'disabled' : ''}>${S.loggingIn ? 'Logger ind…' : 'Log ind'}</button>
      </form>
      ${S.error ? `<div class="alert">${esc(S.error)}</div>` : ''}
      <p class="muted small">"Husk mig" gemmer login i browseren på denne telefon, så appen selv kan logge ind igen, når vasketur.dk smider dig ud.</p>
    </section>`;
  }

  function renderSheet() {
    const sh = S.sheet;
    if (!sh) return '';
    let inner = '';
    let canClose = true;
    if (sh.kind === 'book') {
      inner += `<div class="sh-title">${esc(dayName(sh.day, true))} ${esc(dateLabel(sh.day))} kl. ${esc(shortTime(sh.from))}–${esc(shortTime(sh.to))}</div>
        <div class="muted">${esc(sh.term)}</div>`;
      if (sh.phase === 'loading') inner += `<div class="sh-wait"><span class="spinner"></span>${sh.waiting ? 'Venter på, at appen bliver færdig med at hente…' : 'Gør klar…'}</div>`;
      if (sh.phase === 'choose') {
        const mg = sh.mg;
        const primary = mg.random ? mg.random.name : (mg.options.find((o) => !o.disabled) || {}).name;
        inner += `<button class="btn-primary big" data-act="machine" data-name="${esc(primary)}">Book tiden</button>`;
        if (mg.options.length > 1) {
          inner += `<div class="muted small center">eller vælg selv maskine</div><div class="mchoice">${mg.options.map((o) =>
            `<button class="btn-ghost" data-act="machine" data-name="${esc(o.name)}" ${o.disabled ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>`;
        }
        if (mg.quota != null) inner += `<div class="muted small center">Du kan booke ${mg.quota} tider mere.</div>`;
      }
      if (sh.phase === 'booking') { canClose = false; inner += `<div class="sh-wait"><span class="spinner"></span>Booker…</div>`; }
      if (sh.phase === 'done') {
        inner += `<div class="success"><div class="big-check">✓</div>Du har vasketid${sh.machine ? ` på ${esc(sh.machine)}` : ''}.</div>`;
        if (sh.left != null) inner += `<div class="muted small center">Du kan booke ${sh.left} tider mere.</div>`;
        inner += `<button class="btn-primary" data-act="close-sheet">Færdig</button>`;
      }
      if (sh.phase === 'error') inner += `<div class="alert">${esc(sh.msg)}</div><button class="btn-primary" data-act="close-sheet">OK</button>`;
      if (sh.phase === 'loading' || sh.phase === 'choose') inner += `<button class="btn-link" data-act="close-sheet">Fortryd</button>`;
    } else if (sh.kind === 'cancel') {
      const [date, machine, from, to] = sh.b.cells;
      const d = parseDanishDate(date);
      inner += `<div class="sh-title">Afbestil vasketid?</div>
        <div class="muted">${esc(d ? `${dayName(+d, true)} ${dateLabel(+d)}` : date)} kl. ${esc(shortTime(from))}–${esc(shortTime(to))} · ${esc(machine || '')} · ${esc(shortName(sh.b.term))}</div>`;
      if (sh.phase === 'confirm') inner += `<button class="btn-danger big" data-act="do-cancel">Ja, afbestil</button><button class="btn-link" data-act="close-sheet">Nej, behold den</button>`;
      if (sh.phase === 'cancelling') { canClose = false; inner += `<div class="sh-wait"><span class="spinner"></span>Afbestiller…</div>`; }
      if (sh.phase === 'error') inner += `<div class="alert">${esc(sh.msg)}</div><button class="btn-primary" data-act="close-sheet">OK</button>`;
    }
    return `<div class="backdrop" ${canClose ? 'data-act="close-sheet"' : ''}></div><div class="sheet" role="dialog">${inner}</div>`;
  }

  let root;
  function render() {
    if (!root) return;
    const busy = running || S.loading || !!S.statusBusy;
    let main = '';
    if (S.view === 'loading') main = `<div class="skeleton"></div><div class="skeleton"></div>`;
    else if (S.view === 'login') main = renderLogin();
    else if (S.view === 'pick') main = renderPick();
    else {
      if (S.error) main += `<div class="alert">${esc(S.error)}<button class="btn-ghost" data-act="refresh">Prøv igen</button></div>`;
      main += S.tab === 'book' ? renderBook() : renderStatus();
      main += `<footer><button class="btn-link small" data-act="original">Åbn den gamle side</button>${creds() ? '<button class="btn-link small" data-act="forget">Glem mit login på denne telefon</button>' : ''}</footer>`;
    }
    const favSelect = S.view === 'app' && S.terms.length
      ? `<label class="favsel"><span class="sr">Vaskeri</span><select data-change="fav">${S.terms.map((t) => `<option value="${esc(t)}" ${t === S.fav ? 'selected' : ''}>${esc(t)}</option>`).join('')}<option value="${ALL}" ${S.fav === ALL ? 'selected' : ''}>Alle vaskerier</option></select></label>`
      : '';
    const scrollY = window.scrollY;
    root.innerHTML = `
      <header>
        <div class="h-row"><h1>Vasketid</h1>${favSelect}
          ${S.view === 'app' ? `<button class="icon" data-act="refresh" aria-label="Opdatér"><span class="${busy ? 'spin' : ''}">↻</span></button>` : ''}</div>
        <div class="progress ${busy ? 'on' : ''}"></div>
      </header>
      <main>${main}</main>
      ${S.view === 'app' ? `<nav>
        <button class="${S.tab === 'book' ? 'on' : ''}" data-act="tab" data-tab="book"><span class="n-ic">📅</span>Book</button>
        <button class="${S.tab === 'status' ? 'on' : ''}" data-act="tab" data-tab="status"><span class="n-ic">🧺</span>Maskiner nu</button>
      </nav>` : ''}
      ${renderSheet()}
      ${S.toast ? `<div class="toast">${esc(S.toast)}</div>` : ''}`;
    window.scrollTo(0, scrollY);
    const on = root.querySelector('.days .on');
    if (on && !render.scrolled) { on.scrollIntoView({ inline: 'center', block: 'nearest' }); render.scrolled = true; }
  }

  function onClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.disabled) return;
    ev.preventDefault();
    const act = el.dataset.act;
    switch (act) {
      case 'tab':
        S.tab = el.dataset.tab;
        store.set('tab2', S.tab);
        window.scrollTo(0, 0);
        render();
        if (S.tab === 'status' && (!S.status || Date.now() - S.status.at > 60000)) refreshStatus();
        break;
      case 'refresh':
        if (S.tab === 'status') refreshStatus(); else refresh();
        break;
      case 'status-retry': refreshStatus(); break;
      case 'day': selectDay(+el.dataset.ts); break;
      case 'book': openBooking(el.dataset.term, +el.dataset.week, el.dataset.cell); break;
      case 'machine': chooseMachine(el.dataset.name); break;
      case 'close-sheet': closeSheet(); break;
      case 'cancel': askCancel(el.dataset.key); break;
      case 'do-cancel': doCancel(); break;
      case 'fav': setFav(el.dataset.term); break;
      case 'forget': doForget(); break;
      case 'original':
        session.set('off', '1');
        location.href = BASE + 'Booking/TerminalSelector.aspx';
        break;
    }
  }

  function onChange(ev) {
    if (ev.target.matches('select[data-change="fav"]')) setFav(ev.target.value);
  }

  function onSubmit(ev) {
    const f = ev.target.closest('form[data-form="login"]');
    if (!f) return;
    ev.preventDefault();
    doLogin(f);
  }

  const CSS = `
  :root{--bg:#f3f4f6;--card:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#0a66c2;--accent-fg:#fff;--soft:#e8f1fb;
    --ok:#047857;--okbg:#d1fae5;--res:#92400e;--resbg:#fef3c7;--run:#1d4ed8;--runbg:#dbeafe;--err:#b91c1c;--errbg:#fee2e2;--shadow:0 1px 2px rgba(0,0,0,.06),0 1px 8px rgba(0,0,0,.04)}
  @media (prefers-color-scheme: dark){:root{--bg:#0d0f13;--card:#171a20;--fg:#eceef1;--muted:#9aa1ab;--line:#272b33;--accent:#5aa9ff;--accent-fg:#06121f;--soft:#14263b;
    --ok:#6ee7b7;--okbg:#0d3326;--res:#fcd34d;--resbg:#3a2c0a;--run:#93c5fd;--runbg:#132a4f;--err:#fca5a5;--errbg:#3f1515;--shadow:none}}
  html,body{margin:0!important;padding:0!important;background:var(--bg)!important}
  body>*:not(#vt-root){display:none!important}
  #vt-root{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);min-height:100vh;padding-bottom:calc(76px + env(safe-area-inset-bottom));-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
  #vt-root *{box-sizing:border-box}
  #vt-root button,#vt-root select{font:inherit;color:inherit;cursor:pointer}
  #vt-root .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  #vt-root header{position:sticky;top:0;z-index:5;background:var(--bg)}
  #vt-root .h-row{display:flex;align-items:center;gap:8px;padding:12px 16px 10px;max-width:640px;margin:0 auto}
  #vt-root h1{font-size:20px;margin:0;flex:1;letter-spacing:-.01em}
  #vt-root .favsel select{appearance:none;-webkit-appearance:none;border:1px solid var(--line);background:var(--card);border-radius:20px;padding:7px 30px 7px 12px;font-size:14px;font-weight:600;max-width:52vw;text-overflow:ellipsis;
    background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%;background-size:5px 5px;background-repeat:no-repeat}
  #vt-root .icon{background:none;border:0;font-size:22px;width:40px;height:40px;border-radius:20px;color:var(--muted);display:grid;place-items:center}
  #vt-root .spin{display:inline-block;animation:vtspin 1s linear infinite}
  @keyframes vtspin{to{transform:rotate(360deg)}}
  #vt-root .progress{height:2px;background:transparent;overflow:hidden}
  #vt-root .progress.on{background:linear-gradient(90deg,transparent,var(--accent),transparent);background-size:50% 100%;background-repeat:no-repeat;animation:vtbar 1.1s linear infinite}
  @keyframes vtbar{from{background-position:-50% 0}to{background-position:150% 0}}
  #vt-root main{padding:8px 16px 16px;max-width:640px;margin:0 auto}
  #vt-root .block{margin:8px 0 22px}
  #vt-root .block h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  #vt-root .card{background:var(--card);border-radius:16px;padding:14px;box-shadow:var(--shadow);border:1px solid var(--line)}
  #vt-root .card h2{color:var(--fg);text-transform:none;letter-spacing:0;font-size:17px}
  #vt-root .card.fav{border-color:var(--accent)}
  #vt-root .tag{font-size:12px;background:var(--soft);color:var(--accent);padding:2px 8px;border-radius:10px;vertical-align:middle;font-weight:600}
  #vt-root .muted{color:var(--muted)} #vt-root .small{font-size:13px} #vt-root .center{text-align:center}
  #vt-root .empty{color:var(--muted);text-align:center;padding:28px 0}
  #vt-root .mybook{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:12px 12px 12px 14px;margin-bottom:8px;box-shadow:var(--shadow)}
  #vt-root .mb-main{flex:1;min-width:0} #vt-root .mb-when{font-weight:700} #vt-root .mb-sub{color:var(--muted);font-size:14px}
  #vt-root .days{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x proximity;padding:2px 2px 10px;margin:0 -16px;padding-left:16px;padding-right:16px;scrollbar-width:none}
  #vt-root .days::-webkit-scrollbar{display:none}
  #vt-root .dayb{flex:none;width:66px;border:1px solid var(--line);background:var(--card);border-radius:14px;padding:8px 0;display:flex;flex-direction:column;align-items:center;gap:1px;scroll-snap-align:center}
  #vt-root .d-top{font-size:12px;color:var(--muted)} #vt-root .d-num{font-size:20px;font-weight:700;line-height:1.2} #vt-root .d-free{font-size:11px;color:var(--ok);font-weight:600}
  #vt-root .dayb.full .d-free{color:var(--muted);font-weight:400}
  #vt-root .dayb.on{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
  #vt-root .dayb.on .d-top,#vt-root .dayb.on .d-free{color:var(--accent-fg);opacity:.9}
  #vt-root .dayhead{display:flex;justify-content:space-between;align-items:baseline;font-weight:700;font-size:17px;margin:4px 0 8px}
  #vt-root .slots{display:flex;flex-direction:column;gap:8px}
  #vt-root .slot{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border-radius:14px;padding:14px;border:1px solid var(--line);background:var(--card);min-height:58px}
  #vt-root .s-time{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;width:76px;flex:none}
  #vt-root .s-time small{font-size:14px;font-weight:500;color:var(--muted)}
  #vt-root .s-state{flex:1;font-size:15px}
  #vt-root .slot.free{border-color:transparent;background:var(--okbg);color:var(--ok)}
  #vt-root .slot.free .s-time small{color:inherit;opacity:.75}
  #vt-root .s-cta{background:var(--ok);color:var(--card);font-weight:700;padding:8px 16px;border-radius:10px;font-size:15px}
  #vt-root .slot.taken{background:transparent;color:var(--muted)}
  #vt-root .slot.mine{background:var(--soft);border-color:var(--accent);color:var(--accent);font-weight:600}
  #vt-root .s-ok{width:32px;height:32px;border-radius:16px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;font-weight:700}
  #vt-root .slot.taken .s-time{color:var(--muted)}
  #vt-root .slot.multi{flex-wrap:wrap;align-items:flex-start}
  #vt-root .slot.multi .chips{flex:1;display:flex;flex-wrap:wrap;gap:6px}
  #vt-root .chip{border:0;background:var(--okbg);color:var(--ok);font-weight:600;border-radius:10px;padding:8px 12px;font-size:14px}
  #vt-root .skeleton{height:58px;border-radius:14px;background:linear-gradient(90deg,var(--line),var(--card),var(--line));background-size:200% 100%;animation:vtsk 1.2s ease-in-out infinite;margin-bottom:8px}
  @keyframes vtsk{from{background-position:100% 0}to{background-position:-100% 0}}
  #vt-root .grp{margin-top:10px} #vt-root .grp-h{font-weight:600;font-size:14px;margin-bottom:6px;display:flex;justify-content:space-between}
  #vt-root .machines{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px}
  #vt-root .mach{border-radius:12px;padding:10px;text-align:center}
  #vt-root .m-name{font-weight:700;font-size:15px} #vt-root .m-state{font-size:13px}
  #vt-root .mach.ok{background:var(--okbg);color:var(--ok)} #vt-root .mach.res{background:var(--resbg);color:var(--res)}
  #vt-root .mach.run{background:var(--runbg);color:var(--run)} #vt-root .mach.err{background:var(--errbg);color:var(--err)}
  #vt-root .note{background:var(--soft);color:var(--accent);border-radius:12px;padding:12px;margin-bottom:12px;font-size:14px}
  #vt-root .alert{background:var(--errbg);color:var(--err);border-radius:12px;padding:12px;margin:10px 0;font-size:14px;display:flex;align-items:center;gap:10px;justify-content:space-between}
  #vt-root .btn-primary,#vt-root .btn-danger{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-weight:700;font-size:16px;margin-top:14px}
  #vt-root .btn-primary{background:var(--accent);color:var(--accent-fg)} #vt-root .btn-danger{background:var(--err);color:#fff}
  #vt-root .btn-primary:disabled{opacity:.5}
  #vt-root .big{padding:17px;font-size:17px}
  #vt-root .btn-ghost{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:9px 14px;font-weight:600;font-size:14px;flex:none}
  #vt-root .btn-ghost.danger{color:var(--err)}
  #vt-root .btn-ghost:disabled{opacity:.4}
  #vt-root .btn-link{display:block;width:100%;background:none;border:0;color:var(--accent);padding:14px;font-size:15px}
  #vt-root .mchoice{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:8px 0 12px}
  #vt-root .pick{display:block;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;font-size:17px;font-weight:600;margin-bottom:8px}
  #vt-root .pick.alt{font-weight:400;color:var(--muted)}
  #vt-root .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10;animation:vtfade .15s ease-out}
  #vt-root .sheet{position:fixed;left:0;right:0;bottom:0;z-index:11;background:var(--card);border-radius:22px 22px 0 0;padding:22px 18px calc(10px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto;animation:vtup .18s ease-out}
  @keyframes vtup{from{transform:translateY(30px);opacity:.5}} @keyframes vtfade{from{opacity:0}}
  #vt-root .sh-title{font-size:20px;font-weight:700;margin-bottom:2px}
  #vt-root .sh-wait{display:flex;align-items:center;gap:10px;color:var(--muted);padding:22px 0}
  #vt-root .spinner{width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:vtspin .8s linear infinite;flex:none}
  #vt-root .success{text-align:center;font-size:18px;font-weight:700;color:var(--ok);padding:14px 0 4px}
  #vt-root .big-check{width:56px;height:56px;border-radius:28px;background:var(--okbg);display:grid;place-items:center;margin:0 auto 10px;font-size:30px}
  #vt-root .login label{display:block;margin:12px 0;font-size:14px;color:var(--muted)}
  #vt-root .login input:not([type=checkbox]){display:block;width:100%;margin-top:4px;padding:13px;font-size:16px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg)}
  #vt-root .login label.check{display:flex;gap:10px;align-items:center;color:var(--fg);font-size:15px}
  #vt-root .login input[type=checkbox]{width:20px;height:20px}
  #vt-root nav{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;background:var(--card);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
  #vt-root nav button{flex:1;background:none;border:0;padding:8px 0 10px;font-size:13px;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:2px}
  #vt-root nav .n-ic{font-size:21px;filter:grayscale(1);opacity:.7}
  #vt-root nav button.on{color:var(--accent);font-weight:700} #vt-root nav button.on .n-ic{filter:none;opacity:1}
  #vt-root footer{margin-top:24px;border-top:1px solid var(--line);padding-top:8px}
  #vt-root footer .btn-link{color:var(--muted);padding:8px}
  #vt-root .toast{position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:11px 18px;border-radius:22px;z-index:20;font-size:14px;font-weight:600;white-space:nowrap}
  `;

  function addViewport() {
    let m = document.querySelector('meta[name=viewport]');
    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
    m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  }

  function showReturnButton() {
    const b = document.createElement('button');
    b.textContent = 'Tilbage til Vasketid';
    b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;padding:12px 16px;border-radius:24px;border:0;background:#0a66c2;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = () => { session.del('off'); location.href = BASE + 'Booking/TerminalSelector.aspx'; };
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
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    document.title = 'Vasketid';
    let meta = document.querySelector('meta[name=theme-color]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = matchMedia('(prefers-color-scheme: dark)').matches ? '#0d0f13' : '#f3f4f6';

    if (isLoginPage(document)) {
      const c = creds();
      if (!c) { S.view = 'login'; render(); return; }
      render();
      try {
        await serial(() => login(c.user, c.pass), true);
      } catch (e) {
        S.view = 'login';
        S.error = e.message;
        render();
        return;
      }
    }
    startApp();
  }

  // Til test udefra (ingen effekt i normal brug).
  window.__vasketid = { S, render: () => render(), refresh, parseCalendar, parseStatus, parseBookings, parseTerminals };

  init();
})();
