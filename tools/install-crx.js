/**
 * ExtensionSync — Bulk .crx installer (Node, dependency-free)
 * ===========================================================
 *
 * Installs one or more local Chrome Web Store `.crx` files into a Brave or
 * Chrome profile as "Developer Mode" (unpacked) extensions, so they survive
 * restarts instead of being forgotten after a single `--load-extension` pass.
 *
 * Why this exists (and its limits):
 *   - Chrome/Brave expose NO API for an extension (or script) to silently
 *     install another extension. Silent sideloading is deliberately blocked.
 *   - The Chrome Web Store no longer serves `.crx` files (the update endpoint
 *     returns 204) — CRX files are only delivered through the "Add to Chrome"
 *     click with a signed token. So you must ALREADY possess the `.crx` files.
 *   - This script registers each `.crx`'s unpacked copy under the target
 *     profile's `extensions.settings` (location 4 = unpacked, developer mode).
 *     Brave/Chrome honor this per-profile for developer extensions. Signed
 *     store `.crx` may still be refused by the browser; use the store page for
 *     those (see the in-extension "Install Selected" flow).
 *
 * How the extension ID is computed: Chromium derives an extension ID from the
 * SHA-256 of the CRX public key, mapping each nibble onto the alphabet
 * "abcdefghijklmnop" (the first 16 bytes become the 32-char ID). Both the CRX2
 * and CRX3 (protobuf) headers are parsed here.
 *
 * USAGE
 * -----
 *     node tools/install-crx.js <path-to.crx> [more.crx ...] [options]
 *     node tools/install-crx.js --file <ids.json> [--crx-dir <dir>] [options]
 *
 * Examples:
 *     node tools/install-crx.js C:\crx\ublock.crx C:\crx\adblock.crx
 *     node tools/install-crx.js --file "%USERPROFILE%\Downloads\extensionsync-install.json" --crx-dir C:\crx
 *
 * The second form reads an IDs export produced by the ExtensionSync popup's
 * "Install Selected" (see tools/install-extensions.cmd), looks up each ID as
 * `<id>.crx` inside --crx-dir, and batch-installs every CRX found.
 *
 * Options:
 *   --profile <name>   Profile directory name (default: "Default").
 *   --browser <b>      "brave" (default) or "chrome".
 *   --dry-run          Print what would be installed without touching the profile.
 *   --unpack-dir <dir> Where to unpack the CRX (default: alongside the profile).
 *   --file <json>      Read extension IDs from a JSON export ({extensions:[ids]}).
 *   --crx-dir <dir>    Directory containing <id>.crx files (used with --file).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');

/* ------------------------------------------------------------------ */
/* CRX header parsing + extension ID derivation                        */
/* ------------------------------------------------------------------ */

const CRX_ID_ALPHABET = 'abcdefghijklmnop';

/** Computes a Chromium extension ID from a DER public key buffer. */
function deriveExtensionId(publicKey) {
  // ID = first 128 bits of SHA-256(publicKey), nibble-mapped onto a-p.
  return crypto.createHash('sha256').update(publicKey).digest('hex')
    .slice(0, 32)
    .split('')
    .map((h) => CRX_ID_ALPHABET[parseInt(h, 16)])
    .join('');
}

/** Minimal protobuf reader (field 2 of AsymmetricKeyProof = public_key). */
function readProtobufField2(buf) {
  // We walk top-level fields; we want the LAST length-delimited field with
  // wire type 2 whose contents look like a DER key. Chromium's CrxFileHeader
  // proof list stores public_key as field 2, length-delimited.
  let i = 0;
  let candidate = null;
  while (i < buf.length) {
    // varint tag
    let tag = 0; let shift = 0;
    while (i < buf.length && shift < 28) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      // varint
      while (i < buf.length) { if (!(buf[i++] & 0x80)) break; }
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 2) {
      // length-delimited
      let len = 0; let ls = 0;
      while (i < buf.length && ls < 28) {
        const b = buf[i++];
        len |= (b & 0x7f) << ls;
        ls += 7;
        if (!(b & 0x80)) break;
      }
      const start = i;
      if (field === 2 && start + len <= buf.length) {
        candidate = buf.slice(start, start + len);
      }
      i = start + len;
    } else if (wire === 5) {
      i += 4;
    } else {
      break; // unknown wire type
    }
  }
  return candidate;
}

/**
 * Extracts { publicKey, zipStart } from a CRX buffer. Supports CRX2 and CRX3.
 * Throws on malformed files.
 */
function parseCrx(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = 'Cr24';
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== MAGIC) {
    throw new Error(`${path.basename(file)} is not a valid .crx (bad magic)`);
  }
  const version = buf.readUInt32LE(4);

  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    const pubKey = buf.slice(16, 16 + pubKeyLen);
    const zipStart = 16 + pubKeyLen + sigLen;
    return { publicKey: pubKey, zipStart };
  }

  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    const headerBuf = buf.slice(12, 12 + headerSize);
    const publicKey = readProtobufField2(headerBuf);
    if (!publicKey) {
      throw new Error(`${path.basename(file)}: could not locate public key in CRX3 header`);
    }
    return { publicKey, zipStart: 12 + headerSize };
  }

  throw new Error(`${path.basename(file)}: unsupported CRX version ${version}`);
}

/* ------------------------------------------------------------------ */
/* Profile discovery                                                   */
/* ------------------------------------------------------------------ */

// Maps browser name -> possible Local AppData root dirs (per OS).
function profileRoot(browser) {
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = {
    brave: ['BraveSoftware', 'Brave-Browser', 'User Data'],
    chrome: ['Google', 'Chrome', 'User Data']
  };
  return path.join(appData, ...(roots[browser] || roots.brave));
}

/* ------------------------------------------------------------------ */
/* Preference-file registration                                        */
/* ------------------------------------------------------------------ */

// Securely read the extension ID framing the manifest check. We simply embed
// `location: 4` (unpacked / developer mode) plus the absolute unpacked path.
// Brave/Chrome read extensions.settings.<id> to know where to load the
// unpacked extension and whether it is enabled.

function findPrefFiles(profileDir, log) {
  const candidates = ['Secure Preferences', 'Preferences'];
  const found = [];
  for (const name of candidates) {
    const p = path.join(profileDir, name);
    if (fs.existsSync(p)) found.push(p);
  }
  if (!found.length && log) log(`No Preferences file found in ${profileDir} — the profile likely has not been launched yet.`);
  return found;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonFile(file, json) {
  // Electron/Chromium rewrite the Preferences atomically; a dense write is fine.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json));
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { browser: 'brave', profile: 'Default', dryRun: false, files: [], unpackDir: null, file: null, crxDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--browser') opts.browser = argv[++i];
    else if (a === '--unpack-dir') opts.unpackDir = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--crx-dir') opts.crxDir = argv[++i];
    else opts.files.push(a);
  }
  return opts;
}

/** Resolves the list of .crx files from direct paths, a directory, or an export. */
function resolveCrxFiles(opts) {
  const crxFiles = [];

  if (opts.file) {
    const abs = path.resolve(opts.file);
    if (!fs.existsSync(abs)) {
      console.error(`! export not found: ${abs}`);
      return crxFiles;
    }
    let exportData;
    try {
      exportData = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      console.error(`! invalid JSON export: ${abs}`);
      return crxFiles;
    }
    const ids = Array.isArray(exportData?.extensions)
      ? exportData.extensions
      : Array.isArray(exportData)
        ? exportData
        : [];
    const crxDir = opts.crxDir ? path.resolve(opts.crxDir) : process.cwd();
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) continue;
      const candidate = lookupCrx(crxDir, id);
      if (!candidate) { console.error(`! no .crx found for ${id} in ${crxDir}`); continue; }
      if (seen.has(candidate)) continue; // dedupe repeated ids
      seen.add(candidate);
      crxFiles.push(candidate);
    }
    return crxFiles;
  }

  for (const f of opts.files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) { console.error(`! not found: ${f}`); continue; }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      fs.readdirSync(abs).filter((n) => n.endsWith('.crx')).forEach((n) => crxFiles.push(path.join(abs, n)));
    } else {
      crxFiles.push(abs);
    }
  }
  return crxFiles;
}

/** Finds `<id>.crx` or `<id>_<x>.crx` inside a directory. */
function lookupCrx(dir, id) {
  const direct = path.join(dir, id + '.crx');
  if (fs.existsSync(direct)) return direct;
  const prefix = id + '_';
  const match = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((n) => n.toLowerCase().startsWith(prefix) && n.toLowerCase().endsWith('.crx'))
    : undefined;
  return match ? path.join(dir, match) : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(m);

  if (!opts.files.length && !opts.file) {
    console.log('Usage: node tools/install-crx.js <file.crx> [...] | --file <ids.json> [--crx-dir <dir>] [options]');
    process.exit(1);
  }

  const crxFiles = resolveCrxFiles(opts);

  if (!crxFiles.length) { console.error('No .crx files found.'); process.exit(1); }

  const profileDir = path.join(profileRoot(opts.browser), opts.profile);
  const unpackRoot = opts.unpackDir ? path.resolve(opts.unpackDir) : profileRoot(opts.browser);
  const prefFiles = findPrefFiles(profileDir, log);

  console.log(`Browser: ${opts.browser}  Profile: ${opts.profile}`);
  console.log(`Profile dir: ${profileDir}`);
  console.log(`Mode: ${opts.dryRun ? 'DRY-RUN (no writes)' : 'INSTALL'}\n`);

  const plans = [];
  for (const crx of crxFiles) {
    try {
      const { publicKey, zipStart } = parseCrx(crx);
      const id = deriveExtensionId(publicKey);
      plans.push({ crx, id, publicKey, zipStart });
    } catch (e) {
      console.error(`! ${path.basename(crx)}: ${e.message}`);
    }
  }

  for (const p of plans) {
    const unpacked = path.join(unpackRoot, 'ExtensionSync', p.id);
    let size = 'n/a';
    try { size = fs.statSync(p.crx).size + ' bytes'; } catch {}
    console.log(`\n[${p.id}]`);
    console.log(`  file     : ${p.crx} (${size})`);
    console.log(`  unpacked : ${unpacked}`);
    if (opts.dryRun) continue;

    // Unpack the ZIP payload (after the CRX header) into the extension dir.
    const buf = fs.readFileSync(p.crx);
    const zip = buf.slice(p.zipStart);
    fs.mkdirSync(unpacked, { recursive: true });
    await unpackZip(zip, unpacked);
    console.log('  extracting: ok');

    // Register in Preferences / Secure Preferences.
    for (const prefPath of prefFiles) {
      const json = readJsonFile(prefPath);
      json.extensions = json.extensions || {};
      json.extensions.settings = json.extensions.settings || {};
      json.extensions.settings[p.id] = {
        path: unpacked,
        state: 1, // ENABLED
        location: 4, // LOAD (unpacked / developer mode)
        manifest: json.extensions.settings[p.id]?.manifest || undefined,
        disable_reasons: 0
      };
      writeJsonFile(prefPath, json);
      console.log(`  registered: ${path.basename(prefPath)}`);
    }
  }

  console.log('\nDone.');
  if (opts.dryRun) {
    console.log('Dry-run only — re-run without --dry-run to install.');
  } else {
    console.log('\nNext steps:');
    console.log(' 1. Completely quit your browser (all windows).');
    console.log(' 2. Reopen it and go to chrome://extensions (or brave://extensions).');
    console.log(' 3. Switch on "Developer mode" and "Allow extensions from other sources" if asked,');
    console.log('    then reload the page — the unpacked extensions should appear.');
    console.log('\nNote: signed store .crx may be refused; use the store page for those.');
  }
}

/** Extracts a classic ZIP (Stored/Deflate) to `dest` dependency-free. */
async function unpackZip(buf, dest) {
  const fsLib = require('fs');
  // Use PowerShell-free pure-JS via a lazy pull: but deflate needs inflate.
  // We support both methods by scanning the End Of Central Directory.
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a valid ZIP (no EOCD)');
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const entries = readCentralDirectory(buf, centralOffset);
  for (const e of entries) {
    const out = path.join(dest, e.name);
    if (e.isDir) { fsLib.mkdirSync(out, { recursive: true }); continue; }
    fsLib.mkdirSync(path.dirname(out), { recursive: true });
    const data = buf.slice(e.localOffset + e.localHeaderSize, e.localOffset + e.localHeaderSize + e.compressedSize);
    const raw = inflate(e.method, e.compressedSize, data);
    fsLib.writeFileSync(out, raw);
  }
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function inflate(method, anySize, data) {
  return method === 8 ? zlib.inflateRawSync(data) : data;
}

function readCentralDirectory(buf, offset) {
  const entries = [];
  let pos = offset;
  // The central directory starts at `offset` (number of entries marker aside).
  // Read until we hit the End Of Central Directory (0x06054b50).
  let count = 0;
  while (count < 5000) {
    if (pos + 4 > buf.length) break;
    if (buf.readUInt32LE(pos) === 0x06054b50) break; // EOCD
    if (buf.readUInt32LE(pos) !== 0x02014b50) { pos += 1; continue; } // resync
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    let name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    // Read the local header size for the data slice.
    const localHeaderSize = getLocalHeaderSize(buf, localOffset);
    const isDir = name.endsWith('/');
    if (!isDir) name = name.replace(/\/+$/, '');
    // decrypt-unsupported or data-descriptor(bit3) handling
    const usesDescriptor = (flags & 0x08) !== 0;
    entries.push({ name, method, compSize, localOffset, localHeaderSize, isDir, usesDescriptor });
    pos += 46 + nameLen + extraLen + commentLen;
    count++;
  }
  return entries;
}

function getLocalHeaderSize(buf, localOffset) {
  if (localOffset + 30 > buf.length) return 0;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  return 30 + nameLen + extraLen;
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
