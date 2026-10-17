// ==UserScript==
// @name         Vasketid
// @namespace    vasketid.nikolaj
// @version      0.8.6
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
  const VERSION = '0.8.6'; // skal matche @version øverst
  const SCRIPT_URL = 'https://bettelej.github.io/vasketid/vasketid.user.js';
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
    activity = null;
    render();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Hvad appen venter på lige nu (vises nederst og i bookingvinduet med sekunder).
  let activity = null;
  function step(label) {
    activity = { label, since: Date.now() };
    render();
  }

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
    // Tidsgrænse: hænger vasketur.dk, giver vi op efter 12 sek. i stedet for at vente på browseren.
    const ctrl = new AbortController();
    const { timeout = 12000, ...fetchOpts } = opts;
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      r = await fetch(url, { credentials: 'same-origin', ...fetchOpts, signal: ctrl.signal });
    } catch (e) {
      throw new VtError('NET', e.name === 'AbortError' ? 'vasketur.dk svarer ikke lige nu. Prøv igen.' : 'Ingen forbindelse til vasketur.dk. Tjek dit net.');
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new VtError('HTTP', `vasketur.dk svarede med fejl ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const page = { url: r.url, doc };
    if (/\/ErrorPages\//i.test(r.url)) {
      cur = null;
      sessTerm = null;
      const raw = pageMessage(doc);
      if (/ingen kontakt med systemet/i.test(raw)) {
        throw new VtError('OFFLINE', 'vasketur.dk har ikke forbindelse til vaskerierne lige nu. Prøv igen om lidt.');
      }
      throw new VtError('SERVER', 'vasketur.dk havde en fejl. Prøv igen om lidt.');
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

  function post(page, extra, allowLogin = false, timeout = 12000) {
    const f = page.doc.forms[0];
    const action = new URL((f && f.getAttribute('action')) || page.url, page.url).href;
    return request(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody(page.doc, extra),
      timeout,
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
  const savedCreds = () => store.get('creds', null);
  const creds = () => savedCreds() || memCreds;

  // Spærring: vasketur.dk svarer "Kunde må ikke logge ind" efter for mange logins. Så logger appen
  // ikke selv ind i 30 minutter, så den ikke forlænger spærringen.
  const BLOCK_MS = 30 * 60000;
  const blockedUntil = () => store.get('blockedUntil', 0);
  const isBlocked = () => blockedUntil() > Date.now();
  function blockedError() {
    const t = new Date(blockedUntil());
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return new VtError('BLOCKED', `vasketur.dk har spærret login for kontoen lige nu ("Kunde må ikke logge ind"). Det sker typisk efter mange logins på kort tid. Appen prøver ikke selv igen før kl. ${hm}. Virker det stadig ikke, kan viceværten eller vasketur.dk låse kontoen op.`);
  }

  async function login(user, pass) {
    if (isBlocked()) throw blockedError();
    await beforeLogin();
    selCache = null;
    sessTerm = null;
    const p = await request(BASE + 'Default.aspx', {}, true);
    const res = await post(p, {
      __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btOK',
      __EVENTARGUMENT: '',
      'ctl00$ContentPlaceHolder1$tbUsername': user,
      'ctl00$ContentPlaceHolder1$tbPassword': pass,
    }, true);
    if (isLoginPage(res.doc)) {
      if (/må ikke logge ind|not allowed to log ?in/i.test(res.doc.body ? res.doc.body.textContent : '')) {
        store.set('blockedUntil', Date.now() + BLOCK_MS);
        throw blockedError();
      }
      throw new VtError('BADLOGIN', 'Forkert navn eller adgangskode');
    }
    store.del('blockedUntil');
    return res;
  }

  // Kører fn; hvis sessionen er væk og login er gemt, logges der ind igen og prøves én gang til.
  async function withSession(fn) {
    try {
      return await fn();
    } catch (e) {
      const c = creds();
      if ((e.code === 'LOGIN' || e.code === 'SERVER') && c) {
        if (isBlocked()) throw blockedError();
        step('Logger ind igen');
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

  let selCache = null; // {page, at} – siden med vaskeri-listen kan genbruges til at vælge vaskeri
  async function selector(fresh = false) {
    if (!fresh && selCache && Date.now() - selCache.at < 10 * 60000) return selCache.page;
    step('Henter vaskerier');
    let p = await request(BASE + 'Booking/TerminalSelector.aspx');
    if (parseTerminals(p).length) { selCache = { page: p, at: Date.now() }; return p; }
    const panel = p.doc.querySelector('a[href*="LinkButtonEls"]');
    if (panel) {
      p = await activate(p, panel);
      if (parseTerminals(p).length) return p;
    }
    throw new VtError('PARSE', 'Kunne ikke finde listen over vaskerier');
  }

  async function openTerminal(name, fresh = false) {
    const sel = await selector(fresh);
    const t = parseTerminals(sel).find((x) => x.name === name);
    if (!t) throw new VtError('PARSE', `Fandt ikke vaskeriet "${name}"`);
    let main;
    step(`Åbner ${shortName(name)}`);
    try {
      main = await postback(sel, t.pb.target, t.pb.arg); // -> BookingMain.aspx
    } catch (e) {
      if (fresh || e.code === 'LOGIN') { selCache = null; throw e; }
      selCache = null;
      return openTerminal(name, true);
    }
    if (!main.doc.querySelector('a[href*="LinkBooking"]')) { // gemt liste virkede ikke – hent frisk
      selCache = null;
      if (!fresh) return openTerminal(name, true);
      throw new VtError('PARSE', 'Kunne ikke åbne vaskeriet');
    }
    ctx = { term: name, page: 'main' };
    sessTerm = name;
    return main;
  }

  // --- Bookinger ("Min side") ---
  function parseBookings(page) {
    return [...page.doc.querySelectorAll('[name*="DataGridBookings"], a[href*="DataGridBookings"]')].map((el) => {
      const tr = el.closest('tr');
      const cells = tr
        ? [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim().replace(/^(Vask|Tør)(\d)/i, '$1 $2')).filter((t) => t && t !== '-' && !/^Afbestil/i.test(t))
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
    step(`Henter kalender · ${shortName(term)}`);
    let p = await postback(main, 'ctl00$LinkBooking');
    for (let i = 0; i < week; i++) { step(`Næste uge · ${shortName(term)}`); p = await clickByName(p, NEXT_BTN); }
    ctx = { term, page: 'calendar', week };
    return p;
  }

  // Går til kalenderen for vaskeri/uge og genbruger hvor serveren allerede står, når det kan lade sig gøre.
  async function gotoCalendar(term, week) {
    if (ctx && cur && ctx.term === term) {
      if (ctx.page === 'calendar' && ctx.week === week) return cur;
      if (ctx.page === 'calendar' && ctx.week === week - 1) {
        step(`Næste uge · ${shortName(term)}`);
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
      .map((e) => ({ name: e.name, label: e.value.trim().replace(/^(Vask|Tør)(\d)/i, '$1 $2'), disabled: e.disabled || /aspNetDisabled/.test(e.className) }));
    const rnd = page.doc.querySelector('input[name$="btMaskingruppRandom"]');
    if (!options.length && !rnd) throw new VtError('BOOK', pageMessage(page.doc) || 'Ingen ledige maskiner');
    return { page, quota: quota != null ? +quota : null, options, random: rnd ? { name: rnd.name } : null };
  }

  // Åbner maskinvalget for et tidsrum. Booker ikke noget – det sker først ved klik på en maskine.
  async function startBooking(term, week, cellId, retry = true) {
    try {
      const cal = await gotoCalendar(term, week);
      const parsed = parseCalendar(cal, week);
      // Celle-id fra API'et ("dato|pass|fra") findes via dag og starttid.
      const [date, , from] = String(cellId).split('|');
      const cell = parsed.cells.find((c) => c.id === cellId)
        || (from && parsed.cells.find((c) => parsed.days[c.d] === isoTs(date) && c.from === from));
      if (!cell || !cell.bookable) throw new VtError('GONE', 'Tiden er ikke længere ledig her.');
      step(`Henter maskiner · ${shortName(term)}`);
      return parseMachineGroup(await postback(cal, 'BookPass' + cell.id, cell.id));
    } catch (e) {
      if (!retry || e.code === 'LOGIN' || e.code === 'GONE') throw e;
      ctx = null; // genvejen holdt ikke – tag den lange vej én gang
      step('Prøver igen');
      return startBooking(term, week, cellId, false);
    }
  }

  async function confirmBooking(mg, name) {
    const lbl = (mg.options.find((o) => o.name === name) || {}).label || '';
    step(`Booker ${lbl}`.trim());
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
    step(`Afbestiller · ${shortName(term)}`);
    let page = await openTerminal(term);
    const failed = [];
    // Nøglen kan stamme fra API'et (anden tekst for datoen) – sammenlign også på dato, maskine og tid.
    const same = (x, key) => x.key === key || bookingSig(x) === keySig(key);
    for (const key of keys) {
      const row = parseBookings(page).find((x) => same(x, key));
      if (!row) continue; // allerede væk
      const el = page.doc.getElementsByName(row.id)[0] || page.doc.querySelector(`a[href*="${row.id}"]`);
      try {
        page = await activate(page, el);
        if (parseBookings(page).some((x) => same(x, key))) failed.push(key);
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
    step(statusLabel(' (vasketur.dk er langsom her)'));
    let base = cur && cur.doc.querySelector('a[href*="LinkStatus"]') ? cur : null;
    if (!base) {
      const sel = await selector();
      const t = parseTerminals(sel)[0];
      base = await postback(sel, t.pb.target, t.pb.arg);
      sessTerm = t.name;
    }
    // Status-siden er langsom hos vasketur.dk (10–20 sek.), så den får længere tidsgrænse.
    return parseStatus(await post(base, { __EVENTTARGET: 'ctl00$LinkStatus', __EVENTARGUMENT: '' }, false, 45000));
  }

  // ---------------------------------------------------------------------------
  // Mobil-API: samme SOAP-tjeneste som den officielle app (VisionMobile.asmx, samme server).
  // Svarer på 20–700 ms mod 0,4–1,2 sek. pr. webside. Kræver navn+kode (gemt via "Husk mig" eller
  // tastet i denne session). Fejler API'et, falder appen tilbage til websiderne ovenfor.
  // ---------------------------------------------------------------------------

  const API_URL = BASE + 'Api/Mobile/VisionMobile.asmx';
  const API_NS = 'http://www.rco.se/Api/Mobile';
  const api = { guid: null, units: null, unit: -1, broken: '', off: false };

  // API-nøglen huskes mellem åbninger (op til 9 min efter sidste brug), så appen ikke logger ind hver gang.
  const API_KEY_MS = 9 * 60000;
  let lastKeySave = 0;
  function saveApiKey() {
    if (!api.guid) return;
    lastKeySave = Date.now();
    store.set('apiKey', { guid: api.guid, units: api.units, user: (creds() || {}).user, at: lastKeySave });
  }
  function restoreApiKey() {
    const k = store.get('apiKey', null);
    const c = creds();
    if (k && c && k.user === c.user && k.units && Date.now() - k.at < API_KEY_MS) {
      api.guid = k.guid; api.units = k.units; api.unit = -1;
      return true;
    }
    return false;
  }
  const clearApiKey = () => store.del('apiKey');

  // Loft: højst 3 automatiske logins pr. 10 minutter (API + web tilsammen). Brugerens egne tryk tæller med, men stoppes ikke.
  const LOGIN_CAP = 3;
  const LOGIN_WINDOW = 10 * 60000;
  let manualLogin = false;
  const hhmmOf = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  // Automatiske logins venter mindst 60 s efter det forrige, så en fejl ikke giver en byge af logins.
  const LOGIN_GAP = 60000;
  async function beforeLogin() {
    let log = store.get('loginLog', []).filter((t) => Date.now() - t < LOGIN_WINDOW);
    if (!manualLogin && log.length) {
      const until = log[log.length - 1] + LOGIN_GAP;
      while (Date.now() < until) {
        step(`Venter ${Math.ceil((until - Date.now()) / 1000)} s før nyt login`);
        await sleep(1000);
      }
      log = store.get('loginLog', []).filter((t) => Date.now() - t < LOGIN_WINDOW);
    }
    if (!manualLogin && log.length >= LOGIN_CAP) {
      throw new VtError('THROTTLE', `Appen har allerede logget ind ${LOGIN_CAP} gange de sidste 10 minutter og venter til kl. ${hhmmOf(log[0] + LOGIN_WINDOW)}, så kontoen ikke bliver spærret. Du kan selv trykke Log ind.`);
    }
    log.push(Date.now());
    store.set('loginLog', log);
  }
  let memCreds = null; // login tastet i denne session – kun i hukommelsen
  const timings = []; // målinger til test: {label, via, ms}

  // Parametre skal have xsi:type – ellers svarer serveren med fejl 500.
  const xs = (v) => ['string', v];
  const xi = (v) => ['int', v];
  const xl = (v) => ['long', v];
  const xd = (iso) => ['dateTime', iso + 'T00:00:00'];
  const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function soap(op, params = {}, timeout = 15000) {
    const body = Object.entries(params).map(([k, [t, v]]) => `<${k} xsi:type="xsd:${t}">${xmlEsc(v)}</${k}>`).join('');
    const env = '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
      + `<soap:Body><${op} xmlns="${API_NS}">${body}</${op}></soap:Body></soap:Envelope>`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let r;
    try {
      r = await fetch(API_URL, {
        method: 'POST', credentials: 'same-origin', body: env, signal: ctrl.signal,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${API_NS}/${op}"` },
      });
    } catch (e) {
      throw new VtError('NET', e.name === 'AbortError' ? 'vasketur.dk svarer ikke lige nu. Prøv igen.' : 'Ingen forbindelse til vasketur.dk. Tjek dit net.');
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new VtError('API', `API-fejl ${r.status} (${op})`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const res = doc.getElementsByTagNameNS(API_NS, op + 'Result')[0];
    if (!res) throw new VtError('API', `Uventet svar fra API (${op})`);
    return res;
  }

  const tx = (el, name) => { const e = el.getElementsByTagNameNS(API_NS, name)[0]; return e ? e.textContent.trim() : ''; };
  const list = (el) => [...el.children].map((c) => c.textContent.trim()); // ArrayOfAnyType
  // Negativ kode i svaret (-1 = forkert rækkefølge/indeks, -2 = sessionen er udløbet), ellers 0.
  function code(el) {
    const v = (el.children.length ? el.children[0].textContent : el.textContent).trim();
    return /^-\d+$/.test(v) ? +v : 0;
  }

  async function apiCall(op, params = {}, timeout, guidName = 'loginguid') {
    const res = await soap(op, { [guidName]: xs(api.guid), ...params }, timeout);
    if (code(res) === -2) { api.guid = null; clearApiKey(); throw new VtError('APISESSION', 'API-sessionen er udløbet'); }
    if (Date.now() - lastKeySave > 30000) saveApiKey(); // hold den gemte nøgle frisk
    return res;
  }

  async function apiConnect() {
    const c = creds();
    if (!c) throw new VtError('LOGIN', 'Du er ikke logget ind');
    if (isBlocked()) throw blockedError();
    await beforeLogin();
    step('Logger ind');
    api.guid = null;
    clearApiKey();
    api.unit = -1;
    const res = await soap('Login', { systemname: xs('DB0073-ABMonten'), username: xs(c.user), Password: xs(c.pass), timeout: xi(600) });
    const g = (/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.exec(res.textContent) || [])[0];
    // Tomt svar kan både være forkert kode og en fejl hos API'et – websiden afgør det bagefter.
    if (!g) throw new VtError('API', 'API-login gav intet svar');
    api.guid = g;
    api.units = list(await apiCall('GetBookUnits')).slice(1);
    saveApiKey();
  }

  // Kører fn mod API'et; logger ind (igen), hvis sessionen mangler eller er udløbet.
  async function apiRun(fn) {
    if (!api.guid) await apiConnect();
    try {
      return await fn();
    } catch (e) {
      if (e.code !== 'APISESSION') throw e;
      await apiConnect();
      return fn();
    }
  }

  const apiReady = () => !api.off && !api.broken && !!(api.guid || creds());

  // Bruger API'et når det kan; ved uventede API-fejl skiftes til websiderne resten af sessionen.
  async function viaApi(apiFn, webFn, label, fallback = true) {
    const t0 = performance.now();
    let via = 'web';
    try {
      if (apiReady()) {
        via = 'api';
        try {
          return await apiRun(apiFn);
        } catch (e) {
          if (!['API', 'APISESSION'].includes(e.code)) throw e;
          api.broken = e.message || 'API-fejl';
          if (!fallback) throw new VtError(e.code, 'Noget gik galt. Tjek "Mine" og prøv igen.');
          via = 'api→web';
        }
      }
      return await webFn();
    } finally {
      if (label) {
        timings.push({ label, via, ms: Math.round(performance.now() - t0) });
        if (timings.length > 200) timings.shift();
      }
    }
  }

  // Vælger vaskeri på API-sessionen (som "Bestil vask <vaskeri>" i appen).
  async function apiUnit(term) {
    const i = api.units.findIndex((u) => sameLaundry(u, term));
    if (i < 0) throw new VtError('API', `API kender ikke ${shortName(term)}`);
    if (api.unit === i) return;
    api.unit = -1;
    step(`Åbner ${shortName(term)}`);
    await apiCall('ConnectToUnit', { unitindex: xl(i) });
    await apiCall('GetBookPrechoices'); // skal hentes før valget accepteres
    if (code(await apiCall('SetBookPrechoises', { prechoiseindex: xi(0) }))) throw new VtError('API', 'Kunne ikke vælge vaskeriet');
    api.unit = i;
  }

  const isoDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const isoTs = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const fmtMachine = (s) => String(s || '').trim().replace(/^(Vask|Tør)\s*(\d)/i, '$1 $2');

  // IsFree = mindst én maskine ledig i tidsrummet; IsBookable = tidsrummet kan bookes (ikke forbi/lukket).
  async function apiCalDays(term, fromOff, toOff) {
    await apiUnit(term);
    const res = await apiCall('GetBookingCalendarDays', { startDate: xd(isoDay(dayTs(fromOff))), endDate: xd(isoDay(dayTs(toOff))) }, 20000);
    return [...res.getElementsByTagNameNS(API_NS, 'BookDay')].map((b) => {
      const date = tx(b, 'BookDate').slice(0, 10);
      return {
        ts: isoTs(date),
        passes: [...b.getElementsByTagNameNS(API_NS, 'BookDayPass')].map((p) => ({
          date, pi: +tx(p, 'PassIndex'), from: tx(p, 'StartTime'), to: tx(p, 'EndTime'),
          free: tx(p, 'IsFree') === 'true', open: tx(p, 'IsBookable') === 'true',
        })),
      };
    });
  }

  async function apiBookings(term) {
    await apiUnit(term);
    const n = +(await apiCall('GetBookUserBookingCount')).textContent || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = list(await apiCall('GetBookUserBookings', { bookindex: xl(i) })); // [5, 'Tirsdag 20 Okt', 'Vask 1', '13:00', '15:00', true]
      if (!(+v[0] >= 4)) continue;
      const cells = [v[1], fmtMachine(v[2]), v[3], v[4]];
      out.push({ key: cells.join(' | '), cells, id: 'api:' + i, idx: i, term });
    }
    return out;
  }

  // Begge uger + dine bookinger for ét vaskeri. Celle-id: "dato|passindex|fra".
  async function apiLoadTerm(term) {
    step(`Henter kalender · ${shortName(term)}`);
    const days = await apiCalDays(term, 0, 13);
    for (const week of [0, 1]) {
      const span = Array.from({ length: 7 }, (_, i) => dayTs(week * 7 + i));
      const cells = [];
      for (const day of days) {
        const d = span.indexOf(day.ts);
        if (d < 0) continue;
        for (const p of day.passes) {
          cells.push({ id: `${p.date}|${p.pi}|${p.from}`, d, s: p.pi, g: 0, from: p.from, to: p.to, state: p.free ? 'Ledig' : 'Optaget', bookable: p.free && p.open });
        }
      }
      if (cells.length) S.cal[term + '|' + week] = { days: span, cells, at: Date.now() };
    }
    step(`Henter dine tider · ${shortName(term)}`);
    S.bookMap[term] = await apiBookings(term);
    render();
  }

  // Finder dato+passindex for en celle. Celler fra en ældre version (websiden) slås op via dag og tid.
  async function apiRef(term, week, cellId) {
    const [date, pi] = String(cellId).split('|');
    if (pi != null) return { date, pi: +pi };
    const old = S.cal[term + '|' + week];
    const c = old && old.cells.find((x) => x.id === cellId);
    if (!c) throw new VtError('GONE', 'Tiden er ikke længere ledig her.');
    const ts = old.days[c.d];
    await apiLoadTerm(term);
    const now = S.cal[term + '|' + week];
    const n = now && now.cells.find((x) => now.days[x.d] === ts && x.from === c.from);
    if (!n) throw new VtError('GONE', 'Tiden er ikke længere ledig her.');
    return { date: isoDay(ts), pi: n.s };
  }

  // Maskinvalget for et tidsrum (booker ikke noget). Trinene skal tages i denne rækkefølge.
  async function apiMachinesAt(term, ref) {
    await apiUnit(term);
    step(`Henter maskiner · ${shortName(term)}`);
    if (code(await apiCall('SetBookPass', { SystemDate: xd(ref.date), passindex: xi(ref.pi) }))) throw new VtError('API', 'Kunne ikke vælge tidsrummet');
    const types = list(await apiCall('GetBookMachineGroupTypes'));
    if (!(+types[0] > 0)) throw new VtError('GONE', 'Tiden er ikke længere ledig her.'); // 0 = ingen ledige maskiner
    await apiCall('SetBookMachineGroupTypes', { typeindex: xi(0) });
    const names = list(await apiCall('GetNextBookMachineGroups')).slice(1);
    const free = list(await apiCall('GetBookMachineGroupsFree')).slice(1); // 1 = ledig
    const left = list(await apiCall('GetBookMachineGroupsCountersLeft'))[1];
    return {
      api: true,
      quota: left != null && +left < 9999 ? +left : null,
      random: null,
      options: names.map((n, i) => ({ name: String(i), label: fmtMachine(n), disabled: free[i] !== '1' })),
    };
  }

  async function apiMachines(term, week, cellId) {
    return apiMachinesAt(term, await apiRef(term, week, cellId));
  }

  async function apiBookMany(term, week, cellId, labels, onProgress) {
    const ref = await apiRef(term, week, cellId);
    const done = [];
    let left = null;
    for (const label of labels) {
      onProgress(done.length + 1, labels.length);
      try {
        const mg = await apiMachinesAt(term, ref);
        const opt = mg.options.find((o) => o.label === label && !o.disabled);
        if (!opt) throw new VtError('BOOK', `${label} er ikke længere ledig.`);
        step(`Booker ${label}`);
        const r = list(await apiCall('SetBookMachineGroup', { machinegroupindex: xi(+opt.name) })); // [4, 20261020, 'Vask 1', '13:00', '15:00']
        if (!/^\d{8}$/.test(r[1] || '')) throw new VtError('BOOK', 'Bookingen gik ikke igennem');
        const l = list(await apiCall('GetBookMachineGroupsCountersLeft'))[1];
        left = l != null && +l < 9999 ? +l : null;
        done.push(label);
      } catch (e) {
        if (e.code === 'APISESSION' && !done.length) throw e; // intet booket endnu – apiRun logger ind og prøver igen
        return { done, left, error: e };
      }
    }
    return { done, left, error: null };
  }

  // Samme booking set fra web og API: dato + maskinnummer + starttid.
  const bookingSig = (b) => `${bookingDate(b)}|${machineNo(b.cells[1])}|${b.cells[2]}`;
  const keySig = (key) => bookingSig({ cells: key.split(' | ') });

  async function apiCancelMany(term, keys) {
    step(`Afbestiller · ${shortName(term)}`);
    const want = keys.map(keySig);
    const before = await apiBookings(term);
    // Bagfra, så indeksene på de resterende ikke flytter sig.
    const idx = before.filter((b) => want.includes(bookingSig(b))).map((b) => b.idx).sort((a, b) => b - a);
    for (const i of idx) await apiCall('DelBookUserBookings', { bookindex: xl(i) });
    const after = await apiBookings(term);
    return { after, failed: keys.filter((k) => after.some((b) => bookingSig(b) === keySig(k))) };
  }

  // Status for alle vaskerier i ét kald – med rigtig køre-status (Started/Done) og klar-tid.
  let statusAttempt = 1; // vises i aktivitetslinjen ved genforsøg
  const statusLabel = (extra = '') => `Henter status${extra}${statusAttempt > 1 ? ` · forsøg ${statusAttempt} af 3` : ''}`;
  async function apiStatus() {
    step(statusLabel());
    const res = await apiCall('GetMachineGroups', {}, 30000, 'loginGuid');
    const laundries = [];
    let L = null;
    for (const s of res.getElementsByTagNameNS(API_NS, 'SelectionObjectsAndObjectStatus')) {
      const name = tx(s, 'Name');
      let m;
      let type;
      if ((m = /^Bestil vask\s*(.*)$/i.exec(name))) {
        L = { name: m[1] || 'Vaskeri', groups: [] };
        laundries.push(L);
        type = 'Vaskemaskiner';
      } else if (L && /^Bestil (tørretumbler|tørring|tørreskab)/i.test(name)) {
        type = 'Tørretumblere';
      } else continue;
      const machines = [...s.getElementsByTagNameNS(API_NS, 'Machine')].map((x) => {
        const st = tx(x, 'Status');
        const ready = tx(x, 'ReadyTime');
        const start = tx(x, 'StartTime');
        const hm = (t) => /^\d{1,2}:\d{2}$/.test(t);
        const nm = tx(x, 'MachineName').replace(/^VASK\s*/i, 'Vask ').replace(/^TØRRE?\s*/i, 'Tør ');
        if (/start|run|busy/i.test(st)) return { name: nm, state: 'I brug', detail: hm(ready) ? `Klar ca. ${ready}` : hm(start) ? `Start ${start}` : '' };
        if (/done|idle|ready|free|finish/i.test(st)) return { name: nm, state: 'Ledig', detail: hm(ready) ? `Afsluttedes ${ready}` : '' };
        if (/book|reserv/i.test(st)) return { name: nm, state: 'Reserveret', detail: '' };
        return { name: nm, state: st || 'Ukendt', detail: '' };
      });
      L.groups.push({ type, machines });
    }
    if (!laundries.length) {
      if (code(await apiCall('GetSystemDate')) === 0) throw new VtError('API', 'Status fra API var tom');
    }
    return { laundries, at: Date.now() };
  }

  // Dagens resterende tidsrum for ét vaskeri: hvilke maskiner er booket nu, og hvornår næste gang.
  // Læser kun maskinvalget – der bookes ikke noget.
  async function apiPlanDay(term, nums) {
    const days = await serial(() => apiRun(() => apiCalDays(term, 0, 0)));
    const passes = days.length ? days[0].passes : [];
    const next = {};
    const now = {};
    let known = nums ? [...nums] : null;
    for (const p of passes) {
      if (toMin(p.to) <= nowMin()) continue;
      const current = toMin(p.from) <= nowMin();
      let booked;
      if (!p.free) booked = known || ['*'];
      else {
        const mg = await serial(() => apiRun(() => apiMachinesAt(term, { date: p.date, pi: p.pi }))).catch(() => null);
        if (!mg) continue;
        if (!known) known = mg.options.map((o) => machineNo(o.label));
        booked = mg.options.filter((o) => o.disabled).map((o) => machineNo(o.label));
      }
      for (const n of booked) {
        if (current) now[n] = true;
        else if (!next[n]) next[n] = p.from;
      }
      if (known && known.every((n) => next[n])) break;
    }
    return { next, now };
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
    dayPlan: store.get('dayPlan', {}), // vaskeri -> {day, at, next: {maskinnr: 'HH:MM'}} – næste booking i dag pr. maskine
    planBusy: false,
    mineSel: [], // markerede maskiner på Mine (bookingnøgler)
    mineOpen: [], // udfoldede tider på Mine (gruppenøgler)
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
    store.set('dayPlan', S.dayPlan);
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
      clearApiKey();
      S.error = e.message;
    } else if (e.code === 'BLOCKED' || e.code === 'THROTTLE') {
      S.view = 'login';
      S.error = e.message;
    } else {
      S[field] = e.message || String(e);
    }
    render();
  }

  async function loadTerms() {
    return serial(() => viaApi(async () => {
      S.terms = [...api.units];
      return S.terms;
    }, () => withSession(async () => {
      S.terms = parseTerminals(await selector()).map((t) => t.name);
      return S.terms;
    }), 'vaskerier'));
  }

  // Ét job: vaskeriets bookinger + kalender. API'et henter begge uger på én gang.
  function loadCalendar(term, week) {
    return serial(() => viaApi(() => apiLoadTerm(term), () => withSession(async () => {
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
    }), `kalender ${shortName(term)}`));
  }

  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    S.loading = true;
    S.error = '';
    render();
    refreshing = (async () => {
      const t0 = Date.now();
      try {
        await loadTerms();
        for (const term of ordered()) {
          await loadCalendar(term, 0);
          const w1 = S.cal[term + '|1'];
          if (!w1 || w1.at < t0) await loadCalendar(term, 1); // API'et har allerede hentet uge 2
        }
        timings.push({ label: 'opdatér alt', via: apiReady() ? 'api' : 'web', ms: Date.now() - t0 });
        S.bookingsAt = Date.now();
        saveCache();
        refreshDayPlan(); // så Status har tidspunkterne klar
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

  const machineNo = (label) => (/(\d+)/.exec(label || '') || [])[1] || label;

  // Går dagens resterende vasketider igennem for ét vaskeri og finder første booking pr. maskine.
  // Åbner kun maskinvalget (som når man trykker Book) – der bookes ikke noget.
  async function planDay(term, nums) {
    const parsed = await serial(() => withSession(async () => {
      const p = parseCalendar(await gotoCalendar(term, 0), 0);
      S.cal[term + '|0'] = p;
      return p;
    }));
    const di = parsed.days.indexOf(dayTs(0));
    const slots = parsed.cells.filter((c) => c.d === di && c.from && toMin(c.from) > nowMin())
      .sort((a, b) => toMin(a.from) - toMin(b.from));
    const next = {};
    let known = nums ? [...nums] : null;
    for (const c of slots) {
      if (known && known.every((n) => next[n])) break;
      if (!c.bookable) { // helt optaget: alle (resterende) maskiner er booket her
        if (known) known.forEach((n) => { if (!next[n]) next[n] = c.from; });
        else next['*'] = c.from;
        break;
      }
      // Hvert tidsrum er sit eget job – en booking kan komme til imellem dem.
      const mg = await serial(() => withSession(async () => {
        const cal = await gotoCalendar(term, 0);
        step(`Tjekker dagens bookinger · ${shortName(term)}`);
        const mgPage = await postback(cal, 'BookPass' + c.id, c.id);
        let res;
        try { res = parseMachineGroup(mgPage); } catch (e) { res = { options: [] }; }
        const back = mgPage.doc.querySelector('input[name$="btMaskingruppBack"]');
        if (back) { await activate(mgPage, back); ctx = { term, page: 'calendar', week: 0 }; }
        return res;
      }));
      const offered = mg.options.map((o) => machineNo(o.label));
      if (!known) known = offered;
      known.forEach((n) => {
        const o = mg.options.find((x) => machineNo(x.label) === n);
        if (!next[n] && (!o ? offered.length > 0 : o.disabled)) next[n] = c.from;
      });
    }
    return next;
  }

  async function refreshDayPlan() {
    if (S.planBusy) return;
    const today = dayTs(0);
    const todo = ordered().filter((t) => { const p = S.dayPlan[t]; return !p || p.day !== today || Date.now() - p.at > 5 * 60000; });
    if (!todo.length) return;
    S.planBusy = true;
    render();
    try {
      for (const term of todo) {
        const L = S.status && S.status.laundries.find((x) => sameLaundry(x.name, term));
        const G = L && L.groups.find((g) => !/tørre/i.test(g.type));
        const nums = G ? G.machines.map((m) => machineNo(m.name)) : null;
        const plan = apiReady() ? await apiPlanDay(term, nums) : { next: await planDay(term, nums) };
        S.dayPlan[term] = { day: today, at: Date.now(), ...plan };
        render();
      }
      saveCache();
    } catch (e) {
      // Ikke kritisk – status vises bare uden tidspunkter.
    } finally {
      S.planBusy = false;
      render();
    }
  }

  async function refreshStatus() {
    if (S.statusBusy) return;
    S.statusError = '';
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      statusAttempt = attempt;
      S.statusBusy = attempt > 1 ? `Status svarede ikke. Prøver igen (${attempt} af 3)…`
        : apiReady() ? 'Henter status…' : 'Henter status… vasketur.dk er langsom her, det kan tage op til 20 sekunder.';
      render();
      try {
        S.status = await serial(() => viaApi(apiStatus, () => withSession(loadStatusOnce), 'status'), true);
        S.statusBusy = '';
        saveCache();
        render();
        refreshDayPlan();
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
    const ownTerms = slot.own.map((g) => g.term);
    const cands = slot.items.filter((i) => i.cell.bookable).map((i) => ({ term: i.term, cellId: i.cell.id }));
    if (!cands.length) return;
    const start = Math.max(0, cands.findIndex((c) => ownTerms.includes(c.term)));
    S.sheet = { kind: 'book', phase: 'choose', day: ts, from: slot.from, to: slot.to, week: slot.week, cands, idx: start, probes: {}, sel: [], remove: [] };
    render();
    probe(start);
  }

  function probe(idx) {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'book') return;
    if (sh.idx !== idx) sh.remove = [];
    sh.idx = idx;
    const c = sh.cands[idx];
    const p = sh.probes[c.term];
    if (p && p.state === 'ok') { preselect(); render(); return; }
    sh.probes[c.term] = { state: 'loading', waiting: running };
    render();
    serial(() => {
      if (S.sheet === sh) { sh.probes[c.term].waiting = false; render(); }
      return machinesFor(c.term, sh.week, c.cellId);
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

  // API først, websiderne som reserve.
  const machinesFor = (term, week, cellId) => viaApi(
    () => apiMachines(term, week, cellId), () => withSession(() => startBooking(term, week, cellId)), 'maskinvalg');
  const cancelFor = (term, keys) => viaApi(
    () => apiCancelMany(term, keys), () => withSession(() => cancelMany(term, keys)), `afbestil ${keys.length}`);
  // Booking falder ikke tilbage midt i et forløb – fejl vises, og man kan prøve igen (så via websiden).
  const bookFor = (term, week, cellId, labels, fresh, onProgress) => viaApi(
    () => apiBookMany(term, week, cellId, labels, onProgress),
    () => bookMachines(term, week, cellId, labels, fresh && !fresh.api ? fresh : null, onProgress),
    `book ${labels.length}`, false);

  function freeLabels(mg) { return mg.options.filter((o) => !o.disabled).map((o) => o.label); }

  // Dine egne maskiner i bookingvinduets tidsrum og vaskeri.
  function ownItems(sh, term) {
    const g = bookingGroups().find((x) => x.day === sh.day && x.from === sh.from && x.term === term);
    return g ? g.items : [];
  }
  const ownMachines = (sh, term) => ownItems(sh, term).map((b) => machineNo(b.cells[1]));

  // Tryk på en af dine egne maskiner markerer den til afbestilling (og tilbage igen).
  function toggleOwn(no) {
    const sh = S.sheet;
    if (!sh || sh.phase !== 'choose') return;
    sh.remove = sh.remove.includes(no) ? sh.remove.filter((x) => x !== no) : [...sh.remove, no];
    render();
  }

  function preselect() {
    const sh = S.sheet;
    const p = sh.probes[sh.cands[sh.idx].term];
    if (!p || p.state !== 'ok') { sh.sel = []; return; }
    const own = ownMachines(sh, sh.cands[sh.idx].term).length;
    sh.sel = own ? [] : freeLabels(p.mg).slice(0, S.count);
  }

  function toggleMachine(label) {
    const sh = S.sheet;
    if (!sh || sh.phase !== 'choose') return;
    sh.flash = '';
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
    if (!sh || sh.phase !== 'choose' || (!sh.sel.length && !sh.remove.length)) return;
    const c = sh.cands[sh.idx];
    const p = sh.probes[c.term];
    if (!p || p.state !== 'ok') return;
    const labels = freeLabels(p.mg).filter((l) => sh.sel.includes(l)); // i maskinrækkefølge
    const removeItems = ownItems(sh, c.term).filter((b) => sh.remove.includes(machineNo(b.cells[1])));
    sh.phase = 'booking';
    sh.term = c.term;
    sh.progress = removeItems.length ? 'Afbestiller…' : `Booker ${labels[0]}…`;
    render();
    // Maskinvalgs-siden er kun gyldig, hvis serveren ikke har flyttet sig siden (gælder kun det senest undersøgte vaskeri).
    const fresh = sh.lastProbe === c.term && !removeItems.length ? p.mg : null;
    serial(async () => {
      let cancelled = [];
      if (removeItems.length) {
        const r = await cancelFor(c.term, removeItems.map((b) => b.key));
        S.bookMap[c.term] = r.after.map((x) => ({ ...x, term: c.term }));
        cancelled = removeItems.filter((b) => !r.failed.includes(b.key)).map((b) => b.cells[1]);
        if (r.failed.length) return { done: [], cancelled, left: null, error: new VtError('CANCEL', 'Ikke alle kunne afbestilles') };
      }
      if (!labels.length) return { done: [], cancelled, left: null, error: null };
      const res = await bookFor(c.term, sh.week, c.cellId, labels, fresh, (i, n) => {
        sh.progress = n > 1 ? `Booker maskine ${i} af ${n}…` : 'Booker…';
        render();
      });
      return { ...res, cancelled };
    }, true).then((res) => {
      if (res.error) {
        sh.phase = 'done';
        sh.result = res;
        render();
        loadCalendar(c.term, sh.week).then(saveCache, () => {});
        return;
      }
      const parts = [];
      if (res.done.length) parts.push(`Booket ${machineList(res.done)}`);
      if (res.cancelled && res.cancelled.length) parts.push(`afbestilt ${machineList(res.cancelled)}`);
      const flash = parts.join(' · ');
      sh.flash = flash.charAt(0).toUpperCase() + flash.slice(1);
      sh.phase = 'choose';
      sh.sel = [];
      sh.remove = [];
      sh.probes[c.term] = { state: 'loading', waiting: false };
      render();
      // Hent bookinger og maskinvalg igen, så vinduet viser det nye ("din").
      serial(() => viaApi(async () => {
        S.bookMap[c.term] = await apiBookings(c.term);
        return apiMachines(c.term, sh.week, c.cellId);
      }, () => withSession(async () => {
        const main = await openTerminal(c.term);
        S.bookMap[c.term] = parseBookings(main).map((b) => ({ ...b, term: c.term }));
        return startBooking(c.term, sh.week, c.cellId);
      })), true).then((mg) => {
        if (S.sheet !== sh) return;
        sh.probes[c.term] = { state: 'ok', mg, at: Date.now() };
        sh.lastProbe = c.term;
        render();
      }, (e) => {
        if (S.sheet !== sh) return;
        if (e.code === 'GONE') { S.sheet = null; toast(sh.flash); render(); pump(); }
        else { sh.probes[c.term] = { state: 'error', msg: e.message }; render(); }
      }).finally(() => {
        saveCache();
        loadCalendar(c.term, sh.week).then(saveCache, () => {});
      });
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

  function askCancelAll() {
    const all = bookingGroups();
    const total = all.reduce((x, g) => x + g.items.length, 0);
    const groups = S.mineSel.length
      ? all.map((g) => ({ ...g, items: g.items.filter((b) => S.mineSel.includes(selKey(b))) })).filter((g) => g.items.length)
      : all;
    const n = groups.reduce((x, g) => x + g.items.length, 0);
    if (groups.length) { S.sheet = { kind: 'cancelall', phase: 'confirm', groups, partial: n < total }; render(); }
  }

  function toggleMineGroup(gk) {
    const g = bookingGroups().find((x) => groupKey(x) === gk);
    if (!g) return;
    const keys = g.items.map(selKey);
    const allOn = keys.every((k) => S.mineSel.includes(k));
    S.mineSel = allOn ? S.mineSel.filter((k) => !keys.includes(k)) : [...new Set([...S.mineSel, ...keys])];
    if (g.items.length > 1) {
      S.mineOpen = allOn ? S.mineOpen.filter((x) => x !== gk) : [...new Set([...S.mineOpen, gk])];
    }
    render();
  }

  function toggleMineItem(key) {
    S.mineSel = S.mineSel.includes(key) ? S.mineSel.filter((x) => x !== key) : [...S.mineSel, key];
    render();
  }

  function toggleMineOpen(gk) {
    S.mineOpen = S.mineOpen.includes(gk) ? S.mineOpen.filter((x) => x !== gk) : [...S.mineOpen, gk];
    render();
  }

  // Afbestiller alle grupper, samlet pr. vaskeri (ét serverbesøg pr. vaskeri).
  function doCancelAll() {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'cancelall' || sh.phase !== 'confirm') return;
    sh.phase = 'cancelling';
    render();
    const byTerm = new Map();
    for (const g of sh.groups) {
      if (!byTerm.has(g.term)) byTerm.set(g.term, []);
      byTerm.get(g.term).push(...g.items.map((b) => b.key));
    }
    const total = [...byTerm.values()].reduce((n, k) => n + k.length, 0);
    serial(async () => {
      let failed = 0;
      for (const [term, keys] of byTerm) {
        const res = await cancelFor(term, keys);
        S.bookMap[term] = res.after.map((x) => ({ ...x, term }));
        failed += res.failed.length;
      }
      return failed;
    }, true).then((failed) => {
      saveCache();
      if (failed) {
        S.sheet = { ...sh, phase: 'error', msg: `${failed} af ${total} kunne ikke afbestilles. Prøv igen.` };
      } else {
        S.sheet = null;
        S.mineSel = [];
        toast(`${total} maskine${total === 1 ? '' : 'r'} afbestilt`);
      }
      render();
      for (const term of byTerm.keys()) loadCalendar(term, 0).then(saveCache, () => {});
    }, (e) => {
      if (e.code === 'LOGIN' && !creds()) { S.sheet = null; handleError(e); return; }
      S.sheet = { ...sh, phase: 'error', msg: e.message };
      render();
    });
  }

  function doCancel() {
    const sh = S.sheet;
    if (!sh || sh.kind !== 'cancel' || !sh.sel.length) return;
    sh.phase = 'cancelling';
    render();
    serial(() => cancelFor(sh.g.term, sh.sel), true)
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
    memCreds = { user, pass };
    api.broken = '';
    // API'et først (hurtigt). Fejler det, afgør websiden om koden er forkert.
    serial(async () => {
      manualLogin = true;
      try {
        try { await apiConnect(); } catch (e) {
          if (['BLOCKED', 'THROTTLE'].includes(e.code)) throw e;
          api.broken = e.message || 'API-login fejlede';
          await login(user, pass);
        }
      } finally { manualLogin = false; }
    }, true).then(() => {
      if (remember) store.set('creds', { user, pass }); else store.del('creds');
      S.loggingIn = false;
      startApp();
    }, (e) => { memCreds = null; S.loggingIn = false; S.view = 'login'; S.error = e.message; render(); });
  }

  function doForget() {
    store.del('creds');
    clearApiKey();
    S.sheet = null;
    toast('Login glemt på denne telefon');
    render();
  }

  let shownDay = null; // dagen Book-siden viser lige nu
  const DAYS = 14;

  function selectDay(ts, dir = '') {
    S.day = ts;
    S.slide = dir;
    render();
    S.slide = '';
    // Sørg for at den valgte dag kan ses i dagsvælgeren.
    const strip = root.querySelector('.days');
    const on = strip && strip.querySelector('.on');
    if (on) {
      const r = on.getBoundingClientRect();
      const sr = strip.getBoundingClientRect();
      if (r.left < sr.left || r.right > sr.right) {
        strip.scrollBy({ left: r.left - sr.left - (strip.clientWidth - on.clientWidth) / 2, behavior: 'smooth' });
      }
    }
  }

  function stepDay(delta) {
    const days = Array.from({ length: DAYS }, (_, i) => dayTs(i));
    const j = days.indexOf(shownDay) + delta;
    if (j < 0 || j >= days.length) return;
    selectDay(days[j], delta > 0 ? 'next' : 'prev');
  }

  // Swipe på Book-siden: venstre = næste dag, højre = dagen før.
  let swipe = null;
  function onTouchStart(ev) {
    if (S.view !== 'app' || S.tab !== 'book' || S.sheet || ev.touches.length !== 1) return;
    if (ev.target.closest('.days, .o-handle')) return; // dagsvælgeren scroller selv vandret
    const t = ev.touches[0];
    swipe = { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(ev) {
    if (!swipe) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    stepDay(dx < 0 ? 1 : -1);
  }

  let toastTimer;
  function toast(msg) {
    S.toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2500);
  }

  // Ny version? Slå @version op i scriptet på GitHub Pages og vis en besked med opdatér-knap.
  const newer = (a, b) => {
    const x = a.split('.').map(Number); const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
    return false;
  };
  // Hjælpeteksten afhænger af telefonen (Firefox + Violentmonkey på Android, Safari + Userscripts på iPhone).
  function updateHelp() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'Åbn Userscripts-appen og opdatér Vasketid – eller tryk aA → Userscripts i Safari.';
    if (/Android/i.test(ua)) return 'Åbn Violentmonkey (Firefox-menuen → Udvidelser) og tryk opdatér ved Vasketid.';
    return 'Åbn din userscript-udvidelse og opdatér Vasketid.';
  }

  async function checkUpdate() {
    try {
      const txt = await (await fetch(`${SCRIPT_URL}?check=${Date.now()}`, { cache: 'no-store' })).text();
      const v = (/@version\s+([\d.]+)/.exec(txt) || [])[1];
      if (v && newer(v, VERSION)) { S.update = v; render(); }
    } catch (e) { /* intet net – prøv igen senere */ }
  }
  setInterval(checkUpdate, 30 * 60000);

  function startApp() {
    checkUpdate();
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

  const groupKey = (g) => `${g.day}|${g.from}|${g.term}`;
  // Markering på Mine skal kende vaskeriet: samme dato/tid/maskine kan findes i flere vaskerier.
  const selKey = (b) => `${b.term}::${b.key}`;

  function renderBookings() {
    const groups = bookingGroups();
    if (!groups.length) return S.bookingsAt ? '<p class="muted small">Du har ingen vasketider booket.</p>' : '';
    return groups.map((g) => {
      const gk = groupKey(g);
      const keys = g.items.map(selKey);
      const n = keys.filter((k) => S.mineSel.includes(k)).length;
      const state = n === 0 ? '' : n === keys.length ? 'all' : 'some';
      const multi = g.items.length > 1;
      const open = multi && S.mineOpen.includes(gk);
      const sub = open
        ? `<div class="mb-items">${g.items.map((b) => {
          const on = S.mineSel.includes(selKey(b));
          return `<div class="mb-item ${on ? 'sel' : ''}" data-act="mine-item" data-key="${esc(selKey(b))}"><span class="mb-check small" aria-hidden="true">${on ? '✓' : ''}</span><span>${esc(b.cells[1])}</span></div>`;
        }).join('')}</div>`
        : '';
      return `<div class="mybook ${state ? 'sel' : ''}">
        <div class="mb-row">
          <button class="mb-check ${state}" data-act="mine-group" data-k="${esc(gk)}" aria-label="Markér alle">${state === 'all' ? '✓' : state === 'some' ? '–' : ''}</button>
          <div class="mb-main" data-act="mine-group" data-k="${esc(gk)}">
            <div class="mb-when">${esc(fullDay(g.day))} · ${esc(span(g.from, g.to))}</div>
            <div class="mb-sub">${esc(shortName(g.term))} · ${esc(machineList(g.items.map((x) => x.cells[1])))}</div>
          </div>
          ${multi ? `<button class="mb-fold ${open ? 'open' : ''}" data-act="mine-open" data-k="${esc(gk)}" aria-label="Vis maskiner">›</button>` : ''}
        </div>${sub}
      </div>`;
    }).join('');
  }

  function renderBook() {
    const days = Array.from({ length: DAYS }, (_, i) => dayTs(i));
    // Indtil man selv vælger en dag, vises den første dag med ledige tider.
    const day = S.day != null && days.includes(S.day) ? S.day : (days.find((ts) => loadedDay(ts) && freeSlots(ts) > 0) || days[0]);
    shownDay = day;
    const di = days.indexOf(day);
    const ownDays = new Set(bookingGroups().map((g) => g.day));
    const strip = days.map((ts) => {
      const n = loadedDay(ts) ? freeSlots(ts) : null;
      const d = new Date(ts);
      const top = Math.round((ts - dayTs(0)) / 864e5) === 0 ? 'I dag' : cap(WEEKDAYS[d.getDay()]);
      return `<button class="dayb ${ts === day ? 'on' : ''} ${n === 0 ? 'full' : ''}" data-act="day" data-ts="${ts}" aria-label="${esc(fullDay(ts))}${n === 0 ? ', fuldt' : ''}">
        ${ownDays.has(ts) ? '<span class="d-dot" title="Du har en tid"></span>' : ''}
        <span class="d-top">${esc(top)}</span><span class="d-num">${d.getDate()}</span></button>`;
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
          const info = `<span class="s-main"><b>Din tid</b><small>${esc(shortName(g.term))} · ${esc(machineList(g.items.map((b) => b.cells[1])))}</small></span>`;
          return s.items.some((i) => i.cell.bookable)
            ? `<button class="slot mine" data-act="book" data-from="${esc(s.from)}" data-ts="${day}">${t}${info}<span class="s-more">+ Book flere</span></button>`
            : `<div class="slot mine">${t}${info}<span class="s-ok">✓</span></div>`;
        }
        const free = s.items.filter((i) => i.cell.bookable);
        if (!free.length) return `<div class="slot taken">${t}<span class="s-main">Alt optaget</span></div>`;
        const best = free[0].term;
        const othersAll = free.slice(1).map((i) => shortName(i.term));
        const others = othersAll.length > 2 ? [`${othersAll[0]} +${othersAll.length - 1}`] : othersAll;
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
      <section class="block book-block">
        <div class="daybar">
          <div class="days">${strip}</div>
          <div class="dayhead">
            <button class="daynav" data-act="day-step" data-d="-1" ${di <= 0 ? 'disabled' : ''} aria-label="Dagen før">‹</button>
            <span class="dh-title">${esc(fullDay(day))}</span>
            <button class="daynav" data-act="day-step" data-d="1" ${di >= days.length - 1 ? 'disabled' : ''} aria-label="Næste dag">›</button>
          </div>
        </div>
        <div class="slots ${S.slide ? 'slide-' + S.slide : ''}">${list}</div>
        <div class="muted small dh-upd">${esc(updated)}</div>
      </section>`;
  }

  function renderMine() {
    const list = renderBookings();
    if (!list) return '<p class="empty">Henter dine vasketider…</p>';
    if (!bookingGroups().length) {
      return `<section class="block">${list}
        <button class="btn-primary" data-act="tab" data-tab="book">Book en tid</button></section>`;
    }
    const groups = bookingGroups();
    const allKeys = groups.flatMap((g) => g.items.map(selKey));
    S.mineSel = S.mineSel.filter((k) => allKeys.includes(k)); // glem markeringer for maskiner, der er væk
    const n = S.mineSel.length;
    const all = n
      ? `<button class="btn-danger wide-danger" data-act="cancel-all">Afbestil valgte (${n} maskine${n === 1 ? '' : 'r'})</button>`
      : `<button class="btn-ghost danger wide" data-act="cancel-all">Afbestil alle (${allKeys.length} maskine${allKeys.length === 1 ? '' : 'r'})</button>`;
    return `<section class="block">${all}${list}</section>`;
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
  function machineView(m, bookable = true, plan = null) {
    const d = m.detail || '';
    let r;
    if ((r = /Klar\s*ca\.?:?\s*(\d{1,2}[:.]\d{2})/i.exec(d))) {
      const hm = r[1].replace('.', ':');
      const left = minutesUntil(hm);
      return { cls: 'run', label: 'I brug', sub: `til ${hm} · ${Math.max(left, 1)} min` };
    }
    if ((r = /Start\w*\s*(\d{1,2}[:.]\d{2})/i.exec(d))) {
      const since = -minutesUntil(r[1].replace('.', ':'));
      return { cls: 'run', label: 'I brug', sub: since > 0 ? `i gang i ${since} min` : 'lige startet' };
    }
    const cls = stateClass(m.state);
    if (cls === 'err') return { cls, label: m.state, sub: '' };
    // Uden for vasketiderne (fx efter 20:30 og før 07:00) er vaskeriet lukket.
    if (!passNow()) return { cls: 'closed', label: 'Lukket', sub: `åbner kl. ${shortTime(passes()[0][0])}` };
    const last = (r = /Afsluttedes\s*(\d{1,2}[:.]\d{2})/i.exec(d)) ? `sidst brugt ${r[1].replace('.', ':')}` : '';
    if (cls === 'res') {
      const cur = passNow();
      if (cur) return { cls: 'res', label: 'Booket nu', sub: `til kl. ${shortTime(cur[1])}` };
      const nx = nextPass()[0];
      return { cls: 'ok', label: 'Ledig', sub: toMin(nx) > nowMin() ? `til kl. ${shortTime(nx)}` : `til i morgen kl. ${shortTime(nx)}` };
    }
    // API'ets status kender ikke bookinger – dagsplanen ved, om maskinen er booket i den igangværende tid.
    if (cls === 'ok' && bookable && plan && plan.now && (plan.now[machineNo(m.name)] || plan.now['*'])) {
      return { cls: 'res', label: 'Booket nu', sub: `til kl. ${shortTime(passNow()[1])}` };
    }
    if (cls === 'ok') {
      if (!bookable || !plan) return { cls, label: 'Ledig', sub: '' };
      const at = plan.next[machineNo(m.name)] || plan.next['*'];
      return { cls, label: 'Ledig', sub: at ? `til kl. ${shortTime(at)}` : 'resten af dagen' };
    }
    return { cls, label: m.state, sub: last || d };
  }

  function renderStatus() {
    let html = '';
    if (S.statusError) html += `<div class="alert">${esc(S.statusError)}<button class="btn-ghost" data-act="status-retry">Prøv igen</button></div>`;
    if (S.status) {
      const order = ordered();
      const rank = (n) => { const i = order.findIndex((t) => sameLaundry(t, n)); return i < 0 ? 50 + hillRank(n) : i; };
      const ls = [...S.status.laundries].sort((a, b) => rank(a.name) - rank(b.name));
      html += `<p class="muted small status-upd">Opdateret ${esc(ago(S.status.at))}.${S.planBusy ? ' Henter dagens bookinger…' : ''}</p>`;
      for (const L of ls) {
        const groups = L.groups.map((g) => {
          const term = S.terms.find((t) => sameLaundry(t, L.name));
          const plan = term && S.dayPlan[term] && S.dayPlan[term].day === dayTs(0) ? S.dayPlan[term] : null;
          const views = g.machines.map((m) => ({ m, v: machineView(m, !/tørre/i.test(g.type), plan) }));
          const free = views.filter((x) => x.v.cls === 'ok').length;
          const busy = views.filter((x) => x.v.cls === 'run').length;
          const closed = views.every((x) => x.v.cls === 'closed' || x.v.cls === 'run');
          return `<div class="grp"><div class="grp-h">${esc(g.type)} <span class="muted">${closed ? 'Lukket' : `${free} af ${g.machines.length} ledige nu`}${busy ? ` · ${busy} i brug` : ''}</span></div>
            <div class="machines">${views.map(({ m, v }) => `<div class="mach ${v.cls}"><div class="m-name">${esc(m.name)}</div><div class="m-state">${esc(v.label)}</div>${v.sub ? `<div class="m-sub">${esc(v.sub).replace(/ · /g, '<br>')}</div>` : ''}</div>`).join('')}</div></div>`;
        }).join('');
        // Status-siden staver nogle navne forkert (fx "Sokkellundsvej") – vis navnet fra vaskeri-listen.
        const name = S.terms.find((t) => sameLaundry(t, L.name)) || L.name;
        html += `<section class="block card"><h2>${esc(name)}</h2>${groups}</section>`;
      }
    } else if (!S.statusError) {
      html += '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    }
    return html;
  }

  function renderLogin() {
    const c = savedCreds();
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
      if (sh.flash) h += `<div class="flash">✓ ${esc(sh.flash)}</div>`;
      // Vaskeri-valg (kun dem med plads, i din rækkefølge)
      h += `<div class="seg-l">${sh.cands.map((c, i) => `<button class="${i === sh.idx ? 'on' : ''}" data-act="probe" data-i="${i}">${esc(shortName(c.term))}</button>`).join('')}</div>`;
      const c = sh.cands[sh.idx];
      const p = sh.probes[c.term] || {};
      if (p.state === 'loading') {
        h += `<div class="sh-wait"><span class="spinner"></span>${activity ? `${esc(activity.label)} … ${Math.floor((Date.now() - activity.since) / 1000)} s` : `Ser hvilke maskiner der er ledige på ${esc(shortName(c.term))}…`}</div>`;
      } else if (p.state === 'error') {
        h += `<div class="alert">${esc(p.msg)}</div>`;
        if (sh.idx + 1 < sh.cands.length) h += `<button class="btn-ghost wide" data-act="probe" data-i="${sh.idx + 1}">Prøv ${esc(shortName(sh.cands[sh.idx + 1].term))}</button>`;
      } else if (p.state === 'ok') {
        const free = freeLabels(p.mg);
        const mine = ownMachines(sh, c.term);
        h += `<div class="mgrid">${p.mg.options.map((o) => {
          const no = machineNo(o.label);
          if (o.disabled && mine.includes(no)) {
            const rm = sh.remove.includes(no);
            return `<button class="mbtn own ${rm ? 'rm' : ''}" data-act="machine-own" data-no="${esc(no)}">${esc(o.label)}<small>${rm ? 'afbestilles' : 'din'}</small></button>`;
          }
          const on = sh.sel.includes(o.label);
          return `<button class="mbtn ${on ? 'on' : ''}" data-act="machine" data-label="${esc(o.label)}" ${o.disabled ? 'disabled' : ''}>${esc(o.label)}<small>${o.disabled ? 'optaget' : on ? 'valgt' : 'ledig'}</small></button>`;
        }).join('')}</div>`;
        const n = sh.sel.length;
        const m = sh.remove.length;
        const label = n && m ? `Book ${n} · afbestil ${m}`
          : n ? `Book ${n === 1 ? esc(sh.sel[0]) : `${n} maskiner`}`
            : m ? `Afbestil ${m === 1 ? `Vask ${esc(sh.remove[0])}` : `${m} maskiner`}`
              : (mine.length ? 'Vælg flere maskiner' : 'Vælg mindst én maskine');
        h += `<button class="${m && !n ? 'btn-danger' : 'btn-primary'} big" data-act="do-book" ${n || m ? '' : 'disabled'}>${label}</button>`;
        if (p.mg.quota != null) h += `<div class="muted small center">Du kan booke ${p.mg.quota} maskine${p.mg.quota === 1 ? '' : 'r'} mere på ${esc(shortName(c.term))}.</div>`;
      }
      h += '<button class="btn-link" data-act="close-sheet">Fortryd</button>';
    } else if (sh.phase === 'booking') {
      h += `<div class="sh-wait"><span class="spinner"></span>${esc(activity ? `${activity.label} … ${Math.floor((Date.now() - activity.since) / 1000)} s` : (sh.progress || 'Booker…'))}</div>`;
    } else if (sh.phase === 'done') {
      const r = sh.result;
      if (r.done.length) {
        h += `<div class="success"><div class="big-check">✓</div>Booket på ${esc(shortName(sh.term))}:<br>${esc(machineList(r.done))}</div>`;
      }
      if (r.cancelled && r.cancelled.length) {
        h += `<div class="success ${r.done.length ? 'small-ok' : ''}">${r.done.length ? '' : '<div class="big-check">✓</div>'}Afbestilt: ${esc(machineList(r.cancelled))}</div>`;
      }
      if (r.error) h += `<div class="alert">${r.done.length ? 'Resten gik ikke igennem: ' : ''}${esc(r.error.message)}</div>`;
      if (r.left != null) h += `<div class="muted small center">Du kan booke ${r.left} maskine${r.left === 1 ? '' : 'r'} mere på ${esc(shortName(sh.term))}.</div>`;
      h += '<button class="btn-primary" data-act="close-sheet">Færdig</button>';
    }
    return h;
  }

  function renderCancelAllSheet(sh) {
    const n = sh.groups.reduce((x, g) => x + g.items.length, 0);
    let h = `<div class="sh-title">${sh.partial ? 'Afbestil valgte vasketider?' : 'Afbestil alle vasketider?'}</div>`;
    h += `<div class="cl-list">${sh.groups.map((g) => `<div>${esc(fullDay(g.day))} kl. ${esc(span(g.from, g.to))} · ${esc(shortName(g.term))} · ${esc(machineList(g.items.map((b) => b.cells[1])))}</div>`).join('')}</div>`;
    if (sh.phase === 'confirm') h += `<button class="btn-danger big" data-act="do-cancel-all">Ja, afbestil ${sh.partial ? '' : 'alle '}${n} maskine${n === 1 ? '' : 'r'}</button><button class="btn-link" data-act="close-sheet">Nej, behold dem</button>`;
    if (sh.phase === 'cancelling') h += '<div class="sh-wait"><span class="spinner"></span>Afbestiller…</div>';
    if (sh.phase === 'error') h += `<div class="alert">${esc(sh.msg)}</div><button class="btn-primary" data-act="close-sheet">OK</button>`;
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
    if (savedCreds()) h += '<button class="btn-link small" data-act="forget">Glem mit login på denne telefon</button>';
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
    const inner = sh.kind === 'book' ? renderBookSheet(sh) : sh.kind === 'cancel' ? renderCancelSheet(sh) : sh.kind === 'cancelall' ? renderCancelAllSheet(sh) : renderSettingsSheet();
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
      if (S.update && !S.updateHidden) main += `<div class="update"><span>Ny version ${esc(S.update)} er klar</span><button class="btn-primary small-btn" data-act="do-update">Opdatér</button><button class="btn-x" data-act="hide-update" aria-label="Skjul">✕</button><small class="upd-help">Virker knappen ikke? ${esc(updateHelp())}</small></div>`;
      if (S.error) main += `<div class="alert">${esc(S.error)}<button class="btn-ghost" data-act="refresh">Prøv igen</button></div>`;
      main += S.tab === 'book' ? renderBook() : S.tab === 'mine' ? renderMine() : renderStatus();
    }
    const sheet = renderSheet(!!S.sheet && !sheetWasOpen);
    sheetWasOpen = !!S.sheet;
    const parts = {
      header: `<div class="h-row"><h1>${S.view === 'app' ? { book: 'Book vask', mine: 'Mine vasketider', status: 'Status' }[S.tab] : 'Vasketid'}</h1>
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
      toast: S.toast ? `<div class="toast">${esc(S.toast)}</div>`
        : activity && Date.now() - activity.since > 700 && !(S.sheet && S.sheet.kind === 'book')
          ? `<div class="activity"><span class="spinner"></span>${esc(activity.label)} … ${Math.floor((Date.now() - activity.since) / 1000)} s</div>` : '',
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
        const oldSeg = el.querySelector('.seg-l');
        const segX = oldSeg ? oldSeg.scrollLeft : 0;
        el.innerHTML = html;
        const nw = el.querySelector('.sheet');
        if (nw && old) nw.scrollTop = top;
        // Vaskeri-rækken i bookingvinduet: bliv stående og sørg for at det valgte kan ses.
        const seg = el.querySelector('.seg-l');
        if (seg) {
          seg.scrollLeft = segX;
          const on = seg.querySelector('.on');
          if (on) {
            const r = on.getBoundingClientRect();
            const sr = seg.getBoundingClientRect();
            if (r.left < sr.left) seg.scrollLeft -= sr.left - r.left + 12;
            else if (r.right > sr.right) seg.scrollLeft += r.right - sr.right + 12;
          }
        }
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
      case 'day-step': stepDay(+el.dataset.d); break;
      case 'book': openBooking(el.dataset.from, +el.dataset.ts); break;
      case 'probe': probe(+el.dataset.i); break;
      case 'machine': toggleMachine(el.dataset.label); break;
      case 'machine-own': toggleOwn(el.dataset.no); break;
      case 'count': setCount(S.count + +el.dataset.d); break;
      case 'do-book': doBook(); break;
      case 'close-sheet': closeSheet(); break;
      case 'cancel': askCancel(+el.dataset.i); break;
      case 'toggle-cancel': toggleCancel(el.dataset.key); break;
      case 'do-cancel': doCancel(); break;
      case 'cancel-all': askCancelAll(); break;
      case 'hide-update': S.updateHidden = true; render(); break;
      case 'do-update': {
        // Åbn i ny fane direkte fra trykket – så må Firefox/Violentmonkey vise "Installér"-siden.
        const w = window.open(SCRIPT_URL, '_blank');
        if (!w) location.href = SCRIPT_URL;
        break;
      }
      case 'mine-group': toggleMineGroup(el.dataset.k); break;
      case 'mine-item': toggleMineItem(el.dataset.key); break;
      case 'mine-open': toggleMineOpen(el.dataset.k); break;
      case 'do-cancel-all': doCancelAll(); break;
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
  #vt-root .mybook{display:block;gap:12px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:12px 12px 12px 14px;margin-bottom:8px;box-shadow:var(--shadow)}
  #vt-root .mb-check{width:28px;height:28px;border-radius:14px;border:2px solid var(--line);background:var(--card);color:var(--accent-fg);font-weight:700;font-size:15px;flex:none;display:grid;place-items:center;padding:0}
  #vt-root .mb-row{display:flex;align-items:center;gap:12px}
  #vt-root .mybook.sel{border-color:var(--err);border-left-color:var(--err)}
  #vt-root .mb-check.all,#vt-root .mb-check.some,#vt-root .mb-item.sel .mb-check{background:var(--err);border-color:var(--err);color:#fff}
  #vt-root .mb-check.small{width:24px;height:24px;font-size:13px}
  #vt-root .mb-main[data-act]{cursor:pointer}
  #vt-root .mb-fold{width:36px;height:36px;border:0;background:none;color:var(--muted);font-size:22px;flex:none;transition:transform .15s}
  #vt-root .mb-fold.open{transform:rotate(90deg)}
  #vt-root .mb-items{margin:8px 0 0 40px;display:flex;flex-direction:column;gap:6px}
  #vt-root .mb-item{display:flex;align-items:center;gap:10px;font-size:15px;padding:4px 0;cursor:pointer}
  #vt-root .mb-check.small{display:grid;place-items:center}
  #vt-root .btn-danger.wide-danger{margin:0 0 10px;padding:12px;font-size:15px}
  #vt-root .mb-main{flex:1;min-width:0} #vt-root .mb-when{font-weight:700} #vt-root .mb-sub{color:var(--muted);font-size:14px}
  #vt-root .book-block{margin-top:0}
  #vt-root .daybar{position:sticky;top:0;z-index:4;background:var(--bg);margin:-8px -16px 0;padding:8px 16px 6px;border-bottom:1px solid var(--line)}
  #vt-root .days{display:flex;gap:6px;overflow-x:auto;padding:2px 16px 8px;margin:0 -16px;scrollbar-width:none}
  #vt-root .days::-webkit-scrollbar{display:none}
  #vt-root .dayb{position:relative;flex:none;width:48px;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:5px 0;display:flex;flex-direction:column;align-items:center;gap:0}
  #vt-root .d-top{font-size:11px;color:var(--muted)} #vt-root .d-num{font-size:18px;font-weight:700;line-height:1.2}
  #vt-root .d-dot{position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:4px;background:var(--accent)}
  #vt-root .dayb.full{opacity:.45}
  #vt-root .slots{margin-top:10px}
  #vt-root .status-h{margin-bottom:0} #vt-root .status-upd{margin-top:0}
  #vt-root .dayb.on{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
  #vt-root .dayb.on .d-top{color:var(--accent-fg);opacity:.9} #vt-root .dayb.on.full{opacity:1}
  #vt-root .dayb.on .d-dot{background:var(--accent-fg)}
  #vt-root .dayhead{display:flex;align-items:center;gap:6px;font-weight:700;font-size:17px;margin:6px 0 0}
  #vt-root .dh-title{flex:1;text-align:center}
  #vt-root .daynav{width:40px;height:36px;border:1px solid var(--line);background:var(--card);border-radius:10px;font-size:22px;line-height:1;color:var(--accent);flex:none}
  #vt-root .daynav:disabled{opacity:.3}
  #vt-root .dh-upd{text-align:center;margin:12px 0 0}
  #vt-root .slots.slide-next{animation:vtslideN .2s ease-out} #vt-root .slots.slide-prev{animation:vtslideP .2s ease-out}
  @keyframes vtslideN{from{transform:translateX(24px);opacity:.3}} @keyframes vtslideP{from{transform:translateX(-24px);opacity:.3}}
  #vt-root .slots{display:flex;flex-direction:column;gap:8px}
  #vt-root .slot{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border-radius:14px;padding:10px 10px 10px 12px;border:1px solid var(--line);background:var(--card);min-height:62px}
  #vt-root .s-time{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;width:66px;flex:none;white-space:nowrap}
  #vt-root .s-time small{font-size:14px;font-weight:500;opacity:.7}
  #vt-root .s-main{flex:1;min-width:0;display:flex;flex-direction:column}
  #vt-root .s-main b{font-size:15px} #vt-root .s-main small{font-size:13px;opacity:.8;line-height:1.3}
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
  #vt-root .mach.run{background:var(--runbg);color:var(--run)} #vt-root .mach.err{background:var(--errbg);color:var(--err)} #vt-root .mach.closed{background:var(--bg);color:var(--muted);border:1px solid var(--line)}
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
  #vt-root .block > .btn-ghost.wide:first-child{margin:0 0 10px}
  #vt-root .cl-list{margin:10px 0;font-size:14px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
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
  #vt-root .sheet{position:fixed;left:0;right:0;bottom:0;z-index:11;background:var(--card);border-radius:22px 22px 0 0;padding:20px 18px 8px;max-width:640px;margin:0 auto;max-height:90vh;overflow-y:auto}
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
  #vt-root .mbtn.own{border-color:var(--accent);background:var(--soft);color:var(--accent)} #vt-root .mbtn.own small{color:var(--accent)}
  #vt-root .mbtn.own.rm{border-color:var(--err);background:var(--errbg);color:var(--err);text-decoration:line-through} #vt-root .mbtn.own.rm small{color:var(--err);text-decoration:none}
  #vt-root .success.small-ok{font-size:15px;padding-top:0}
  #vt-root .flash{background:var(--okbg);color:var(--ok);border-radius:12px;padding:10px 12px;margin:10px 0 0;font-weight:700;font-size:15px}
  #vt-root .s-more{border:1px solid var(--accent);color:var(--accent);border-radius:10px;padding:7px 10px;font-size:13px;font-weight:700;flex:none;white-space:nowrap}
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
  #vt-root nav{flex:none;z-index:6;display:flex;background:var(--card);border-top:1px solid var(--line)}
  #vt-root nav button{position:relative;flex:1;background:none;border:0;padding:8px 0 9px;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:2px;font-size:12px}
  #vt-root nav button.on{color:var(--accent);font-weight:600}
  #vt-root nav .badge{position:absolute;top:4px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:11px;font-weight:700;display:grid;place-items:center}
  #vt-root .activity{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;background:var(--card);color:var(--muted);border:1px solid var(--line);padding:7px 12px;border-radius:18px;z-index:19;font-size:13px;white-space:nowrap;box-shadow:var(--shadow);max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis}
  #vt-root .update{display:flex;align-items:center;gap:8px;background:var(--soft);color:var(--accent);border-radius:12px;padding:8px 8px 8px 12px;margin:0 0 10px;font-weight:600;font-size:14px}
  #vt-root .update{flex-wrap:wrap}
  #vt-root .update span{flex:1}
  #vt-root .update .upd-help{flex-basis:100%;font-weight:400;font-size:12px;opacity:.8}
  #vt-root .btn-primary.small-btn{display:inline-block;width:auto;margin:0;padding:8px 14px;font-size:14px;text-decoration:none}
  #vt-root .btn-x{border:0;background:none;color:var(--muted);width:32px;height:32px;font-size:15px}
  #vt-root .toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:11px 18px;border-radius:22px;z-index:20;font-size:14px;font-weight:600;white-space:nowrap}
  `;

  function addViewport() {
    let m = document.querySelector('meta[name=viewport]');
    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
    m.content = 'width=device-width, initial-scale=1';
  }

  function showReturnButton() {
    const b = document.createElement('button');
    b.textContent = 'Tilbage til Vasketid';
    b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;padding:12px 16px;border-radius:24px;border:0;background:#0a66c2;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = () => { session.del('off'); location.href = BASE + 'Booking/TerminalSelector.aspx'; };
    document.body.appendChild(b);
  }

  setInterval(() => { if (activity) render(); }, 1000);

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
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    document.title = 'Vasketid';
    let meta = document.querySelector('meta[name=theme-color]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = matchMedia('(prefers-color-scheme: dark)').matches ? '#0d0f13' : '#f3f4f6';

    const c = savedCreds();
    if (c && isBlocked() && isLoginPage(document)) { S.view = 'login'; S.error = blockedError().message; render(); return; }
    // Med gemt login går alt via API'et – websiden behøver ikke engang at være logget ind.
    let startupError = null;
    if (c && !isBlocked() && !restoreApiKey()) {
      render();
      try { await serial(apiConnect, true); } catch (e) { api.broken = e.message || 'API-login fejlede'; startupError = e; }
    }
    if (isLoginPage(document) && !api.guid) {
      // Ikke et login nummer to på websiden af sig selv – brugeren trykker selv Log ind.
      S.view = 'login';
      if (c) {
        S.error = startupError && ['BLOCKED', 'THROTTLE'].includes(startupError.code)
          ? startupError.message
          : 'Automatisk login lykkedes ikke. Tryk Log ind for at prøve igen.';
      }
      render();
      return;
    }
    startApp();
  }

  // Til test udefra (ingen effekt i normal brug).
  window.__vasketid = {
    S, render: () => render(), refresh, slotsFor, bookingGroups, ordered, parseStatus, machineView, timings,
    apiState: () => ({ ready: apiReady(), loggedIn: !!api.guid, broken: api.broken, off: api.off }),
    useWeb: (on) => { api.off = !!on; }, // test: tving websiderne for at måle før/efter
  };

  init();
})();
