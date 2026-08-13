import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../scripts/probe-auth-binding-http3.ps1', import.meta.url),
);

describe('probe-auth-binding-http3 PowerShell contract', () => {
  it('uses exact .NET HTTP/3 and only the fixed Messaging read allowlist', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toMatch(/^param\(\)\r?\n/);
    expect(script).not.toContain('CmdletBinding');
    expect(script).not.toContain('UnboundArguments');
    expect(script).toContain('$args.Count -eq 4');
    expect(script).toContain('$args[$index]');
    expect(script).toContain("'-HarPath'");
    expect(script).toContain("'-AuthEpoch'");
    expect(script).toContain("[string]::Equals($option, '-HarPath', [StringComparison]::Ordinal)");
    expect(script).toContain("[string]::Equals($option, '-AuthEpoch', [StringComparison]::Ordinal)");
    expect(script).toContain('StartsWith');
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
    expect(script).toContain("'/web/version.json'");
    expect(script).toContain("'?version=8dd50222'");
    expect(script).toContain('$buildPinned');
    expect(script).not.toContain('$FixedVersionUrl');
    expect(script).toContain('messagingcoreservice.MessagingCoreService');
    expect(script).toContain('response.Version');
    expect(script).toContain("ToString('yyyy-MM-ddTHH:mm:ss.fffZ')");
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
      'startedAt',
      'protocol',
      'tokenEqualsEpochBaseline',
      'safeHeaderNames',
    ]);
    expect(script).toContain('$result.status');
    expect(script).toContain('$result.requestBodyBytes');
    expect(script).toContain('$result.requestBodySha256');
    expect(script).toContain('$result.transportError');
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
    const capturedHeaderBlock = script.match(
      /\$AllowedCapturedHeaderNames\s*=\s*@\(([\s\S]*?)\n\)/,
    )?.[1] ?? '';
    const capturedHeaderNames = [...capturedHeaderBlock.matchAll(/'([^']+)'/g)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    );
    const staticHeaderBlock = script.match(
      /\$StaticHeaders\s*=\s*\[ordered\]@\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    const staticHeaderNames = [...staticHeaderBlock.matchAll(/'([^']+)'\s*=/g)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    );

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
    expect(script).toContain("if ([string]::IsNullOrEmpty($forwardedHeaders['authorization']))");
    expect(script).not.toContain("-or\n        [string]::IsNullOrEmpty($forwardedHeaders['cookie'])");
    expect(script).toContain("$safeHeaderNames = @($forwardedHeaders.Keys) + @($StaticHeaders.Keys)");
    expect(script).toContain('postData');
    expect(script).toContain("'content-type'");
    expect(script).not.toMatch(
      /(?:Get-Clipboard|Get-ItemProperty|Login Data|IndexedDB|Local State|WebSocket)/i,
    );
    expect(script.match(/\$client\.Send\(/g) ?? []).toHaveLength(1);
  });

  it('has exactly two manually parsed named options and rejects malformed invocations offline', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script.startsWith('param()')).toBe(true);
    expect(script).toContain('$seenHarPath');
    expect(script).toContain('$seenAuthEpoch');
    expect(script).toContain('$harPath');
    expect(script).toContain('$authEpoch');
    expect(script).toMatch(/-Category\s+'invalid-input'/);
    expect(script).not.toMatch(/(?:Write-Error|throw\s+\$|\$PSCmdlet\.WriteError)/i);

    const malformedCases = [
      ['positional-one', 'positional-two'],
      ['-Unknown', 'value', '-AuthEpoch', 'epoch'],
      ['-harpath', 'path.har', '-authepoch', 'epoch'],
      ['-HARPATH', 'path.har', '-AUTHEPOCH', 'epoch'],
      ['-HarPath', 'first.har', '-HarPath', 'second.har'],
      ['-HarPath', '-AuthEpoch', 'epoch', 'extra'],
      ['-HarPath', 'path.har'],
      ['-HarPath', 'path.har', '-AuthEpoch'],
      ['-HarPath', 'path.har', '-AuthEpoch', '-next'],
      ['-HarPath', '', '-AuthEpoch', 'epoch'],
    ];

    for (const args of malformedCases) {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-File', scriptPath, ...args],
        { encoding: 'utf8' },
      );

      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toBe('');
      const outputLines = result.stdout.trim().split(/\r?\n/);
      expect(outputLines).toHaveLength(1);
      const outputLine = outputLines[0];
      if (outputLine === undefined) {
        throw new Error('expected one sanitized JSON output line');
      }
      expect(JSON.parse(outputLine)).toMatchObject({
        context: 'dotnet-http3',
        operation: 'messaging-read',
        transportError: 'other',
      });
    }

    const accepted = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-File', scriptPath, '-HarPath', 'path.har', '-AuthEpoch', 'epoch-1'],
      { encoding: 'utf8' },
    );
    expect(accepted.status).toBe(1);
    expect(accepted.stderr).toBe('');
    expect(JSON.parse(accepted.stdout.trim())).toMatchObject({
      transportError: 'other',
    });
  });
});
