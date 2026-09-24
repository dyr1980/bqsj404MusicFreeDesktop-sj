/**
 * 事务工厂 —— 兼容 better-sqlite3 的 `db.transaction(fn)` 语义
 *
 * 为什么需要它：
 *   `node:sqlite` 没有 better-sqlite3 的 `transaction()` 辅助器，而项目里有 24 处
 *   `db.transaction(...)` 调用（迁移、歌单批量增删/排序、下载完成登记、本地扫描批量写入等），
 *   其中若干处是「把 db.transaction 当函数工厂用」——先拿到可复用函数、再传参调用。
 *
 * 语义对齐（与 better-sqlite3 保持一致）：
 *   1. 延迟开启事务：调用 `transaction(fn)` 时不开启，**返回的函数被调用时**才 BEGIN
 *   2. 返回的函数可复用，并原样透传参数与返回值
 *   3. 支持嵌套：内层用 SAVEPOINT 实现（better-sqlite3 的嵌套事务也是 savepoint 语义）
 *   4. 抛错即回滚，并把异常继续向上抛
 *   5. 全程同步（与 better-sqlite3 一致；不支持 async 事务函数）
 *
 * 性能注意：
 *   BEGIN/COMMIT/ROLLBACK/SAVEPOINT 全部**预编译一次**复用。
 *   `node:sqlite` 下用 `exec()` 每次重新解析这些语句时，1000 次小事务实测慢约 20 倍。
 *
 * 调用方必须保证连接已设置 `PRAGMA journal_mode = WAL` 与 `PRAGMA synchronous = NORMAL`
 * （见 `infra/database/main.ts`），否则每次提交都会 fsync，小事务会慢一个数量级。
 */
import type { DatabaseSync } from 'node:sqlite';

type AnyFn = (...args: any[]) => any;

export function createTransactionFactory(db: DatabaseSync) {
    const begin = db.prepare('BEGIN');
    const commit = db.prepare('COMMIT');
    const rollback = db.prepare('ROLLBACK');
    const savepoint = db.prepare('SAVEPOINT mf_sp');
    const release = db.prepare('RELEASE mf_sp');
    const rollbackTo = db.prepare('ROLLBACK TO mf_sp');

    /** 当前嵌套深度：0 = 没有活动事务 */
    let depth = 0;

    return function transaction<T extends AnyFn>(fn: T): (...args: Parameters<T>) => ReturnType<T> {
        return (...args: Parameters<T>): ReturnType<T> => {
            const nested = depth > 0;

            if (nested) {
                savepoint.run();
            } else {
                begin.run();
            }
            depth++;

            try {
                const result = fn(...args) as ReturnType<T>;
                depth--;
                if (nested) {
                    release.run();
                } else {
                    commit.run();
                }
                return result;
            } catch (err) {
                depth--;
                try {
                    if (nested) {
                        rollbackTo.run();
                        // ROLLBACK TO 之后仍需 RELEASE 才会真正结束这一层 savepoint，
                        // 但失败路径下直接释放即可（外层事务仍可继续或整体回滚）
                        release.run();
                    } else {
                        rollback.run();
                    }
                } catch {
                    // 回滚本身失败时不再掩盖原始异常
                }
                throw err;
            }
        };
    };
}
