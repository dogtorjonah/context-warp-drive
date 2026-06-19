declare module 'better-sqlite3' {
  namespace Database {
    interface Options {
      readonly?: boolean | undefined;
      fileMustExist?: boolean | undefined;
      timeout?: number | undefined;
      verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | undefined;
    }

    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement {
      run(...params: readonly unknown[]): RunResult;
      get(...params: readonly unknown[]): unknown;
      all(...params: readonly unknown[]): unknown[];
      pluck(toggle?: boolean): Statement;
    }

    interface Transaction<T extends (...args: never[]) => unknown> {
      (...params: Parameters<T>): ReturnType<T>;
    }

    interface Database {
      close(): void;
      exec(sql: string): this;
      loadExtension(extensionPath: string): this;
      pragma(source: string): unknown;
      prepare(sql: string): Statement;
      transaction<T extends (...args: never[]) => unknown>(fn: T): Transaction<T>;
    }
  }

  class Database {
    constructor(filename: string, options?: Database.Options);

    close(): void;
    exec(sql: string): this;
    loadExtension(extensionPath: string): this;
    pragma(source: string): unknown;
    prepare(sql: string): Database.Statement;
    transaction<T extends (...args: never[]) => unknown>(fn: T): Database.Transaction<T>;
  }

  export default Database;
}
