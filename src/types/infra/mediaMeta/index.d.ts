/** per-item 附加元数据 */
export interface IMediaMeta {
    /** 下载信息（downloadManager 写入） */
    downloadData?: {
        /** 本地文件路径 */
        path: string;
        /** 下载音质 */
        quality: IMusic.IQualityKey;
        /**
         * 写入下载记录的时间（ms）。
         *
         * 单独存一份而不用 `media_meta.updated_at`：后者被任何 meta 写入都会刷新
         * （改歌词偏移、换封面…），拿它当「下载时间」会让列表里这条记录莫名跳位。
         * 老记录没有这个字段，读取方退回 `updated_at`。
         */
        at?: number;
    };
    /** 关联歌词（用户手动绑定 + 歌词文本缓存） */
    associatedLyric?: {
        /** 关联的歌词来源歌曲 */
        musicItem: IMusic.IMusicItem;
        /** 缓存的歌词文本 */
        rawLrc?: string;
        /** 翻译歌词 */
        translation?: string;
        /**
         * 关联来源。
         * - 'manual'：用户在「搜索歌词」里手动关联的 → 永远优先
         * - 'auto' / 缺省：自动搜索后缓存下来的 → 不能挡住本地 .lrc / 云盘歌词
         */
        source?: 'manual' | 'auto';
    };
    /** 用户设置的歌词时间偏移（秒），正值歌词提前，负值延后 */
    lyricOffset?: number;
    /**
     * 用户自定义封面（dataURL）。
     *
     * 播放界面右键封面 →「更换封面」写入；置空表示仍用歌曲自带封面。
     */
    artwork?: string;
}

/** setMeta patch 类型：null 表示删除该字段（RFC 7396） */
export type MediaMetaPatch = {
    [K in keyof IMediaMeta]?: IMediaMeta[K] | null;
};

/** meta 变更事件载荷 */
export interface IMediaMetaChangeEvent {
    platform: string;
    musicId: string;
    meta: IMediaMeta | null;
}

/**
 * 歌曲身份（算「作品键」用）。
 *
 * `platform + id` 是出处键（从哪儿取播放），同一首作品在不同插件下不同；
 * `title + artist` 归一化后得到作品键，与插件无关 —— 歌词偏移、关联歌词、
 * 下载记录、云盘已上传这些「作品级」状态都按它找。
 */
export interface IMediaIdentity {
    title?: string | null;
    artist?: string | null;
}

/**
 * mediaMeta 统一 DI 接口。
 *
 * 各消费模块（downloadManager / localMusic / pluginManager）
 * 注入同一个 provider 实例，按需使用其中的方法。
 */
export interface IMediaMetaProvider {
    /**
     * 更新 meta（RFC 7396 JSON Merge Patch）。
     *
     * @param identity 曲目的歌名/歌手（算作品键用）。主进程会先按 (platform, id)
     *   去 `music_items` 查；查不到（例如本地/云盘条目）就必须由调用方传进来，
     *   否则这条记录没有作品键，换个插件播同一首歌就找不回来。
     */
    setMeta(
        platform: string,
        musicId: string,
        patch: MediaMetaPatch,
        identity?: IMediaIdentity,
    ): void;

    /** 查询单条歌曲的下载信息 */
    getDownloadData(
        platform: string,
        musicId: string,
    ): { path: string; quality: IMusic.IQualityKey } | null;

    /** 获取所有已下载歌曲的下载信息（带歌名/歌手/作品键，供「同一首歌换了插件」的本地匹配） */
    getAllDownloaded(): Array<{
        platform: string;
        musicId: string;
        path: string;
        quality: IMusic.IQualityKey;
        title?: string;
        artist?: string;
        workKey?: string;
        /** 记录下载的时间（ms；老记录取 media_meta.updated_at 兜底，可能缺失） */
        downloadedAt?: number;
    }>;

    /** 通过下载路径反查原始歌曲的 platform + musicId */
    getMetaByDownloadPath(filePath: string): { platform: string; musicId: string } | null;

    /**
     * 按作品键（归一化 歌名|歌手）找一条**已知条目身份**。
     *
     * 供本地库文件解析身份用：同一首作品在哪个插件下被搜到过、留下过条目，
     * 就能挂到那个身份上，**不再依赖下载记录反查**。返回 null 表示这个作品
     * 库里从来没有过条目（纯本地文件）。
     */
    findIdentityByWorkKey(workKey: string): { platform: string; musicId: string } | null;

    /** 获取关联歌词信息 */
    getAssociatedLyric(platform: string, musicId: string): IMediaMeta['associatedLyric'] | null;
}
