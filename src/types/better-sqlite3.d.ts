declare module 'better-sqlite3' {
  namespace Database {
    interface Statement {
      run(...params: readonly unknown[]): unknown;
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
      pragma(source: string): unknown;
      prepare(sql: string): Statement;
      transaction<T extends (...args: never[]) => unknown>(fn: T): Transaction<T>;
    }
  }

  interface DatabaseConstructor {
    new(filename: string): Database.Database;
    (filename: string): Database.Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
