// Lightroom previews as the model and the on-device analyzer receive them.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

// Lightroom sometimes answers a small preview request with the full-size image (seen on a
// CR3: 5472 × 3648, 3 MB). Neither the model nor the analyzer needs more than this.
export const PREVIEW_MAX_EDGE = 1024;

export function previewBytes(preview) {
  const raw = preview?.image?.data;
  if (typeof raw !== 'string' || raw.length < 100) throw new Error('Lightroom preview is missing');
  return Buffer.from(raw, 'base64');
}

// Pixel size from the JPEG frame header, or null if the bytes aren't a readable JPEG.
export function jpegSize(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  for (let i = 2; i + 9 < buf.length; i += 2 + buf.readUInt16BE(i + 2)) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker))
      return {width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5)};
  }
  return null;
}

// Writes the preview to `file`, scaled down in place when it is larger than needed, and
// returns the bytes actually stored. If scaling fails the original is kept.
export function savePreview(jpeg, file) {
  fs.writeFileSync(file, jpeg, {mode: 0o600});
  const size = jpegSize(jpeg);
  if (!size || Math.max(size.width, size.height) <= PREVIEW_MAX_EDGE) return jpeg;
  const r = spawnSync('/usr/bin/sips', ['-Z', String(PREVIEW_MAX_EDGE), file], {stdio: 'ignore'});
  return r.status === 0 ? fs.readFileSync(file) : jpeg;
}
