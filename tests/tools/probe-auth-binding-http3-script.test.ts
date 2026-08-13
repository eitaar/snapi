import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../scripts/probe-auth-binding-http3.ps1', import.meta.url),
);

describe('probe-auth-binding-http3 PowerShell contract', () => {
  it('uses exact .NET HTTP/3 and only the fixed Messaging read allowlist', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('System.Net.Http.HttpClient');
    expect(script).toMatch(/DefaultRequestVersion\s*=\s*\[Version\]::new\(3,\s*0\)/);
    expect(script).toContain('RequestVersionExact');
    expect(script).toContain('DeltaSync');
    expect(script).toContain('BatchDeltaSync');
    expect(script).toContain('GetGroups');
    expect(script).toContain(
      'https://web.snapchat.com/web/version.json?version=8dd50222',
    );
    expect(script).toContain('messagingcoreservice.MessagingCoreService');
    expect(script).toContain('response.Version');
    expect(script).not.toContain('TryGetProperty');
  });

  it('emits only sanitized status JSON without credential or raw-response output', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('ConvertTo-Json -Compress');
    expect(script).toContain('safeHeaderNames');
    expect(script).toContain('requestBodySha256');
    expect(script).toContain('transportError');
    expect(script).not.toMatch(/\bWrite-(?:Host|Output|Error|Warning|Verbose|Debug)\b/i);
    expect(script).not.toMatch(/^\s*(?:Authorization|Cookie)\s*=/im);
    expect(script).not.toMatch(/\$response\.(?:Content|Headers)\b/i);
    expect(script).not.toMatch(/(?:Exception\.Message|\$_\.(?:Exception|Message))/i);
  });

  it('uses HAR-only credentials and static safe header allowlists', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('$AllowedCapturedHeaderNames');
    expect(script).toContain('$StaticHeaders');
    expect(script).toContain('postData');
    expect(script).not.toMatch(
      /(?:Get-Clipboard|Get-ItemProperty|Login Data|IndexedDB|Local State|WebSocket)/i,
    );
  });
});
