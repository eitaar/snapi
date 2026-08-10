export interface CliIo {
  readonly version: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export function createProcessIo(version: string): CliIo {
  return {
    version,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}
