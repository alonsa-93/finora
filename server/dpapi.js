// Windows DPAPI (CurrentUser scope) via powershell.exe + System.Security.Cryptography.ProtectedData.
//
// Used for exactly one thing at runtime: wrapping / unwrapping the 32-byte data key (keys.js), once
// per launch. Bytes travel ONLY over the child's stdin/stdout as raw binary (never as a JS string,
// never in argv / env / on disk); every Buffer we own is zeroed after use.
//
// The legacy credential format (v1: one DPAPI blob per connection with a fixed entropy string) is
// still readable so existing installs migrate transparently (db.js), and protectJSON /
// unprotectJSON remain for that path and its tests.
import { spawn, spawnSync } from 'node:child_process';
import { systemExe } from './config.js';

// Legacy v1 (reads credentials written by earlier versions so they can be upgraded).
// v1 fixed entropy. It is NOT a secret (it is in this source file): it only separates our blobs from
// other DPAPI blobs of the same user. See keys.js for the per-install entropy used by v2.
export const LEGACY_ENTROPY = Buffer.from('MoneyCash/credentials/v1', 'utf8');

const POWERSHELL = () => systemExe('WindowsPowerShell', 'v1.0', 'powershell.exe');

// Input on stdin: [1 byte entropy length][entropy][data]. Output on stdout: raw result bytes.
const RAW_SCRIPT = (mode) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$ms = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($ms)
$all = $ms.ToArray()
$n = [int]$all[0]
$entropy = New-Object byte[] $n
[Array]::Copy($all, 1, $entropy, 0, $n)
$data = New-Object byte[] ($all.Length - 1 - $n)
[Array]::Copy($all, 1 + $n, $data, 0, $data.Length)
[Array]::Clear($all, 0, $all.Length)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
${mode === 'protect'
    ? '$out = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)'
    : '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)'}
[Array]::Clear($data, 0, $data.Length)
$o = [Console]::OpenStandardOutput()
$o.Write($out, 0, $out.Length)
$o.Flush()
[Array]::Clear($out, 0, $out.Length)
`;

const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');
const psArgs = (mode) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(RAW_SCRIPT(mode))];

function frame(entropy, data) {
  if (!Buffer.isBuffer(entropy) || entropy.length > 255) throw new Error('bad entropy');
  const input = Buffer.alloc(1 + entropy.length + data.length);
  input[0] = entropy.length;
  entropy.copy(input, 1);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(input, 1 + entropy.length);
  return input;
}

/** Synchronous DPAPI (one PowerShell process). Returns a Buffer the caller must zero. */
export function dpapiSync(mode, data, entropy) {
  if (process.platform !== 'win32') throw new Error('DPAPI_UNAVAILABLE');
  const input = frame(entropy, data);
  try {
    const r = spawnSync(POWERSHELL(), psArgs(mode), {
      input, windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0 || !r.stdout?.length) {
      if (r.stdout) r.stdout.fill(0);
      throw new Error(mode === 'protect' ? 'DPAPI_PROTECT_FAILED' : 'DPAPI_UNPROTECT_FAILED');
    }
    return r.stdout;
  } finally {
    input.fill(0);
  }
}

/** Asynchronous variant (same protocol). */
export function dpapi(mode, data, entropy) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('DPAPI_UNAVAILABLE')); return; }
    let input;
    try { input = frame(entropy, data); } catch (e) { reject(e); return; }
    const child = spawn(POWERSHELL(), psArgs(mode), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('DPAPI_TIMEOUT')); }, 30000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', () => {});
    const wipe = () => { for (const c of chunks) c.fill(0); input.fill(0); };
    child.on('error', () => { clearTimeout(timer); wipe(); reject(new Error('DPAPI_SPAWN_FAILED')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Never include stdout/stdin content in errors.
      if (code !== 0 || !chunks.length) {
        wipe();
        reject(new Error(mode === 'protect' ? 'DPAPI_PROTECT_FAILED' : 'DPAPI_UNPROTECT_FAILED'));
        return;
      }
      const out = Buffer.concat(chunks);
      wipe();
      resolve(out);
    });
    child.stdin.on('error', () => { /* handled by close */ });
    child.stdin.end(input);
  });
}

// ---- Legacy v1 credential format: upgrades data written by earlier versions (see db.js migrate) ----
/** Legacy v1: encrypt a JSON-serialisable object. Returns base64 ciphertext. */
export async function protectJSON(obj) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  try {
    const out = await dpapi('protect', plain, LEGACY_ENTROPY);
    return out.toString('base64');
  } finally {
    plain.fill(0);
  }
}

function legacyBlob(blobB64) {
  if (typeof blobB64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blobB64)) throw new Error('DPAPI_UNPROTECT_FAILED');
  const raw = Buffer.from(blobB64, 'base64');
  if (!raw.length) throw new Error('DPAPI_UNPROTECT_FAILED');
  return raw;
}

/** Legacy v1: decrypt a base64 ciphertext produced by protectJSON. */
export async function unprotectJSON(blobB64) {
  const buf = await dpapi('unprotect', legacyBlob(blobB64), LEGACY_ENTROPY);
  try {
    return JSON.parse(buf.toString('utf8'));
  } finally {
    buf.fill(0);
  }
}

/** Legacy v1, synchronous: returns the plaintext JSON as a Buffer (caller zeroes it). */
export function unprotectLegacySync(blobB64) {
  return dpapiSync('unprotect', legacyBlob(blobB64), LEGACY_ENTROPY);
}
