/**
 * formatDateTime — 列表里的紧凑时间文本（「记录时间」列用）
 *
 * 规则（省宽度、又不产生歧义，按时间由近到远逐级加信息）：
 *  - 今天      → `HH:mm`
 *  - 今年      → `MM-DD HH:mm`
 *  - 更早/跨年 → `YYYY-MM-DD`
 *
 * 时间戳无效（0 / 空 / NaN）→ 返回空串，由调用方显示占位符。
 */
export default function formatDateTime(timestamp?: number | null): string {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
        return '';
    }

    const date = new Date(timestamp);
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    const isToday =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    if (isToday) return time;

    const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    if (date.getFullYear() === now.getFullYear()) return `${monthDay} ${time}`;

    return `${date.getFullYear()}-${monthDay}`;
}
