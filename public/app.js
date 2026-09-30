// Hub — 작은 화면 동작 (복사, 탭, 확인창). 인라인 스크립트 없이 CSP 'self'만 사용.

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

document.addEventListener('click', async (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  const copyBtn = target.closest('[data-copy-target]');
  if (copyBtn) {
    const el = document.getElementById(copyBtn.getAttribute('data-copy-target') || '');
    if (!el) return;
    const label = copyBtn.textContent;
    const ok = await copyText(el.textContent || '');
    copyBtn.textContent = ok ? '복사됨 ✓' : '복사 실패';
    setTimeout(() => {
      copyBtn.textContent = label;
    }, 1500);
    return;
  }

  const tab = target.closest('[data-tab]');
  if (tab) {
    const scope = tab.closest('.card') || document;
    const key = tab.getAttribute('data-tab');
    scope.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    scope.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('active', p.getAttribute('data-panel') === key));
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement && form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
    e.preventDefault();
  }
});
