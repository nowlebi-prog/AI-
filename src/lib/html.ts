/** 자동 이스케이프되는 HTML 템플릿. 값은 기본적으로 이스케이프되고, SafeHtml만 그대로 들어간다. */

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** 신뢰할 수 있는 문자열만 넣을 것 */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

/** 줄바꿈을 <br>로 바꾼 이스케이프 텍스트 */
export function multiline(s: string): SafeHtml {
  return new SafeHtml(escapeHtml(s).replace(/\r?\n/g, '<br>'));
}
