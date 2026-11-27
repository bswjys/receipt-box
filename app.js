(() => {
  'use strict';

  const VERSION = '1';
  const DB_NAME = 'receipt-box';
  const DB_VERSION = 1;
  const STORE = 'receipts';
  const LS_KEY = 'receiptbox.v1';
  const MAX_PHOTOS = 2;
  const MAX_SIDE = 1800;
  const QUALITY = 0.84;
  const SOON_DAYS = 3;

  const PURPOSE = {
    refund: { label: '교환·환불', cls: 'refund' },
    expense: { label: '경비·정산', cls: 'expense' },
    as: { label: 'AS·보증', cls: 'as' },
    keep: { label: '보관용', cls: 'keep' },
  };
  // 용도별 마감일 빠른 선택 — 구매일에서 세어 채운다
  const DUE_RULES = {
    refund: [{ days: 7, label: '7일' }, { days: 14, label: '14일' }, { days: 30, label: '30일' }],
    as: [{ months: 12, label: '1년' }, { months: 24, label: '2년' }],
  };
  const DUE_LABEL = { refund: '교환·환불 마감일', as: '보증 만료일' };

  const state = { items: [], tab: 'active', purpose: 'all', q: '', mode: 'idb' };
  let db = null;
  let form = null;
  let currentId = null;
  let confirmResolver = null;
  let toastTimer = null;
  const els = {};

  /* ── 날짜 ───────────────────────── */
  const pad2 = (n) => String(n).padStart(2, '0');

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function isoUTC(iso) {
    if (!iso) return NaN;
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d);
  }

  function dayDiff(due) {
    if (!due) return null;
    const t = isoUTC(due);
    if (Number.isNaN(t)) return null;
    return Math.round((t - isoUTC(todayISO())) / 86400000);
  }

  function addDays(iso, n) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return '';
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }

  function addMonths(iso, n) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return '';
    const idx = (m - 1) + n;
    const ny = y + Math.floor(idx / 12);
    const nm = ((idx % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return `${ny}-${pad2(nm + 1)}-${pad2(Math.min(d, last))}`;
  }

  function koreanDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return `${y}년 ${m}월 ${d}일`;
  }

  function shortDate(iso) {
    if (!iso) return '';
    const [, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return `${m}.${d}`;
  }

  function won(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return '0원';
    return `${comma(n)}원`;
  }

  function comma(n) {
    if (n == null || n === '') return '';
    return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function amountText(item) {
    return item.amount === null ? '금액 없음' : won(item.amount);
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function uid() {
    return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ── D-day 배지 ───────────────────────── */
  function badgeOf(item) {
    if (item.done) return { key: 'done', label: '처리완료' };
    const d = dayDiff(item.due);
    if (d === null) return { key: 'none', label: '' };
    if (d < 0) return { key: 'past', label: '기한 지남' };
    if (d === 0) return { key: 'urgent', label: 'D-DAY' };
    if (d <= SOON_DAYS) return { key: 'urgent', label: `D-${d}` };
    if (d <= 7) return { key: 'soon', label: `D-${d}` };
    return { key: 'normal', label: `D-${d}` };
  }

  /* ── 이번 달 합계 ───────────────────────── */
  function monthKey() {
    return todayISO().slice(0, 7);
  }

  function monthSummary() {
    const mk = monthKey();
    const list = state.items.filter((i) => String(i.date || '').startsWith(mk));
    const sum = list.reduce((s, i) => s + (i.amount || 0), 0);
    return { sum, count: list.length };
  }

  function pendingCount() {
    return state.items.filter((i) => !i.done && i.purpose !== 'keep').length;
  }

  /* ── 정렬 ───────────────────────── */
  // 보관 중: 마감 임박 → 마감 먼 것 → 마감 없음 → 기한 지남
  function sortActive(list) {
    return list.slice().sort((a, b) => {
      const da = dayDiff(a.due);
      const db2 = dayDiff(b.due);
      const ga = da === null ? 1 : da < 0 ? 2 : 0;
      const gb = db2 === null ? 1 : db2 < 0 ? 2 : 0;
      if (ga !== gb) return ga - gb;
      if (ga === 0 && da !== db2) return da - db2;
      if (ga === 2 && da !== db2) return db2 - da;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  // 처리완료: 최근에 처리한 것부터
  function sortDone(list) {
    return list.slice().sort((a, b) => {
      const ua = a.doneAt || '';
      const ub = b.doneAt || '';
      if (ua !== ub) return ub.localeCompare(ua);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function haystack(item) {
    return [
      item.store,
      item.memo,
      PURPOSE[item.purpose] ? PURPOSE[item.purpose].label : '',
      item.amount === null ? '' : String(item.amount),
      item.amount === null ? '' : comma(item.amount),
      item.date || '',
      item.due || '',
    ].join(' ').toLowerCase();
  }

  function visibleItems() {
    const q = state.q.trim().toLowerCase();
    let list = state.items.filter((i) => (state.tab === 'done' ? i.done : !i.done));
    if (state.purpose !== 'all') list = list.filter((i) => i.purpose === state.purpose);
    if (q) list = list.filter((i) => haystack(i).includes(q));
    return state.tab === 'done' ? sortDone(list) : sortActive(list);
  }

  /* ── 저장 (IndexedDB · localStorage 대체) ───────────────────────── */
  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexeddb'));
      req.onblocked = () => reject(new Error('indexeddb blocked'));
    });
  }

  function ask(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function store(mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  const idbAll = () => ask(store('readonly').getAll());
  const idbPut = (item) => ask(store('readwrite').put(item));
  const idbDelete = (id) => ask(store('readwrite').delete(id));
  const idbClear = () => ask(store('readwrite').clear());

  function lsAll() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && Array.isArray(data.items) ? data.items : [];
    } catch (err) {
      return [];
    }
  }

  function lsWrite(items) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ app: 'receipt-box', version: VERSION, items }));
      return true;
    } catch (err) {
      return false;
    }
  }

  async function persistItem(item) {
    if (state.mode === 'idb') {
      try {
        await idbPut(item);
        return true;
      } catch (err) {
        return false;
      }
    }
    return lsWrite(state.items);
  }

  async function forgetItem(id) {
    if (state.mode === 'idb') {
      try {
        await idbDelete(id);
        return true;
      } catch (err) {
        return false;
      }
    }
    return lsWrite(state.items);
  }

  async function persistAll(items) {
    if (state.mode === 'idb') {
      try {
        await idbClear();
        for (const it of items) await idbPut(it);
        return true;
      } catch (err) {
        return false;
      }
    }
    return lsWrite(items);
  }

  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

  function normalize(raw) {
    const it = Object.assign({}, raw || {});
    it.id = it.id || uid();
    it.store = String(it.store || '').trim();
    it.purpose = PURPOSE[it.purpose] ? it.purpose : 'keep';
    it.date = isDate(it.date) ? it.date : todayISO();
    it.due = isDate(it.due) ? it.due : null;
    if (it.purpose === 'keep' || it.purpose === 'expense') it.due = null;
    it.memo = String(it.memo || '');
    const amount = Number(it.amount);
    it.amount = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
    it.photos = Array.isArray(it.photos)
      ? it.photos.filter((s) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, MAX_PHOTOS)
      : [];
    it.done = !!it.done;
    it.doneAt = it.done ? (isDate(it.doneAt) ? it.doneAt : todayISO()) : null;
    it.createdAt = Number(it.createdAt) || Date.now();
    it.updatedAt = Number(it.updatedAt) || it.createdAt;
    return it;
  }

  /* ── 렌더 ───────────────────────── */
  function cacheEls() {
    [
      'summaryBar', 'sumMonth', 'sumMonthCount', 'pendingCount',
      'tabTabs', 'countActive', 'countDone', 'searchInput', 'searchClear', 'purposeChips',
      'soonNote', 'receiptGrid', 'emptyState', 'emptyTitle', 'emptyDesc', 'listCount',
      'addWrap', 'addClose', 'addSave', 'addTitle', 'addBody', 'photoGrid', 'photoInput',
      'fStore', 'fAmount', 'fDate', 'dateHint', 'purposeSeg', 'dueBox', 'dueLabel', 'dueChips', 'fDue', 'dueHint', 'fMemo',
      'detailWrap', 'detailClose', 'detailBody', 'detailTitle', 'detailDone', 'detailEdit', 'detailDelete',
      'zoomWrap', 'zoomImg', 'zoomClose',
      'moreWrap', 'moreBtn', 'moreClose', 'moreInfo', 'backupBtn', 'restoreBtn', 'restoreInput',
      'confirmWrap', 'confirmTitle', 'confirmDesc', 'confirmOk', 'confirmCancel',
      'toast',
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function cardHTML(item) {
    const b = badgeOf(item);
    const photo = item.photos[0];
    const p = PURPOSE[item.purpose] || PURPOSE.keep;
    return `
      <button type="button" class="receipt${item.done ? ' is-done' : ''}${b.key === 'past' ? ' is-past' : ''}" data-id="${esc(item.id)}" aria-label="${esc(item.store)} 영수증 상세 보기">
        <span class="thumb">
          ${photo
            ? `<img src="${photo}" alt="${esc(item.store)} 영수증 사진" loading="lazy">`
            : `<span class="thumb-empty"><span aria-hidden="true">🧾</span></span>`}
          ${b.label ? `<span class="dday ${b.key}">${b.label}</span>` : ''}
          ${item.done ? '<span class="done-stamp"><span>처리완료</span></span>' : ''}
        </span>
        <span class="receipt-meta">
          <span class="receipt-store">${esc(item.store)}</span>
          <span class="receipt-amount">${amountText(item)}</span>
          <span class="receipt-foot">
            <span class="pill ${p.cls}">${p.label}</span>
            <span class="receipt-date">${shortDate(item.date)}</span>
          </span>
        </span>
      </button>`;
  }

  const addCardHTML = `
      <button type="button" class="add-card" id="addCard">
        <span class="plus" aria-hidden="true">＋</span>
        <strong>영수증 사진등록</strong>
        <small>찍거나 골라서 담기</small>
      </button>`;

  function renderSummary() {
    const m = monthSummary();
    els.sumMonth.textContent = won(m.sum);
    els.sumMonthCount.textContent = `${m.count}건`;
    els.pendingCount.textContent = String(pendingCount());
  }

  function renderTabs() {
    const active = state.items.filter((i) => !i.done).length;
    const done = state.items.filter((i) => i.done).length;
    els.countActive.textContent = String(active);
    els.countDone.textContent = String(done);
    els.tabTabs.querySelectorAll('button[data-tab]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === state.tab));
    });
  }

  function renderChips() {
    els.purposeChips.querySelectorAll('button[data-purpose]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.purpose === state.purpose));
    });
  }

  function renderList() {
    const list = visibleItems();
    els.receiptGrid.innerHTML = [state.tab === 'active' ? addCardHTML : '']
      .concat(list.map(cardHTML))
      .join('');

    const soon = state.items.filter((i) => {
      if (i.done) return false;
      const d = dayDiff(i.due);
      return d !== null && d >= 0 && d <= SOON_DAYS;
    }).length;
    els.soonNote.hidden = !(state.tab === 'active' && state.purpose === 'all' && !state.q.trim() && soon > 0);
    els.soonNote.innerHTML = `⏰ ${SOON_DAYS}일 안에 마감되는 영수증이 <b>${soon}건</b> 있어요`;

    els.listCount.textContent = state.tab === 'done'
      ? `처리완료 ${list.length}개`
      : `영수증 ${list.length}개`;

    const showEmpty = list.length === 0;
    els.emptyState.hidden = !showEmpty;
    if (showEmpty) {
      if (state.q.trim()) {
        els.emptyTitle.textContent = '찾는 영수증이 없어요';
        els.emptyDesc.innerHTML = '다른 가게 이름이나 금액으로 검색해 보세요.';
      } else if (state.purpose !== 'all') {
        const p = PURPOSE[state.purpose];
        els.emptyTitle.textContent = `${p ? p.label : '이'} 영수증이 없어요`;
        els.emptyDesc.innerHTML = '전체로 바꾸면 담아 둔 영수증을 모두 볼 수 있어요.';
      } else if (state.tab === 'done') {
        els.emptyTitle.textContent = '처리완료한 영수증이 없어요';
        els.emptyDesc.innerHTML = '정산이나 환불이 끝난 영수증은<br>처리완료로 넘겨서 따로 모아 둘 수 있어요.';
      } else {
        els.emptyTitle.textContent = '아직 담아 둔 영수증이 없어요';
        els.emptyDesc.innerHTML = '종이 영수증을 찍어 담으면<br>교환·환불 기한이 가까운 순서로 먼저 보여 드려요.';
      }
    }
  }

  function render() {
    renderSummary();
    renderTabs();
    renderChips();
    renderList();
  }

  /* ── 토스트 ───────────────────────── */
  function hideToast() {
    clearTimeout(toastTimer);
    els.toast.classList.remove('show');
    els.toast.hidden = true;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('show');
      setTimeout(() => { els.toast.hidden = true; }, 220);
    }, 2400);
  }

  /* ── 오버레이 ───────────────────────── */
  /* ── 오버레이 ───────────────────────── */
  /* 모달·추가창 화면 고정 (2026-11-28)
     열 때 스크롤 위치를 저장하고 body를 fixed로 잠가 배경이 흔들리지 않게 한다.
     여러 창이 겹쳐 열려도 마지막 창이 닫힐 때만 원래 위치로 돌아간다. */
  let lockedScrollY = null;
  const MODAL_KEYS = ['addWrap', 'detailWrap', 'moreWrap', 'confirmWrap', 'zoomWrap'];

  function lockBody() {
    const anyOpen = MODAL_KEYS.some((k) => els[k] && !els[k].hidden);
    const isLocked = document.body.classList.contains('modal-open');

    if (anyOpen && !isLocked) {
      lockedScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
      document.body.style.top = `-${lockedScrollY}px`;
      document.body.classList.add('modal-open', 'locked');
    } else if (!anyOpen && isLocked) {
      document.body.classList.remove('modal-open', 'locked');
      document.body.style.top = '';
      const backY = lockedScrollY || 0;
      lockedScrollY = null;
      window.scrollTo(0, backY);
    }
  }

  function askConfirm({ title, desc, ok = '확인', tone = 'primary' }) {
    els.confirmTitle.textContent = title;
    els.confirmDesc.innerHTML = desc || '';
    els.confirmOk.textContent = ok;
    els.confirmOk.className = `btn ${tone === 'danger' ? 'danger' : 'primary'}`;
    els.confirmWrap.hidden = false;
    lockBody();
    return new Promise((resolve) => { confirmResolver = resolve; });
  }

  function resolveConfirm(value) {
    els.confirmWrap.hidden = true;
    lockBody();
    const fn = confirmResolver;
    confirmResolver = null;
    if (fn) fn(value);
  }

  /* ── 사진 ───────────────────────── */
  function compressImage(file, maxSide = MAX_SIDE, quality = QUALITY) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h) throw new Error('empty image');
          const scale = Math.min(1, maxSide / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          const cv = document.createElement('canvas');
          cv.width = cw;
          cv.height = ch;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 읽지 못했어요'));
      };
      img.src = url;
    });
  }

  function renderPhotoGrid() {
    if (!form) return;
    const cells = form.photos.map((src, idx) => `
      <div class="photo-cell">
        <button type="button" class="photo" data-photo="${idx}" aria-label="영수증 사진 ${idx + 1} 크게 보기">
          <img src="${src}" alt="영수증 사진 ${idx + 1}">
        </button>
        <button type="button" class="photo-del" data-remove="${idx}" aria-label="영수증 사진 ${idx + 1} 빼기">×</button>
      </div>`).join('');
    const add = form.photos.length < MAX_PHOTOS
      ? '<button type="button" class="photo-add" id="photoAdd"><span aria-hidden="true">＋</span><small>사진 추가</small></button>'
      : '';
    els.photoGrid.innerHTML = cells + add;
  }

  async function handlePhotoFiles(files) {
    if (!form) return;
    const list = Array.from(files || []);
    if (!list.length) return;
    const room = MAX_PHOTOS - form.photos.length;
    if (room <= 0) {
      toast(`사진은 ${MAX_PHOTOS}장까지 넣을 수 있어요`);
      els.photoInput.value = '';
      return;
    }
    const use = list.slice(0, room);
    if (list.length > room) toast(`사진은 ${MAX_PHOTOS}장까지라 ${room}장만 넣었어요`);
    let failed = 0;
    for (const file of use) {
      if (!String(file.type || '').startsWith('image/')) { failed += 1; continue; }
      try {
        const data = await compressImage(file);
        if (form.photos.length < MAX_PHOTOS) form.photos.push(data);
      } catch (err) {
        failed += 1;
      }
    }
    if (failed) toast('사진을 읽지 못했어요. 다른 사진으로 해 주세요.');
    renderPhotoGrid();
    els.photoInput.value = '';
  }

  function openZoom(src) {
    if (!src) return;
    els.zoomImg.src = src;
    els.zoomWrap.hidden = false;
    lockBody();
  }

  function closeZoom() {
    els.zoomWrap.hidden = true;
    els.zoomImg.removeAttribute('src');
    lockBody();
  }

  /* ── 등록·수정 ───────────────────────── */
  function blankForm() {
    return {
      id: null,
      photos: [],
      store: '',
      amount: null,
      date: todayISO(),
      purpose: 'refund',
      due: '',
      dueRule: null,
      memo: '',
      done: false,
      doneAt: null,
      createdAt: null,
    };
  }

  function dueTarget(rule) {
    const base = form.date || els.fDate.value || todayISO();
    return rule.days ? addDays(base, rule.days) : addMonths(base, rule.months);
  }

  function ruleKey(r) {
    return r.days ? `d${r.days}` : `m${r.months}`;
  }

  function renderDueChips() {
    const rules = DUE_RULES[form.purpose] || [];
    els.dueBox.hidden = !rules.length;
    if (!rules.length) {
      els.dueChips.innerHTML = '';
      return;
    }
    els.dueLabel.textContent = DUE_LABEL[form.purpose] || '마감일';
    els.dueChips.innerHTML = rules.map((r) => {
      const key = ruleKey(r);
      const on = form.dueRule === key;
      return `<button type="button" data-due="${key}" aria-pressed="${on ? 'true' : 'false'}">${r.label}</button>`;
    }).join('');
    renderDueHint();
  }

  function renderDueHint() {
    if (!form) return;
    const rules = DUE_RULES[form.purpose] || [];
    if (!rules.length) return;
    const d = dayDiff(form.due);
    if (form.due && d !== null) {
      els.dueHint.textContent = d < 0
        ? `${koreanDate(form.due)} · 기한이 ${-d}일 지났어요`
        : d === 0
          ? `${koreanDate(form.due)} · 오늘까지예요`
          : `${koreanDate(form.due)}까지 · ${d}일 남았어요`;
      return;
    }
    els.dueHint.textContent = form.purpose === 'as'
      ? '보증이 끝나는 날을 적어 두면 만료 D-day를 세어 드려요.'
      : '구매일에서 7일을 세어 마감일을 채워 드려요. 직접 골라도 돼요.';
  }

  function paintDate() {
    const iso = form.date || todayISO();
    els.dateHint.textContent = iso === todayISO()
      ? `${koreanDate(iso)} · 오늘`
      : koreanDate(iso);
  }

  function paintDue() {
    els.fDue.value = form.due || '';
    renderDueChips();
  }

  function paintPurpose() {
    els.purposeSeg.querySelectorAll('button[data-purpose]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.purpose === form.purpose));
    });
    paintDue();
  }

  // 구매일에서 세어 마감일이 딱 맞으면 빠른 선택 칩을 켜 둔다
  function inferDueRule() {
    const rules = DUE_RULES[form.purpose] || [];
    form.dueRule = null;
    if (!form.due) return;
    const hit = rules.find((r) => dueTarget(r) === form.due);
    if (hit) form.dueRule = ruleKey(hit);
  }

  function paintForm() {
    if (!form) return;
    els.fStore.value = form.store;
    els.fAmount.value = comma(form.amount);
    els.fDate.value = form.date || todayISO();
    els.fMemo.value = form.memo;
    paintDate();
    paintPurpose();
    renderPhotoGrid();
  }

  function openForm(id = null) {
    const item = id ? state.items.find((i) => i.id === id) : null;
    if (item) {
      form = {
        id: item.id,
        photos: item.photos.slice(),
        store: item.store,
        amount: item.amount,
        date: item.date,
        purpose: item.purpose,
        due: item.due || '',
        dueRule: null,
        memo: item.memo,
        done: item.done,
        doneAt: item.doneAt,
        createdAt: item.createdAt,
      };
    } else {
      form = blankForm();
    }
    els.addTitle.textContent = item ? '영수증 수정' : '영수증 등록';
    inferDueRule();
    paintForm();
    els.addBody.scrollTop = 0;
    els.addWrap.hidden = false;
    lockBody();
  }

  function closeForm() {
    els.addWrap.hidden = true;
    form = null;
    els.photoInput.value = '';
    lockBody();
  }

  function numValue(el) {
    if (!el) return null;
    const digits = String(el.value || '').replace(/[^\d]/g, '');
    if (!digits) return null;
    return Math.min(999999999, parseInt(digits, 10));
  }

  async function saveForm() {
    if (!form) return;
    const storeName = els.fStore.value.trim();
    if (!storeName) {
      toast('가게나 항목명을 적어 주세요');
      els.fStore.focus();
      return;
    }
    const date = els.fDate.value || todayISO();
    const rules = DUE_RULES[form.purpose] || [];
    const due = rules.length ? (els.fDue.value || null) : null;
    const wasEdit = !!form.id;
    const base = wasEdit ? state.items.find((i) => i.id === form.id) : null;
    const now = Date.now();
    const item = normalize({
      id: form.id || uid(),
      store: storeName,
      amount: numValue(els.fAmount),
      date,
      purpose: form.purpose,
      due,
      memo: els.fMemo.value.trim(),
      photos: form.photos,
      done: base ? base.done : false,
      doneAt: base ? base.doneAt : null,
      createdAt: base ? base.createdAt : now,
      updatedAt: now,
    });

    const prev = state.items.slice();
    if (base) state.items = state.items.map((i) => (i.id === item.id ? item : i));
    else state.items = state.items.concat([item]);

    const ok = await persistItem(item);
    if (!ok) {
      state.items = prev;
      render();
      toast('저장하지 못했어요. 저장 공간을 확인해 주세요.');
      return;
    }
    closeForm();
    if (!wasEdit) {
      // 담은 영수증이 바로 보이도록 목록 상태를 되돌린다
      state.tab = 'active';
      state.purpose = 'all';
      state.q = '';
      els.searchInput.value = '';
      els.searchClear.hidden = true;
    }
    render();
    toast(wasEdit ? '수정했어요' : '영수증을 담았어요');
  }

  /* ── 상세 ───────────────────────── */
  function openDetail(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    currentId = id;
    renderDetail();
    els.detailBody.scrollTop = 0;
    els.detailWrap.hidden = false;
    lockBody();
  }

  function closeDetail() {
    els.detailWrap.hidden = true;
    currentId = null;
    lockBody();
  }

  function renderDetail() {
    const item = state.items.find((i) => i.id === currentId);
    if (!item) { closeDetail(); return; }
    const b = badgeOf(item);
    const d = dayDiff(item.due);
    const p = PURPOSE[item.purpose] || PURPOSE.keep;
    els.detailTitle.textContent = '영수증';

    let line = '';
    let lineCls = '';
    if (item.done) {
      line = `${koreanDate(item.doneAt)}에 처리완료했어요`;
    } else if (item.due) {
      if (d === null) {
        line = '마감일이 없어요';
      } else if (d < 0) {
        line = `${koreanDate(item.due)} 마감 · ${-d}일 지났어요`;
      } else if (d === 0) {
        line = '오늘까지예요';
        lineCls = 'urgent';
      } else {
        line = `${koreanDate(item.due)}까지 · ${d}일 남았어요`;
        lineCls = d <= SOON_DAYS ? 'urgent' : d <= 7 ? 'soon' : '';
      }
    } else {
      line = item.purpose === 'keep'
        ? '보관용으로 담아 둔 영수증이에요'
        : p.label + ' 영수증이에요';
    }

    let html = '';
    html += `<div class="detail-top"><span class="pill ${p.cls}">${p.label}</span>${b.label && b.key !== 'done' ? `<span class="dday inline ${b.key}">${b.label}</span>` : ''}</div>`;
    html += `<h3 class="detail-name">${esc(item.store)}</h3>`;
    html += `<p class="detail-amount">${amountText(item)}</p>`;
    html += `<p class="detail-line ${lineCls}">${esc(line)}</p>`;

    if (item.photos.length) {
      html += '<div class="shot-wrap">';
      item.photos.forEach((src, i) => {
        html += `<button type="button" class="shot" data-zoom="${i}" aria-label="영수증 사진 ${i + 1} 크게 보기"><img src="${src}" alt="영수증 사진 ${i + 1}"></button>`;
      });
      html += '</div>';
      html += '<p class="shot-hint">사진을 누르면 흰 바탕으로 크게 볼 수 있어요</p>';
    } else {
      html += '<div class="no-shot">등록된 사진이 없어요. 수정에서 사진을 더할 수 있어요.</div>';
    }

    html += '<dl class="info">';
    html += `<div><dt>구매일</dt><dd>${koreanDate(item.date)}</dd></div>`;
    html += `<div><dt>용도</dt><dd>${p.label}</dd></div>`;
    html += `<div><dt>마감일</dt><dd>${item.due ? koreanDate(item.due) : '없음'}</dd></div>`;
    if (item.memo) html += `<div><dt>메모</dt><dd>${esc(item.memo)}</dd></div>`;
    html += '</dl>';

    els.detailBody.innerHTML = html;
    els.detailDone.textContent = item.done ? '되돌리기' : '처리완료';
  }

  async function toggleDone() {
    const item = state.items.find((i) => i.id === currentId);
    if (!item) return;
    const next = normalize({
      ...item,
      done: !item.done,
      doneAt: item.done ? null : todayISO(),
      updatedAt: Date.now(),
    });
    const prev = state.items.slice();
    state.items = state.items.map((i) => (i.id === next.id ? next : i));
    const ok = await persistItem(next);
    if (!ok) {
      state.items = prev;
      render();
      toast('저장하지 못했어요');
      return;
    }
    closeDetail();
    render();
    toast(next.done ? '처리완료로 넘겼어요' : '보관 중으로 되돌렸어요');
  }

  async function deleteCurrent() {
    const item = state.items.find((i) => i.id === currentId);
    if (!item) return;
    const ok = await askConfirm({
      title: '이 영수증을 지울까요?',
      desc: `‘${esc(item.store)}’ 영수증과 사진이 함께 지워져요.<br>되돌릴 수 없어요.`,
      ok: '지우기',
      tone: 'danger',
    });
    if (!ok) return;
    const prev = state.items.slice();
    state.items = state.items.filter((i) => i.id !== item.id);
    const done = await forgetItem(item.id);
    if (!done) {
      state.items = prev;
      render();
      toast('지우지 못했어요');
      return;
    }
    closeDetail();
    render();
    toast('영수증을 지웠어요');
  }

  /* ── 백업·복원 ───────────────────────── */
  function openMore() {
    hideToast();
    const total = state.items.length;
    const active = state.items.filter((i) => !i.done).length;
    const done = total - active;
    const photos = state.items.reduce((s, e) => s + e.photos.length, 0);
    let bytes = 0;
    try {
      bytes = new Blob([JSON.stringify({ version: VERSION, items: state.items })]).size;
    } catch (err) { bytes = 0; }
    const kb = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
    const where = state.mode === 'idb' ? 'IndexedDB' : 'localStorage';
    els.moreInfo.textContent = `영수증 ${total}개 (보관 중 ${active} · 처리완료 ${done}) · 사진 ${photos}장 · 저장 용량 약 ${kb} · ${where}`;
    els.moreWrap.hidden = false;
    lockBody();
  }

  function backup() {
    const payload = {
      app: 'receipt-box',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      items: state.items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `receipt-box-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    els.moreWrap.hidden = true;
    lockBody();
    toast('백업 파일을 내려받았어요');
  }

  async function restoreFromFile(file) {
    if (!file) return;
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      toast('백업 파일을 읽을 수 없어요');
      return;
    }
    const list = Array.isArray(data) ? data : (data && data.items);
    if (!Array.isArray(list)) {
      toast('백업 파일이 아니에요');
      return;
    }
    const clean = list.filter((i) => i && i.store).map(normalize);
    if (!clean.length) {
      toast('불러올 영수증이 없어요');
      return;
    }

    els.moreWrap.hidden = true;
    lockBody();
    const ok = await askConfirm({
      title: `백업 ${clean.length}개를 불러올까요?`,
      desc: '지금 영수증은 백업에 있는 내용으로 바뀌어요.',
      ok: '불러오기',
    });
    if (!ok) return;

    const prev = state.items.slice();
    const written = await persistAll(clean);
    if (!written) {
      state.items = prev;
      render();
      toast('복원하지 못했어요. 저장 공간을 확인해 주세요.');
      return;
    }
    state.items = clean;
    render();
    toast(`${clean.length}개를 불러왔어요`);
  }

  /* ── 이벤트 ───────────────────────── */
  function bindEvents() {
    els.tabTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      state.tab = btn.dataset.tab;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    els.purposeChips.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-purpose]');
      if (!btn) return;
      state.purpose = btn.dataset.purpose;
      render();
    });

    els.receiptGrid.addEventListener('click', (e) => {
      const add = e.target.closest('#addCard');
      if (add) { openForm(); return; }
      const card = e.target.closest('[data-id]');
      if (card) openDetail(card.dataset.id);
    });

    let searchTimer = null;
    els.searchInput.addEventListener('input', (e) => {
      state.q = e.target.value;
      els.searchClear.hidden = !state.q.length;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 80);
    });
    els.searchClear.addEventListener('click', () => {
      els.searchInput.value = '';
      state.q = '';
      els.searchClear.hidden = true;
      renderList();
      els.searchInput.focus();
    });

    // 등록·수정 시트
    els.addClose.addEventListener('click', closeForm);
    els.addSave.addEventListener('click', saveForm);
    els.photoInput.addEventListener('change', (e) => {
      handlePhotoFiles(e.target.files);
    });
    els.photoGrid.addEventListener('click', (e) => {
      const del = e.target.closest('[data-remove]');
      if (del && form) {
        form.photos.splice(Number(del.dataset.remove), 1);
        renderPhotoGrid();
        return;
      }
      const add = e.target.closest('#photoAdd');
      if (add) { els.photoInput.click(); return; }
      const photo = e.target.closest('[data-photo]');
      if (photo && form) openZoom(form.photos[Number(photo.dataset.photo)]);
    });
    els.purposeSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-purpose]');
      if (!btn || !form) return;
      form.purpose = btn.dataset.purpose;
      if (!(DUE_RULES[form.purpose] || []).length) {
        form.due = '';
        form.dueRule = null;
      }
      paintPurpose();
    });
    els.dueChips.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-due]');
      if (!btn || !form) return;
      const rules = DUE_RULES[form.purpose] || [];
      const rule = rules.find((r) => ruleKey(r) === btn.dataset.due);
      if (!rule) return;
      form.dueRule = ruleKey(rule);
      form.due = dueTarget(rule);
      els.fDue.value = form.due;
      renderDueChips();
    });
    els.fDate.addEventListener('change', () => {
      if (!form) return;
      form.date = els.fDate.value || todayISO();
      paintDate();
      // 빠른 선택으로 채운 마감일은 구매일을 따라 함께 움직인다
      const rules = DUE_RULES[form.purpose] || [];
      const rule = rules.find((r) => ruleKey(r) === form.dueRule);
      if (rule) form.due = dueTarget(rule);
      paintDue();
    });
    els.fDue.addEventListener('change', () => {
      if (!form) return;
      form.due = els.fDue.value || '';
      form.dueRule = null;
      renderDueChips();
    });
    els.fAmount.addEventListener('input', () => {
      const v = numValue(els.fAmount);
      els.fAmount.value = v === null ? '' : comma(v);
    });

    // 상세
    els.detailClose.addEventListener('click', closeDetail);
    els.detailDone.addEventListener('click', toggleDone);
    els.detailEdit.addEventListener('click', () => {
      const id = currentId;
      closeDetail();
      openForm(id);
    });
    els.detailDelete.addEventListener('click', deleteCurrent);
    els.detailBody.addEventListener('click', (e) => {
      const shot = e.target.closest('[data-zoom]');
      if (shot) {
        const item = state.items.find((i) => i.id === currentId);
        if (item) openZoom(item.photos[Number(shot.dataset.zoom)]);
      }
    });

    // 확대
    els.zoomClose.addEventListener('click', closeZoom);
    els.zoomWrap.addEventListener('click', (e) => {
      if (e.target === els.zoomWrap || e.target === els.zoomImg) closeZoom();
      else if (!e.target.closest('.zoom-note')) closeZoom();
    });

    // 더보기·백업
    els.moreBtn.addEventListener('click', openMore);
    els.moreClose.addEventListener('click', () => { els.moreWrap.hidden = true; lockBody(); });
    els.backupBtn.addEventListener('click', backup);
    els.restoreBtn.addEventListener('click', () => els.restoreInput.click());
    els.restoreInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) restoreFromFile(file);
    });

    // 확인 창
    els.confirmOk.addEventListener('click', () => resolveConfirm(true));
    els.confirmCancel.addEventListener('click', () => resolveConfirm(false));
    els.confirmWrap.addEventListener('click', (e) => {
      if (e.target === els.confirmWrap) resolveConfirm(false);
    });

    [['addWrap', closeForm], ['detailWrap', closeDetail]].forEach(([key, fn]) => {
      els[key].addEventListener('click', (e) => {
        if (e.target === els[key]) fn();
      });
    });
    els.moreWrap.addEventListener('click', (e) => {
      if (e.target === els.moreWrap) { els.moreWrap.hidden = true; lockBody(); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.zoomWrap.hidden) { closeZoom(); return; }
      if (!els.confirmWrap.hidden) { resolveConfirm(false); return; }
      if (!els.moreWrap.hidden) { els.moreWrap.hidden = true; lockBody(); return; }
      if (!els.detailWrap.hidden) { closeDetail(); return; }
      if (!els.addWrap.hidden) closeForm();
    });
  }

  /* ── 시작 ───────────────────────── */
  async function init() {
    cacheEls();
    bindEvents();
    let stored = [];
    try {
      db = await openDB();
      state.mode = 'idb';
      stored = await idbAll();
    } catch (err) {
      db = null;
      state.mode = 'local';
      stored = lsAll();
    }
    state.items = (stored || []).map(normalize);
    render();
    document.documentElement.dataset.ready = '1';

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  window.__receiptbox = {
    version: VERSION,
    get items() { return state.items; },
    get view() { return { tab: state.tab, purpose: state.purpose, q: state.q, mode: state.mode }; },
    get form() { return form; },
    get currentId() { return currentId; },
    badgeOf,
    dayDiff,
    addDays,
    addMonths,
    monthSummary,
    pendingCount,
    sortActive,
    sortDone,
    compressImage,
    async replaceAll(list) {
      const items = (list || []).map(normalize);
      await persistAll(items);
      state.items = items;
      render();
      return state.items.length;
    },
    async clearAll() {
      await persistAll([]);
      state.items = [];
      render();
    },
  };

  init();
})();
