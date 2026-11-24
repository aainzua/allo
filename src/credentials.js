import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AlloError } from './profile.js'

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AlloCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string name, uint type, uint flags, out IntPtr pointer);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref Credential entry, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string name, uint type, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr pointer);

  public static string[] Read(string name) {
    IntPtr pointer;
    if (!CredRead(name, 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      var entry = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      var bytes = new byte[entry.BlobSize];
      Marshal.Copy(entry.Blob, bytes, 0, bytes.Length);
      try { return new[] { entry.UserName, Encoding.UTF8.GetString(bytes) }; }
      finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }

  public static void Write(string name, string email, string token) {
    var bytes = Encoding.UTF8.GetBytes(token);
    var pointer = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, pointer, bytes.Length);
      var entry = new Credential {
        TargetName = name, Type = 1, Persist = 2, UserName = email,
        Blob = pointer, BlobSize = (uint)bytes.Length
      };
      if (!CredWrite(ref entry, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(pointer, i, 0);
      Marshal.FreeHGlobal(pointer);
      Array.Clear(bytes, 0, bytes.Length);
    }
  }

  public static bool Delete(string name) {
    if (CredDelete(name, 1, 0)) return true;
    int error = Marshal.GetLastWin32Error();
    if (error == 1168) return false;
    throw new Win32Exception(error);
  }
}
'@
switch ($request.action) {
  'read' {
    $entry = [AlloCredential]::Read($request.target)
    if ($null -eq $entry) { [Console]::Write('null') }
    else {
      [Console]::Write((@{ email = $entry[0]; token = $entry[1] } | ConvertTo-Json -Compress))
    }
  }
  'write' {
    [AlloCredential]::Write($request.target, $request.email, $request.token)
    [Console]::Write('null')
  }
  'delete' { [Console]::Write(([AlloCredential]::Delete($request.target) | ConvertTo-Json -Compress)) }
}
`

const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

async function manage(action, name, destination, values) {
  if (process.platform !== 'win32') {
    if (action === 'read') return null
    throw new AlloError('credential_store_unsupported', 'Saved login requires Windows Credential Manager')
  }
  const target = 'Allo/' + createHash('sha256').update(JSON.stringify([name, destination])).digest('hex')
  return new Promise((resolve, reject) => {
    const fail = () => reject(new AlloError('credential_store_failed', 'Windows Credential Manager could not complete the request', { action }))
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', code => {
      if (code !== 0) return fail()
      try {
        resolve(JSON.parse(output))
      } catch {
        fail()
      }
    })
    child.stdin.end(JSON.stringify({ action, target, ...values }))
  })
}

export const credentialStore = {
  read: (name, destination) => manage('read', name, destination),
  write: (name, destination, email, token) => manage('write', name, destination, { email, token }),
  delete: (name, destination) => manage('delete', name, destination),
}
