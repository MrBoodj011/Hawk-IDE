import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Generates the application artwork from code, so each Code-OSS preparation
 * receives the same Hawk identity without committing opaque binaries.
 */
export async function writeBrandAssets(codeOssRoot) {
  const images = new Map([
    [16, createPng(16)],
    [32, createPng(32)],
    [48, createPng(48)],
    [64, createPng(64)],
    [128, createPng(128)],
    [150, createPng(150)],
    [192, createPng(192)],
    [256, createPng(256)],
    [512, createPng(512)],
  ]);
  const files = [
    ['resources/win32/code.ico', createIco([16, 32, 48, 64, 128, 256], images)],
    ['resources/win32/code_70x70.png', images.get(64)],
    ['resources/win32/code_150x150.png', images.get(150)],
    ['resources/linux/code.png', images.get(512)],
    ['resources/server/code-192.png', images.get(192)],
    ['resources/server/code-512.png', images.get(512)],
    ['resources/server/favicon.ico', createIco([16, 32, 48], images)],
    ['resources/darwin/code.icns', createIcns(images.get(512))],
  ];

  await Promise.all(
    files.map(async ([relativePath, contents]) => {
      const path = join(codeOssRoot, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }),
  );
}

export function renderBrandPng(size = 256) {
  return createPng(size);
}

function createPng(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 256;
  const point = (value) => value * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const index = (y * size + x) * 4;
      const set = (red, green, blue, alpha = 255) => {
        pixels[index] = red;
        pixels[index + 1] = green;
        pixels[index + 2] = blue;
        pixels[index + 3] = alpha;
      };

      if (insideRoundedRect(px, py, point(18), point(18), point(220), point(220), point(52))) {
        const depth = Math.min(1, Math.hypot(px - point(196), py - point(36)) / point(230));
        set(Math.round(10 + depth * 7), Math.round(16 + depth * 9), Math.round(29 + depth * 14));
      }

      const shield = [
        [128, 31], [204, 61], [192, 157], [128, 223], [64, 157], [52, 61],
      ].map(([sx, sy]) => [point(sx), point(sy)]);
      if (insidePolygon(px, py, shield)) {
        const ratio = (px + py) / (size * 2);
        set(Math.round(255 - ratio * 12), Math.round(203 - ratio * 102), Math.round(104 - ratio * 48));
      }

      const innerShield = [
        [128, 52], [183, 74], [174, 147], [128, 196], [82, 147], [73, 74],
      ].map(([sx, sy]) => [point(sx), point(sy)]);
      if (insidePolygon(px, py, innerShield)) {
        set(10, 19, 33);
      }

      const sky = [85, 220, 255];
      const amber = [255, 184, 77];
      const lineWidth = Math.max(1, point(13));
      const p = (vx, vy) => [point(vx), point(vy)];
      const wingSegments = [
        [p(70, 94), p(119, 114)], [p(70, 94), p(105, 137)], [p(73, 138), p(128, 183)],
        [p(186, 94), p(137, 114)], [p(186, 94), p(151, 137)], [p(183, 138), p(128, 183)],
      ];
      const wing = wingSegments.some(([from, to]) => distanceToSegment(px, py, ...from, ...to) < lineWidth / 2);
      if (wing) {
        const hue = Math.min(1, Math.max(0, (px - point(70)) / point(116)));
        set(
          Math.round(sky[0] * (1 - hue) + amber[0] * hue),
          Math.round(sky[1] * (1 - hue) + amber[1] * hue),
          Math.round(sky[2] * (1 - hue) + amber[2] * hue),
        );
      }
      const beak = [[128, 99], [151, 128], [128, 177], [105, 128]].map(([sx, sy]) => [point(sx), point(sy)]);
      if (insidePolygon(px, py, beak)) set(...amber);
      const eyeRadius = Math.max(1, point(6));
      if (Math.hypot(px - point(105), py - point(111)) < eyeRadius || Math.hypot(px - point(151), py - point(111)) < eyeRadius) set(...sky);
    }
  }

  return encodePng(size, size, pixels);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearestY = Math.max(top + radius, Math.min(y, top + height - radius));
  return Math.hypot(x - nearestX, y - nearestY) <= radius;
}

function insidePolygon(x, y, vertices) {
  let contained = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const [ax, ay] = vertices[index];
    const [bx, by] = vertices[previous];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) contained = !contained;
  }
  return contained;
}

function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const projection = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + projection * dx), y - (ay + projection * dy));
}

function encodePng(width, height, pixels) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (width * 4 + 1)] = 0;
    pixels.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return output;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createIco(sizes, images) {
  const entries = sizes.map((size) => images.get(size));
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((image, index) => {
    const size = sizes[index];
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...entries]);
}

function createIcns(image) {
  const chunkSize = image.length + 8;
  const output = Buffer.alloc(chunkSize + 8);
  output.write('icns', 0, 'ascii');
  output.writeUInt32BE(output.length, 4);
  output.write('ic10', 8, 'ascii');
  output.writeUInt32BE(chunkSize, 12);
  image.copy(output, 16);
  return output;
}
