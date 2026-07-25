/**
 * Type declarations for optional tool dependencies.
 * These packages are NOT required at runtime — tools that use them
 * gracefully report "not installed" if the import fails.
 */

declare module "tesseract.js" {
  export function createWorker(lang: string): Promise<{
    recognize: (image: string) => Promise<{ data: { text: string; confidence: number } }>;
    terminate: () => Promise<void>;
  }>;
}

declare module "playwright" {
  export const chromium: {
    launch: (opts?: { headless?: boolean }) => Promise<{
      newPage: () => Promise<unknown>;
      close: () => Promise<void>;
    }>;
  };
}

declare module "better-sqlite3" {
  export default class Database {
    constructor(path: string, opts?: { readonly?: boolean });
    prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
    transaction(fn: () => void): () => void;
    close(): void;
  }
}

declare module "adm-zip" {
  export default class AdmZip {
    constructor(input?: string | Buffer);
    addLocalFolder(path: string): void;
    addLocalFile(path: string): void;
    writeZip(dest: string): void;
    extractAllTo(dest: string, overwrite: boolean): void;
  }
}
