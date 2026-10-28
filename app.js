/* Монитор тендеров — сайт без сервера и без библиотек.
   Данные: data/*.enc (зашифрованы; ключ отпирается паролем пользователя через data/auth.json)
   или data/*.json, если вход на сайт выключен (content/settings.txt). Всё считается в браузере. */
(function () {
  'use strict';

  const CFG = JSON.parse(document.getElementById('site-config').textContent);

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtInt = new Intl.NumberFormat('ru-RU');
  const fmt1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const fmtBig = (v) => {
    if (v == null || isNaN(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return fmt1.format(v / 1e9) + ' млрд';
    if (a >= 1e6) return fmt1.format(v / 1e6) + ' млн';
    if (a >= 1e4) return fmt1.format(v / 1e3) + ' тыс.';
    return fmtInt.format(Math.round(v));
  };
  const pct = (v) => (v == null ? '—' : fmt1.format(v) + '%');
  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2]; };
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const longDate = (s) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)} г.`;
  const shortDate = (s) => (s ? s.slice(8, 10) + '.' + s.slice(5, 7) : '');
  const periodLabel = (p) => { const q = p.match(/^(\d{4})-Q(\d)$/); return q ? `${['I', 'II', 'III', 'IV'][q[2] - 1]} кв. ${q[1]}` : `${MON[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`; };
  const MONTHS_IN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
  const periodIn = (p) => { const q = p.match(/^(\d{4})-Q(\d)$/); return q ? `в ${['I', 'II', 'III', 'IV'][q[2] - 1]} квартале` : `в ${MONTHS_IN[Number(p.slice(5, 7)) - 1]}`; };
  const KIND_COLOR = { 'Товары': 'var(--c-goods)', 'Работы': 'var(--c-works)', 'Услуги': 'var(--c-services)' };
  const safeUrl = (u) => (/^https:\/\/icetrade\.by\//.test(u) ? u : null);

  /* ---------- вход: PBKDF2 + AES-GCM (Web Crypto), как в site_auth.py ---------- */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const ver = '?v=' + encodeURIComponent(CFG.build || '');
  const store = {
    get() { for (const st of [localStorage, sessionStorage]) { try { const v = st.getItem('tm.auth'); if (v) return JSON.parse(v); } catch (e) { /* хранилище недоступно */ } } return null; },
    set(v, remember) { this.clear(); try { (remember ? localStorage : sessionStorage).setItem('tm.auth', JSON.stringify(v)); } catch (e) { /* без запоминания */ } },
    clear() { for (const st of [localStorage, sessionStorage]) { try { st.removeItem('tm.auth'); } catch (e) { /* ничего */ } } },
  };
  async function loginId(login) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('tm1|' + login.normalize('NFC').trim().toLowerCase())));
    return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function deriveKek(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC').trim()), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }
  async function aesOpen(raw, blob, aad) {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const p = { name: 'AES-GCM', iv: blob.slice(0, 12) }; if (aad) p.additionalData = aad;
    return new Uint8Array(await crypto.subtle.decrypt(p, key, blob.slice(12)));
  }
  async function gunzip(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  let authFile = null;
  async function getAuth() {
    if (!authFile) authFile = await fetch('data/auth.json' + ver, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('auth.json ' + r.status); return r.json(); });
    return authFile;
  }
  async function unlock(id, kek) {
    const e = (await getAuth()).users[id];
    if (!e) { const err = new Error('нет пользователя'); err.code = 'nouser'; throw err; }
    const o = JSON.parse(dec.decode(await aesOpen(kek, b64d(e.w), enc.encode(id))));
    return { key: b64d(o.k), name: o.n || '' };
  }
  async function fetchEnc(path, key) {
    const r = await fetch(path + ver, { cache: 'no-store' });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return JSON.parse(dec.decode(await gunzip(await aesOpen(key, new Uint8Array(await r.arrayBuffer())))));
  }

  /* ---------- поиск: та же логика основы слова, что в build_site.py ---------- */
  const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е');
  const ENDINGS = /(ами|ями|ого|его|ому|ему|ыми|ими|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ые|ие|ых|их|ом|ем|ам|ям|ах|ях|ую|юю|а|я|о|е|ы|и|у|ю|ь)$/;
  const stem = (w) => { const x = norm(w); const s = x.replace(ENDINGS, ''); return s.length >= 4 ? s : x; };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const LETTER = '0-9a-zа-я';
  function queryRegexes(q) {
    return (norm(q).match(/[0-9a-zа-я-]+/g) || []).filter((w) => w.length >= 2)
      .map((w) => new RegExp(`(^|[^${LETTER}])(${esc(stem(w))}[${LETTER}-]*)`, 'g'));
  }
  function highlight(text, regs) {
    const frag = document.createDocumentFragment();
    if (!regs.length) { frag.append(text); return frag; }
    const n = norm(text), ranges = [];
    for (const re of regs) { re.lastIndex = 0; let m; while ((m = re.exec(n))) { const s = m.index + m[1].length; ranges.push([s, s + m[2].length]); if (m[0].length === 0) re.lastIndex++; } }
    ranges.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [s, e] of ranges) {
      if (s < pos) continue;
      frag.append(text.slice(pos, s));
      frag.append(el('mark', null, text.slice(s, e)));
      pos = e;
    }
    frag.append(text.slice(pos));
    return frag;
  }

  /* ---------- состояние ---------- */
  const FILTERS = { q: '', o: '', c: '', k: '', src: '', p: '', d: '', s: 'urgent', div: '', sub: '' };
  const state = { ...FILTERS };
  let shown = 30, data = null, summary = null, grain = 'month', today = '';

  function readUrl() {
    const u = new URLSearchParams(location.search);
    for (const k of Object.keys(FILTERS)) state[k] = u.get(k) ?? FILTERS[k];
  }
  function writeUrl() {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) if (v && v !== FILTERS[k]) u.set(k, v);
    const qs = u.toString();
    try { history.replaceState(null, '', (qs ? '?' + qs : location.pathname) + location.hash); } catch (e) { /* предпросмотр без адресной строки */ }
  }

  /* ---------- разделы ---------- */
  const DATA_VIEWS = ['poisk', 'rynok', 'dinamika'];
  const PAGES = CFG.pages || [];
  const VIEWS = ['vhod', ...DATA_VIEWS, ...PAGES.map((p) => p.slug)];
  const LEGACY = { start: 'novichkam' };  // старые ссылки
  let session = null;                      // { key, name } после входа
  let wanted = '';                         // куда шёл посетитель до входа
  const isClosed = (v) => CFG.login && !session && (DATA_VIEWS.includes(v) || PAGES.some((p) => p.slug === v && p.private));
  const menuName = (v) => ($(`.nav [data-view-link="${v}"]`) || { textContent: '' }).textContent.trim();

  function showView(v) {
    v = LEGACY[v] || v;
    if (!VIEWS.includes(v) || (v === 'vhod' && (!CFG.login || session))) v = CFG.login && !session ? 'vhod' : 'poisk';
    if (isClosed(v)) {
      wanted = v;
      $('#login-reason').textContent = `Раздел «${menuName(v)}» открывается после входа.`;
      v = 'vhod';
    }
    for (const id of VIEWS) { const sec = $('#view-' + id); if (sec) sec.hidden = id !== v; }
    $$('.nav [data-view-link]').forEach((a) => {
      if (a.dataset.viewLink === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      a.classList.toggle('is-locked', isClosed(a.dataset.viewLink));
    });
    if (v === 'rynok') renderMarket();
    if (v === 'dinamika') renderTrends();
    if (v === 'vhod') setTimeout(() => { const f = $('#lg-login'); if (f && !f.value) f.focus({ preventScroll: true }); }, 50);
    return v;
  }
  function route(scroll = true) {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h || VIEWS.includes(LEGACY[h] || h)) { showView(h); if (scroll) window.scrollTo(0, 0); return; }
    const t = document.getElementById(h), sec = t && t.closest('.view');
    if (sec) { showView(sec.id.slice(5)); setTimeout(() => t.scrollIntoView(), 30); return; }
    const page = PAGES.find((p) => (p.anchors || []).includes(h));
    showView(page ? page.slug : h);
  }
  window.addEventListener('hashchange', () => route());

  /* ---------- загрузка ---------- */
  const loadFailed = () => {
    $('#intro-text').textContent = 'Не удалось загрузить данные. Обновите страницу; если ошибка повторится, данные ещё публикуются — попробуйте через несколько минут.';
  };
  function receive([s, t, pages]) {
      if (pages) {
        for (const [slug, htmlText] of Object.entries(pages)) {
          if (!$('#view-' + slug)) $('main').insertAdjacentHTML('beforeend', htmlText);
        }
        watchToc();
      }
      summary = s;
      const ix = Object.fromEntries(t.columns.map((c, i) => [c, i]));
      data = t.rows.map((r) => {
        const o = {};
        for (const c of t.columns) o[c] = r[ix[c]];
        o.url = o.url || t.url_template.replace('{id}', o.id);
        o.text = norm([o.title, o.customer, o.subcategory, o.division_name, o.category].join(' '));
        return o;
      });
      // «Дней до окончания» — от сегодняшней даты: данные обновляются раз в неделю, а сроки идут каждый день
      const now = new Date();
      const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      today = localToday > s.report_date ? localToday : s.report_date;
      const t0 = Date.parse(today + 'T00:00:00Z');
      data = data.filter((o) => o.deadline && o.deadline >= today);
      for (const o of data) o.days_left = Math.round((Date.parse(o.deadline + 'T00:00:00Z') - t0) / 864e5);
      init();
  }
  function loadOpen() {
    return Promise.all([fetch('data/summary.json' + ver).then((r) => r.json()), fetch('data/tenders.json' + ver).then((r) => r.json()), null]);
  }
  function loadLocked() {
    const priv = PAGES.some((p) => p.private);
    return Promise.all([fetchEnc('data/summary.enc', session.key), fetchEnc('data/tenders.enc', session.key), priv ? fetchEnc('data/pages.enc', session.key) : null]);
  }
  function signedIn() {
    $('#btn-login').hidden = true;
    const who = $('#who'); who.hidden = false;
    const name = session.name || 'Вы вошли';
    who.replaceChildren(el('i', null, name.trim()[0] ? name.trim()[0].toUpperCase() : '•'), name);
    $('#btn-logout').hidden = false;
  }

  async function boot() {
    watchToc();
    if (CFG.date) {
      $('#landing-meta').textContent = `Данные на ${longDate(CFG.date)}`;
      $$('.js-date').forEach((e) => { e.textContent = longDate(CFG.date); });
    }
    if (!CFG.login) {
      $('#account').hidden = true;
      route();
      return loadOpen().then(receive).catch(loadFailed);
    }
    if (!window.crypto || !crypto.subtle || typeof DecompressionStream === 'undefined') {
      route();
      showLoginError('Этот браузер устарел и не умеет открывать защищённые данные. Обновите Chrome, Edge, Firefox или Safari.');
      return;
    }
    const saved = store.get();
    if (saved) {
      try { session = await unlock(saved.id, b64d(saved.kek)); } catch (e) {
        store.clear();
        if (e.code === 'nouser' || e.name === 'OperationError') $('#login-reason').textContent = 'Пароль изменён или доступ закрыт. Войдите снова или напишите администратору.';
      }
    }
    route();
    if (session) { signedIn(); return loadLocked().then(receive).catch(loadFailed); }
  }

  function init() {
    $$('.js-date').forEach((e) => { e.textContent = longDate(summary.report_date); });
    const open = data.length, openSum = data.reduce((a, t) => a + (t.currency === 'BYN' ? t.price || 0 : 0), 0);
    const due3 = data.filter((t) => t.days_left <= 3).length;
    const intro = $('#intro-text');
    intro.replaceChildren(
      'Сейчас принимают заявки ', el('b', null, fmtInt.format(open)), ` ${plural(open, ['закупка', 'закупки', 'закупок'])} на `,
      el('b', null, fmtBig(openSum) + ' BYN'), '. ', el('span', 'hot', fmtInt.format(due3)),
      ` из них закрываются в ближайшие 3 дня. Данные icetrade.by и zakupki.butb.by на ${longDate(summary.report_date)}`);

    // подсказки
    const chips = $('#chips');
    const live = summary.chips.map((c) => {
      const regs = queryRegexes(c.q);
      return { q: c.q, n: data.filter((t) => regs.every((re) => { re.lastIndex = 0; return re.test(t.text); })).length };
    }).filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
    chips.append(...live.map((c) => {
      const b = el('button', 'chip'); b.type = 'button'; b.dataset.q = c.q;
      b.append(c.q, el('span', null, fmtInt.format(c.n)));
      b.addEventListener('click', () => { state.q = state.q === c.q ? '' : c.q; $('#q').value = state.q; update(); });
      return b;
    }));

    // фильтры
    const facet = (key) => Object.entries(data.reduce((m, t) => { if (t[key]) m[t[key]] = (m[t[key]] || 0) + 1; return m; }, {}))
      .map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    const fill = (sel, items, all) => { sel.replaceChildren(new Option(all, ''), ...items.map((i) => new Option(`${i.name} (${fmtInt.format(i.n)})`, i.name))); };
    fill($('#f-oblast'), facet('oblast'), 'Все области');
    fill($('#f-category'), facet('category'), 'Все отрасли');
    fill($('#f-kind'), facet('kind').filter((k) => k.name !== 'Не указано'), 'Все типы');
    const bind = (id, key) => $(id).addEventListener('change', (e) => { state[key] = e.target.value; update(); });
    bind('#f-oblast', 'o'); bind('#f-category', 'c'); bind('#f-kind', 'k'); bind('#f-src', 'src'); bind('#f-price', 'p'); bind('#f-days', 'd'); bind('#f-sort', 's');
    let timer;
    $('#q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); update(); }, 180); });
    $('#clear-q').addEventListener('click', () => { state.q = ''; $('#q').value = ''; update(); $('#q').focus(); });
    $('#reset').addEventListener('click', () => { Object.assign(state, FILTERS); syncControls(); update(); });
    $('#more').addEventListener('click', () => { shown += 30; renderResults(false); });
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { grain = b.dataset.grain; renderTrends(); }));

    readUrl();
    syncControls();
    update(true);
    route(false);
  }

  function syncControls() {
    $('#q').value = state.q;
    for (const [id, k] of [['#f-oblast', 'o'], ['#f-category', 'c'], ['#f-kind', 'k'], ['#f-src', 'src'], ['#f-price', 'p'], ['#f-days', 'd'], ['#f-sort', 's']]) {
      const s = $(id); s.value = state[k]; if (s.value !== state[k]) { s.value = ''; state[k] = ''; }
      s.classList.toggle('is-set', !!state[k] && k !== 's');
    }
  }

  function update(keepShown) {
    if (!keepShown) shown = 30;
    syncControls();
    writeUrl();
    renderResults(true);
  }

  /* ---------- результаты ---------- */
  let lastFound = [], firstPaint = true;
  function filtered() {
    const regs = queryRegexes(state.q);
    const [pMin, pMax] = state.p ? state.p.split('-').map((x) => (x === '' ? null : Number(x))) : [null, null];
    const [dMin, dMax] = state.d ? state.d.split('-').map((x) => (x === '' ? null : Number(x))) : [null, null];
    const out = data.filter((t) => {
      if (state.o && t.oblast !== state.o) return false;
      if (state.c && t.category !== state.c) return false;
      if (state.k && t.kind !== state.k) return false;
      if (state.src && t.source !== state.src) return false;
      if (state.div && t.division_name !== state.div) return false;
      if (state.sub && t.subcategory !== state.sub) return false;
      if (pMin != null && !(t.currency === 'BYN' && t.price >= pMin)) return false;
      if (pMax != null && !(t.currency === 'BYN' && t.price < pMax)) return false;
      if (dMin != null && !(t.days_left >= dMin)) return false;
      if (dMax != null && !(t.days_left <= dMax)) return false;
      for (const re of regs) { re.lastIndex = 0; if (!re.test(t.text)) return false; }
      return true;
    });
    const by = {
      urgent: (a, b) => a.days_left - b.days_left || b.price - a.price,
      new: (a, b) => (b.published || '').localeCompare(a.published || '') || a.days_left - b.days_left,
      'price-desc': (a, b) => (b.price || 0) - (a.price || 0),
      'price-asc': (a, b) => (a.price || 0) - (b.price || 0),
    }[state.s] || ((a, b) => a.days_left - b.days_left);
    return { list: out.sort(by), regs };
  }

  function renderResults(fresh) {
    const { list, regs } = filtered();
    lastFound = list;
    const box = $('#results');
    const any = Object.entries(state).some(([k, v]) => v && v !== FILTERS[k]);
    $('#reset').hidden = !any;
    $('#clear-q').hidden = !state.q;
    $$('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.q === state.q)));

    const count = $('#results-count');
    const sum = list.reduce((s, t) => s + (t.currency === 'BYN' ? t.price || 0 : 0), 0);
    count.replaceChildren(`${list.length === data.length ? 'Все открытые закупки' : 'Найдено'}: ${fmtInt.format(list.length)} `, el('small', null, list.length ? `на ${fmtBig(sum)} BYN` : ''));
    for (const [key, label] of [['div', 'Раздел ОКРБ'], ['sub', 'Направление']]) {
      if (!state[key]) continue;
      const b = el('button', 'link-btn', `${label}: ${state[key]} ×`); b.type = 'button'; b.style.marginLeft = '12px'; b.style.fontSize = '15px';
      b.addEventListener('click', () => { state[key] = ''; update(); });
      count.append(b);
    }

    if (fresh) box.replaceChildren();
    const start = fresh ? 0 : box.children.length;
    box.classList.toggle('is-fresh', firstPaint || !fresh);
    firstPaint = false;
    if (!list.length) {
      const e = el('div', 'empty');
      e.append(el('b', null, 'Ничего не нашлось. '), 'Попробуйте другое слово или его начало («кров» вместо «кровельные»), уберите часть фильтров или выберите другую область.');
      box.append(e);
    }
    const frag = document.createDocumentFragment();
    list.slice(start, shown).forEach((t, i) => { const c = card(t, regs); if (i < 12) c.style.setProperty('--i', i); frag.append(c); });
    box.append(frag);
    const left = list.length - Math.min(shown, list.length);
    const more = $('#more');
    more.hidden = left <= 0;
    more.textContent = `Показать ещё ${Math.min(30, left)} из ${fmtInt.format(left)}`;
  }

  function card(t, regs) {
    const a = el('article', 'tender');
    const stub = el('div', 'stub' + (t.days_left <= 2 ? ' is-hot' : t.days_left <= 7 ? ' is-week' : '') + (t.days_left === 0 ? ' is-today' : ''));
    if (t.days_left === 0) stub.append(el('b', null, 'сегодня'));
    else stub.append(el('b', null, String(t.days_left)), el('span', null, plural(t.days_left, ['день', 'дня', 'дней'])));
    stub.append(el('small', null, 'до ' + shortDate(t.deadline)));
    stub.title = `Приём заявок до ${longDate(t.deadline)}`;

    const body = el('div', 't-body');
    const link = el('a', 't-title');
    const u = safeUrl(t.url);
    if (u || /^https:\/\/zakupki\.butb\.by\//.test(t.url)) { link.href = u || t.url; link.target = '_blank'; link.rel = 'noopener'; }
    if (t.source === 'butb' && !u) link.title = 'Откроется реестр закупок ЭТП БУТБ — найдите закупку по регистрационному номеру';
    link.append(highlight(t.title, regs));
    const who = el('p', 't-who'); who.append(highlight(t.customer, regs));
    const tags = el('div', 't-tags');
    const tag = (text, cls, onClick, title) => { const b = el('button', 'tag ' + (cls || ''), text); b.type = 'button'; b.title = title; b.addEventListener('click', onClick); tags.append(b); };
    if (t.oblast && t.oblast !== 'Не указан') tag(t.oblast, '', () => { state.o = t.oblast; update(); }, 'Показать закупки этой области');
    const guessed = t.subcategory === 'отрасль определена по названию';
    if (t.category && t.category !== 'Отрасль не указана') tag((guessed ? '≈ ' : '') + t.category, '', () => { state.c = t.category; update(); }, guessed ? 'Отрасль определена автоматически по названию закупки — возможны ошибки' : 'Показать закупки этой отрасли');
    if (t.kind && t.kind !== 'Не указано') tag(t.kind, 'kind-' + t.kind, () => { state.k = t.kind; update(); }, 'Показать только этот тип');
    const meta = el('div', 't-meta');
    const butb = t.source === 'butb';
    meta.append(el('span', 'src src-' + (butb ? 'butb' : 'icetrade'), butb ? 'zakupki.butb.by' : 'icetrade.by'));
    if (t.procedure) meta.append(el('span', null, t.procedure));
    if (butb && t.reg_number) meta.append(el('span', null, 'Рег. № ' + t.reg_number));
    if (t.gias_number) meta.append(el('span', null, 'ГИАС № ' + String(t.gias_number).replace(/\.0$/, '')));
    if (butb && /госзакуп|бюджет/i.test(t.financing)) tag('госзакупка', 'fin-gov', () => { state.src = 'butb'; update(); }, 'Закупка за счёт бюджета');
    body.append(link, who, meta, tags);

    const price = el('div', 't-price');
    if (t.price != null) price.append(el('b', null, fmtInt.format(Math.round(t.price))), el('span', null, t.currency));
    a.append(stub, body, price);
    return a;
  }

  /* ---------- обзор рынка ---------- */
  function bars(box, items, opts = {}) {
    box.replaceChildren();
    const max = Math.max(...items.map((i) => i.value), 1);
    for (const it of items) {
      const b = el(it.onClick ? 'button' : 'div', 'bar');
      if (it.onClick) { b.type = 'button'; b.addEventListener('click', it.onClick); b.title = 'Показать эти закупки'; }
      const n = el('span', 'bar-name', it.label); n.title = it.label;
      const v = el('span', 'bar-val', it.valueText); if (it.sub) v.append(el('span', null, it.sub));
      const tr = el('span', 'bar-track'); const f = el('span', 'bar-fill');
      f.style.width = Math.max(1, (it.value / max) * 100) + '%'; f.style.setProperty('--fill', it.color || opts.color || 'var(--c-goods)');
      tr.append(f); b.append(n, v, tr); box.append(b);
    }
  }
  function goSearch(patch) { Object.assign(state, FILTERS, patch); shown = 30; location.hash = 'poisk'; update(); }

  function stat(dl, label, value, note, hot) {
    const d = el('div', 'stat');
    const dt = el('dt', null, label), dd = el('dd', hot ? 'is-hot' : null, value);
    d.append(dt, dd); if (note) d.append(el('p', null, note));
    dl.append(d);
  }

  let marketDone = false;
  function renderMarket() {
    if (!summary || marketDone) return;
    marketDone = true;
    const m = summary.market;
    const km = Object.fromEntries(m.kind_mix.map((k) => [k.kind, k]));
    const top = m.divisions.slice(0, 3).map((d) => d.name.toLowerCase()).join(', ');
    const worst = m.outcomes[0];
    $('#market-lead').replaceChildren(
      `На ${longDate(summary.report_date)} было открыто `, el('b', null, fmtInt.format(m.open)), ` закупок на `, el('b', null, fmtBig(m.open_sum) + ' BYN'),
      ` от ${fmtInt.format(m.customers)} заказчиков. Товары — ${pct(km['Товары']?.n_share)} закупок и ${pct(km['Товары']?.sum_share)} стоимости, работы — ${pct(km['Работы']?.n_share)} и ${pct(km['Работы']?.sum_share)}, услуги — ${pct(km['Услуги']?.n_share)} и ${pct(km['Услуги']?.sum_share)}. Больше всего закупают: ${top}.`
      + (worst ? ` Не состоялась ${pct(m.fail_rate)} закупок с известным исходом; слабее всего конкуренция в отрасли «${worst.name}».` : ''));

    const dl = el('dl', 'stats');
    stat(dl, 'Открытых закупок', fmtInt.format(m.open), 'принимали заявки ' + shortDate(summary.report_date));
    stat(dl, 'Их стоимость, BYN', fmtBig(m.open_sum), 'сумма начальных цен');
    stat(dl, 'Закрывались за 3 дня', fmtInt.format(m.due3), 'на дату данных', true);
    stat(dl, 'Активных заказчиков', fmtInt.format(m.customers), `10 крупнейших — ${pct(m.top10_share)} стоимости`);
    stat(dl, 'Средняя закупка, BYN', fmtBig(m.median), 'медиана: половина закупок дешевле');
    $('#market-stats').replaceWith(dl); dl.id = 'market-stats';

    // типы
    const mixBox = $('#mix-kind'); mixBox.className = 'mix';
    for (const [label, share, val] of [['По числу закупок', 'n_share', (k) => fmtInt.format(k.n)], ['По стоимости', 'sum_share', (k) => fmtBig(k.sum) + ' BYN']]) {
      const row = el('div', 'mix-row');
      const lab = el('div', 'mix-label'); lab.append(el('b', null, label));
      const bar = el('div', 'mix-bar'), keys = el('div', 'keys');
      for (const k of m.kind_mix) {
        const s = el('div', 'mix-seg'); s.style.width = (k[share] || 0) + '%'; s.style.background = KIND_COLOR[k.kind]; s.title = `${k.kind}: ${pct(k[share])}`; bar.append(s);
        const key = el('span'); const i = el('i'); i.style.background = KIND_COLOR[k.kind];
        key.append(i, k.kind, el('b', null, pct(k[share])), ' · ' + val(k)); keys.append(key);
      }
      row.append(lab, bar, keys); mixBox.append(row);
    }
    bars($('#bars-outcomes'), m.outcomes.map((o) => ({ label: o.name, value: o.rate, valueText: pct(o.rate), sub: `${o.failed} из ${o.decided}`, onClick: () => goSearch({ c: o.name }) })), { color: 'var(--red)' });
    bars($('#bars-divisions'), m.divisions.slice(0, 12).map((d) => ({ label: d.name, value: d.n, valueText: fmtInt.format(d.n), sub: fmtBig(d.sum) + ' BYN', color: KIND_COLOR[d.kind], onClick: () => goSearch({ div: d.name }) })));
    bars($('#bars-subcats'), m.subcats.map((d) => ({ label: d.name, value: d.n, valueText: fmtInt.format(d.n), sub: fmtBig(d.sum) + ' BYN', onClick: () => goSearch({ sub: d.name }) })), { color: 'var(--c-services)' });

    $('#tbl-active tbody').replaceChildren(...m.active.map((a) => {
      const tr = el('tr'); tr.append(el('td', null, a.name), el('td', 'r', fmtInt.format(a.total)), el('td', 'r', fmtInt.format(a.open))); return tr;
    }));
    $('#tbl-biggest tbody').replaceChildren(...m.biggest.map((b) => {
      const tr = el('tr'); const td = el('td');
      const u = safeUrl(b.url) || `https://icetrade.by/tenders/all/view/${encodeURIComponent(b.id)}`;
      const a = el('a', null, b.title); a.href = u; a.target = '_blank'; a.rel = 'noopener';
      td.append(a, el('small', null, b.customer));
      tr.append(td, el('td', 'r', fmtBig(b.price)), el('td', 'r', shortDate(b.deadline))); return tr;
    }));
  }

  /* ---------- динамика ---------- */
  function renderTrends() {
    if (!summary) return;
    $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.grain === grain)));
    const rows = summary.trend[grain] || [];
    const have = rows.filter((r) => r.full_days > 0);
    const last = have[have.length - 1], prev = have[have.length - 2];
    const lead = $('#trend-lead');
    if (last && prev) {
      const ch = prev.per_day ? ((last.per_day - prev.per_day) / prev.per_day) * 100 : null;
      const cap = (x) => x[0].toUpperCase() + x.slice(1);
      lead.textContent = `${cap(periodIn(last.period))} в среднем ${fmtInt.format(Math.round(last.per_day))} новых закупок в рабочий день — ${ch >= 0 ? 'на ' + fmt1.format(ch) + '% больше' : 'на ' + fmt1.format(-ch) + '% меньше'}, чем ${periodIn(prev.period)}. Полностью собранных дней пока ${summary.full_days}, поэтому цифры предварительные: точность растёт с каждой неделей сбора.`;
    } else lead.textContent = 'Динамика появится, когда накопятся данные за два периода.';

    const cols = $('#rate'); cols.replaceChildren();
    const max = Math.max(...rows.map((r) => r.per_day || 0), 1);
    for (const r of rows) {
      const c = el('div', 'col' + (r.full_days < 10 ? ' is-thin' : ''));
      c.append(el('span', 'col-val', r.per_day ? fmtInt.format(Math.round(r.per_day)) : '—'));
      const b = el('div', 'col-bar'); b.style.height = Math.max(2, ((r.per_day || 0) / max) * 170) + 'px'; c.append(b);
      const l = el('span', 'col-lab', periodLabel(r.period)); l.append(el('small', null, r.full_days ? `${r.full_days} ${plural(r.full_days, ['полный день', 'полных дня', 'полных дней'])}` : 'нет полных дней'));
      c.append(l); cols.append(c);
    }

    const mix = $('#mix-trend'); mix.className = 'mix'; mix.replaceChildren();
    for (const r of have) {
      const row = el('div', 'mix-row');
      const lab = el('div', 'mix-label'); lab.append(el('b', null, periodLabel(r.period)), el('span', null, `${fmtInt.format(r.n)} закупок`));
      const bar = el('div', 'mix-bar'), keys = el('div', 'keys');
      for (const k of ['Товары', 'Работы', 'Услуги']) {
        const s = el('div', 'mix-seg'); s.style.width = (r.mix[k] || 0) + '%'; s.style.background = KIND_COLOR[k]; bar.append(s);
        const key = el('span'); const i = el('i'); i.style.background = KIND_COLOR[k]; key.append(i, k, el('b', null, pct(r.mix[k]))); keys.append(key);
      }
      row.append(lab, bar, keys); mix.append(row);
    }

    const mv = summary.movers[grain];
    const body = $('#tbl-movers tbody');
    if (mv) {
      $('#th-prev').textContent = 'Было, ' + periodLabel(mv.prev);
      $('#th-last').textContent = 'Стало, ' + periodLabel(mv.last);
      const maxAbs = Math.max(...mv.rows.map((r) => Math.abs(r.change || 0)), 1);
      body.replaceChildren(...mv.rows.map((r) => {
        const tr = el('tr');
        const name = el('td'); const a = el('a', null, r.name); a.href = '#poisk'; a.addEventListener('click', (e) => { e.preventDefault(); goSearch({ c: r.name }); }); name.append(a);
        const ch = el('td', 'r ' + (r.change > 0 ? 'up' : r.change < 0 ? 'down' : ''), r.change == null ? '—' : (r.change > 0 ? '+' : '') + fmt1.format(r.change) + '%');
        const bc = el('td', 'hide-sm'); const d = el('div', 'diverge'); const s = el('span');
        const w = (Math.abs(r.change || 0) / maxAbs) * 50; s.style.width = w + '%'; s.style.left = (r.change >= 0 ? 50 : 50 - w) + '%'; s.style.background = r.change >= 0 ? 'var(--pos)' : 'var(--red)';
        d.append(s); bc.append(d);
        tr.append(name, el('td', 'r', fmt1.format(r.prev)), el('td', 'r', fmt1.format(r.last)), ch, bc); return tr;
      }));
    } else {
      const tr = el('tr'); const td = el('td', null, 'Для сравнения нужны два периода с полностью собранными днями.'); td.colSpan = 5; tr.append(td); body.replaceChildren(tr);
    }

    // полнота данных
    const days = summary.days, box = $('#coverage');
    if (!days.length) { box.replaceChildren(); return; }
    const W = 1000, H = 200, m = { t: 10, r: 4, b: 26, l: 40 };
    const max2 = Math.max(...days.map((d) => Math.max(d.issued, d.captured)), 1);
    const step = (W - m.l - m.r) / days.length, bw = Math.max(2, step * 0.78);
    const y = (v) => H - m.b - (v / max2) * (H - m.t - m.b);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Сколько закупок опубликовано и собрано по рабочим дням');
    const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
    for (const v of [0, Math.round(max2 / 2 / 100) * 100, Math.floor(max2 / 100) * 100]) {
      add('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--line)' });
      add('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--muted)' }, fmtInt.format(v));
    }
    days.forEach((d, i) => {
      const x = m.l + i * step + (step - bw) / 2;
      add('rect', { x, width: bw, y: y(d.issued), height: H - m.b - y(d.issued), rx: 2, fill: 'var(--bar-track)' });
      const c = Math.min(d.captured, d.issued || d.captured);
      const r = add('rect', { x, width: bw, y: y(c), height: H - m.b - y(c), rx: 2, fill: 'var(--c-goods)', opacity: d.full ? 1 : 0.35 });
      const t = document.createElementNS(NS, 'title'); t.textContent = `${shortDate(d.day)}: опубликовано ≈ ${fmtInt.format(d.issued)}, собрано ${fmtInt.format(d.captured)}`; r.append(t);
      if (new Date(d.day + 'T00:00:00Z').getUTCDay() === 1) add('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--muted)' }, shortDate(d.day));
    });
    box.replaceChildren(svg);
  }

  /* ---------- оглавление справочника: подсветка раздела, который сейчас на экране ---------- */
  let tocObserver = null;
  function watchToc() {
    if (!('IntersectionObserver' in window)) return;
    if (tocObserver) tocObserver.disconnect();
    tocObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const sec = e.target.closest('.view');
        $$('.toc a', sec).forEach((a) => a.classList.toggle('is-here', a.getAttribute('href') === '#' + e.target.id));
      }
    }, { rootMargin: '-90px 0px -65% 0px' });
    $$('.brief[id]').forEach((b) => tocObserver.observe(b));
  }

  /* ---------- вход ---------- */
  function showLoginError(msg) { const e = $('#login-error'); e.hidden = !msg; e.textContent = msg || ''; if (msg) { e.style.animation = 'none'; void e.offsetWidth; e.style.animation = ''; } }
  function setTab(reg) {
    $('#tab-login').setAttribute('aria-selected', String(!reg)); $('#tab-reg').setAttribute('aria-selected', String(reg));
    $('#pane-login').hidden = reg; $('#pane-reg').hidden = !reg;
    (reg ? $('#rg-company') : $('#lg-login')).focus({ preventScroll: true });
  }
  $('#tab-login').addEventListener('click', () => setTab(false));
  $('#tab-reg').addEventListener('click', () => setTab(true));
  $('#to-reg').addEventListener('click', () => setTab(true));
  $('#pass-eye').addEventListener('click', (e) => {
    const p = $('#lg-pass'), show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  });
  $('#pane-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const login = $('#lg-login').value, pass = $('#lg-pass').value;
    if (!login.trim() || !pass.trim()) { showLoginError('Введите логин и пароль.'); return; }
    const btn = $('#login-submit'); btn.disabled = true; btn.classList.add('is-busy'); btn.firstElementChild.textContent = 'Проверяем пароль…';
    showLoginError('');
    try {
      const id = await loginId(login);
      const entry = (await getAuth()).users[id];
      if (!entry) throw Object.assign(new Error(), { code: 'bad' });
      const kek = await deriveKek(pass, b64d(entry.s), entry.i);
      session = await unlock(id, kek);
      store.set({ id, kek: b64e(kek) }, $('#lg-remember').checked);
      $('#lg-pass').value = '';
      signedIn();
      const go = wanted || 'poisk';
      if (location.hash.slice(1) === go) route(); else location.hash = go;
      await loadLocked().then(receive);
    } catch (e) {
      session = null;
      showLoginError(e.code === 'bad' || e.code === 'nouser' || e.name === 'OperationError'
        ? 'Неверный логин или пароль. Проверьте раскладку клавиатуры и Caps Lock.'
        : 'Не удалось связаться с сайтом. Проверьте интернет и попробуйте ещё раз.');
    } finally {
      btn.disabled = false; btn.classList.remove('is-busy'); btn.firstElementChild.textContent = 'Войти';
    }
  });
  $('#btn-logout').addEventListener('click', () => { store.clear(); location.hash = 'vhod'; location.reload(); });

  /* ---------- заявка на доступ: письмо администратору ---------- */
  let regText = '';
  $('#pane-reg').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = (id) => $(id).value.trim();
    const need = ['#rg-company', '#rg-name', '#rg-email', '#rg-role', '#rg-goods'];
    need.forEach((id) => $(id).classList.toggle('is-bad', !v(id)));
    const err = $('#reg-error');
    const fail = (msg) => { err.hidden = false; err.textContent = msg; };
    if (need.some((id) => !v(id))) return fail('Заполните поля, отмеченные звёздочкой.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('#rg-email'))) { $('#rg-email').classList.add('is-bad'); return fail('Проверьте e-mail: он станет вашим логином.'); }
    if (v('#rg-unp') && !/^\d{9}$/.test(v('#rg-unp'))) { $('#rg-unp').classList.add('is-bad'); return fail('УНП — 9 цифр.'); }
    if (!$('#rg-consent').checked) return fail('Отметьте согласие на обработку данных — без него заявку не рассмотреть.');
    if (!CFG.email) return fail('Приём заявок пока не настроен: администратор не указал e-mail. Попробуйте позже.');
    err.hidden = true;
    const now = new Date();
    regText = [
      `Заявка на доступ к сайту «${CFG.name}»`, '',
      `Компания: ${v('#rg-company')}`, `УНП: ${v('#rg-unp') || '—'}`, `Контактное лицо: ${v('#rg-name')}`,
      `E-mail (логин): ${v('#rg-email')}`, `Телефон: ${v('#rg-phone') || '—'}`, `На рынке закупок: ${v('#rg-role')}`,
      `Что продаёт или покупает: ${v('#rg-goods')}`, `Опыт внешней торговли: ${v('#rg-trade')}`,
      `Сертификаты и разрешения: ${v('#rg-cert') || '—'}`, 'Согласие на обработку данных: да',
      `Дата заявки: ${now.toLocaleDateString('ru-RU')}`,
    ].join('\n');
    const subject = `Заявка на доступ — ${v('#rg-company')}`;
    const link = $('#reg-mail-link'); link.href = `mailto:${CFG.email}`; link.textContent = CFG.email;
    $('#reg-done').hidden = false;
    location.href = `mailto:${CFG.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(regText)}`;
  });
  $('#reg-copy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(regText); e.currentTarget.textContent = 'Текст скопирован'; } catch (err) { e.currentTarget.textContent = 'Выделите и скопируйте текст вручную'; }
  });

  boot();
})();
