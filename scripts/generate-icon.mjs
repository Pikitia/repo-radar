import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "assets");
const sizes = [256, 128, 64, 48, 32, 16];

function rgba(hex, alpha = 255) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    alpha
  ];
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function blendPixel(buffer, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  const alpha = color[3] / 255;
  const inverse = 1 - alpha;
  buffer[offset] = Math.round(color[0] * alpha + buffer[offset] * inverse);
  buffer[offset + 1] = Math.round(color[1] * alpha + buffer[offset + 1] * inverse);
  buffer[offset + 2] = Math.round(color[2] * alpha + buffer[offset + 2] * inverse);
  buffer[offset + 3] = Math.min(255, Math.round(color[3] + buffer[offset + 3] * inverse));
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return Math.hypot(x - cx, y - cy) <= radius || (x >= left + radius && x <= right - radius && y >= top && y <= bottom) || (y >= top + radius && y <= bottom - radius && x >= left && x <= right);
}

function drawLine(buffer, size, ax, ay, bx, by, width, color) {
  const minX = Math.floor(Math.min(ax, bx) - width);
  const maxX = Math.ceil(Math.max(ax, bx) + width);
  const minY = Math.floor(Math.min(ay, by) - width);
  const maxY = Math.ceil(Math.max(ay, by) + width);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const d = distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
      const edge = width / 2 - d;
      if (edge > -1) blendPixel(buffer, size, x, y, [...color.slice(0, 3), Math.round(color[3] * Math.max(0, Math.min(1, edge + 1)))]);
    }
  }
}

function drawCircle(buffer, size, cx, cy, radius, color) {
  const min = Math.floor(-radius - 1);
  const max = Math.ceil(radius + 1);
  for (let y = min; y <= max; y += 1) {
    for (let x = min; x <= max; x += 1) {
      const d = Math.hypot(x + 0.5, y + 0.5);
      const edge = radius - d;
      if (edge > -1) blendPixel(buffer, size, Math.round(cx + x), Math.round(cy + y), [...color.slice(0, 3), Math.round(color[3] * Math.max(0, Math.min(1, edge + 1)))]);
    }
  }
}

function drawRing(buffer, size, cx, cy, radius, width, color) {
  for (let y = Math.floor(cy - radius - width); y <= Math.ceil(cy + radius + width); y += 1) {
    for (let x = Math.floor(cx - radius - width); x <= Math.ceil(cx + radius + width); x += 1) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius);
      const edge = width / 2 - d;
      if (edge > -1) blendPixel(buffer, size, x, y, [...color.slice(0, 3), Math.round(color[3] * Math.max(0, Math.min(1, edge + 1)))]);
    }
  }
}

function drawWedge(buffer, size, cx, cy, radius, startAngle, endAngle, color) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI * 2;
      if (dist <= radius && angle >= startAngle && angle <= endAngle) {
        const radial = 1 - dist / radius;
        blendPixel(buffer, size, x, y, [...color.slice(0, 3), Math.round(color[3] * (0.18 + radial * 0.55))]);
      }
    }
  }
}

function render(size) {
  const scale = size / 256;
  const buffer = new Uint8Array(size * size * 4);
  const bg1 = rgba("#223246");
  const bg2 = rgba("#101820");

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x / scale;
      const py = y / scale;
      if (!insideRoundedRect(px, py, 14, 14, 228, 228, 48)) continue;
      const color = mix(bg1, bg2, (x + y) / (size * 2));
      blendPixel(buffer, size, x, y, color);
    }
  }

  const s = (n) => n * scale;
  drawWedge(buffer, size, s(128), s(132), s(92), Math.PI * 1.61, Math.PI * 2.02, rgba("#6ee7b7", 115));
  drawRing(buffer, size, s(128), s(132), s(82), s(6), rgba("#5f7f95", 130));
  drawRing(buffer, size, s(128), s(132), s(54), s(5), rgba("#7ba2b5", 120));
  drawRing(buffer, size, s(128), s(132), s(27), s(4), rgba("#b7d3db", 95));
  drawLine(buffer, size, s(128), s(132), s(207), s(82), s(7), rgba("#76f4c7", 235));

  const line = rgba("#d8f6ff", 245);
  drawLine(buffer, size, s(83), s(163), s(83), s(111), s(10), line);
  drawLine(buffer, size, s(83), s(111), s(124), s(111), s(10), line);
  drawLine(buffer, size, s(124), s(111), s(155), s(78), s(10), line);
  drawLine(buffer, size, s(83), s(142), s(126), s(142), s(10), line);
  drawLine(buffer, size, s(126), s(142), s(165), s(179), s(10), line);

  const nodes = [
    [83, 163, "#23c55e", "#f7fff9"],
    [83, 111, "#38bdf8", "#f7fcff"],
    [155, 78, "#f8c14a", "#fff8dc"],
    [165, 179, "#f07178", "#fff2f4"]
  ];
  for (const [x, y, outer, inner] of nodes) {
    drawCircle(buffer, size, s(x), s(y), s(15), rgba(outer));
    drawCircle(buffer, size, s(x), s(y), s(6), rgba(inner));
  }

  drawLine(buffer, size, s(64), s(202), s(193), s(202), s(7), rgba("#6ee7b7", 125));
  return buffer;
}

function makeIco(images) {
  const headerSize = 6 + images.length * 16;
  const entries = [];
  const payloads = [];
  let offset = headerSize;

  for (const { size, rgba: image } of images) {
    const xorBytes = size * size * 4;
    const andStride = Math.ceil(size / 32) * 4;
    const andBytes = andStride * size;
    const dib = Buffer.alloc(40 + xorBytes + andBytes);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(0, 16);
    dib.writeUInt32LE(xorBytes + andBytes, 20);

    let out = 40;
    for (let y = size - 1; y >= 0; y -= 1) {
      for (let x = 0; x < size; x += 1) {
        const input = (y * size + x) * 4;
        dib[out++] = image[input + 2];
        dib[out++] = image[input + 1];
        dib[out++] = image[input];
        dib[out++] = image[input + 3];
      }
    }

    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(dib.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(dib);
    offset += dib.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  return Buffer.concat([header, ...entries, ...payloads]);
}

await mkdir(outDir, { recursive: true });
const images = sizes.map((size) => ({ size, rgba: render(size) }));
await writeFile(path.join(outDir, "icon.ico"), makeIco(images));
console.log(`Wrote ${path.join(outDir, "icon.ico")}`);
