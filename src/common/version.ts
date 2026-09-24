/**
 * 版本号展示
 *
 * `package.json` 里必须写**合法 semver**，所以本变体（fork）标记 `sj` 放在预发布位：
 *   - `1.0.0-sj`：合法 semver；语义上是「1.0.0 的 sj 变体」；
 *   - 排序上 `1.0.0-sj` < `1.0.0`，所以原版的 1.0.0 会被判定为「更新」——这正是想要的；
 *   - 打包链路（electron-forge / electron-packager 写 exe 版本信息）、更新比较
 *     （semver.compare）都认它。之前用的 `1.0.0-beta.4` 同样是预发布，已验证能正常打包。
 *   不能直接写 `sjv1.0.0`：那不是合法 semver，会让版本比较与打包元数据出问题。
 *
 * 界面上**原样显示这份版本号**（只加一个应用惯例的 `v` 前缀）：
 *   `1.0.0-sj` → `v1.0.0-sj`
 * 这样「关于」页、package.json、插件拿到的 appVersion 三处完全一致，不会对不上。
 */

/** `1.0.0-sj` → `v1.0.0-sj` */
export function formatAppVersionDisplay(version: string): string {
    return `v${version}`;
}
