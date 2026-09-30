import { crc32, deflateSync } from 'node:zlib';

/** 앱 아이콘(PNG)을 코드로 그린다: 보라색 둥근 사각형 + 흰색 H */

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // 필터 없음
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function iconPng(size: number, opts: { maskable?: boolean } = {}): Buffer {
  const px = new Uint8Array(size * size * 4);
  const bg = [0x4f, 0x46, 0xe5];
  const radius = opts.maskable ? 0 : size * 0.22;
  const inset = opts.maskable ? size * 0.2 : size * 0.1;
  const stroke = size * 0.11;
  const left = inset + size * 0.14;
  const right = size - inset - size * 0.14;
  const top = inset + size * 0.12;
  const bottom = size - inset - size * 0.12;
  const mid = size / 2;
  const inRounded = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const inH = (x: number, y: number) =>
    (y >= top && y <= bottom && ((x >= left && x <= left + stroke) || (x >= right - stroke && x <= right))) ||
    (x >= left && x <= right && y >= mid - stroke / 2 && y <= mid + stroke / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (!inRounded(cx, cy)) continue;
      const white = inH(cx, cy);
      px[i] = white ? 255 : (bg[0] ?? 0);
      px[i + 1] = white ? 255 : (bg[1] ?? 0);
      px[i + 2] = white ? 255 : (bg[2] ?? 0);
      px[i + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}
