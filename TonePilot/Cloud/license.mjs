// TonePilot Cloud licenses: tp1.<licenseId>.<expiresUnix>.<signature>, where the signature
// is HMAC-SHA256 (base64url) over "tp1.<licenseId>.<expiresUnix>" with the owner's secret.
// Stateless: no license database; a license ends at its expiry or when the secret rotates.
import {createHmac, timingSafeEqual} from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');

export function signLicense(licenseId, expiresUnix, secret) {
  if (!ID.test(licenseId)) throw new Error('licenseId must be 1–64 letters, digits, "-" or "_"');
  if (!Number.isSafeInteger(expiresUnix) || expiresUnix <= 0) throw new Error('expiry must be a Unix time in seconds');
  const payload = 'tp1.' + licenseId + '.' + expiresUnix;
  return payload + '.' + sign(payload, secret);
}

// → {licenseId} when valid, {error: 'license-expired'} for a genuine but expired license,
//   {error: 'license-invalid'} for anything else. The signature is checked before expiry.
export function verifyLicense(token, secret, nowUnix) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  const [version, licenseId, expires, signature] = parts;
  if (parts.length !== 4 || version !== 'tp1' || !ID.test(licenseId) || !/^\d{1,12}$/.test(expires)) return {error: 'license-invalid'};
  const expected = Buffer.from(sign('tp1.' + licenseId + '.' + expires, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return {error: 'license-invalid'};
  if (Number(expires) <= nowUnix) return {error: 'license-expired'};
  return {licenseId};
}
