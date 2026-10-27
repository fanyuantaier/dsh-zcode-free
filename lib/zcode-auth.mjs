import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * ZCode local credential discovery.
 *
 * The ZCode desktop client (v3.x) stores every secret in
 * ~/.zcode/v2/credentials.json encrypted as:
 *
 *   enc:v1:<iv.b64url>.<authTag.b64url>.<ciphertext.b64url>
 *
 * AES-256-GCM with a key derived as sha256(seed), where seed is
 *
 *   ZCODE_CREDENTIAL_SECRET   if set, otherwise
 *   "zcode-credential-fallback:<platform>:<homedir>:<username>"
 *
 * Recovered from the bundled client build (two identical copies of the same
 * module), verified against this machine's file. No server round-trip is
 * involved: the seed is machine-local and never leaves the box.
 */

export const ENC_PREFIX = 'enc:v1:';
export const ENC_ALGO = 'aes-256-gcm';
export const ENC_IV_LEN = 12;
export const ENC_TAG_LEN = 16;
export const SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';
export const APP_VERSION_FALLBACK = '3.14.3';

export function credentialSecretSeed(env = process.env) {
  if (env[SECRET_ENV] && env[SECRET_ENV].trim().length > 0) return env[SECRET_ENV];
  let username = 'unknown';
  try { username = os.userInfo().username; } catch { /* keep unknown */ }
  return 'zcode-credential-fallback:' + os.platform() + ':' + os.homedir() + ':' + username;
}

export function deriveCipherKey(seed) {
  return crypto.createHash('sha256').update(seed).digest();
}

/** Decrypt one enc:v1: value. Passes through anything else unchanged. */
export function decryptZcodeValue(value, opts = {}) {
  if (typeof value !== 'string') return value;
  if (!value.startsWith(ENC_PREFIX)) return value;
  const seed = opts.seed ?? credentialSecretSeed(opts.env ?? process.env);
  const key = deriveCipherKey(seed);
  const parts = value.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) {
    throw new Error('ZCode ciphertext shape invalid (expected 3 base64url segments)');
  }
  const [iv, tag, ct] = parts;
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function zcodeHome(env = process.env) {
  if (env.ZCODE_HOME && env.ZCODE_HOME.trim().length > 0) return env.ZCODE_HOME;
  return path.join(os.homedir(), '.zcode');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Highest semver-looking version directory under the v2 provider runtime. */
function versionFromRuntime(home) {
  const root = path.join(home, 'v2', 'runtime', 'provider');
  try {
    const platforms = fs.readdirSync(root);
    for (const platform of platforms) {
      const versions = fs.readdirSync(path.join(root, platform)).sort();
      const ranked = versions
        .filter((v) => /^\d+\.\d+\.\d+/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (ranked.length > 0) return ranked[0];
    }
  } catch { /* no runtime dir */ }
  return undefined;
}

/** Find the persisted device id the desktop registered. */
function deviceMidFrom(home, env = process.env) {
  if (env.ZCODE_DEVICE_MID && env.ZCODE_DEVICE_MID.trim().length > 0) return env.ZCODE_DEVICE_MID;
  const candidates = [
    ['onboarding', path.join(home, 'v2', 'onboarding-record.json'), 'deviceMid'],
    ['telemetry', path.join(home, 'v2', 'telemetry-state.json'), 'deviceMid'],
    ['session', path.join(home, 'session.json'), 'deviceMid'],
    ['config', path.join(home, 'config.json'), 'deviceMid'],
  ];
  for (const [source, file, field] of candidates) {
    const record = readJson(file);
    if (record && typeof record[field] === 'string' && record[field].length > 0) {
      return { value: record[field], source };
    }
  }
  return undefined;
}

/**
 * Resolve a usable ZCode login for the free plan.
 *
 * Returns { zcode_jwt, device_mid, app_version, user } or null.
 * Precedence: ZCODE_JWT env > local encrypted store.
 */
export function discoverZcodeCredential(env = process.env) {
  const home = zcodeHome(env);
  const store = readJson(path.join(home, 'v2', 'credentials.json')) ?? {};
  const device = deviceMidFrom(home, env);
  const app_version =
    env.ZCODE_APP_VERSION && env.ZCODE_APP_VERSION.trim().length > 0
      ? env.ZCODE_APP_VERSION
      : versionFromRuntime(home) ?? APP_VERSION_FALLBACK;

  let jwt;
  let jwtSource;
  if (env.ZCODE_JWT && env.ZCODE_JWT.trim().length > 0) {
    jwt = env.ZCODE_JWT.trim();
    jwtSource = 'env:ZCODE_JWT';
  } else {
    for (const key of Object.keys(store)) {
      const lower = key.toLowerCase();
      if (lower.includes('zcode') && lower.includes('jwt')) {
        try {
          const value = decryptZcodeValue(store[key], { env });
          if (typeof value === 'string' && value.split('.').length === 3) {
            jwt = value;
            jwtSource = 'store:' + key;
            break;
          }
        } catch { /* try the next key */ }
      }
    }
  }

  if (!jwt) return null;
  if (!device) {
    return {
      error: 'No device id found for the stored ZCode login (looked at onboarding-record.json, telemetry-state.json). Set ZCODE_DEVICE_MID.',
      zcode_jwt: jwt,
      device_mid: '',
      app_version,
      jwt_source: jwtSource,
    };
  }

  let user;
  const userInfoKey = Object.keys(store).find((k) => k.toLowerCase().includes('user_info'));
  if (userInfoKey) {
    try { user = JSON.parse(decryptZcodeValue(store[userInfoKey], { env })); } catch { /* ignore */ }
  }

  return {
    zcode_jwt: jwt,
    device_mid: device.value,
    app_version,
    jwt_source: jwtSource,
    device_source: device.source,
    user,
  };
}

export default { discoverZcodeCredential, decryptZcodeValue, credentialSecretSeed, zcodeHome };
