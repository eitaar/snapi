import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../scripts/probe-auth-binding-http3.ps1', import.meta.url),
);

describe('probe-auth-binding-http3 PowerShell contract', () => {
  it('uses exact .NET HTTP/3 and only the fixed Messaging read allowlist', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('[CmdletBinding(PositionalBinding=$false)]');
    expect(script).toMatch(
      /\[Parameter\(ValueFromRemainingArguments=\$true\)\]\[object\[\]\]\$UnboundArguments/,
    );
    expect(script).toContain("$UnboundArguments.Count -gt 0");
    expect(script).toContain('System.Net.Http.HttpClient');
    expect(script).toMatch(/DefaultRequestVersion\s*=\s*\[Version\]::new\(3,\s*0\)/);
    expect(script).toContain('RequestVersionExact');
    expect(script).toContain('AllowAutoRedirect = $false');
    expect(script.indexOf('AllowAutoRedirect = $false')).toBeLessThan(
      script.indexOf('[System.Net.Http.HttpClient]::new'),
    );
    expect(script).toContain('DeltaSync');
    expect(script).toContain('BatchDeltaSync');
    expect(script).toContain('GetGroups');
    expect(script).toContain(
      'https://web.snapchat.com/web/version.json?version=8dd50222',
    );
    expect(script).toContain('messagingcoreservice.MessagingCoreService');
    expect(script).toContain('response.Version');
    expect(script).not.toContain('TryGetProperty');
    expect(script).toContain("if ($postStatus -lt 200 -or $postStatus -ge 300)");
  });

  it('emits only sanitized status JSON without credential or raw-response output', () => {
    const script = readFileSync(scriptPath, 'utf8');
    const resultBlock = script.match(/\$result = \[ordered\]@\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
    const resultKeys = [...resultBlock.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=/gm)].map(
      (match) => match[1],
    );

    expect(script).toContain('ConvertTo-Json -Compress');
    expect(resultKeys).toEqual([
      'authEpoch',
      'context',
      'operation',
      'endpointPath',
      'status',
      'protocol',
      'requestBodyBytes',
      'requestBodySha256',
      'safeHeaderNames',
      'transportError',
    ]);
    expect(script).toContain('safeHeaderNames');
    expect(script).toContain('requestBodySha256');
    expect(script).toContain('transportError');
    expect(resultBlock).not.toMatch(/authorization|cookie/i);
    expect(script).not.toMatch(/\bWrite-(?:Host|Output|Error|Warning|Verbose|Debug)\b/i);
    expect(script).not.toMatch(/\$\w*response\.(?:Content|Headers|ReasonPhrase)\b/i);
    expect(script).not.toMatch(/(?:ReadAsStringAsync|ReadAsByteArrayAsync|ReadAsStreamAsync)/i);
    expect(script).not.toMatch(/(?:Exception\.Message|\$_\.(?:Exception|Message|Error)|\$Error\b)/i);
  });

  it('uses exact HAR-only captured and static header allowlists with membership gates', () => {
    const script = readFileSync(scriptPath, 'utf8');
    const capturedHeaderNames = script.match(
      /\$AllowedCapturedHeaderNames\s*=\s*@\(([\s\S]*?)\n\)/,
    )?.[1].match(/'([^']+)'/g)?.map((name) => name.slice(1, -1));
    const staticHeaderNames = script.match(
      /\$StaticHeaders\s*=\s*\[ordered\]@\{([\s\S]*?)\n\}/,
    )?.[1].match(/'([^']+)'\s*=/g)?.map((name) => name.match(/'([^']+)'/)?.[1]);

    expect(capturedHeaderNames).toEqual([
      'authorization',
      'cookie',
      'x-snapchat-client',
      'x-snapchat-user-agent',
      'x-user-agent',
    ]);
    expect(staticHeaderNames).toEqual(['accept', 'content-type', 'x-grpc-web']);
    expect(script).toContain('$AllowedCapturedHeaderNames');
    expect(script).toContain('$StaticHeaders');
    expect(script).toContain("if ($headerName -in $AllowedCapturedHeaderNames)");
    expect(script).toContain("$safeHeaderNames = @($forwardedHeaders.Keys) + @($StaticHeaders.Keys)");
    expect(script).toContain('postData');
    expect(script).toContain("'content-type'");
    expect(script).not.toMatch(
      /(?:Get-Clipboard|Get-ItemProperty|Login Data|IndexedDB|Local State|WebSocket)/i,
    );
  });

  it('has exactly two public named parameters and rejects unbound arguments generically', () => {
    const script = readFileSync(scriptPath, 'utf8');
    const parameterBlock = script.match(/param\(([\s\S]*?)\n\)/)?.[1] ?? '';

    expect(parameterBlock).toContain('[string]$HarPath');
    expect(parameterBlock).toContain('[string]$AuthEpoch');
    expect(parameterBlock).toContain('$UnboundArguments');
    expect([...parameterBlock.matchAll(/\[string\]\$([A-Za-z]+)/g)].map((match) => match[1])).toEqual([
      'HarPath',
      'AuthEpoch',
    ]);
    expect(script).toMatch(/-Category\s+'invalid-input'/);
    expect(script).not.toMatch(/(?:Write-Error|throw\s+\$|\$PSCmdlet\.WriteError)/i);
  });
});
