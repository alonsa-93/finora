// Is the system drive / data drive protected by BitLocker or Device Encryption? Read without admin
// rights through the shell property System.Volume.BitLockerProtection. Anything we cannot determine
// stays null and the UI says nothing.
import { spawn } from 'node:child_process';
import { parse } from 'node:path';
import { systemExe, dataDir } from './config.js';

let status = null; // 'on' | 'off' | null

export const diskEncryption = () => status;

const ON = new Set([1, 3, 6]); // on, encrypting, on (locked)
const OFF = new Set([2, 4, 5, 8]); // off, decrypting, suspended, waiting for activation

export function checkDiskEncryption() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  let drives;
  try {
    drives = [...new Set([process.env.SystemDrive || 'C:', parse(dataDir()).root.slice(0, 2)])]
      .filter((d) => /^[A-Za-z]:$/.test(d));
  } catch { return Promise.resolve(null); }
  const script = `$s = New-Object -ComObject Shell.Application; @(${drives.map((d) => `'${d}\\'`).join(',')}) | ForEach-Object { [string]$s.NameSpace($_).Self.ExtendedProperty('System.Volume.BitLockerProtection') }`;
  return new Promise((resolve) => {
    const child = spawn(systemExe('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const vals = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(Number);
      if (vals.length !== drives.length || vals.some((v) => !Number.isInteger(v))) { resolve(null); return; }
      if (vals.some((v) => OFF.has(v))) status = 'off';
      else if (vals.every((v) => ON.has(v))) status = 'on';
      else status = null;
      resolve(status);
    });
  });
}
