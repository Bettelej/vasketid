// ==UserScript==
// @name         Vasketid
// @namespace    vasketid.nikolaj
// @version      0.5.6
// @description  Mobilvenligt UI til vasketur.dk (Electrolux web booking): find tid i dine foretrukne vaskerier, book flere maskiner på én gang, se maskinstatus.
// @match        https://web.vasketur.dk/DB0073/*
// @grant        none
// @inject-into  page
// @run-at       document-end
// @noframes
// @homepageURL  https://bettelej.github.io/vasketid/
// @downloadURL  https://bettelej.github.io/vasketid/vasketid.user.js
// @updateURL    https://bettelej.github.io/vasketid/vasketid.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BASE = (location.pathname.match(/^\/[^/]+\//) || ['/DB0073/'])[0];
  const KEY = 'vt:';
  const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
  const WEEKDAYS_LONG = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };
  const NEXT_BTN = 'ctl00$ContentPlaceHolder1$btCalendarNext';
  const HELP_URL = 'https://bettelej.github.io/vasketid/';
  // Vaskerierne i den rækkefølge de ligger ned ad bakken – bruges når der skal vises en neutral liste.
  const HILL_ORDER = ['Sokkelundsvej', 'Rytterbakken', 'Svendelodden', 'Mesterstien', 'Smedetoften'];

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
  let sessTerm = null; // vaskeriet serveren har valgt i sessionen (overlever sideskift)

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
  // Mens bookingvinduet er åbent, må baggrundsjob ikke flytte serveren til et andet vaskeri.
  const paused = () => !!(S.sheet && S.sheet.kind === 'book' && S.sheet.phase !== 'done');
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
      sessTerm = null;
      throw new VtError('SERVER', pageMessage(doc) || 'Fejl hos vasketur.dk');
    }
    if (!allowLogin && isLoginPage(doc)) {
      cur = null;
      sessTerm = null;
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
    sessTerm = null;
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
    sessTerm = name;
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
    // Serveren har stadig vaskeriet valgt (fx efter en booking): gå direkte via "Bestille"-linket.
    if (sessTerm === term && cur && cur.doc.querySelector('a[href*="LinkBooking"]')) return openCalendar(cur, week, term);
    return openCalendar(await openTerminal(term), week, term);
  }

  function calendarDates(doc, week) {
    const joined = texts(doc).join(' ');
    const nums = [...joined.matchAll(/\b(Man|Tir|Ons|Tor|Fre|Lør|Søn)\s+(\d{1,2})\b/g)].slice(0, 7).map((m) => +m[2]);
    let first = new Date(dayTs(week * 7));
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
      .map((e) => ({ name: e.name, label: e.value.trim(), disabled: e.disabled || /aspNetDisabled/.test(e.className) }));
    const rnd = page.doc.querySelector('input[name$="btMaskingruppRandom"]');
    if (!options.length && !rnd) throw new VtError('BOOK', pageMessage(page.doc) || 'Ingen ledige maskiner');
    return { page, quota: quota != null ? +quota : null, options, random: rnd ? { name: rnd.name } : null };
  }

  // Åbner maskinvalget for et tidsrum. Booker ikke noget – det sker først ved klik på en maskine.
  async function startBooking(term, week, cellId, retry = true) {
    try {
      const cal = await gotoCalendar(term, week);
      const cell = parseCalendar(cal, week).cells.find((c) => c.id === cellId);
      if (!cell || !cell.bookable) throw new VtError('GONE', 'Tiden er ikke længere ledig her.');
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
    const left = (/Du har (\d+) bestillinger tilbage/i.exec(t) || [])[1];
    return { left: left != null ? +left : null };
  }

  // Booker flere maskiner i samme tidsrum, én ad gangen. Returnerer hvad der lykkedes og evt. fejl.
  async function bookMachines(term, week, cellId, labels, first, onProgress) {
    const done = [];
    let mg = first;
    let left = null;
    for (const label of labels) {
      onProgress(done.length + 1, labels.length);
      try {
        if (!mg) mg = await startBooking(term, week, cellId);
        const opt = mg.options.find((o) => o.label === label && !o.disabled);
        if (!opt) throw new VtError('BOOK', `${label} er ikke længere ledig.`);
        left = (await confirmBooking(mg, opt.name)).left;
        done.push(label);
      } catch (e) {
        return { done, left, error: e };
      } finally {
        mg = null;
      }
    }
    return { done, left, error: null };
  }

  // Afbestiller flere bookinger i samme vaskeri. Returnerer vaskeriets bookinger bagefter.
  async function cancelMany(term, keys) {
    let page = await openTerminal(term);
    const failed = [];
    for (const key of keys) {
      const row = parseBookings(page).find((x) => x.key === key);
      if (!row) continue; // allerede væk
      const el = page.doc.getElementsByName(row.id)[0] || page.doc.querySelector(`a[href*="${row.id}"]`);
      try {
        page = await activate(page, el);
        if (parseBookings(page).some((x) => x.key === key)) failed.push(key);
      } catch (e) {
        failed.push(key);
        if (e.code === 'LOGIN') throw e;
        page = await openTerminal(term);
      }
    }
    ctx = { term, page: 'main' };
    return { after: parseBookings(page), failed };
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
        G.machines.push({ name: m[1].replace(/^(Vask|Tør)(\d)/, '$1 $2'), state: m[2].trim(), detail: '' });
      } else if (G && G.machines.length && (m = /^(?:VASK|TØRRE|TØR)\s*\d+\s+(.+)$/i.exec(t))) {
        G.machines[G.machines.length - 1].detail = m[1].trim();
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
      sessTerm = t.name;
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
  const weekOf = (ts) => (ts >= dayTs(7) ? 1 : 0);
  const shortName = (n) => String(n || '').replace(/\s+\d.*$/, '');
  // Status-siden staver nogle navne lidt anderledes (fx "Sokkellundsvej"), så sammenlign løst.
  const norm = (s) => shortName(s).toLowerCase().replace(/[^a-zæøå]/g, '').replace(/(.)\1+/g, '$1');
  const sameLaundry = (a, b) => !!a && !!b && norm(a) === norm(b);

  const S = {
    view: 'loading', // loading | login | setup | app
    setupPick: [], // vaskerier valgt i førstegangsopsætningen
    tab: store.get('tab3', 'book'), // book | status
    order: store.get('order', null), // vaskerinavne i prioriteret rækkefølge
    count: store.get('count', 2), // antal maskiner man plejer at booke
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

  // Kalendere fra en tidligere dag har forskudte datoer – smid dem væk.
  for (const [k, c] of Object.entries(S.cal)) if (!c || !c.days || c.days[0] < dayTs(k.endsWith('|1') ? 7 : 0) - 864e5) delete S.cal[k];

  function saveCache() {
    store.set('terms', S.terms);
    store.set('cal', S.cal);
    store.set('bookMap', S.bookMap);
    store.set('bookingsAt', S.bookingsAt);
    store.set('status', S.status);
  }

  // Brugerens valgte vaskerier i prioriteret rækkefølge. Kun dem hentes og vises.
  function ordered() {
    if (!S.order) return [];
    return S.order.map((o) => S.terms.find((t) => sameLaundry(o, t))).filter(Boolean);
  }
  function hillRank(t) { const i = HILL_ORDER.findIndex((h) => sameLaundry(h, t)); return i < 0 ? 99 : i; }
  const byHill = (list) => [...list].sort((a, b) => hillRank(a) - hillRank(b));
  const unselected = () => { const o = ordered(); return byHill(S.terms.filter((t) => !o.includes(t))); };

  function bookingDate(b) { const d = parseDanishDate(b.cells[0]); return d ? +d : null; }

  // Bookinger samlet pr. dag+tid+vaskeri: [{day, from, to, term, items:[booking]}]
  function bookingGroups() {
    const map = new Map();
    const mine = ordered();
    for (const b of Object.values(S.bookMap).flat().filter((x) => mine.includes(x.term))) {
      const day = bookingDate(b);
      const k = `${day}|${b.cells[2]}|${b.term}`;
      if (!map.has(k)) map.set(k, { day, from: b.cells[2], to: b.cells[3], term: b.term, items: [] });
      map.get(k).items.push(b);
    }
    const groups = [...map.values()];
    groups.forEach((g) => g.items.sort((a, b) => String(a.cells[1]).localeCompare(String(b.cells[1]), 'da', { numeric: true })));
    return groups.sort((a, b) => (a.day || 0) - (b.day || 0) || String(a.from).localeCompare(String(b.from)));
  }

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

  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    S.loading = true;
    S.error = '';
    render();
    refreshing = (async () => {
      try {
        await loadTerms();
        for (const term of ordered()) {
          await loadCalendar(term, 0);
          await loadCalendar(term, 1);
        }
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
  // Tidsrum for en dag
  // ---------------------------------------------------------------------------

  // [{from, to, week, items:[{term, cell}] (i prioriteret rækkefølge), own: bookingGroup|null}]
  function slotsFor(ts) {
    const week = weekOf(ts);
    const now = Date.now();
    const map = new Map();
    for (const term of ordered()) {
      const c = S.cal[term + '|' + week];
      if (!c) continue;
      const d = c.days.indexOf(ts);
      if (d < 0) continue;
      for (const cell of c.cells.filter((x) => x.d === d)) {
        const [h, m] = (cell.to || '23:59').split(':').map(Number);
        if (new Date(ts).setHours(h, m) < now) continue; // forbi
        const k = cell.from + '–' + cell.to;
        if (!map.has(k)) map.set(k, { from: cell.from, to: cell.to, week, items: [], own: [] });
        map.get(k).items.push({ term, cell });
      }
    }
    const groups = bookingGroups().filter((g) => g.day === ts);
    for (const s of map.values()) s.own = groups.filter((g) => g.from === s.from);
    return [...map.values()].sort((a, b) => a.from.localeCompare(b.from));
  }
  const loadedDay = (ts) => ordered().some((t) => S.cal[t + '|' + weekOf(ts)]);
  const freeSlots = (ts) => slotsFor(ts).filter((s) => s.items.some((i) => i.cell.bookable)).length;

  // ---------------------------------------------------------------------------
  // Handlinger
  // ---------------------------------------------------------------------------

  // Åbner bookingvinduet for et tidsrum og undersøger det første vaskeri (i din rækkefølge) med plads.
  function openBooking(fromKey, ts) {
    const slot = slotsFor(ts).find((s) => s.from === fromKey);
    if (!slot) return;
    const cands = slot.items.filter((i) => i.cell.bookable).map((i) => ({ term: i.term, cellId: i.cell.id }));
    if (!cands.length) return;
    S.sheet = { kind: 'book', phase: 'choose', day: ts, from: slot.from, to: slot.to, week: slot.week, cands, idx: 0, probes: {}, sel: [] };
    render();
    probe(0);
  }

  function probe(idx) {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'book') return;
    sh.idx = idx;
    const c = sh.cands[idx];
    const p = sh.probes[c.term];
    if (p && p.state === 'ok') { preselect(); render(); return; }
    sh.probes[c.term] = { state: 'loading', waiting: running };
    render();
    serial(() => {
      if (S.sheet === sh) { sh.probes[c.term].waiting = false; render(); }
      return withSession(() => startBooking(c.term, sh.week, c.cellId));
    }, true).then((mg) => {
      if (S.sheet !== sh) return;
      sh.probes[c.term] = { state: 'ok', mg, at: Date.now() };
      sh.lastProbe = c.term; // serveren står nu på dette vaskeris maskinvalg
      if (sh.idx === idx) preselect();
      render();
    }, (e) => {
      if (S.sheet !== sh) return;
      if (e.code === 'LOGIN' && !creds()) { S.sheet = null; handleError(e); return; }
      sh.probes[c.term] = { state: 'error', msg: e.message };
      render();
    });
  }

  function freeLabels(mg) { return mg.options.filter((o) => !o.disabled).map((o) => o.label); }

  function preselect() {
    const sh = S.sheet;
    const p = sh.probes[sh.cands[sh.idx].term];
    if (!p || p.state !== 'ok') { sh.sel = []; return; }
    sh.sel = freeLabels(p.mg).slice(0, S.count);
  }

  function toggleMachine(label) {
    const sh = S.sheet;
    if (!sh || sh.phase !== 'choose') return;
    sh.sel = sh.sel.includes(label) ? sh.sel.filter((x) => x !== label) : [...sh.sel, label];
    render();
  }

  function setCount(n) {
    S.count = Math.max(1, Math.min(8, n));
    store.set('count', S.count);
    if (S.sheet && S.sheet.kind === 'book' && S.sheet.phase === 'choose') preselect();
    render();
  }

  function doBook() {
    const sh = S.sheet;
    if (!sh || sh.phase !== 'choose' || !sh.sel.length) return;
    const c = sh.cands[sh.idx];
    const p = sh.probes[c.term];
    if (!p || p.state !== 'ok') return;
    const labels = freeLabels(p.mg).filter((l) => sh.sel.includes(l)); // i maskinrækkefølge
    sh.phase = 'booking';
    sh.term = c.term;
    sh.progress = `Booker ${labels[0]}…`;
    render();
    // Maskinvalgs-siden er kun gyldig, hvis serveren ikke har flyttet sig siden (gælder kun det senest undersøgte vaskeri).
    const fresh = sh.lastProbe === c.term ? p.mg : null;
    serial(() => bookMachines(c.term, sh.week, c.cellId, labels, fresh, (i, n) => {
      sh.progress = n > 1 ? `Booker maskine ${i} af ${n}…` : 'Booker…';
      render();
    }), true).then((res) => {
      sh.phase = 'done';
      sh.result = res;
      render();
      loadCalendar(c.term, sh.week).then(saveCache, () => {});
    }, (e) => {
      sh.phase = 'done';
      sh.result = { done: [], left: null, error: e };
      render();
    });
  }

  function closeSheet() {
    S.sheet = null;
    render();
    pump();
  }

  function askCancel(gi) {
    const g = bookingGroups()[gi];
    if (g) { S.sheet = { kind: 'cancel', phase: 'confirm', g, sel: g.items.map((b) => b.key) }; render(); }
  }

  function toggleCancel(key) {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'cancel' || sh.phase !== 'confirm') return;
    sh.sel = sh.sel.includes(key) ? sh.sel.filter((k) => k !== key) : [...sh.sel, key];
    render();
  }

  function doCancel() {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'cancel' || !sh.sel.length) return;
    sh.phase = 'cancelling';
    render();
    serial(() => withSession(() => cancelMany(sh.g.term, sh.sel)), true)
      .then(({ after, failed }) => {
        S.bookMap[sh.g.term] = after.map((x) => ({ ...x, term: sh.g.term }));
        saveCache();
        if (failed.length) {
          S.sheet = { ...sh, phase: 'error', msg: `${failed.length} af ${sh.sel.length} kunne ikke afbestilles. Prøv igen.` };
        } else {
          S.sheet = null;
          toast(sh.sel.length > 1 ? `${sh.sel.length} maskiner afbestilt` : 'Afbestilt');
        }
        render();
        loadCalendar(sh.g.term, weekOf(sh.g.day || 0)).then(saveCache, () => {});
      }, (e) => {
        if (e.code === 'LOGIN' && !creds()) { S.sheet = null; handleError(e); return; }
        S.sheet = { ...sh, phase: 'error', msg: e.message };
        render();
      });
  }

  function moveOrder(term, dir) {
    const list = ordered();
    const i = list.indexOf(term);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    S.order = list.map(shortName);
    store.set('order', S.order);
    render();
  }

  function toggleLaundry(term) {
    const list = ordered();
    if (list.includes(term)) {
      if (list.length === 1) return; // mindst ét vaskeri
      S.order = list.filter((t) => t !== term).map(shortName);
    } else {
      S.order = [...list, term].map(shortName);
    }
    store.set('order', S.order);
    render();
    if (!list.includes(term)) refresh();
  }

  function pickSetup(term) {
    S.setupPick = S.setupPick.includes(term) ? S.setupPick.filter((t) => t !== term) : [...S.setupPick, term];
    render();
  }

  function finishSetup() {
    if (!S.setupPick.length) return;
    S.order = S.setupPick.map(shortName);
    store.set('order', S.order);
    startApp();
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
    S.sheet = null;
    toast('Login glemt på denne telefon');
    render();
  }

  function selectDay(ts) {
    S.day = ts;
    render();
  }

  let toastTimer;
  function toast(msg) {
    S.toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2500);
  }

  function startApp() {
    if (!S.order || !S.order.length) {
      S.view = 'setup';
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
  const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const shortTime = (t) => String(t || '').replace(/:00$/, '');
  const span = (from, to) => `${shortTime(from)}–${shortTime(to)}`;
  function dayName(ts, long) {
    const diff = Math.round((ts - dayTs(0)) / 864e5);
    if (diff === 0) return 'I dag';
    if (diff === 1) return 'I morgen';
    const d = new Date(ts);
    return cap((long ? WEEKDAYS_LONG : WEEKDAYS)[d.getDay()]);
  }
  const dateLabel = (ts) => { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}`; };
  const fullDay = (ts) => (ts == null ? '' : `${dayName(ts, true)} ${dateLabel(ts)}`);
  const ago = (ts) => {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'lige nu' : m < 60 ? `for ${m} min siden` : `kl. ${hhmm(ts)}`;
  };
  const machineList = (labels) => {
    const nums = labels.map((l) => (/(\d+)/.exec(l) || [])[1]);
    if (labels.length > 1 && nums.every(Boolean) && labels.every((l) => /^Vask/i.test(l))) return `Vask ${nums.join(', ')}`;
    return labels.join(', ');
  };

  function renderBookings() {
    const groups = bookingGroups();
    if (!groups.length) return S.bookingsAt ? '<p class="muted small">Du har ingen vasketider booket.</p>' : '';
    return groups.map((g, i) => `<div class="mybook">
        <div class="mb-main">
          <div class="mb-when">${esc(fullDay(g.day))} · ${esc(span(g.from, g.to))}</div>
          <div class="mb-sub">${esc(shortName(g.term))} · ${esc(machineList(g.items.map((b) => b.cells[1])))}</div>
        </div>
        <button class="btn-ghost danger" data-act="cancel" data-i="${i}">Afbestil</button>
      </div>`).join('');
  }

  function renderBook() {
    const days = Array.from({ length: 14 }, (_, i) => dayTs(i));
    const day = S.day != null && days.includes(S.day) ? S.day : (days.find((ts) => loadedDay(ts) && freeSlots(ts) > 0) || days[0]);
    const ownDays = new Set(bookingGroups().map((g) => g.day));
    const strip = days.map((ts) => {
      const n = loadedDay(ts) ? freeSlots(ts) : null;
      const d = new Date(ts);
      const top = Math.round((ts - dayTs(0)) / 864e5) === 0 ? 'I dag' : cap(WEEKDAYS[d.getDay()]);
      return `<button class="dayb ${ts === day ? 'on' : ''} ${n === 0 ? 'full' : ''}" data-act="day" data-ts="${ts}">
        ${ownDays.has(ts) ? '<span class="d-dot" title="Du har en tid"></span>' : ''}
        <span class="d-top">${esc(top)}</span><span class="d-num">${d.getDate()}</span>
        <span class="d-free">${n == null ? '·' : n === 0 ? 'fuldt' : `${n} tid${n === 1 ? '' : 'er'}`}</span></button>`;
    }).join('');

    const slots = slotsFor(day);
    let list;
    if (!loadedDay(day)) {
      list = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    } else if (!slots.length) {
      list = `<p class="empty">Ikke flere tider ${day === dayTs(0) ? 'i dag' : 'denne dag'}.</p>`;
    } else {
      const top = ordered()[0];
      list = slots.map((s) => {
        const t = `<span class="s-time">${esc(shortTime(s.from))}<small>–${esc(shortTime(s.to))}</small></span>`;
        if (s.own.length) {
          const g = s.own[0];
          return `<div class="slot mine">${t}<span class="s-main"><b>Din tid</b><small>${esc(shortName(g.term))} · ${esc(machineList(g.items.map((b) => b.cells[1])))}</small></span><span class="s-ok">✓</span></div>`;
        }
        const free = s.items.filter((i) => i.cell.bookable);
        if (!free.length) return `<div class="slot taken">${t}<span class="s-main">Alt optaget</span></div>`;
        const best = free[0].term;
        const others = free.slice(1).map((i) => shortName(i.term));
        const sub = best === top
          ? (others.length ? `Også: ${others.join(', ')}` : 'Kun ledig her')
          : `${shortName(top)} optaget${others.length ? ` · også: ${others.join(', ')}` : ''}`;
        return `<button class="slot free ${best === top ? '' : 'alt'}" data-act="book" data-from="${esc(s.from)}" data-ts="${day}">${t}
          <span class="s-main"><b>${esc(shortName(best))}</b><small>${esc(sub)}</small></span><span class="s-cta">Book</span></button>`;
      }).join('');
    }

    const c = S.terms.map((t) => S.cal[t + '|0']).filter(Boolean);
    const updated = c.length ? `Opdateret ${ago(Math.min(...c.map((x) => x.at)))}` : '';
    return `
      <section class="block">
        <h2>Book vask</h2>
        <div class="days">${strip}</div>
        <div class="dayhead">${esc(fullDay(day))}<span class="muted small">${esc(updated)}</span></div>
        <div class="slots">${list}</div>
      </section>`;
  }

  function renderMine() {
    const list = renderBookings();
    if (!list) return '<p class="empty">Henter dine vasketider…</p>';
    if (!bookingGroups().length) {
      return `<section class="block"><h2>Dine vasketider</h2>${list}
        <button class="btn-primary" data-act="tab" data-tab="book">Book en tid</button></section>`;
    }
    return `<section class="block"><h2>Dine vasketider</h2>${list}</section>`;
  }

  function stateClass(s) {
    if (/^ledig/i.test(s)) return 'ok';
    if (/reserv/i.test(s)) return 'res';
    if (/fejl|ude af drift|spærret|error/i.test(s)) return 'err';
    return 'run';
  }

  // Minutter fra nu til et klokkeslæt i dag (håndterer midnat).
  function minutesUntil(hm) {
    const [h, m] = hm.split(':').map(Number);
    const now = new Date();
    let diff = h * 60 + m - (now.getHours() * 60 + now.getMinutes());
    if (diff < -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    return diff;
  }

  // Vasketiderne (pas) – fra kalenderen hvis den er hentet, ellers foreningens faste tider.
  const DEFAULT_PASSES = [['07:00', '09:00'], ['09:00', '11:00'], ['11:00', '13:00'], ['13:00', '15:00'], ['15:00', '17:00'], ['17:00', '19:00'], ['19:00', '20:30']];
  const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  function passes() {
    const c = Object.values(S.cal).find((x) => x && x.cells && x.cells.length);
    if (c) {
      const map = new Map();
      c.cells.forEach((x) => { if (x.from && x.to) map.set(x.from, x.to); });
      if (map.size) return [...map].sort((x, y) => toMin(x[0]) - toMin(y[0]));
    }
    return DEFAULT_PASSES;
  }
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const passNow = () => passes().find(([f, t]) => toMin(f) <= nowMin() && nowMin() < toMin(t)) || null;
  const nextPass = () => passes().find(([f]) => toMin(f) > nowMin()) || passes()[0];

  // Status svarer på ét spørgsmål: kan maskinen bruges lige nu?
  // "Reserveret" fra vasketur.dk betyder booket i den igangværende – eller, uden for vasketiderne, den næste – vasketid.
  function machineView(m) {
    const d = m.detail || '';
    let r;
    if ((r = /Klar\s*ca\.?:?\s*(\d{1,2}[:.]\d{2})/i.exec(d))) {
      const hm = r[1].replace('.', ':');
      const left = minutesUntil(hm);
      return { cls: 'run', label: 'I brug', sub: `klar ca. ${hm}${left > 0 ? ` · om ${left} min` : ' · snart færdig'}` };
    }
    if ((r = /Start\w*\s*(\d{1,2}[:.]\d{2})/i.exec(d))) {
      const since = -minutesUntil(r[1].replace('.', ':'));
      return { cls: 'run', label: 'I brug', sub: since > 0 ? `i gang i ${since} min` : 'lige startet' };
    }
    const cls = stateClass(m.state);
    if (cls === 'err') return { cls, label: m.state, sub: '' };
    const last = (r = /Afsluttedes\s*(\d{1,2}[:.]\d{2})/i.exec(d)) ? `sidst brugt ${r[1].replace('.', ':')}` : '';
    if (cls === 'res') {
      const cur = passNow();
      if (cur) return { cls: 'res', label: 'Booket nu', sub: `til kl. ${shortTime(cur[1])}` };
      return { cls: 'ok', label: 'Ledig', sub: `booket fra kl. ${shortTime(nextPass()[0])}` };
    }
    if (cls === 'ok') return { cls, label: 'Ledig', sub: last };
    return { cls, label: m.state, sub: last || d };
  }

  function renderStatus() {
    let html = '';
    if (S.statusBusy) html += `<div class="note"><span class="spinner"></span>${esc(S.statusBusy)}</div>`;
    if (S.statusError) html += `<div class="alert">${esc(S.statusError)}<button class="btn-ghost" data-act="status-retry">Prøv igen</button></div>`;
    if (S.status) {
      const order = ordered();
      const rank = (n) => { const i = order.findIndex((t) => sameLaundry(t, n)); return i < 0 ? 50 + hillRank(n) : i; };
      const ls = [...S.status.laundries].sort((a, b) => rank(a.name) - rank(b.name));
      html += `<p class="muted small">Opdateret ${esc(ago(S.status.at))}.</p>`;
      for (const L of ls) {
        const groups = L.groups.map((g) => {
          const views = g.machines.map((m) => ({ m, v: machineView(m) }));
          const free = views.filter((x) => x.v.cls === 'ok').length;
          const busy = views.filter((x) => x.v.cls === 'run').length;
          return `<div class="grp"><div class="grp-h">${esc(g.type)} <span class="muted">${free} af ${g.machines.length} ledige nu${busy ? ` · ${busy} i brug` : ''}</span></div>
            <div class="machines">${views.map(({ m, v }) => `<div class="mach ${v.cls}"><div class="m-name">${esc(m.name)}</div><div class="m-state">${esc(v.label)}</div>${v.sub ? `<div class="m-sub">${esc(v.sub).replace(/ · /g, '<br>')}</div>` : ''}</div>`).join('')}</div></div>`;
        }).join('');
        // Status-siden staver nogle navne forkert (fx "Sokkellundsvej") – vis navnet fra vaskeri-listen.
        const name = S.terms.find((t) => sameLaundry(t, L.name)) || L.name;
        html += `<section class="block card"><h2>${esc(name)}</h2>${groups}</section>`;
      }
    } else if (!S.statusBusy && !S.statusError) {
      html += '<p class="empty">Henter status…</p>';
    }
    return html;
  }

  function renderLogin() {
    const c = creds();
    return `<section class="block card login">
      <h2>Log ind</h2>
      <p class="muted small">Brug samme navn og adgangskode som på vasketur.dk.</p>
      <form data-form="login">
        <label>Navn<input name="user" autocomplete="username" inputmode="numeric" value="${esc(c ? c.user : '')}"></label>
        <label>Adgangskode<input name="pass" type="password" autocomplete="current-password"></label>
        <label class="check"><input name="remember" type="checkbox" ${c ? 'checked' : ''}> Husk mig på denne telefon</label>
        <button class="btn-primary" type="submit" ${S.loggingIn ? 'disabled' : ''}>${S.loggingIn ? 'Logger ind…' : 'Log ind'}</button>
      </form>
      ${S.error ? `<div class="alert">${esc(S.error)}</div>` : ''}
      <p class="muted small">"Husk mig" gemmer login i browseren på denne telefon, så appen selv kan logge ind igen, når vasketur.dk smider dig ud.</p>
    </section>`;
  }

  function renderBookSheet(sh) {
    let h = `<div class="sh-title">${esc(fullDay(sh.day))} kl. ${esc(span(sh.from, sh.to))}</div>`;
    if (sh.phase === 'choose') {
      // Vaskeri-valg (kun dem med plads, i din rækkefølge)
      h += `<div class="seg-l">${sh.cands.map((c, i) => `<button class="${i === sh.idx ? 'on' : ''}" data-act="probe" data-i="${i}">${esc(shortName(c.term))}</button>`).join('')}</div>`;
      const c = sh.cands[sh.idx];
      const p = sh.probes[c.term] || {};
      if (p.state === 'loading') {
        h += `<div class="sh-wait"><span class="spinner"></span>${p.waiting ? 'Venter på, at appen bliver færdig med at hente…' : `Ser hvilke maskiner der er ledige på ${esc(shortName(c.term))}…`}</div>`;
      } else if (p.state === 'error') {
        h += `<div class="alert">${esc(p.msg)}</div>`;
        if (sh.idx + 1 < sh.cands.length) h += `<button class="btn-ghost wide" data-act="probe" data-i="${sh.idx + 1}">Prøv ${esc(shortName(sh.cands[sh.idx + 1].term))}</button>`;
      } else if (p.state === 'ok') {
        const free = freeLabels(p.mg);
        h += `<div class="countrow"><span>Antal maskiner</span><span class="stepper"><button data-act="count" data-d="-1" aria-label="Færre">−</button><b>${S.count}</b><button data-act="count" data-d="1" aria-label="Flere">+</button></span></div>`;
        h += `<div class="mgrid">${p.mg.options.map((o) => {
          const on = sh.sel.includes(o.label);
          return `<button class="mbtn ${on ? 'on' : ''}" data-act="machine" data-label="${esc(o.label)}" ${o.disabled ? 'disabled' : ''}>${esc(o.label)}<small>${o.disabled ? 'optaget' : on ? 'valgt' : 'ledig'}</small></button>`;
        }).join('')}</div>`;
        if (free.length < S.count) {
          const next = sh.cands[sh.idx + 1];
          h += `<div class="hint">Kun ${free.length} ledig${free.length === 1 ? '' : 'e'} her.${next ? ` <button class="btn-inline" data-act="probe" data-i="${sh.idx + 1}">Se ${esc(shortName(next.term))}</button>` : ''}</div>`;
        }
        const n = sh.sel.length;
        h += `<button class="btn-primary big" data-act="do-book" ${n ? '' : 'disabled'}>${n ? `Book ${n === 1 ? esc(sh.sel[0]) : `${n} maskiner`}` : 'Vælg mindst én maskine'}</button>`;
        if (p.mg.quota != null) h += `<div class="muted small center">Du kan booke ${p.mg.quota} maskine${p.mg.quota === 1 ? '' : 'r'} mere i alt.</div>`;
      }
      h += '<button class="btn-link" data-act="close-sheet">Fortryd</button>';
    } else if (sh.phase === 'booking') {
      h += `<div class="sh-wait"><span class="spinner"></span>${esc(sh.progress || 'Booker…')}</div>`;
    } else if (sh.phase === 'done') {
      const r = sh.result;
      if (r.done.length) {
        h += `<div class="success"><div class="big-check">✓</div>Booket på ${esc(shortName(sh.term))}:<br>${esc(machineList(r.done))}</div>`;
      }
      if (r.error) h += `<div class="alert">${r.done.length ? 'Resten gik ikke igennem: ' : ''}${esc(r.error.message)}</div>`;
      if (r.left != null) h += `<div class="muted small center">Du kan booke ${r.left} maskine${r.left === 1 ? '' : 'r'} mere i alt.</div>`;
      h += '<button class="btn-primary" data-act="close-sheet">Færdig</button>';
    }
    return h;
  }

  function renderCancelSheet(sh) {
    const g = sh.g;
    let h = `<div class="sh-title">Afbestil vasketid?</div><div class="muted">${esc(fullDay(g.day))} kl. ${esc(span(g.from, g.to))} · ${esc(shortName(g.term))}</div>`;
    if (sh.phase === 'confirm') {
      if (g.items.length > 1) {
        h += `<div class="mgrid">${g.items.map((b) => {
          const on = sh.sel.includes(b.key);
          return `<button class="mbtn danger ${on ? 'on' : ''}" data-act="toggle-cancel" data-key="${esc(b.key)}">${esc(b.cells[1])}<small>${on ? 'afbestilles' : 'beholdes'}</small></button>`;
        }).join('')}</div>`;
      }
      const n = sh.sel.length;
      h += `<button class="btn-danger big" data-act="do-cancel" ${n ? '' : 'disabled'}>${n === g.items.length ? (n > 1 ? `Ja, afbestil alle ${n}` : 'Ja, afbestil') : `Afbestil ${n} maskine${n === 1 ? '' : 'r'}`}</button>`;
      h += '<button class="btn-link" data-act="close-sheet">Nej, behold</button>';
    } else if (sh.phase === 'cancelling') {
      h += '<div class="sh-wait"><span class="spinner"></span>Afbestiller…</div>';
    } else if (sh.phase === 'error') {
      h += `<div class="alert">${esc(sh.msg)}</div><button class="btn-primary" data-act="close-sheet">OK</button>`;
    }
    return h;
  }

  function renderSettingsSheet() {
    const list = ordered();
    const rest = unselected();
    let h = '<div class="sh-title">Indstillinger</div><p class="muted small">Dine vaskerier – appen foreslår altid det øverste med plads. Træk i ≡ for at ændre rækkefølgen.</p>';
    h += `<div class="order">${list.map((t, i) => `<div class="o-row"><span class="o-handle" aria-label="Træk for at flytte">${GRIP}</span><span class="o-n">${i + 1}</span><span class="o-name">${esc(t)}</span>
      <button class="btn-rm" data-act="toggle-laundry" data-term="${esc(t)}" ${list.length === 1 ? 'disabled' : ''}>Fjern</button></div>`).join('')}</div>`;
    if (rest.length) {
      h += `<p class="muted small">Tilføj vaskeri:</p><div class="addrow">${rest.map((t) => `<button class="btn-ghost" data-act="toggle-laundry" data-term="${esc(t)}">+ ${esc(shortName(t))}</button>`).join('')}</div>`;
    }
    h += `<div class="countrow"><span>Antal maskiner jeg plejer at booke</span><span class="stepper"><button data-act="count" data-d="-1">−</button><b>${S.count}</b><button data-act="count" data-d="1">+</button></span></div>`;
    h += '<button class="btn-primary" data-act="close-sheet">Færdig</button>';
    h += `<div class="sh-foot"><a class="btn-link small" href="${HELP_URL}" target="_blank" rel="noopener">Hjælp og vejledning</a><button class="btn-link small" data-act="original">Åbn den gamle side</button>`;
    if (creds()) h += '<button class="btn-link small" data-act="forget">Glem mit login på denne telefon</button>';
    h += '</div>';
    return h;
  }

  function renderSetup() {
    const list = S.terms.length
      ? byHill(S.terms).map((t) => {
        const n = S.setupPick.indexOf(t) + 1;
        return `<button class="pick ${n ? 'on' : ''}" data-act="pick" data-term="${esc(t)}"><span class="o-n">${n || ''}</span>${esc(t)}</button>`;
      }).join('')
      : '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    const n = S.setupPick.length;
    return `<section class="block">
      <h2>Velkommen til Vasketid</h2>
      <p><b>Hvilke vaskerier bruger du?</b><br><span class="muted">Tryk på dem i den rækkefølge, du foretrækker. Appen foreslår altid nr. 1 først og går videre til nr. 2, hvis der er fuldt.</span></p>
      ${list}
      <button class="btn-primary big" data-act="setup-done" ${n ? '' : 'disabled'}>${n ? 'Fortsæt' : 'Vælg mindst ét vaskeri'}</button>
      <p class="muted small center">Du kan altid ændre det under ⚙.</p>
    </section>`;
  }

  function renderSheet(opening) {
    const sh = S.sheet;
    if (!sh) return '';
    const anim = opening ? ' anim' : '';
    const inner = sh.kind === 'book' ? renderBookSheet(sh) : sh.kind === 'cancel' ? renderCancelSheet(sh) : renderSettingsSheet();
    const canClose = !(sh.phase === 'booking' || sh.phase === 'cancelling');
    const x = canClose ? '<button class="sh-close" data-act="close-sheet" aria-label="Luk">✕</button>' : '';
    return `<div class="backdrop${anim}" ${canClose ? 'data-act="close-sheet"' : ''}></div><div class="sheet${anim}" role="dialog">${x}${inner}</div>`;
  }

  // Ikoner fra Tabler Icons (MIT-licens), tegnet som inline SVG så de ser ens ud på alle telefoner.
  const svg = (body) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    mine: svg('<path d="M3.5 5.5l1.5 1.5l2.5 -2.5"/><path d="M3.5 11.5l1.5 1.5l2.5 -2.5"/><path d="M3.5 17.5l1.5 1.5l2.5 -2.5"/><path d="M11 6h9"/><path d="M11 12h9"/><path d="M11 18h9"/>'),
    book: svg('<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M9 12h6"/><path d="M12 9v6"/>'),
    status: svg('<path d="M5 5a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"/><path d="M8 14a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M8 6h.01"/><path d="M11 6h.01"/><path d="M14 6h2"/><path d="M8 14c1.333 -.667 2.667 -.667 4 0c1.333 .667 2.667 .667 4 0"/>'),
  };

  let root;
  const GRIP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';

  let drag = null;
  function onPointerDown(ev) {
    const handle = ev.target.closest('.o-handle');
    if (!handle) return;
    const row = handle.closest('.o-row');
    const rows = [...row.parentElement.children];
    drag = { row, rows, startY: ev.clientY, from: rows.indexOf(row), to: rows.indexOf(row), step: row.getBoundingClientRect().height };
    row.classList.add('dragging');
    handle.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }
  function onPointerMove(ev) {
    if (!drag) return;
    const dy = ev.clientY - drag.startY;
    drag.row.style.transform = `translateY(${dy}px)`;
    const to = Math.max(0, Math.min(drag.rows.length - 1, Math.round(drag.from + dy / drag.step)));
    if (to === drag.to) return;
    drag.to = to;
    drag.rows.forEach((r, i) => {
      if (r === drag.row) return;
      let shift = 0;
      if (drag.from < to && i > drag.from && i <= to) shift = -drag.step;
      if (drag.from > to && i < drag.from && i >= to) shift = drag.step;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }
  function onPointerUp() {
    if (!drag) return;
    const { from, to } = drag;
    drag = null;
    if (from !== to) {
      const list = ordered();
      const [t] = list.splice(from, 1);
      list.splice(to, 0, t);
      S.order = list.map(shortName);
      store.set('order', S.order);
    }
    lastParts.sheet = undefined; // tegn listen forfra i den nye rækkefølge
    render();
  }

  // Skærmen består af faste dele; kun de dele, hvis indhold har ændret sig, tegnes forfra.
  // Så hopper et åbent vindue ikke, når der kommer nye data i baggrunden.
  const lastParts = {};
  let sheetWasOpen = false;
  function render() {
    if (!root) return;
    const busy = running || S.loading || !!S.statusBusy;
    let main = '';
    if (S.view === 'loading') main = '<div class="skeleton"></div><div class="skeleton"></div>';
    else if (S.view === 'login') main = renderLogin();
    else if (S.view === 'setup') main = renderSetup();
    else {
      if (S.error) main += `<div class="alert">${esc(S.error)}<button class="btn-ghost" data-act="refresh">Prøv igen</button></div>`;
      main += S.tab === 'book' ? renderBook() : S.tab === 'mine' ? renderMine() : renderStatus();
    }
    const sheet = renderSheet(!!S.sheet && !sheetWasOpen);
    sheetWasOpen = !!S.sheet;
    const parts = {
      header: `<div class="h-row"><h1>Vasketid</h1>
          ${S.view === 'app' ? `<button class="icon" data-act="refresh" aria-label="Opdatér"><span class="${busy ? 'spin' : ''}">↻</span></button>
          <button class="icon" data-act="settings" aria-label="Indstillinger">⚙</button>` : ''}</div>
        <div class="progress ${busy ? 'on' : ''}"></div>`,
      main,
      nav: S.view === 'app' ? `<nav>
        <button class="${S.tab === 'mine' ? 'on' : ''}" data-act="tab" data-tab="mine">${ICONS.mine}<span>Mine</span>${bookingGroups().length ? `<span class="badge">${bookingGroups().length}</span>` : ''}</button>
        <button class="${S.tab === 'book' ? 'on' : ''}" data-act="tab" data-tab="book">${ICONS.book}<span>Book</span></button>
        <button class="${S.tab === 'status' ? 'on' : ''}" data-act="tab" data-tab="status">${ICONS.status}<span>Status</span></button>
      </nav>` : '',
      sheet,
      toast: S.toast ? `<div class="toast">${esc(S.toast)}</div>` : '',
    };
    if (!root.firstChild) {
      root.innerHTML = '<header data-part="header"></header><div class="scroll"><main data-part="main"></main></div><div class="part" data-part="nav"></div><div class="part" data-part="sheet"></div><div class="part" data-part="toast"></div>';
    }
    for (const [k, html] of Object.entries(parts)) {
      // Animationen må kun køre, når vinduet åbnes – ikke ved hver opdatering af det.
      const cmp = k === 'sheet' ? html.replace(/ anim"/g, '"') : html;
      if (lastParts[k] === cmp) continue;
      if (k === 'sheet' && drag) continue; // ikke midt i et træk
      const el = root.querySelector(`[data-part="${k}"]`);
      if (k === 'main') {
        const daysEl = el.querySelector('.days');
        const daysX = daysEl ? daysEl.scrollLeft : null;
        el.innerHTML = html;
        const newDays = el.querySelector('.days');
        if (newDays) {
          if (daysX != null) newDays.scrollLeft = daysX;
          else {
            const on = newDays.querySelector('.on');
            if (on) newDays.scrollLeft += on.getBoundingClientRect().left - newDays.getBoundingClientRect().left - (newDays.clientWidth - on.clientWidth) / 2;
          }
        }
      } else if (k === 'sheet') {
        const old = el.querySelector('.sheet');
        const top = old ? old.scrollTop : 0;
        el.innerHTML = html;
        const nw = el.querySelector('.sheet');
        if (nw && old) nw.scrollTop = top;
      } else {
        el.innerHTML = html;
      }
      lastParts[k] = cmp;
    }
  }

  function onClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.disabled) return;
    ev.preventDefault();
    const act = el.dataset.act;
    switch (act) {
      case 'tab':
        S.tab = el.dataset.tab;
        store.set('tab3', S.tab);
        { const sc = root.querySelector('.scroll'); if (sc) sc.scrollTop = 0; }
        render();
        if (S.tab === 'status' && (!S.status || Date.now() - S.status.at > 60000)) refreshStatus();
        break;
      case 'refresh':
        if (S.tab === 'status') refreshStatus(); else refresh();
        break;
      case 'status-retry': refreshStatus(); break;
      case 'settings': S.sheet = { kind: 'settings' }; render(); break;
      case 'day': selectDay(+el.dataset.ts); break;
      case 'book': openBooking(el.dataset.from, +el.dataset.ts); break;
      case 'probe': probe(+el.dataset.i); break;
      case 'machine': toggleMachine(el.dataset.label); break;
      case 'count': setCount(S.count + +el.dataset.d); break;
      case 'do-book': doBook(); break;
      case 'close-sheet': closeSheet(); break;
      case 'cancel': askCancel(+el.dataset.i); break;
      case 'toggle-cancel': toggleCancel(el.dataset.key); break;
      case 'do-cancel': doCancel(); break;
      case 'move': moveOrder(el.dataset.term, +el.dataset.d); break;
      case 'toggle-laundry': toggleLaundry(el.dataset.term); break;
      case 'pick': pickSetup(el.dataset.term); break;
      case 'setup-done': finishSetup(); break;
      case 'forget': doForget(); break;
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
  :root{--bg:#f3f4f6;--card:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#0a66c2;--accent-fg:#fff;--soft:#e8f1fb;
    --ok:#047857;--okbg:#d1fae5;--alt:#4d7c0f;--altbg:#ecfccb;--res:#92400e;--resbg:#fef3c7;--run:#1d4ed8;--runbg:#dbeafe;--err:#b91c1c;--errbg:#fee2e2;--shadow:0 1px 2px rgba(0,0,0,.06),0 1px 8px rgba(0,0,0,.04)}
  @media (prefers-color-scheme: dark){:root{--bg:#0d0f13;--card:#171a20;--fg:#eceef1;--muted:#9aa1ab;--line:#272b33;--accent:#5aa9ff;--accent-fg:#06121f;--soft:#14263b;
    --ok:#6ee7b7;--okbg:#0d3326;--alt:#bef264;--altbg:#1f2e0c;--res:#fcd34d;--resbg:#3a2c0a;--run:#93c5fd;--runbg:#132a4f;--err:#fca5a5;--errbg:#3f1515;--shadow:none}}
  html,body{margin:0!important;padding:0!important;background:var(--bg)!important;height:100%!important;overflow:hidden!important;overscroll-behavior:none}
  body>*:not(#vt-root){display:none!important}
  #vt-root{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
  #vt-root *{box-sizing:border-box}
  #vt-root button{font:inherit;color:inherit;cursor:pointer}
  #vt-root header{flex:none;z-index:5;background:var(--bg)}
  #vt-root .h-row{display:flex;align-items:center;gap:4px;padding:12px 10px 10px 16px;max-width:640px;margin:0 auto}
  #vt-root h1{font-size:21px;margin:0;flex:1;letter-spacing:-.01em}
  #vt-root .icon{background:none;border:0;font-size:22px;width:44px;height:44px;border-radius:22px;color:var(--muted);display:grid;place-items:center}
  #vt-root .spin{display:inline-block;animation:vtspin 1s linear infinite}
  @keyframes vtspin{to{transform:rotate(360deg)}}
  #vt-root .progress{height:2px;background:transparent;overflow:hidden}
  #vt-root .progress.on{background:linear-gradient(90deg,transparent,var(--accent),transparent);background-size:50% 100%;background-repeat:no-repeat;animation:vtbar 1.1s linear infinite}
  @keyframes vtbar{from{background-position:-50% 0}to{background-position:150% 0}}
  #vt-root main{padding:8px 16px 16px;max-width:640px;margin:0 auto}
  #vt-root .block{margin:8px 0 22px}
  #vt-root .block h2{font-size:14px;margin:0 0 10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  #vt-root .card{background:var(--card);border-radius:16px;padding:14px;box-shadow:var(--shadow);border:1px solid var(--line)}
  #vt-root .card h2{color:var(--fg);text-transform:none;letter-spacing:0;font-size:17px}
  #vt-root .muted{color:var(--muted)} #vt-root .small{font-size:13px} #vt-root .center{text-align:center}
  #vt-root .empty{color:var(--muted);text-align:center;padding:28px 0}
  #vt-root .mybook{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:12px 12px 12px 14px;margin-bottom:8px;box-shadow:var(--shadow)}
  #vt-root .mb-main{flex:1;min-width:0} #vt-root .mb-when{font-weight:700} #vt-root .mb-sub{color:var(--muted);font-size:14px}
  #vt-root .days{display:flex;gap:8px;overflow-x:auto;padding:4px 16px 10px;margin:0 -16px;scrollbar-width:none}
  #vt-root .days::-webkit-scrollbar{display:none}
  #vt-root .dayb{position:relative;flex:none;width:64px;border:1px solid var(--line);background:var(--card);border-radius:14px;padding:8px 0;display:flex;flex-direction:column;align-items:center;gap:1px}
  #vt-root .d-top{font-size:12px;color:var(--muted)} #vt-root .d-num{font-size:20px;font-weight:700;line-height:1.2} #vt-root .d-free{font-size:11px;color:var(--ok);font-weight:600}
  #vt-root .d-dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:4px;background:var(--accent)}
  #vt-root .dayb.full .d-free{color:var(--muted);font-weight:400}
  #vt-root .dayb.on{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
  #vt-root .dayb.on .d-top,#vt-root .dayb.on .d-free{color:var(--accent-fg);opacity:.9}
  #vt-root .dayb.on .d-dot{background:var(--accent-fg)}
  #vt-root .dayhead{display:flex;justify-content:space-between;align-items:baseline;font-weight:700;font-size:17px;margin:6px 0 8px}
  #vt-root .slots{display:flex;flex-direction:column;gap:8px}
  #vt-root .slot{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border-radius:14px;padding:10px 10px 10px 12px;border:1px solid var(--line);background:var(--card);min-height:62px}
  #vt-root .s-time{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;width:66px;flex:none;white-space:nowrap}
  #vt-root .s-time small{font-size:14px;font-weight:500;opacity:.7}
  #vt-root .s-main{flex:1;min-width:0;display:flex;flex-direction:column}
  #vt-root .s-main b{font-size:16px;overflow-wrap:anywhere} #vt-root .s-main small{font-size:13px;opacity:.8;line-height:1.3}
  #vt-root .slot.free{border-color:transparent;background:var(--okbg);color:var(--ok)}
  #vt-root .slot.free.alt{background:var(--altbg);color:var(--alt)}
  #vt-root .s-cta{background:currentColor;border-radius:10px;padding:8px 12px;font-size:15px;font-weight:700;flex:none}
  #vt-root .s-cta{color:var(--card)} #vt-root .slot.free .s-cta{background:var(--ok)} #vt-root .slot.free.alt .s-cta{background:var(--alt)}
  #vt-root .slot.taken{background:transparent;color:var(--muted)}
  #vt-root .slot.mine{background:var(--soft);border-color:var(--accent);color:var(--accent)}
  #vt-root .s-ok{width:32px;height:32px;border-radius:16px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;font-weight:700;flex:none}
  #vt-root .skeleton{height:62px;border-radius:14px;background:linear-gradient(90deg,var(--line),var(--card),var(--line));background-size:200% 100%;animation:vtsk 1.2s ease-in-out infinite;margin-bottom:8px}
  @keyframes vtsk{from{background-position:100% 0}to{background-position:-100% 0}}
  #vt-root .grp{margin-top:10px} #vt-root .grp-h{font-weight:600;font-size:14px;margin-bottom:6px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 8px} #vt-root .grp-h span{white-space:nowrap}
  #vt-root .machines{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px}
  #vt-root .mach{border-radius:12px;padding:10px;text-align:center}
  #vt-root .m-name{font-weight:700;font-size:15px} #vt-root .m-state{font-size:13px} #vt-root .m-sub{font-size:12px;opacity:.8;margin-top:2px}
  #vt-root .mach.ok{background:var(--okbg);color:var(--ok)} #vt-root .mach.res{background:var(--resbg);color:var(--res)}
  #vt-root .mach.run{background:var(--runbg);color:var(--run)} #vt-root .mach.err{background:var(--errbg);color:var(--err)}
  #vt-root .note{display:flex;gap:10px;align-items:center;background:var(--soft);color:var(--accent);border-radius:12px;padding:12px;margin-bottom:12px;font-size:14px}
  #vt-root .alert{background:var(--errbg);color:var(--err);border-radius:12px;padding:12px;margin:10px 0;font-size:14px;display:flex;align-items:center;gap:10px;justify-content:space-between}
  #vt-root .hint{background:var(--resbg);color:var(--res);border-radius:12px;padding:10px 12px;margin:10px 0;font-size:14px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  #vt-root .btn-inline{border:0;background:var(--card);color:var(--res);font-weight:700;border-radius:8px;padding:6px 10px;font-size:14px}
  #vt-root .btn-primary,#vt-root .btn-danger{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-weight:700;font-size:16px;margin-top:12px}
  #vt-root .btn-primary{background:var(--accent);color:var(--accent-fg)} #vt-root .btn-danger{background:var(--err);color:#fff}
  #vt-root .btn-primary:disabled,#vt-root .btn-danger:disabled{opacity:.45}
  #vt-root .big{padding:17px;font-size:17px}
  #vt-root .btn-ghost{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:9px 14px;font-weight:600;font-size:14px;flex:none}
  #vt-root .btn-ghost.wide{width:100%;margin-top:6px}
  #vt-root .btn-ghost.danger{color:var(--err)}
  #vt-root .btn-link{display:block;width:100%;background:none;border:0;color:var(--accent);padding:12px;font-size:15px}
  #vt-root .btn-icon{width:40px;height:40px;border:1px solid var(--line);background:var(--card);border-radius:10px;font-size:18px}
  #vt-root .btn-icon:disabled{opacity:.3}
  #vt-root .btn-rm{height:40px;border:1px solid var(--line);background:var(--card);color:var(--err);border-radius:10px;padding:0 10px;font-size:14px;font-weight:600}
  #vt-root .btn-rm:disabled{opacity:.3}
  #vt-root .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10}
  #vt-root .backdrop.anim{animation:vtfade .15s ease-out}
  #vt-root .sheet.anim{animation:vtup .18s ease-out}
  #vt-root .part{flex:none}
  #vt-root .sheet{position:fixed;left:0;right:0;bottom:0;z-index:11;background:var(--card);border-radius:22px 22px 0 0;padding:20px 18px calc(8px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto;max-height:90vh;overflow-y:auto}
  @keyframes vtup{from{transform:translateY(30px);opacity:.5}} @keyframes vtfade{from{opacity:0}}
  #vt-root .sh-title{font-size:20px;font-weight:700;margin-bottom:4px;padding-right:44px}
  #vt-root .sh-close{position:absolute;top:12px;right:12px;width:40px;height:40px;border-radius:20px;border:0;background:var(--bg);color:var(--muted);font-size:18px;display:grid;place-items:center}
  #vt-root .seg-l{display:flex;gap:6px;overflow-x:auto;margin:12px 0 4px;scrollbar-width:none}
  #vt-root .seg-l button{flex:none;border:1px solid var(--line);background:var(--bg);border-radius:20px;padding:8px 14px;font-size:14px;font-weight:600}
  #vt-root .seg-l button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
  #vt-root .countrow{display:flex;justify-content:space-between;align-items:center;margin:14px 0 8px;font-size:15px}
  #vt-root .stepper{display:flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:12px;padding:2px}
  #vt-root .stepper button{width:40px;height:36px;border:0;background:none;font-size:20px;border-radius:10px}
  #vt-root .stepper b{min-width:22px;text-align:center;font-size:17px}
  #vt-root .mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(62px,1fr));gap:8px;margin:8px 0}
  #vt-root .mbtn{border:2px solid var(--line);background:var(--card);border-radius:14px;padding:12px 6px;font-weight:700;font-size:15px;display:flex;flex-direction:column;align-items:center;gap:2px}
  #vt-root .mbtn small{font-weight:500;font-size:12px;color:var(--muted)}
  #vt-root .mbtn.on{border-color:var(--ok);background:var(--okbg);color:var(--ok)} #vt-root .mbtn.on small{color:var(--ok)}
  #vt-root .mbtn.danger.on{border-color:var(--err);background:var(--errbg);color:var(--err)} #vt-root .mbtn.danger.on small{color:var(--err)}
  #vt-root .mbtn:disabled{opacity:.4;text-decoration:line-through}
  #vt-root .sh-wait{display:flex;align-items:center;gap:10px;color:var(--muted);padding:22px 0}
  #vt-root .spinner{width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:vtspin .8s linear infinite;flex:none;display:inline-block}
  #vt-root .success{text-align:center;font-size:18px;font-weight:700;color:var(--ok);padding:14px 0 4px}
  #vt-root .big-check{width:56px;height:56px;border-radius:28px;background:var(--okbg);display:grid;place-items:center;margin:0 auto 10px;font-size:30px}
  #vt-root .pick{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;font-size:17px;font-weight:600;margin-bottom:8px}
  #vt-root .pick .o-n{background:var(--bg);border:1px solid var(--line);flex:none}
  #vt-root .pick.on{border-color:var(--accent);background:var(--soft)}
  #vt-root .pick.on .o-n{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
  #vt-root .addrow{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
  #vt-root .sh-foot a.btn-link{text-align:center;text-decoration:none}
  #vt-root .order{margin:10px 0}
  #vt-root .o-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);background:var(--card);transition:transform .15s ease;position:relative}
  #vt-root .o-row.dragging{transition:none;z-index:3;box-shadow:0 4px 16px rgba(0,0,0,.18);border-radius:10px}
  #vt-root .o-handle{width:40px;height:40px;display:grid;place-items:center;color:var(--muted);cursor:grab;touch-action:none;flex:none}
  #vt-root .o-row.dragging .o-handle{cursor:grabbing;color:var(--accent)}
  #vt-root .o-n{width:24px;height:24px;border-radius:12px;background:var(--soft);color:var(--accent);display:grid;place-items:center;font-size:13px;font-weight:700}
  #vt-root .o-name{flex:1;font-weight:600}
  #vt-root .sh-foot{margin-top:10px;border-top:1px solid var(--line);padding-top:4px}
  #vt-root .sh-foot .btn-link{color:var(--muted);padding:8px}
  #vt-root .login label{display:block;margin:12px 0;font-size:14px;color:var(--muted)}
  #vt-root .login input:not([type=checkbox]){display:block;width:100%;margin-top:4px;padding:13px;font-size:16px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg)}
  #vt-root .login label.check{display:flex;gap:10px;align-items:center;color:var(--fg);font-size:15px}
  #vt-root .login input[type=checkbox]{width:20px;height:20px}
  #vt-root .scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  #vt-root nav{flex:none;z-index:6;display:flex;background:var(--card);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
  #vt-root nav button{position:relative;flex:1;background:none;border:0;padding:8px 0 9px;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:2px;font-size:12px}
  #vt-root nav button.on{color:var(--accent);font-weight:600}
  #vt-root nav .badge{position:absolute;top:4px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:11px;font-weight:700;display:grid;place-items:center}
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
    root.addEventListener('submit', onSubmit);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
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
  window.__vasketid = { S, render: () => render(), refresh, slotsFor, bookingGroups, ordered, parseStatus, machineView };

  init();
})();
