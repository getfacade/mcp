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
  return describe(await readFile(filePath), basename(filePath), MIME_BY_EXTENSION[extname(filePath).toLowerCase()]);
}

/**
 * The remote server has no file system of the person it talks to, so the photo
 * arrives as a link. Bounded in time and in size: a link to something that is
 * not a photo, or to an endless stream, must end in a plain answer rather than
 * a hung tool call.
 */
const URL_FETCH_TIMEOUT_MS = 60_000;
const URL_MAX_BYTES = 30 * 1024 * 1024;

export async function readImageFromUrl(imageUrl) {
  const url = new URL(imageUrl);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('`image_url` must be an http(s) link to a JPEG, PNG or WebP file.');
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS), redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`The photo link answered HTTP ${response.status}; it has to be a direct, public link to the image file.`);
  }

  if (Number(response.headers.get('content-length') ?? 0) > URL_MAX_BYTES) {
    throw new Error('The photo behind this link is larger than 30 MB.');
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length > URL_MAX_BYTES) {
    throw new Error('The photo behind this link is larger than 30 MB.');
  }

  const name = basename(url.pathname) || 'photo';
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim();

  return describe(bytes, name, MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? sniffMime(bytes) ?? headerType);
}

function describe(bytes, fileName, contentType) {
  const dimensions = readDimensions(bytes);

  if (!dimensions) {
    throw new Error(`Cannot read the pixel size of ${fileName}. Supported formats: JPEG, PNG, WebP.`);
  }

  return {
    bytes,
    md5: createHash('md5').update(bytes).digest('hex'),
    fileName,
    contentType: contentType || 'application/octet-stream',
    ...dimensions,
  };
}

function sniffMime(buffer) {
  if (readPng(buffer)) return 'image/png';
  if (readWebp(buffer)) return 'image/webp';
  if (readJpeg(buffer)) return 'image/jpeg';

  return null;
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
