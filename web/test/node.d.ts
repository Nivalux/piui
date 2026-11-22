/**
 * The node runtime, seen from a project that refuses a dependency tree.
 *
 * `web/` is typechecked with `types: []`, so nothing here pulls in `@types/node`:
 * the handful of functions the tests actually call get the smallest declaration
 * that makes `tsc` happy.
 */

declare module "node:test" {
  type TestBody = () => void | Promise<void>;
  interface RunOptions {
    skip?: string | false;
  }
  export function test(name: string, body: TestBody): void;
  export function test(name: string, options: RunOptions, body: TestBody): void;
  export function describe(name: string, body: () => void): void;
  export function before(body: TestBody): void;
  export function after(body: TestBody): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
}

declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
  export function chmodSync(path: string, mode: number): void;
  export function writeFileSync(path: string | URL, data: string, encoding?: "utf8" | "base64"): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "node:child_process" {
  interface Stream {
    resume(): void;
  }
  interface ChildProcess {
    stdout: Stream | null;
    stderr: Stream | null;
    kill(): boolean;
  }
  export function spawn(
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string | undefined>; stdio: ["ignore", "pipe", "pipe"] },
  ): ChildProcess;
  export function spawnSync(
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ): { status: number | null; stderr: string };
}

declare module "node:module" {
  export function createRequire(importMetaUrl: string): (id: string) => any;
}

declare module "node:net" {
  interface AddressInfo {
    port: number;
  }
  interface Server {
    on(event: "error", listener: (error: unknown) => void): void;
    listen(port: number, host: string, onListening: () => void): void;
    address(): AddressInfo | string | null;
    close(onClosed: () => void): void;
  }
  export function createServer(): Server;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};
