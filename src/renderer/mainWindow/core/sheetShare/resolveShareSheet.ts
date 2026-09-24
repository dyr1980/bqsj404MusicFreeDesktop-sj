/**
 * 分享数据源 —— 把「歌单」解析成可直接编码的 SheetLike
 *
 * 歌单详情页手里就有 musicList，但侧边栏右键分享时歌单并没有被打开，
 * 内存里没有歌曲列表，必须按歌单来源分别取：
 *   - 本地歌单：歌曲就在本地库里，按 ID 读一次即可
 *   - 收藏的远程歌单：回插件按页拉取（与 SheetPage 的 useSheetDetail 同一接口）
 */
import musicSheet from '@infra/musicSheet/renderer';
import pluginManager from '@infra/pluginManager/renderer';
import type { SheetLike } from './codec';

/**
 * 远程歌单最多拉取的页数。
 *
 * 分享长图会把整张歌单画进一张 canvas，页数不设上限时超大歌单会拖住渲染；
 * 20 页（约千首）已远超长图的可读范围，再多长图本身也会截断并提示。
 */
const MAX_REMOTE_PAGES = 20;

/**
 * 取整张歌单的公共 platform。
 *
 * 编码格式里「与歌单 platform 相同」的歌不再逐条存 platform，
 * 来源一致时能省下每首一截体积；来源混杂时宁可不省，也不能写错。
 */
function commonPlatform(list: NonNullable<SheetLike['musicList']>): string | undefined {
    const first = list[0]?.platform;
    if (!first) return undefined;
    return list.every((item) => item?.platform === first) ? first : undefined;
}

/**
 * 本地歌单 → 分享数据（纯本地读取，不发起网络请求）
 *
 * @param sheetTitle 展示用标题。收藏夹要传 i18n 后的「我喜欢」，不能直接用库里存的名字。
 */
export async function resolveLocalShareSheet(
    sheetId: string,
    sheetTitle: string,
): Promise<SheetLike> {
    const list = await musicSheet.getSheetMusicList(sheetId);
    const meta = musicSheet.getAllSheets().find((sheet) => sheet.id === sheetId);

    return {
        title: sheetTitle,
        platform: commonPlatform(list),
        artwork: meta?.artwork ?? meta?.latestArtwork ?? undefined,
        description: meta?.description ?? undefined,
        musicList: list,
    };
}

/**
 * 远程（收藏的）歌单 → 分享数据
 *
 * 逐页调用 getMusicSheetInfo 直到插件报 isEnd，
 * 同时把每页返回的 sheetItem 元数据合并进来（标题/封面可能只在详情里才有）。
 */
export async function resolveRemoteShareSheet(
    sheetItem: IMusic.IMusicSheetItem,
): Promise<SheetLike> {
    let merged = sheetItem;
    const musicList: NonNullable<SheetLike['musicList']> = [];

    for (let page = 1; page <= MAX_REMOTE_PAGES; page += 1) {
        const result = await pluginManager.callPluginMethod({
            platform: sheetItem.platform,
            method: 'getMusicSheetInfo',
            args: [merged, page],
        });

        if (result?.sheetItem) {
            merged = { ...merged, ...result.sheetItem };
        }

        const pageList = result?.musicList ?? [];
        musicList.push(...pageList);

        // isEnd 缺省按「已结束」处理（与 useSheetDetail 保持一致）；
        // 空页同样中断，避免插件始终回 isEnd:false 时死循环
        if (!pageList.length || (result?.isEnd ?? true)) break;
    }

    return {
        title: merged.title,
        artist: merged.artist,
        platform: merged.platform,
        artwork: merged.artwork,
        description: merged.description,
        musicList,
    };
}
