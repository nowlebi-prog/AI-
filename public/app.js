// Hub 화면 동작 — 인라인 스크립트 없이(CSP 'self') 동작한다.
// - 폼을 보내도 화면이 깜빡이거나 맨 위로 튀지 않게(fetch로 보내고 본문만 교체)
// - 복사 버튼, 탭, 확인창, 빠른 추가 미리보기, 단축키(/ 검색, n 빠른 추가), AI 실행 대기 화면 자동 새로 고침

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function flashButton(btn, text) {
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = label;
  }, 1500);
}

/** 서버에서 받은 텍스트 복사 (사파리는 ClipboardItem에 Promise를 넘겨야 한다) */
async function copyFromUrl(btn) {
  const url = btn.getAttribute('data-copy-url');
  const fetchText = () =>
    fetch(url, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    });
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': fetchText().then((t) => new Blob([t], { type: 'text/plain' })) })]);
    } else {
      await copyText(await fetchText());
    }
    flashButton(btn, '복사됨 ✓');
  } catch {
    try {
      const ok = await copyText(await fetchText());
      flashButton(btn, ok ? '복사됨 ✓' : '복사 실패');
    } catch {
      flashButton(btn, '복사 실패');
    }
  }
}

function closeMenus(except) {
  document.querySelectorAll('details.menu[open]').forEach((d) => {
    if (d !== except) d.removeAttribute('open');
  });
}

document.addEventListener('click', async (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (!target.closest('details.menu')) closeMenus(null);

  const copyBtn = target.closest('[data-copy-target]');
  if (copyBtn) {
    const el = document.getElementById(copyBtn.getAttribute('data-copy-target') || '');
    if (el) flashButton(copyBtn, (await copyText(el.textContent || '')) ? '복사됨 ✓' : '복사 실패');
    return;
  }

  const urlBtn = target.closest('[data-copy-url]');
  if (urlBtn) {
    e.preventDefault();
    copyFromUrl(urlBtn);
    return;
  }

  const handoff = target.closest('[data-handoff]');
  if (handoff) {
    // 링크는 그대로 새 탭에서 열고, 프롬프트는 복사해 둔다
    const src = document.getElementById(handoff.getAttribute('data-copy-source') || '');
    if (src) copyText(src.textContent || '');
    const csrf = document.querySelector('input[name="_csrf"]');
    fetch(handoff.getAttribute('data-mark'), {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'X-Requested-With': 'fetch' },
      body: new URLSearchParams({ _csrf: csrf ? csrf.value : '', ai: handoff.dataset.ai || '', model: handoff.dataset.model || '' }),
    }).catch(() => {});
    return;
  }

  const checkAll = target.closest('[data-check-all], [data-check-none]');
  if (checkAll) {
    const name = checkAll.getAttribute('data-check-all') || checkAll.getAttribute('data-check-none');
    const on = checkAll.hasAttribute('data-check-all');
    const form = checkAll.closest('form');
    if (form) form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name || '')}"]`).forEach((c) => (c.checked = on));
    return;
  }

  const tab = target.closest('[data-tab]');
  if (tab) {
    // 같은 탭 묶음 안에서만 바꾼다 (한 카드에 탭 묶음이 여러 개일 수 있다)
    const group = tab.closest('[data-tabs]') || tab.parentElement;
    const key = tab.getAttribute('data-tab');
    const keys = [...group.querySelectorAll('[data-tab]')].map((t) => t.getAttribute('data-tab'));
    group.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    let scope = group.parentElement;
    while (scope && !scope.querySelector(`[data-panel="${CSS.escape(key || '')}"]`)) scope = scope.parentElement;
    if (scope) {
      scope.querySelectorAll('[data-panel]').forEach((p) => {
        const k = p.getAttribute('data-panel');
        if (keys.includes(k)) p.classList.toggle('active', k === key);
      });
    }
  }
});

document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.classList.contains('menu') && d.open) closeMenus(d);
  },
  true,
);

// ─── 폼: 화면 유지하며 보내기 ─────────────────────────────────────

let pollTimer = null;

function swapDocument(htmlText, finalUrl, keepScroll) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const y = window.scrollY;
  document.title = doc.title;
  document.body.replaceWith(doc.body);
  const next = new URL(finalUrl || location.href, location.href);
  const same = next.pathname + next.search === location.pathname + location.search;
  if (!same) history.pushState({}, '', next.pathname + next.search);
  window.scrollTo(0, same && keepScroll ? y : 0);
  initPage();
}

async function submitForm(form, submitter) {
  const body = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (typeof v === 'string') body.append(k, v);
  if (submitter && submitter.name) body.append(submitter.name, submitter.value);
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  const keepName = form.getAttribute('data-keep-focus');
  const action = form.getAttribute('action');
  const url = submitter && submitter.hasAttribute('formaction') ? submitter.formAction : form.action;
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { 'X-Requested-With': 'fetch', Accept: 'text/html' },
    });
    if (res.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) {
      if (res.ok) location.reload();
      else window.alert(await res.text());
      return;
    }
    swapDocument(await res.text(), res.url, true);
    if (keepName) {
      const again = document.querySelector(`form[action="${CSS.escape(action || '')}"] [name="${CSS.escape(keepName)}"]`);
      if (again) again.focus();
    }
  } catch {
    buttons.forEach((b) => (b.disabled = false));
    HTMLFormElement.prototype.submit.call(form); // 네트워크 문제면 일반 전송으로
  }
}

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  const submitter = e.submitter instanceof HTMLElement ? e.submitter : null;
  const message = (submitter && submitter.dataset.confirm) || form.dataset.confirm;
  if (message && !window.confirm(message)) {
    e.preventDefault();
    return;
  }
  if (form.method.toLowerCase() !== 'post' || form.hasAttribute('data-no-ajax') || form.target) return;
  e.preventDefault();
  submitForm(form, submitter);
});

window.addEventListener('popstate', () => location.reload());

// ─── 빠른 추가 미리보기 ──────────────────────────────────────────

let previewTimer = null;

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = `chip ${cls || ''}`;
  s.textContent = text;
  return s;
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.preview) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const out = document.querySelector('[data-preview-out]');
    if (!out) return;
    const text = el.value.trim();
    if (!text) {
      out.replaceChildren();
      return;
    }
    try {
      const r = await fetch(`${el.dataset.preview}?text=${encodeURIComponent(text)}`, { credentials: 'same-origin' });
      const j = await r.json();
      if (j.empty) return out.replaceChildren();
      const parts = [chip(`“${j.title}”`, 'preview-title'), chip(j.project || '프로젝트 없음'), chip(j.role), chip(j.due ? `마감 ${j.due}` : '마감 없음')];
      if (j.repeat) parts.push(chip(`🔁 ${j.repeat}`, 'repeat'));
      if (j.priority) parts.push(chip(j.priority, 'overdue-chip'));
      out.replaceChildren(...parts);
    } catch {
      out.replaceChildren();
    }
  }, 200);
});

// ─── 단축키 ────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
  if (e.key === 'Escape') {
    closeMenus(null);
    if (typing) t.blur();
    return;
  }
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    const s = [...document.querySelectorAll('[data-search-input]')].find((x) => x instanceof HTMLElement && x.offsetParent !== null);
    if (s) s.focus();
    else location.href = '/search';
  } else if (e.key === 'n') {
    const q = document.querySelector('[data-quick-add]');
    e.preventDefault();
    if (q) q.focus();
    else location.href = '/?focus=add';
  }
});

// ─── 페이지 준비 (처음 + 본문 교체 후) ─────────────────────────────

function initPage() {
  clearTimeout(pollTimer);
  const poll = document.querySelector('[data-poll]');
  if (poll) {
    const every = Number(poll.getAttribute('data-poll')) || 2500;
    pollTimer = setTimeout(async () => {
      try {
        const r = await fetch(location.href, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
        if (r.ok) swapDocument(await r.text(), location.href, true);
      } catch {
        initPage();
      }
    }, every);
  }
  const auto = document.querySelector('[autofocus]');
  if (auto instanceof HTMLElement && document.activeElement === document.body) auto.focus({ preventScroll: true });
}

initPage();
