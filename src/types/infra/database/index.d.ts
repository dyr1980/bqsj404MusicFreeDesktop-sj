import type { DatabaseSync } from 'node:sqlite';

/**
 * 预编译语句。
 *
 * 为什么返回类型是宽松的（`any` / `number`）而不是直接用 `StatementSync`：
 *   `node:sqlite` 的 `get()` 返回 `Record<string, SQLOutputValue>`、`run()` 的
 *   `changes/lastInsertRowid` 是 `number | bigint`；而项目里沿用了 better-sqlite3 时代
 *   的写法（60+ 处 `db.prepare(...).all(...) as IXxx[]`、直接对 `changes` 做算术）。
 *   better-sqlite3 的这些方法返回 `any`，所以那些断言/运算本来就是合法的。
 *
 *   迁移目标是「行为等价、改动最小」，因此这里把签名放宽到与 better-sqlite3 一致，
 *   避免为了迁就类型而大改业务代码（类型更严格并不等于更安全）。
 */
export interface IDbStatement {
    /** 执行写入；返回受影响行数与自增主键（与 better-sqlite3 一致，均为 number） */
    run(...params: any[]): { changes: number; lastInsertRowid: number };
    /** 取一行（无结果时 undefined） */
    get(...params: any[]): any;
    /** 取多行 */
    all(...params: any[]): any[];
}

/**
 * 数据库连接 = `node:sqlite` 的 `DatabaseSync` + 两个 **better-sqlite3 兼容方法**。
 *
 * 兼容层（shim）存在的唯一目的：让项目里 24 处 `db.transaction(...)` 与
 * 几处 `db.pragma(...)` **一行都不用改**（实现见 `infra/database/main.ts` 的 `withCompat()`、
 * 事务实现见 `infra/database/transaction.ts`）。
 *
 * ⚠️ 注意：`transaction()` / `pragma()` **不是** `node:sqlite` 的原生 API。
 * 新写的代码建议直接用原生写法：`db.exec('PRAGMA …')`、`db.prepare('PRAGMA …').get()`。
 */
export type IDbCompat = Omit<DatabaseSync, 'prepare'> & {
    /** 覆盖为宽松语句类型（见 IDbStatement 的说明） */
    prepare(sql: string): IDbStatement;

    /** 事务工厂：语义与 better-sqlite3 的 `db.transaction` 一致（可复用、可传参、支持嵌套、抛错回滚） */
    transaction<T extends (...args: any[]) => any>(
        fn: T,
    ): (...args: Parameters<T>) => ReturnType<T>;

    /** PRAGMA 读写：`pragma('synchronous = NORMAL')` 写入；`pragma('user_version', { simple: true })` 读单值 */
    pragma(pragma: string, opts?: { simple?: boolean }): unknown;
};

/**
 * `db.transaction(fn)` 的返回值：一个可复用、可传参的事务函数。
 *
 * 用法与 better-sqlite3 完全一致：
 *   const tx = db.transaction((a, b) => { ... });
 *   tx(1, 2);   // 这里才真正 BEGIN … COMMIT
 */
export type IDbTransaction<F extends (...args: any[]) => any = (...args: any[]) => any> = (
    ...args: Parameters<F>
) => ReturnType<F>;

/**
 * 数据库提供者接口。
 * 其他 infra 模块通过 setup(dbProvider) 注入此接口来获取 DB 连接。
 */
export interface IDatabaseProvider {
    /** 获取数据库连接（Electron 内置 node:sqlite + 兼容方法） */
    getDatabase(): IDbCompat;

    /** 关闭数据库连接。应在应用退出时最后调用。 */
    dispose(): void;
}
