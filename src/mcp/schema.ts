import { UserError } from '../domain/types.ts';

/** 도구 입력에 쓰는 JSON Schema 부분집합 */
export interface PropSchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: PropSchema;
  properties?: Record<string, PropSchema>;
  required?: readonly string[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, PropSchema>;
  required?: readonly string[];
}

function coerce(schema: PropSchema, value: unknown, path: string, errors: string[]): unknown {
  switch (schema.type) {
    case 'string': {
      let v: unknown = value;
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v !== 'string') {
        errors.push(`${path}: 문자열이어야 해요`);
        return undefined;
      }
      if (schema.enum) {
        const hit = schema.enum.find((e) => e.toLowerCase() === (v as string).trim().toLowerCase());
        if (!hit) {
          errors.push(`${path}: ${schema.enum.join(', ')} 중 하나여야 해요`);
          return undefined;
        }
        return hit;
      }
      if (schema.maxLength && v.length > schema.maxLength) {
        errors.push(`${path}: ${schema.maxLength}자 이내여야 해요`);
        return undefined;
      }
      return v;
    }
    case 'integer':
    case 'number': {
      let v: unknown = value;
      if (typeof v === 'string' && /^\s*[A-Za-z]?\d+(\.\d+)?\s*$/.test(v)) v = Number(v.trim().replace(/^[A-Za-z]/, ''));
      if (typeof v !== 'number' || Number.isNaN(v) || (schema.type === 'integer' && !Number.isInteger(v))) {
        errors.push(`${path}: ${schema.type === 'integer' ? '정수' : '숫자'}여야 해요`);
        return undefined;
      }
      if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path}: ${schema.minimum} 이상이어야 해요`);
      if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path}: ${schema.maximum} 이하여야 해요`);
      return v;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      errors.push(`${path}: true/false여야 해요`);
      return undefined;
    }
    case 'array': {
      let v: unknown = value;
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          /* 아래에서 오류 처리 */
        }
      }
      if (!Array.isArray(v)) {
        errors.push(`${path}: 배열이어야 해요`);
        return undefined;
      }
      if (!schema.items) return v;
      const items = schema.items;
      return v.map((item, i) => coerce(items, item, `${path}[${i}]`, errors));
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: 객체여야 해요`);
        return undefined;
      }
      return coerceObject({ type: 'object', properties: schema.properties ?? {}, required: schema.required }, value as Record<string, unknown>, path, errors);
    }
  }
}

function coerceObject(schema: ObjectSchema, value: Record<string, unknown>, path: string, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = value[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && prop.type !== 'string')) continue;
    const c = coerce(prop, v, path ? `${path}.${key}` : key, errors);
    if (c !== undefined) out[key] = c;
  }
  for (const req of schema.required ?? []) {
    const v = out[req];
    if (v === undefined || (typeof v === 'string' && !v.trim())) errors.push(`${path ? `${path}.` : ''}${req}: 필수 값이에요`);
  }
  return out;
}

/** 스키마에 맞게 값을 정리한다. 틀리면 UserError. 모르는 키는 버린다. */
export function validateArgs(schema: ObjectSchema, args: unknown): Record<string, unknown> {
  const errors: string[] = [];
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const out = coerceObject(schema, obj, '', errors);
  if (errors.length) throw new UserError(`입력값 확인이 필요해요 — ${errors.join('; ')}`);
  return out;
}
