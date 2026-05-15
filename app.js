import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import {
  getFirestore, collection, doc, onSnapshot,
  addDoc, updateDoc, deleteDoc, getDocs,
  serverTimestamp, query, orderBy, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const USERS = ['혜원', '채원', '혜지'];

// ---------- 시드 데이터 ----------
const SHOPPING_SEED = [
  { name: '삼겹살 + 항정살', category: '🥩 고기' },
  { name: '소세지', category: '🥩 고기' },
  { name: '국물 밀키트', category: '🍲 식사' },
  { name: '불닭볶음면', category: '🍲 식사' },
  { name: '컵라면 (아침용)', category: '🍲 식사' },
  { name: '햇반', category: '🍲 식사' },
  { name: '김치', category: '🥬 반찬' },
  { name: '쌈채소', category: '🥬 반찬' },
  { name: '쌈장', category: '🥬 반찬' },
  { name: '마늘', category: '🧄 구이용' },
  { name: '양파', category: '🧄 구이용' },
  { name: '버섯', category: '🧄 구이용' },
  { name: '허브솔트', category: '🧂 양념' },
  { name: '마시멜로', category: '🍬 간식' },
  { name: '과자', category: '🍬 간식' },
  { name: '술', category: '🍺 음료' },
  { name: '음료수', category: '🍺 음료' },
  { name: '물', category: '🍺 음료' },
];

const PERSONAL_SEED = [
  '칫솔/치약',
  '세면도구 (클렌징/스킨로션)',
  '잠옷',
  '갈아입을 옷',
  '속옷/양말',
  '충전기',
  '보조배터리',
  '위장',
];

// 사용자별 추가 준비물
const PERSONAL_EXTRA = {
  '혜지': ['카메라'],
};

// ---------- 상태 ----------
let currentUser = localStorage.getItem('currentUser');
let unsubShopping = null;
let unsubPersonal = null;
let unsubExpense = null;

// ---------- 헬퍼 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const showError = (msg) => {
  const banner = $('#error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 4000);
};
const fmtTime = (ts) => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
};
const fmtMoney = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';

// ---------- 사용자 선택 ----------
function showUserSelect() {
  $('#user-select').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#user-select').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#current-user-name').textContent = currentUser;
  $('#personal-owner').textContent = currentUser;
  $('#expense-payer').value = currentUser;
  const lastTab = localStorage.getItem('lastTab') || 'schedule';
  activateTab(lastTab);
  startSubscriptions();
}

$$('.user-pick').forEach(btn => {
  btn.addEventListener('click', () => {
    currentUser = btn.dataset.user;
    localStorage.setItem('currentUser', currentUser);
    showApp();
  });
});

$('#change-user').addEventListener('click', () => {
  stopSubscriptions();
  currentUser = null;
  localStorage.removeItem('currentUser');
  showUserSelect();
});

// ---------- 탭 ----------
function activateTab(tab) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  localStorage.setItem('lastTab', tab);
}

$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ---------- 중복 정리 (race condition 복구) ----------
async function dedupeSeeded() {
  // shopping: addedBy === 'seed' 항목만 dedupe (사용자가 추가한 건 보존)
  const ss = await getDocs(collection(db, 'shopping'));
  const sGroups = new Map();
  ss.forEach(d => {
    const data = d.data();
    if (data.addedBy !== 'seed') return;
    const key = `${data.name}|${data.category || ''}`;
    if (!sGroups.has(key)) sGroups.set(key, []);
    sGroups.get(key).push({ ref: d.ref, data });
  });
  const sBatch = writeBatch(db);
  let sCount = 0;
  sGroups.forEach(list => {
    if (list.length <= 1) return;
    // 보존 우선순위: 체크됨 > note 정리된 것 > 첫 번째
    list.sort((a, b) => {
      if (!!a.data.bought !== !!b.data.bought) return a.data.bought ? -1 : 1;
      if (!!a.data.note !== !!b.data.note) return a.data.note ? 1 : -1;
      return 0;
    });
    list.slice(1).forEach(item => { sBatch.delete(item.ref); sCount++; });
  });
  if (sCount > 0) await sBatch.commit();

  // personal: 각 user별 name 중복 제거
  for (const user of USERS) {
    const ps = await getDocs(collection(db, 'personal', user, 'items'));
    const pGroups = new Map();
    ps.forEach(d => {
      const key = d.data().name;
      if (!pGroups.has(key)) pGroups.set(key, []);
      pGroups.get(key).push({ ref: d.ref, data: d.data() });
    });
    const pBatch = writeBatch(db);
    let pCount = 0;
    pGroups.forEach(list => {
      if (list.length <= 1) return;
      list.sort((a, b) => {
        if (!!a.data.checked !== !!b.data.checked) return a.data.checked ? -1 : 1;
        return 0;
      });
      list.slice(1).forEach(item => { pBatch.delete(item.ref); pCount++; });
    });
    if (pCount > 0) await pBatch.commit();
  }
}

// ---------- 시드 ----------
async function seedIfEmpty() {
  // 살거
  const shoppingSnap = await getDocs(collection(db, 'shopping'));
  if (shoppingSnap.empty) {
    const batch = writeBatch(db);
    SHOPPING_SEED.forEach((item, i) => {
      const ref = doc(collection(db, 'shopping'));
      batch.set(ref, {
        ...item,
        bought: false,
        addedBy: 'seed',
        order: i,
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();
  }

  // 준비물 (각 유저별)
  for (const user of USERS) {
    const personalSnap = await getDocs(collection(db, 'personal', user, 'items'));
    if (personalSnap.empty) {
      const batch = writeBatch(db);
      const items = [...PERSONAL_SEED, ...(PERSONAL_EXTRA[user] || [])];
      items.forEach((name, i) => {
        const ref = doc(collection(db, 'personal', user, 'items'));
        batch.set(ref, {
          name,
          checked: false,
          order: i,
          createdAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }
  }
}

// ---------- 마이그레이션 (기존 데이터에 새 항목/변경 반영, 멱등) ----------
async function applyChanges() {
  // shopping: 맥주 → 술 이름 변경
  const ss = await getDocs(collection(db, 'shopping'));
  const sBatch = writeBatch(db);
  let sUpdates = 0;
  let hasWater = false;
  ss.forEach(d => {
    const data = d.data();
    if (data.name === '맥주') {
      sBatch.update(d.ref, { name: '술' });
      sUpdates++;
    }
    if (data.name === '물') hasWater = true;
  });
  if (sUpdates > 0) await sBatch.commit();
  if (!hasWater) {
    await addDoc(collection(db, 'shopping'), {
      name: '물',
      category: '🍺 음료',
      bought: false,
      addedBy: 'seed',
      order: 100,
      createdAt: serverTimestamp(),
    });
  }

  // personal: 위장 (모두) + 카메라 (혜지) — 이미 있으면 skip
  for (const user of USERS) {
    const ps = await getDocs(collection(db, 'personal', user, 'items'));
    const names = new Set();
    ps.forEach(d => names.add(d.data().name));

    const toAdd = [];
    if (!names.has('위장')) toAdd.push('위장');
    for (const extra of (PERSONAL_EXTRA[user] || [])) {
      if (!names.has(extra)) toAdd.push(extra);
    }
    for (const name of toAdd) {
      await addDoc(collection(db, 'personal', user, 'items'), {
        name,
        checked: false,
        order: 100,
        createdAt: serverTimestamp(),
      });
    }
  }
}

// ---------- 살거 ----------
function startShoppingListener() {
  const q = query(collection(db, 'shopping'), orderBy('order', 'asc'));
  unsubShopping = onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    renderShopping(items);
  }, (err) => showError('살거 불러오기 실패: ' + err.message));
}

function renderShopping(items) {
  const container = $('#shopping-list');
  container.innerHTML = '';

  // 카테고리별 그룹화
  const groups = {};
  items.forEach(it => {
    const cat = it.category || '기타';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(it);
  });

  Object.entries(groups).forEach(([cat, list]) => {
    const header = document.createElement('div');
    header.className = 'category-header';
    header.textContent = cat;
    container.appendChild(header);

    list.forEach(it => container.appendChild(renderShoppingItem(it)));
  });
}

function renderShoppingItem(it) {
  const el = document.createElement('div');
  el.className = 'list-item' + (it.bought ? ' checked' : '');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!it.bought;
  cb.addEventListener('change', async () => {
    try {
      await updateDoc(doc(db, 'shopping', it.id), {
        bought: cb.checked,
        boughtBy: cb.checked ? currentUser : null,
        boughtAt: cb.checked ? serverTimestamp() : null,
      });
    } catch (e) { showError(e.message); }
  });

  const body = document.createElement('div');
  body.className = 'item-body';
  const name = document.createElement('div');
  name.className = 'item-name';
  name.textContent = it.name;
  body.appendChild(name);

  if (it.note) {
    const note = document.createElement('div');
    note.className = 'item-note';
    note.textContent = it.note;
    body.appendChild(note);
  }

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const parts = [];
  if (it.addedBy && it.addedBy !== 'seed') parts.push(`추가: ${it.addedBy}`);
  if (it.bought && it.boughtBy) parts.push(`✓ ${it.boughtBy}`);
  if (parts.length) meta.innerHTML = parts.join(' · ');
  body.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'delete-btn';
  del.textContent = '×';
  del.title = '삭제';
  del.addEventListener('click', async () => {
    if (!confirm(`"${it.name}" 삭제할까요?`)) return;
    try { await deleteDoc(doc(db, 'shopping', it.id)); }
    catch (e) { showError(e.message); }
  });

  el.appendChild(cb);
  el.appendChild(body);
  el.appendChild(del);
  return el;
}

$('#shopping-add').addEventListener('click', async () => {
  const input = $('#shopping-input');
  const noteInput = $('#shopping-note');
  const name = input.value.trim();
  if (!name) return;
  try {
    await addDoc(collection(db, 'shopping'), {
      name,
      note: noteInput.value.trim(),
      category: '➕ 추가',
      bought: false,
      addedBy: currentUser,
      order: Date.now(),
      createdAt: serverTimestamp(),
    });
    input.value = '';
    noteInput.value = '';
    input.focus();
  } catch (e) { showError(e.message); }
});

$('#shopping-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#shopping-add').click();
});

// ---------- 준비물 ----------
function startPersonalListener() {
  if (unsubPersonal) unsubPersonal();
  const q = query(collection(db, 'personal', currentUser, 'items'), orderBy('order', 'asc'));
  unsubPersonal = onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    renderPersonal(items);
  }, (err) => showError('준비물 불러오기 실패: ' + err.message));
}

function renderPersonal(items) {
  const container = $('#personal-list');
  container.innerHTML = '';
  items.forEach(it => {
    const el = document.createElement('div');
    el.className = 'list-item' + (it.checked ? ' checked' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!it.checked;
    cb.addEventListener('change', async () => {
      try {
        await updateDoc(doc(db, 'personal', currentUser, 'items', it.id), {
          checked: cb.checked,
        });
      } catch (e) { showError(e.message); }
    });

    const body = document.createElement('div');
    body.className = 'item-body';
    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = it.name;
    body.appendChild(name);

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!confirm(`"${it.name}" 삭제할까요?`)) return;
      try { await deleteDoc(doc(db, 'personal', currentUser, 'items', it.id)); }
      catch (e) { showError(e.message); }
    });

    el.appendChild(cb);
    el.appendChild(body);
    el.appendChild(del);
    container.appendChild(el);
  });
}

$('#personal-add').addEventListener('click', async () => {
  const input = $('#personal-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    await addDoc(collection(db, 'personal', currentUser, 'items'), {
      name,
      checked: false,
      order: Date.now(),
      createdAt: serverTimestamp(),
    });
    input.value = '';
    input.focus();
  } catch (e) { showError(e.message); }
});

$('#personal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#personal-add').click();
});

// ---------- 정산 ----------
function startExpenseListener() {
  const q = query(collection(db, 'expenses'), orderBy('createdAt', 'desc'));
  unsubExpense = onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    renderExpense(items);
  }, (err) => showError('정산 불러오기 실패: ' + err.message));
}

function renderExpense(items) {
  // 합계 + 인당 정산
  const paid = { 혜원: 0, 채원: 0, 혜지: 0 };
  const owes = { 혜원: 0, 채원: 0, 혜지: 0 };

  items.forEach(it => {
    paid[it.payer] = (paid[it.payer] || 0) + Number(it.amount || 0);
    const splitWith = it.splitWith && it.splitWith.length ? it.splitWith : USERS;
    const share = Number(it.amount || 0) / splitWith.length;
    splitWith.forEach(u => { owes[u] = (owes[u] || 0) + share; });
  });

  const total = Object.values(paid).reduce((a, b) => a + b, 0);

  const summary = $('#expense-summary');
  summary.innerHTML = '';
  USERS.forEach(u => {
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `<span>${u} 결제</span><b>${fmtMoney(paid[u])}</b>`;
    summary.appendChild(row);
  });
  const totalRow = document.createElement('div');
  totalRow.className = 'summary-row summary-total';
  totalRow.innerHTML = `<span>총 지출</span><b>${fmtMoney(total)}</b>`;
  summary.appendChild(totalRow);

  // 잔액 (양수: 받을 돈, 음수: 줄 돈)
  const balance = {};
  USERS.forEach(u => { balance[u] = Math.round((paid[u] || 0) - (owes[u] || 0)); });

  const balanceDiv = document.createElement('div');
  balanceDiv.className = 'balance';
  USERS.forEach(u => {
    const b = balance[u];
    const row = document.createElement('div');
    if (b > 0) {
      row.className = 'balance-row gets';
      row.textContent = `${u}: +${fmtMoney(b)} (받을 돈)`;
    } else if (b < 0) {
      row.className = 'balance-row owes';
      row.textContent = `${u}: ${fmtMoney(b)} (줄 돈)`;
    } else {
      row.className = 'balance-row';
      row.textContent = `${u}: 0원`;
    }
    balanceDiv.appendChild(row);
  });

  // 누가 누구에게 송금?
  const instructions = settleDebts(balance);
  if (instructions.length) {
    balanceDiv.appendChild(renderSettleTabs(instructions));
  }
  summary.appendChild(balanceDiv);

  // 지출 내역
  const list = $('#expense-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<p class="hint">아직 지출 내역이 없어요.</p>';
    return;
  }
  items.forEach(it => {
    const el = document.createElement('div');
    el.className = 'expense-item';
    const splitWith = it.splitWith && it.splitWith.length ? it.splitWith : USERS;
    el.innerHTML = `
      <div class="expense-item-top">
        <div>
          <div class="expense-desc">${escapeHtml(it.description || '(설명 없음)')}</div>
          <div class="expense-detail">${it.payer} 결제 · ${splitWith.join('/')} 분담 · ${fmtTime(it.createdAt)}</div>
        </div>
        <div class="expense-amount">${fmtMoney(it.amount)}</div>
      </div>
    `;
    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.textContent = '×';
    del.style.float = 'right';
    del.style.marginTop = '-4px';
    del.addEventListener('click', async () => {
      if (!confirm('이 지출을 삭제할까요?')) return;
      try { await deleteDoc(doc(db, 'expenses', it.id)); }
      catch (e) { showError(e.message); }
    });
    el.querySelector('.expense-item-top').appendChild(del);
    list.appendChild(el);
  });
}

function renderSettleTabs(instructions) {
  const mine = instructions.filter(ins => ins.from === currentUser || ins.to === currentUser);

  const wrapper = document.createElement('div');
  wrapper.className = 'settle-section';

  const title = document.createElement('div');
  title.className = 'settle-instructions';
  title.innerHTML = '<b>정산 방법</b>';
  wrapper.appendChild(title);

  const tabs = document.createElement('div');
  tabs.className = 'settle-tabs';
  const tabMine = document.createElement('button');
  tabMine.className = 'settle-tab active';
  tabMine.textContent = `내 정산 (${mine.length})`;
  const tabAll = document.createElement('button');
  tabAll.className = 'settle-tab';
  tabAll.textContent = `전체 (${instructions.length})`;
  tabs.appendChild(tabMine);
  tabs.appendChild(tabAll);
  wrapper.appendChild(tabs);

  const list = document.createElement('div');
  list.className = 'settle-list';
  wrapper.appendChild(list);

  function paint(rows, isMineView) {
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'settle-empty';
      empty.textContent = isMineView ? '내가 받거나 줄 돈이 없어요 🎉' : '정산할 내역이 없어요';
      list.appendChild(empty);
      return;
    }
    rows.forEach(ins => {
      const row = document.createElement('div');
      row.className = 'settle-row';
      if (ins.from === currentUser) row.classList.add('me-send');
      else if (ins.to === currentUser) row.classList.add('me-recv');
      row.innerHTML = `<b>${ins.from}</b> <span class="arrow">→</span> <b>${ins.to}</b> ${fmtMoney(ins.amount)}`;
      list.appendChild(row);
    });
  }

  paint(mine, true);
  tabMine.addEventListener('click', () => {
    tabMine.classList.add('active');
    tabAll.classList.remove('active');
    paint(mine, true);
  });
  tabAll.addEventListener('click', () => {
    tabAll.classList.add('active');
    tabMine.classList.remove('active');
    paint(instructions, false);
  });

  return wrapper;
}

function settleDebts(balance) {
  // greedy: 가장 받을 사람과 가장 줄 사람을 매칭
  const creditors = []; // {user, amount}
  const debtors = [];
  USERS.forEach(u => {
    if (balance[u] > 0) creditors.push({ user: u, amount: balance[u] });
    else if (balance[u] < 0) debtors.push({ user: u, amount: -balance[u] });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const result = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > 0) result.push({ from: debtors[i].user, to: creditors[j].user, amount: pay });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return result;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

$('#expense-add').addEventListener('click', async () => {
  const payer = $('#expense-payer').value;
  const description = $('#expense-desc').value.trim();
  const amount = Number($('#expense-amount').value);
  const splitWith = Array.from($$('.split-with')).filter(c => c.checked).map(c => c.value);

  if (!amount || amount <= 0) {
    showError('금액을 입력해주세요');
    return;
  }
  if (!description) {
    showError('설명을 입력해주세요');
    return;
  }
  if (!splitWith.length) {
    showError('나눠낼 사람을 선택해주세요');
    return;
  }

  try {
    await addDoc(collection(db, 'expenses'), {
      payer,
      description,
      amount,
      splitWith,
      addedBy: currentUser,
      createdAt: serverTimestamp(),
    });
    $('#expense-desc').value = '';
    $('#expense-amount').value = '';
    $$('.split-with').forEach(c => c.checked = true);
  } catch (e) { showError(e.message); }
});

// ---------- 구독 관리 ----------
async function startSubscriptions() {
  $('#loading').classList.remove('hidden');
  try {
    await dedupeSeeded();
    await seedIfEmpty();
    await applyChanges();
  } catch (e) {
    showError('초기 데이터 설정 실패: ' + e.message);
  }
  $('#loading').classList.add('hidden');
  startShoppingListener();
  startPersonalListener();
  startExpenseListener();
}

function stopSubscriptions() {
  if (unsubShopping) { unsubShopping(); unsubShopping = null; }
  if (unsubPersonal) { unsubPersonal(); unsubPersonal = null; }
  if (unsubExpense) { unsubExpense(); unsubExpense = null; }
}

// ---------- 시작 ----------
if (currentUser && USERS.includes(currentUser)) {
  showApp();
} else {
  showUserSelect();
}
