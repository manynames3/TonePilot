#!/usr/bin/env node
// Owner-side: mint a TonePilot Cloud license.
//   TONEPILOT_LICENSE_SECRET=… node mint-license.mjs <licenseId> <days>
// The secret is the value of the SSM SecureString the backend reads; it never ships in the app.
import {signLicense} from './license.mjs';

const [licenseId, days] = process.argv.slice(2);
const secret = process.env.TONEPILOT_LICENSE_SECRET || '';
if (!licenseId || !/^\d+$/.test(days || '') || Number(days) < 1) {
  console.error('usage: TONEPILOT_LICENSE_SECRET=… node mint-license.mjs <licenseId> <days>');
  process.exit(2);
}
if (secret.length < 32) {
  console.error('TONEPILOT_LICENSE_SECRET must be set to the backend secret (at least 32 characters)');
  process.exit(2);
}
const expires = Math.floor(Date.now() / 1000) + Number(days) * 86400;
try {
  console.log(signLicense(licenseId, expires, secret));
  console.error('licenseId ' + licenseId + ', expires ' + new Date(expires * 1000).toISOString());
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
