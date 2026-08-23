/**
 * Local arithmetic over the file the caller pointed at: an md5 and the pixel
 * dimensions the upload endpoint asks for.
 *
 * This is not business logic and it holds no truth of its own. `aspect_ratio`
 * in particular is deliberately NOT computed here: the server derives it from
 * the width and height sent with the upload. Every client that used to snap to
 * the nearest supported ratio on its own was a separate copy of the same rule,
 * drifting apart one rounding at a time. This one keeps none.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function readImage(filePath) {
  const bytes = await readFile(filePath);
  const dimensions = readDimensions(bytes);

  if (!dimensions) {
    throw new Error(`Cannot read the pixel size of ${filePath}. Supported formats: JPEG, PNG, WebP.`);
  }

  return {
    bytes,
    md5: createHash('md5').update(bytes).digest('hex'),
    fileName: basename(filePath),
    contentType: MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    ...dimensions,
  };
}

function readDimensions(buffer) {
  return readPng(buffer) ?? readWebp(buffer) ?? readJpeg(buffer);
}

function readPng(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;

  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readWebp(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const format = buffer.toString('ascii', 12, 16);

  if (format === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }

  if (format === 'VP8L') {
    const bits = buffer.readUInt32LE(21);

    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }

  if (format === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }

  return null;
}

function readJpeg(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);

    // SOF0..SOF15, minus the four markers in that range that are not frame
    // headers (DHT, JPG, DAC, RST) — those carry no size.
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

    if (isFrameHeader) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }

    offset += 2 + length;
  }

  return null;
}
