declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): void;
      get(...values: unknown[]): object | undefined;
      all(...values: unknown[]): object[];
    };
    close(): void;
  }
}
