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
      'cropWrap', 'cropStage', 'cropView', 'cropCanvas', 'cropFrame', 'cropCancel', 'cropApply',
      'cropKeep', 'cropRotate', 'cropAuto', 'cropRatios', 'cropSize',
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
  const MODAL_KEYS = ['addWrap', 'detailWrap', 'moreWrap', 'confirmWrap', 'zoomWrap', 'cropWrap'];

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

  // 사진을 고르면 바로 담지 않고 자르기 창을 먼저 띄운다
  async function handlePhotoFiles(files) {
    if (!form) return;
    const all = Array.from(files || []);
    els.photoInput.value = '';
    if (!all.length) return;
    const room = MAX_PHOTOS - form.photos.length;
    if (room <= 0) {
      toast(`사진은 ${MAX_PHOTOS}장까지 넣을 수 있어요`);
      return;
    }
    const usable = all.filter((file) => String(file.type || '').startsWith('image/'));
    if (!usable.length) {
      toast('사진을 읽지 못했어요. 다른 사진으로 해 주세요.');
      return;
    }
    if (usable.length > room) toast(`사진은 ${MAX_PHOTOS}장까지라 ${room}장만 넣었어요`);
    const batch = usable.slice(0, room);
    if (!els.cropWrap.hidden) {
      cropQueue = cropQueue.concat(batch);
      return;
    }
    cropQueue = batch;
    openNextCrop();
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

  /* ── 사진 자르기(크롭) ───────────────────────── */
  /* 고른·찍은 사진을 바로 담지 않고, 자를 영역을 고른 뒤 담는다.
     · 자르기 적용 — 네 모서리 핸들·박스 안쪽 드래그로 고른 영역만 잘라 JPEG로 압축
     · 원본 그대로 — 자르지 않고 예전처럼 전체를 압축해 담는다
     · 비율 칩(자유·1:1·3:4·4:3)과 ↺ 90° 회전 지원, Pointer 이벤트로 아이폰 터치 대응 */
  const CROP_RATIOS = { free: null, '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3 };
  const CROP_MAX = 2600; // 작업 캔버스 최대 변(px)
  const CROP_MIN = 48;   // 자를 영역 최소 변(화면 px)
  const CROP_ANALYZE = 160; // 자동 맞춤 분석용 축소 캔버스 긴 변(px)
  const crop = { file: null, ratio: 'free', rect: null, scale: 1, drag: null, detected: null };
  let cropQueue = [];

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽지 못했어요')); };
      img.src = url;
    });
  }

  function cropViewSize() {
    const box = els.cropView.getBoundingClientRect();
    return { w: box.width || 1, h: box.height || 1 };
  }

  function maxCropRect(ratio, vw, vh) {
    if (!ratio) return { x: 0, y: 0, w: vw, h: vh };
    let w = vw;
    let h = w / ratio;
    if (h > vh) { h = vh; w = h * ratio; }
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  // ── ✨ 자동 맞춤 ──
  // 축소 캔버스에서 주변 배경과 구분되는 밝은 종이·카드(또는 대비 높은 피사체) 영역을 찾는다.
  // 못 찾거나 감지 영역이 너무 작으면 null을 돌려주고, 부르는 쪽에서 전체 영역으로 되돌린다.
  function detectCropRect() {
    const src = els.cropCanvas;
    if (!src.width || !src.height) return null;
    const k = Math.min(1, CROP_ANALYZE / Math.max(src.width, src.height));
    const w = Math.max(16, Math.round(src.width * k));
    const h = Math.max(16, Math.round(src.height * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    let px = null;
    try {
      px = ctx.getImageData(0, 0, w, h).data;
    } catch (err) {
      return null;
    }

    const lumOf = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

    // 테두리 띠에서 배경색·배경 편차를 잰다
    const band = Math.max(1, Math.round(Math.min(w, h) * 0.06));
    const Rs = [];
    const Gs = [];
    const Bs = [];
    const Ls = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const i = (y * w + x) * 4;
        Rs.push(px[i]);
        Gs.push(px[i + 1]);
        Bs.push(px[i + 2]);
        Ls.push(lumOf(i));
      }
    }
    if (!Rs.length) return null;
    const med = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
    const bgR = med(Rs);
    const bgG = med(Gs);
    const bgB = med(Bs);
    const bgL = med(Ls);
    let dev = 0;
    for (let i = 0; i < Ls.length; i++) dev += Math.abs(Ls[i] - bgL);
    dev /= Ls.length;

    const brightTh = Math.max(26, dev * 2.6); // 배경보다 밝은 종이
    const colorTh = Math.max(62, dev * 4);    // 배경과 확 다른 색(대비 높은 피사체)

    const rowCount = new Float32Array(h);
    const colCount = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dl = lumOf(i) - bgL;
        const dc = Math.max(
          Math.abs(px[i] - bgR),
          Math.abs(px[i + 1] - bgG),
          Math.abs(px[i + 2] - bgB)
        );
        if (dl > brightTh || dc > colorTh) {
          rowCount[y] += 1;
          colCount[x] += 1;
        }
      }
    }

    // 성긴 무늬(글자·바코드)가 끊기지 않게 살짝 뭉갠다
    const smooth = (arr, size) => {
      const out = new Float32Array(arr.length);
      const half = Math.max(0, Math.floor((size - 1) / 2));
      for (let i = 0; i < arr.length; i++) {
        let sum = 0;
        let n = 0;
        for (let j = i - half; j <= i + half; j++) {
          if (j < 0 || j >= arr.length) continue;
          sum += arr[j];
          n += 1;
        }
        out[i] = n ? sum / n : 0;
      }
      return out;
    };
    const win = Math.max(3, (Math.round(Math.min(w, h) * 0.05) | 1));
    const bestRun = (counts, th, center) => {
      const runs = [];
      let cur = null;
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] >= th) {
          if (cur) cur.b = i;
          else { cur = { a: i, b: i }; }
        } else if (cur) {
          runs.push(cur);
          cur = null;
        }
      }
      if (cur) runs.push(cur);
      if (!runs.length) return null;
      const mine = runs.filter((r) => r.a <= center && center <= r.b);
      const pool = mine.length ? mine : runs;
      return pool.reduce((best, r) => (r.b - r.a > best.b - best.a ? r : best), pool[0]);
    };

    // 뭉갠 값으로 구간을 찾고, 실제 픽셀 수로 가장자리를 다시 조인다
    const trim = (counts, run, minCount) => {
      let a = run.a;
      let b = run.b;
      while (a < b && counts[a] < minCount) a += 1;
      while (b > a && counts[b] < minCount) b -= 1;
      return { a, b };
    };
    const rowsFound = bestRun(smooth(rowCount, win), w * 0.2, h / 2);
    const colsFound = bestRun(smooth(colCount, win), h * 0.2, w / 2);
    if (!rowsFound || !colsFound) return null;
    const rowsRun = trim(rowCount, rowsFound, w * 0.12);
    const colsRun = trim(colCount, colsFound, h * 0.12);

    const padX = Math.max(1, Math.round(w * 0.01));
    const padY = Math.max(1, Math.round(h * 0.01));
    const x0 = Math.max(0, colsRun.a - padX);
    const x1 = Math.min(w - 1, colsRun.b + padX);
    const y0 = Math.max(0, rowsRun.a - padY);
    const y1 = Math.min(h - 1, rowsRun.b + padY);
    const nw = (x1 - x0 + 1) / w;
    const nh = (y1 - y0 + 1) / h;
    if (nw < 0.25 || nh < 0.25) return null; // 너무 작으면 안전하게 포기
    return { x: x0 / w, y: y0 / h, w: nw, h: nh };
  }

  // 감지한 영역(없으면 전체) 안에 지금 고른 비율을 맞춰 넣는다
  function cropFitToDetected() {
    const { w: vw, h: vh } = cropViewSize();
    const ratio = CROP_RATIOS[crop.ratio] || null;
    const d = crop.detected;
    let rect;
    if (!d) {
      rect = maxCropRect(ratio, vw, vh);
    } else {
      const bx = d.x * vw;
      const by = d.y * vh;
      const bw = d.w * vw;
      const bh = d.h * vh;
      if (!ratio) {
        rect = { x: bx, y: by, w: bw, h: bh };
      } else {
        let rw = bw;
        let rh = rw / ratio;
        if (rh > bh) { rh = bh; rw = rh * ratio; }
        rect = { x: bx + (bw - rw) / 2, y: by + (bh - rh) / 2, w: rw, h: rh };
      }
    }
    const cw = Math.min(rect.w, vw);
    const ch = Math.min(rect.h, vh);
    crop.rect = {
      x: Math.min(Math.max(0, rect.x), Math.max(0, vw - cw)),
      y: Math.min(Math.max(0, rect.y), Math.max(0, vh - ch)),
      w: cw,
      h: ch,
    };
    paintCropFrame();
  }

  // ✨ 자동 맞춤 — 지금 사진(회전 반영)에서 영역을 다시 찾아 맞춘다
  function autoFitCrop() {
    crop.detected = detectCropRect();
    cropFitToDetected();
    return !!crop.detected;
  }

  // 비율만 바꿀 때: 지금 영역의 넓이·중심을 지키며 비율을 맞춘다(반복해도 줄지 않게)
  function cropFitRatio(ratio) {
    const { w: vw, h: vh } = cropViewSize();
    const r0 = crop.rect || maxCropRect(null, vw, vh);
    if (!ratio) {
      crop.rect = { x: r0.x, y: r0.y, w: r0.w, h: r0.h };
      paintCropFrame();
      return;
    }
    const cx = r0.x + r0.w / 2;
    const cy = r0.y + r0.h / 2;
    const area = Math.max(1, r0.w * r0.h);
    let w = Math.sqrt(area * ratio);
    let h = w / ratio;
    const maxW = Math.min(vw, vh * ratio);
    if (w > maxW) { w = maxW; h = w / ratio; }
    w = Math.max(w, Math.min(CROP_MIN, vw));
    h = Math.max(h, Math.min(CROP_MIN, vh));
    if (h > vh) { h = vh; w = h * ratio; }
    if (w > vw) { w = vw; h = w / ratio; }
    const x = Math.min(Math.max(0, cx - w / 2), Math.max(0, vw - w));
    const y = Math.min(Math.max(0, cy - h / 2), Math.max(0, vh - h));
    crop.rect = { x, y, w, h };
    paintCropFrame();
  }

  function paintCropFrame() {
    if (!crop.rect) return;
    const r = crop.rect;
    els.cropFrame.style.left = `${r.x}px`;
    els.cropFrame.style.top = `${r.y}px`;
    els.cropFrame.style.width = `${r.w}px`;
    els.cropFrame.style.height = `${r.h}px`;
    els.cropSize.textContent = `자를 영역 ${Math.round(r.w * crop.scale)} × ${Math.round(r.h * crop.scale)}`;
  }

  function paintCropRatio() {
    els.cropRatios.querySelectorAll('button[data-ratio]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.ratio === crop.ratio));
    });
  }

  // 작업 캔버스를 화면에 맞춰 줄이고, 자를 영역 상자를 다시 그린다
  function layoutCrop() {
    const cv = els.cropCanvas;
    const w = cv.width || 1;
    const h = cv.height || 1;
    const availW = Math.max(80, els.cropStage.clientWidth - 48);
    const availH = Math.max(80, els.cropStage.clientHeight - 48);
    const fit = Math.min(availW / w, availH / h, 1);
    const vw = Math.max(40, w * fit);
    const vh = Math.max(40, h * fit);
    els.cropView.style.width = `${Math.round(vw * 100) / 100}px`;
    els.cropView.style.height = `${Math.round(vh * 100) / 100}px`;
    cv.style.width = `${vw}px`;
    cv.style.height = `${vh}px`;
    crop.scale = w / vw;
    crop.rect = maxCropRect(CROP_RATIOS[crop.ratio] || null, vw, vh);
    paintCropFrame();
  }

  async function openCrop(file) {
    if (!form || form.photos.length >= MAX_PHOTOS) return false;
    let img = null;
    try {
      img = await loadImageFile(file);
    } catch (err) {
      return false;
    }
    const nw = img.naturalWidth || img.width || 0;
    const nh = img.naturalHeight || img.height || 0;
    if (!nw || !nh) return false;
    if (!form || form.photos.length >= MAX_PHOTOS) return false;
    const k = Math.min(1, CROP_MAX / Math.max(nw, nh));
    const cv = els.cropCanvas;
    cv.width = Math.max(1, Math.round(nw * k));
    cv.height = Math.max(1, Math.round(nh * k));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    crop.file = file;
    crop.ratio = 'free';
    crop.rect = null;
    crop.drag = null;
    paintCropRatio();
    els.cropWrap.hidden = false;
    lockBody();
    layoutCrop();
    autoFitCrop(); // 처음 열 때 밝은 종이/카드 영역을 찾아 미리 맞춰 둔다
    return true;
  }

  function closeCrop() {
    els.cropWrap.hidden = true;
    crop.file = null;
    crop.rect = null;
    crop.drag = null;
    crop.ratio = 'free';
    crop.detected = null;
    paintCropRatio();
    lockBody();
  }

  function cancelCrop() {
    cropQueue = [];
    closeCrop();
  }

  // 여러 장을 고르면 한 장씩 차례로 자르기 창을 띄운다
  async function openNextCrop() {
    while (cropQueue.length) {
      const file = cropQueue.shift();
      if (await openCrop(file)) return;
      toast('사진을 읽지 못했어요. 다른 사진으로 해 주세요.');
    }
  }

  function addCropPhoto(data) {
    if (!form) return false;
    if (form.photos.length >= MAX_PHOTOS) {
      toast(`사진은 ${MAX_PHOTOS}장까지 넣을 수 있어요`);
      return false;
    }
    form.photos.push(data);
    renderPhotoGrid();
    return true;
  }

  function rotateCrop() {
    const cv = els.cropCanvas;
    if (!cv.width || !cv.height) return;
    const tmp = document.createElement('canvas');
    tmp.width = cv.width;
    tmp.height = cv.height;
    tmp.getContext('2d').drawImage(cv, 0, 0);
    const next = document.createElement('canvas');
    next.width = tmp.height;
    next.height = tmp.width;
    const ctx = next.getContext('2d');
    ctx.translate(next.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(tmp, 0, 0);
    cv.width = next.width;
    cv.height = next.height;
    const cvCtx = cv.getContext('2d');
    cvCtx.imageSmoothingEnabled = true;
    cvCtx.imageSmoothingQuality = 'high';
    cvCtx.drawImage(next, 0, 0);
    layoutCrop();
    autoFitCrop(); // 회전한 사진 기준으로 다시 찾는다
  }

  function applyCrop() {
    const cv = els.cropCanvas;
    if (!crop.rect || !cv.width || !cv.height) return;
    const r = crop.rect;
    const sx = Math.max(0, Math.round(r.x * crop.scale));
    const sy = Math.max(0, Math.round(r.y * crop.scale));
    const sw = Math.max(1, Math.min(cv.width - sx, Math.round(r.w * crop.scale)));
    const sh = Math.max(1, Math.min(cv.height - sy, Math.round(r.h * crop.scale)));
    const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * k));
    out.height = Math.max(1, Math.round(sh * k));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cv, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const data = out.toDataURL('image/jpeg', QUALITY);
    addCropPhoto(data);
    closeCrop();
    openNextCrop();
  }

  async function keepCropOriginal() {
    const file = crop.file;
    if (!file) return;
    let data = null;
    try {
      data = await compressImage(file);
    } catch (err) {
      toast('사진을 읽지 못했어요. 다른 사진으로 해 주세요.');
      closeCrop();
      openNextCrop();
      return;
    }
    addCropPhoto(data);
    closeCrop();
    openNextCrop();
  }

  // 비율을 지키면서 모서리를 끄는 크기 조절
  function cropResizeRect(r0, mode, dx, dy, ratio, vw, vh) {
    const left = mode.indexOf('l') >= 0;
    const top = mode.indexOf('t') >= 0;
    const ax = left ? r0.x + r0.w : r0.x;   // 고정점(반대 모서리)
    const ay = top ? r0.y + r0.h : r0.y;
    const px = (left ? r0.x : r0.x + r0.w) + dx;
    const py = (top ? r0.y : r0.y + r0.h) + dy;
    const maxW = Math.max(CROP_MIN, left ? ax : vw - ax);
    const maxH = Math.max(CROP_MIN, top ? ay : vh - ay);
    let w = Math.abs(px - ax);
    let h = Math.abs(py - ay);
    if (ratio) {
      w = Math.max(w, h * ratio);
      h = w / ratio;
      if (w > maxW) { w = maxW; h = w / ratio; }
      if (h > maxH) { h = maxH; w = h * ratio; }
      w = Math.max(w, Math.max(Math.min(CROP_MIN, maxW), Math.min(CROP_MIN, maxH) * ratio));
      h = Math.min(w / ratio, maxH);
      w = h * ratio;
    } else {
      w = Math.min(Math.max(w, Math.min(CROP_MIN, maxW)), maxW);
      h = Math.min(Math.max(h, Math.min(CROP_MIN, maxH)), maxH);
    }
    return { x: left ? ax - w : ax, y: top ? ay - h : ay, w, h };
  }

  function cropDragStart(e) {
    if (!crop.rect) return;
    const handle = e.target.closest('[data-handle]');
    const frame = e.target.closest('#cropFrame');
    if (!handle && !frame) return;
    if (typeof e.button === 'number' && e.button > 0) return;
    e.preventDefault();
    crop.drag = {
      mode: handle ? handle.dataset.handle : 'move',
      sx: e.clientX,
      sy: e.clientY,
      rect0: { ...crop.rect },
      ratio: handle ? (CROP_RATIOS[crop.ratio] || null) : null,
    };
    const target = handle || frame;
    if (target.setPointerCapture) {
      try { target.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
    }
  }

  function cropDragMove(e) {
    const d = crop.drag;
    if (!d) return;
    e.preventDefault();
    const { w: vw, h: vh } = cropViewSize();
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === 'move') {
      const x = Math.min(Math.max(0, d.rect0.x + dx), Math.max(0, vw - d.rect0.w));
      const y = Math.min(Math.max(0, d.rect0.y + dy), Math.max(0, vh - d.rect0.h));
      crop.rect = { x, y, w: d.rect0.w, h: d.rect0.h };
    } else {
      crop.rect = cropResizeRect(d.rect0, d.mode, dx, dy, d.ratio, vw, vh);
    }
    paintCropFrame();
  }

  function cropDragEnd() {
    crop.drag = null;
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

    // 사진 자르기
    els.cropCancel.addEventListener('click', cancelCrop);
    els.cropApply.addEventListener('click', applyCrop);
    els.cropKeep.addEventListener('click', keepCropOriginal);
    els.cropRotate.addEventListener('click', rotateCrop);
    els.cropAuto.addEventListener('click', () => {
      if (!autoFitCrop()) toast('자를 영역을 찾지 못해 전체로 맞췄어요');
    });
    els.cropRatios.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ratio]');
      if (!btn) return;
      const key = Object.prototype.hasOwnProperty.call(CROP_RATIOS, btn.dataset.ratio) ? btn.dataset.ratio : 'free';
      crop.ratio = key;
      paintCropRatio();
      cropFitRatio(CROP_RATIOS[key]);
    });
    els.cropView.addEventListener('pointerdown', cropDragStart);
    document.addEventListener('pointermove', cropDragMove);
    document.addEventListener('pointerup', cropDragEnd);
    document.addEventListener('pointercancel', cropDragEnd);
    window.addEventListener('resize', () => {
      if (!els.cropWrap || els.cropWrap.hidden) return;
      layoutCrop();
      cropFitToDetected();
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
      if (!els.cropWrap.hidden) { cancelCrop(); return; }
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
    get crop() {
      return {
        open: !!(els.cropWrap && !els.cropWrap.hidden),
        ratio: crop.ratio,
        rect: crop.rect ? { ...crop.rect } : null,
        scale: crop.scale,
        source: els.cropCanvas ? { w: els.cropCanvas.width, h: els.cropCanvas.height } : null,
        detected: crop.detected ? { ...crop.detected } : null,
        queued: cropQueue.length,
      };
    },
    autoFitCrop,
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
