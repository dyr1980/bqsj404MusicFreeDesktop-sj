/**
 * TrackPlayer — 编排层（单例，唯一对外 API）
 *
 * 协调 AudioController、PlayQueue、LyricManager 三大子模块，
 * 通过 jotai atoms 驱动 UI，通过 AppSync 同步状态到辅助窗口和主进程。
 */
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import {
    PlayerState,
    RepeatMode,
    QUALITY_KEYS,
    LOCAL_PLUGIN_NAME,
    CLOUD_PLUGIN_NAME,
} from '@common/constant';
import { compositeKey, isSameMedia } from '@common/mediaKey';
import musicItemToSlim from '@common/musicItemToSlim';
import delay from '@common/delay';
import throttle from '@common/throttle';
import musicSheet from '@infra/musicSheet/renderer';
import pluginManager from '@infra/pluginManager/renderer';
import appConfig from '@infra/appConfig/renderer';
import cloudDisk from '@infra/cloudDisk/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import i18n from '@infra/i18n/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { isCoverAutoLoadEnabled } from '@renderer/common/coverLoad';
import { preloadDefaultCover } from '@renderer/common/defaultCoverImage';
import { switchItemsToSource, type TSourceSwitchKind } from '../sourceSwitch';
import localSource from '../localSource';
import { getSongCoverSync, normalizeCover } from '../artworkEdit';
import { addToRecentlyPlayed } from '../recentlyPlayed';
import { findNextSourceSequential, getSongGroupKey, getTogglePlugins } from '../sourceMatch';
import appSync from '@infra/appSync/renderer/main';
import { syncKV } from '@renderer/common/kvStore';
import { REPEAT_MODE_MAP } from '@renderer/common/repeatModeMap';
import { type IAudioController, createAudioController } from './audioController';
import PlayQueue from './playQueue';
import LyricManager from './lyricManager';
import type { IPlayOptions } from './types';
import {
    store,
    currentMusicAtom,
    playerStateAtom,
    repeatModeAtom,
    progressAtom,
    volumeAtom,
    speedAtom,
    qualityAtom,
    currentLyricAtom,
    currentSourceAtom,
    sourceSwitchAtom,
} from './store';

// ─── AppSync 桥接 ───

/**
 * 订阅 store → appSync 桥接。
 * 注意：这些 subscriptions 故意不清理——主窗口生命周期 === 应用生命周期，
 * store.sub 返回的 unsub 函数不需要调用。
 */
function setupAppSyncBridge(): void {
    // 计算当前歌曲是否已收藏
    const getIsFavorite = () => {
        const music = store.get(currentMusicAtom);
        return music ? musicSheet.isFavoriteMusic(music) : false;
    };

    /**
     * 同步给辅助窗口（歌词 / 迷你模式）的当前歌曲。
     *
     * 封面取「用户自定义优先」的最终结果——辅助窗口拿不到 mediaMeta，
     * 只能由主窗口把结果算好推过去。
     */
    const getSyncedMusic = (): IMusicItemSlim | null => {
        const music = store.get(currentMusicAtom);
        if (!music) return null;
        const custom = getSongCoverSync(music.platform, String(music.id));
        // 有自定义封面（含哨兵值）就按自定义来
        if (custom !== undefined) {
            // 哨兵值（使用默认封面图）会把自带封面也抹掉
            return { ...music, artwork: normalizeCover(custom) };
        }
        // 没有自定义封面：按「封面加载」策略决定要不要把网络封面推给辅助窗口
        return isCoverAutoLoadEnabled('song') ? music : { ...music, artwork: undefined };
    };

    store.sub(currentMusicAtom, () => {
        const music = store.get(currentMusicAtom);
        appSync.syncAppState({
            musicItem: getSyncedMusic(),
            isFavorite: getIsFavorite(),
        });

        // 自定义封面可能还没进 mediaMeta 缓存，拉一次再补推
        if (music) {
            void (async () => {
                try {
                    await mediaMeta.preload([{ platform: music.platform, id: String(music.id) }]);
                    appSync.syncAppState({ musicItem: getSyncedMusic() });
                } catch {
                    // 预加载失败就用当前封面，不影响播放
                }
            })();
        }
    });
    store.sub(playerStateAtom, () => {
        appSync.syncAppState({ playerState: store.get(playerStateAtom) });
    });
    store.sub(repeatModeAtom, () => {
        appSync.syncAppState({ repeatMode: store.get(repeatModeAtom) });
    });
    store.sub(volumeAtom, () => {
        appSync.syncAppState({ volume: store.get(volumeAtom) });
    });
    store.sub(currentLyricAtom, () => {
        const lyric = store.get(currentLyricAtom);
        appSync.syncAppState({ currentLrc: lyric?.currentLrc ?? null });
    });

    // 收藏状态变化时同步
    musicSheet.subscribeFavoriteChange(() => {
        appSync.syncAppState({ isFavorite: getIsFavorite() });
    });

    // 进度同步节流 1s——辅助窗口不需要实时精度
    const throttledProgressSync = throttle(
        (progress: { currentTime: number; duration: number }) => {
            appSync.syncAppState({ progress });
        },
        1000,
    );
    store.sub(progressAtom, () => {
        throttledProgressSync(store.get(progressAtom));
    });

    // 获取当前完整状态快照
    const getCurrentState = () => ({
        musicItem: getSyncedMusic(),
        playerState: store.get(playerStateAtom),
        repeatMode: store.get(repeatModeAtom),
        progress: store.get(progressAtom),
        currentLrc: store.get(currentLyricAtom)?.currentLrc ?? null,
        isFavorite: getIsFavorite(),
        volume: store.get(volumeAtom),
    });

    // 初始同步：store.sub 仅监听后续变化，此处补推一次当前状态
    appSync.syncAppState(getCurrentState());

    // 辅助窗口新订阅时，从 store（唯一 source of truth）定向推送
    appSync.onSubscribe((windowType) => {
        appSync.syncAppStateTo(windowType, getCurrentState());
    });
}

// ─── TrackPlayer ───

/**
 * 自动换源链的冷却时间：同一时间段内只允许发起一条换源链，
 * 避免错误事件密集触发多条链、并发向插件发起搜索。
 */
const AUTO_TOGGLE_COOLDOWN_MS = 2000;

/** 单条换源链内最多尝试「换源 + 播放」的次数（每个插件算一次） */
const AUTO_TOGGLE_MAX_PLAY_ATTEMPTS = 3;

/**
 * 云盘那一级确认「真的出声」的等待上限：
 * 文件在云盘上 ≠ 这份流播得出来（远端被改名/删除时是 404），
 * 不确认就会谎报「已切到云盘」然后把用户撂在无声状态。
 */
const CLOUD_SOURCE_VERIFY_MS = 4000;

/**
 * 「文件真值」索引（localSource）的等待上限。
 *
 * 该索引要异步 stat 每个候选文件才能建好；启动恢复播放跑得比它早，
 * 不等待就会漏掉本地音乐库里的文件，把本地播放掉到云端/插件。
 * 只在索引尚未就绪时才会真的等，且最多等这么久。
 */
const LOCAL_SOURCE_READY_MS = 3000;

/**
 * 「刚换源成功」的宽限窗口。
 *
 * 换源链报成功后紧接着又收到播放错误 → 说明换来的那份源其实是哑的。
 * 这个窗口内允许绕开冷却立刻再换一次（换源链会接着试下一个插件），
 * 而不是直接触发「跳到下一首」——那正是「点了歌却自己跳走」的来源。
 */
const TOGGLE_SUCCESS_GRACE_MS = 5000;

/**
 * 启动恢复上次播放时，单个异步步骤（取歌 / 取音源 / 取歌词）的超时时间。
 * 恢复是 best-effort：宁可不恢复，也不能让启动流程卡死。
 */
const RESTORE_STEP_TIMEOUT_MS = 8_000;

class TrackPlayer {
    private audioController!: IAudioController;
    private playQueue!: PlayQueue;
    private lyricManager!: LyricManager;

    // 进度持久化节流
    private lastProgressWriteTime = 0;
    private readonly PROGRESS_WRITE_INTERVAL = 10_000; // 10s

    // 连续播放错误计数
    private consecutiveErrors = 0;
    private readonly MAX_CONSECUTIVE_ERRORS = 3;

    /**
     * 自动换源状态。
     *
     * 以「歌名 + 歌手」作为歌曲组标识集合：换源后 id/platform 会变化、
     * 歌名/歌手也可能略有差异，只有用户主动切到另一首歌时才重置已尝试音源记录。
     */
    private autoToggleGroupKeys = new Set<string>();
    private autoToggleTried = new Set<string>();
    /** 自动换源链是否正在执行（防止多条失败路径并发触发互相干扰） */
    private isAutoToggling = false;
    /** 上次触发自动换源的时间戳（冷却用） */
    private lastAutoToggleAt = 0;
    /** 上次换源「报成功」的时间戳（用于识别「换来的源其实是哑的」） */
    private lastToggleSuccessAt = 0;

    /** 用户点了「停止换源」：中断换源链，并且不再自动跳下一首 */
    private autoToggleStopped = false;

    /**
     * 自动换源链的世代号：用户任何「主动接管播放」的动作（点歌、上一首/下一首、
     * 停止换源、改队列）都会让它 +1，在途的换源链随即作废。
     *
     * 没有这个的话会出现「我点了 B，播放的却是刚换源的 A」：
     * 换源链在插件搜索/替换队列期间用户点了别的歌，链子后段仍会把当前曲目掰回它自己那首
     * （replaceMusicInQueue 的 setQueue 会重写 currentIndex，随后 loadAndPlay 又强制切歌）。
     */
    private autoToggleEpoch = 0;

    /** 当前在跑的换源链所属世代号（-1 = 没有在跑）；用于区分「链自己的错误」和「用户那首的错误」 */
    private autoToggleChainEpoch = -1;

    /**
     * 最近一次装进播放器的音源属于哪首歌（platform\0id）。
     *
     * audio 的 error 事件是异步的：切歌瞬间，上一首/上一次取源的错误还会飘过来。
     * 只看「当前播的是哪首」会把这种残留错误算到用户刚点的那首歌头上，
     * 于是那首歌被误判成播放失败 → 直接跳下一首。
     */
    private lastSourceMediaKey: string | null = null;

    // ─── 启动恢复 ───

    async setup(): Promise<void> {
        // 0. 预热「默认封面位图」：没封面 / 关闭封面加载时，系统媒体控件（Windows 音量浮层）
        //    要显示与界面一致的默认封面。canvas 合成是异步的，先起一次避免第一首歌来不及。
        preloadDefaultCover();

        // 1. 创建子模块
        this.audioController = createAudioController('web-audio');
        this.playQueue = new PlayQueue();
        this.lyricManager = new LyricManager();

        // 2. 恢复持久化状态（localStorage 同步读取，首帧可用）
        const volume = syncKV.get('player.volume') ?? 1;
        const speed = syncKV.get('player.speed') ?? 1;
        const repeatMode = syncKV.get('player.repeatMode') ?? RepeatMode.Queue;
        const savedMusic = syncKV.get('player.currentMusic');
        const savedProgress = syncKV.get('player.currentProgress') ?? 0;

        // 启动音质以「设置 → 播放 → 默认播放音质」为准。
        //
        // 之前读的是 localStorage 里的 player.currentQuality，而那个值记录的是
        // 上次「实际拿到」的音质（可能已被回退），会导致每次启动都从用户配置之外
        // 的音质重新试一轮。用户手动切音质时 QualityPopover 会同步写入该配置，
        // 所以「记住上次选择」的行为不受影响。
        const configQuality = appConfig.getConfigByKey('playMusic.defaultQuality');
        const validQuality: IMusic.IQualityKey = QUALITY_KEYS.includes(configQuality as any)
            ? (configQuality as IMusic.IQualityKey)
            : 'standard';

        store.set(volumeAtom, volume);
        store.set(speedAtom, speed);
        store.set(repeatModeAtom, repeatMode);
        store.set(qualityAtom, validQuality);

        this.audioController.setVolume(volume);
        this.audioController.setSpeed(speed);

        // 3. 恢复播放队列（异步 IPC）
        await this.playQueue.setup();

        // 3.5 恢复 Shuffle 状态（纯内存导航，需在 setup 后重建）
        if (repeatMode === RepeatMode.Shuffle) {
            this.playQueue.enterShuffle();
        }

        // 4. 恢复当前歌曲
        //
        // ⚠️ 这里绝对不能 await 取音源：
        // bootstrapMainWindow 是 `await trackPlayer.setup()` 之后才 root.render 的，
        // 而插件取音源整条链（渲染进程 → IPC → 主进程 → 插件沙箱 → 插件内网络请求）
        // 没有任何超时保护。一旦插件接口挂死（死接口、挂住的系统代理等），
        // setup() 就永远不 resolve → 界面永远不渲染 → 只剩主题底色的「黑屏」。
        // 恢复上次播放本来就只是 best-effort，所以：后台执行 + 整体限时。
        if (savedMusic) {
            void this.restoreCurrentMusic(savedMusic, validQuality, savedProgress);
        }

        // 5. 绑定事件
        this.bindAudioEvents();
        this.bindAppSyncCommands();
        setupAppSyncBridge();
        this.bindMediaSession();

        // 6. beforeunload 兜底
        window.addEventListener('beforeunload', () => {
            syncKV.set('player.currentProgress', store.get(progressAtom).currentTime);
        });

        // 7. 恢复音频输出设备
        const device = appConfig.getConfigByKey('playMusic.audioOutputDevice');
        if (device?.deviceId) {
            this.audioController.setSinkId(device.deviceId).catch(() => {});
        }

        // 8. 监听配置变化
        appConfig.onConfigUpdated((patch) => {
            if ('playMusic.audioOutputDevice' in patch) {
                this.audioController
                    .setSinkId(patch['playMusic.audioOutputDevice']?.deviceId ?? '')
                    .catch(() => {});
            }
            // 打开「无歌词时自动搜索」时，对当前这首（已经试过的）歌再试一次，
            // 否则用户会以为开关没生效，得切歌才行
            if (patch['lyric.autoSearchLyric'] === true) {
                this.lyricManager.allowAutoSearchAgain();
                void this.refreshLyric();
            }
        });

        // 9. 监听音频输出设备断开
        navigator.mediaDevices.addEventListener('devicechange', async () => {
            try {
                const savedDevice = appConfig.getConfigByKey('playMusic.audioOutputDevice');
                if (!savedDevice?.deviceId || savedDevice.deviceId === 'default') return;

                await delay(100);
                const devices = await navigator.mediaDevices.enumerateDevices();
                const stillExists = devices.some(
                    (d) => d.kind === 'audiooutput' && d.deviceId === savedDevice.deviceId,
                );

                if (!stillExists) {
                    this.audioController.setSinkId('').catch(() => {});

                    const behavior =
                        appConfig.getConfigByKey('playMusic.whenDeviceRemoved') ?? 'play';
                    if (behavior === 'pause') {
                        this.pause();
                    }
                }
            } catch {
                /* enumerateDevices 失败时静默忽略 */
            }
        });
    }

    // ─── 播放控制 ───

    /** 播放指定位置；失败时按「播放失败时」配置回退 */
    async playIndex(
        index: number,
        options: IPlayOptions = { restartOnSameMedia: true },
    ): Promise<void> {
        if (this.playQueue.isEmpty) return;

        // 这是「用户主动点播」的统一入口（点歌 / 上下一首 / 换源后重播）：
        // 作废在途的换源链，别让它稍后把当前曲目掰回它自己那首；
        // 同时重新武装自动换源（用户换了一首歌 = 新的意图）
        this.takeOverPlayback();
        this.autoToggleStopped = false;

        const ok = await this.loadAndPlay(index, options);
        if (!ok) {
            this.audioController.reset();
            this.handlePlayError(this.playQueue.getCurrentMusic(), undefined);
        }
    }

    /**
     * 加载并播放指定位置（内部实现，实现见文件末尾「私有方法」区）。
     *
     * 与 playIndex 的区别：失败时静默返回 false，不触发 handlePlayError。
     * 自动换源链需要在一次尝试失败后自行决定「换下一个插件」还是「回退」，
     * 因此必须把错误处理的控制权留在调用方。
     */

    /** 播放单首歌曲（如不在队列则追加到队尾） */
    async playMusic(item: IMusic.IMusicItem): Promise<void> {
        const queueIndex = this.playQueue.findIndex(item);
        if (queueIndex !== -1) {
            await this.playIndex(queueIndex);
        } else {
            this.playQueue.append([item]);
            await this.playIndex(this.playQueue.queue.length - 1);
        }
    }

    /**
     * 替换队列并播放。统一接口，不区分本地/远程歌单。
     * @param list       歌曲列表（IMusicItem 或 IMusicItemSlim）
     * @param options.startItem    起始播放歌曲
     * @param options.fromSheetId  可选性能优化提示：若来自某本地歌单，主进程用 INSERT...SELECT
     */
    async playMusicWithReplaceQueue(
        list: (IMusic.IMusicItem | IMusicItemSlim)[],
        options?: { startItem?: IMedia.IMediaBase; fromSheetId?: string },
    ): Promise<void> {
        const startItem = options?.startItem;
        const startIndex = startItem ? list.findIndex((it) => isSameMedia(it, startItem)) : 0;

        // 换队列 = 用户接管：先作废在途的换源链，别让它在新队列上乱替换
        this.takeOverPlayback();

        this.playQueue.setQueue(list, {
            playIndex: Math.max(startIndex, 0),
            fromSheetId: options?.fromSheetId,
        });
        await this.playIndex(Math.max(startIndex, 0));
    }

    /** 手动切到下一首（与 repeatMode 无关，始终前进） */
    async skipToNext(): Promise<void> {
        this.autoToggleStopped = false;
        if (this.playQueue.isEmpty) {
            this.clearPlayback();
            return;
        }
        await this.playIndex(this.playQueue.getNextIndex());
    }

    /** 手动切到上一首（与 repeatMode 无关，始终后退） */
    async skipToPrev(): Promise<void> {
        this.autoToggleStopped = false;
        if (this.playQueue.isEmpty) {
            this.clearPlayback();
            return;
        }
        await this.playIndex(this.playQueue.getPrevIndex());
    }

    /** 下一首播放：将歌曲插入当前播放曲目之后 */
    addNext(items: (IMusic.IMusicItem | IMusicItemSlim)[]): void {
        this.playQueue.addNext(items);
    }

    /** 从队列中移除歌曲。若移除了当前正在播放的曲目，自动切到下一首或清空 */
    async removeMusic(targets: IMedia.IMediaBase | IMedia.IMediaBase[]): Promise<void> {
        const currentMusic = this.playQueue.getCurrentMusic();
        const currentIdx = this.playQueue.getCurrentIndex();
        const bases = Array.isArray(targets) ? targets : [targets];
        const wasCurrentRemoved =
            currentMusic != null && bases.some((t) => isSameMedia(t, currentMusic));

        // 改队列也算用户接管：在途的换源链会按旧队列的下标找歌，必须作废
        this.takeOverPlayback();
        this.playQueue.remove(targets);

        if (wasCurrentRemoved) {
            if (!this.playQueue.isEmpty) {
                // 有下一首：播放原位置（被删歌曲的后继者现在占据此位置）
                const nextIdx = Math.min(currentIdx, this.playQueue.queue.length - 1);
                await this.playIndex(nextIdx);
            } else {
                this.clearPlayback();
            }
        }
    }

    /**
     * 换源：替换播放队列中的歌曲（保持原有位置与当前播放位置）。
     *
     * 若被替换的歌曲正是当前播放歌曲，会重新加载新来源并继续播放，
     * 同时重置错误计数（换源成功即视为一次成功的播放尝试）。
     *
     * @param pairs   换源结果（old 为被替换歌曲，new 为匹配到的新歌曲）
     * @param options.silent 静默模式：替换当前播放歌曲后不自动重新播放
     *                       （由调用方显式调用 loadAndPlay 并自行处理失败）
     * @returns 实际替换的歌曲数
     */
    async replaceMusicInQueue(
        pairs: Array<{ old: IMedia.IMediaBase; new: IMusic.IMusicItem }>,
        options?: { silent?: boolean },
    ): Promise<number> {
        if (!pairs.length || this.playQueue.isEmpty) return 0;

        const replacementMap = new Map<string, IMusic.IMusicItem>();
        for (const pair of pairs) {
            const key = compositeKey(pair.old.platform, String(pair.old.id));
            if (!replacementMap.has(key)) replacementMap.set(key, pair.new);
        }

        const queue = this.playQueue.queue;
        const currentMusic = this.playQueue.getCurrentMusic();
        let applied = 0;
        let wasCurrentReplaced = false;

        const seen = new Set<string>();
        const nextQueue: IMusicItemSlim[] = [];
        for (const item of queue) {
            let target: IMusicItemSlim = item;
            const key = compositeKey(item.platform, String(item.id));
            const replacement = replacementMap.get(key);

            if (replacement) {
                const targetKey = compositeKey(replacement.platform, String(replacement.id));
                if (!seen.has(targetKey)) {
                    target = musicItemToSlim(replacement);
                    applied++;
                    if (currentMusic && isSameMedia(currentMusic, item)) {
                        wasCurrentReplaced = true;
                    }
                }
            }

            const targetKey = compositeKey(target.platform, String(target.id));
            if (seen.has(targetKey)) continue;
            seen.add(targetKey);
            nextQueue.push(target);
        }

        if (!applied) return 0;

        // 定位当前歌曲在新队列中的位置
        let anchor: IMedia.IMediaBase | null = currentMusic;
        if (wasCurrentReplaced && currentMusic) {
            anchor =
                replacementMap.get(compositeKey(currentMusic.platform, String(currentMusic.id))) ??
                null;
        }

        // 定位「替换后该播哪首」。
        //
        // 注意用的是「此刻正在播的那首歌」而不是方法开头那份快照：替换队列是异步的，
        // 期间用户可能已经点了别的歌。若还按快照把 currentIndex 掰回来，
        // 表现就是「我点了 B，结果播放的还是刚被换源的 A」。
        const liveCurrent = this.playQueue.getCurrentMusic();
        const userMovedOn =
            !!liveCurrent && !!currentMusic && !isSameMedia(liveCurrent, currentMusic);

        let newCurrentIndex = -1;
        if (liveCurrent) {
            // 用户已经切到别的歌（或本来就没被替换）→ 原样保留他那首
            newCurrentIndex = nextQueue.findIndex((it) => isSameMedia(it, liveCurrent));
        }
        if (newCurrentIndex < 0 && wasCurrentReplaced) {
            // 正在播的就是被替换的那首 → 跟到替换后的新条目上
            newCurrentIndex = nextQueue.findIndex((it) => isSameMedia(it, anchor!));
        }
        if (newCurrentIndex < 0 && !userMovedOn) {
            newCurrentIndex = Math.min(this.playQueue.getCurrentIndex(), nextQueue.length - 1);
        }
        if (newCurrentIndex < 0 && !userMovedOn && anchor) newCurrentIndex = 0;

        // 整体替换队列（乐观更新 + 持久化），并保持当前播放位置
        this.playQueue.setQueue(nextQueue, { playIndex: newCurrentIndex });

        if (wasCurrentReplaced && !options?.silent && !userMovedOn) {
            // currentMusicAtom 仍指向旧来源，playIndex 会识别为「换歌」并重新加载音源
            this.consecutiveErrors = 0;
            await this.playIndex(newCurrentIndex);
        }

        return applied;
    }

    pause(): void {
        this.audioController.pause();
    }

    resume(): void {
        if (!this.audioController.hasSource) {
            // 无音源（如恢复失败），尝试重新加载当前曲目
            const idx = this.playQueue.getCurrentIndex();
            if (idx >= 0) {
                this.playIndex(idx, { restartOnSameMedia: true }).catch(() => {});
            }
            return;
        }
        this.audioController.play();
    }

    togglePlayPause(): void {
        if (this.audioController.playerState === PlayerState.Playing) {
            this.pause();
        } else {
            this.resume();
        }
    }

    seekTo(seconds: number): void {
        this.audioController.seekTo(seconds);
    }

    /** 当前播放位置（秒） */
    getCurrentTime(): number {
        return store.get(progressAtom).currentTime;
    }

    // ─── 队列代理 ───

    getPlayQueue(): PlayQueue {
        return this.playQueue;
    }

    /** 当前播放的歌曲（同步取值，供空白处右键菜单之类的非 React 场景使用） */
    getCurrentMusic() {
        return this.playQueue.getCurrentMusic();
    }

    /** 重置播放器：清空当前播放状态 + 清空队列 */
    reset(): void {
        this.takeOverPlayback();
        this.clearPlayback();
        this.playQueue.clear();
    }

    // ─── 设置 ───

    setVolume(volume: number): void {
        this.audioController.setVolume(volume);
        // volumeChange 事件会自动更新 atom 和 localStorage
    }

    setSpeed(speed: number): void {
        this.audioController.setSpeed(speed);
    }

    async setQuality(quality: IMusic.IQualityKey): Promise<boolean> {
        const current = this.playQueue.getCurrentMusic();
        const prevQuality = store.get(qualityAtom);
        if (!current || quality === prevQuality) return true;

        const currentTime = store.get(progressAtom).currentTime;
        const wasPlaying = this.audioController.playerState === PlayerState.Playing;

        try {
            store.set(playerStateAtom, PlayerState.Buffering);

            const fullItem = await musicSheet.getRawMusicItem(current.platform, current.id);
            const musicItem = fullItem ?? (current as IMusic.IMusicItem);

            // 切换音质：仅在音质匹配时使用本地文件
            const localSource = await this.tryLocalSource(musicItem, quality);
            const cloudSource =
                localSource || this.isNativeLocalItem(musicItem)
                    ? null
                    : await this.tryCloudSource(musicItem);
            const pluginSource =
                localSource || cloudSource
                    ? null
                    : await pluginManager.adapters.getMediaSource({
                          hash: pluginManager.getPluginByPlatform(musicItem.platform)?.hash ?? '',
                          musicItem,
                          quality,
                          qualityOrder: QUALITY_KEYS,
                          qualityFallbackOrder: this.getQualityFallbackOrder(),
                      });
            const result = localSource ?? cloudSource ?? pluginSource;

            if (result?.url && this.isCurrentMusic(current)) {
                this.markSource(musicItem, result, localSource, cloudSource);
                this.applyTrackSource(result, musicItem);
                this.audioController.seekTo(currentTime);
                if (wasPlaying) this.audioController.play();
                store.set(qualityAtom, result.quality!);
                syncKV.set('player.currentQuality', result.quality!);
                return result.quality === quality;
            } else {
                // 切歌了或无结果，恢复原状态
                store.set(qualityAtom, prevQuality);
                store.set(playerStateAtom, wasPlaying ? PlayerState.Playing : PlayerState.Paused);
                return false;
            }
        } catch {
            // 切换失败，恢复原音质标记
            store.set(qualityAtom, prevQuality);
            store.set(playerStateAtom, wasPlaying ? PlayerState.Playing : PlayerState.Paused);
            return false;
        }
    }

    setRepeatMode(mode: RepeatMode): void {
        const prev = store.get(repeatModeAtom);

        if (mode === RepeatMode.Shuffle && prev !== RepeatMode.Shuffle) {
            this.playQueue.enterShuffle();
        } else if (prev === RepeatMode.Shuffle && mode !== RepeatMode.Shuffle) {
            this.playQueue.exitShuffle();
        }

        store.set(repeatModeAtom, mode);
        syncKV.set('player.repeatMode', mode);
    }

    toggleRepeatMode(): void {
        const current = store.get(repeatModeAtom);
        this.setRepeatMode(REPEAT_MODE_MAP[current].next);
    }

    /** 获取用户歌词偏移（秒） */
    getLyricOffset(): number {
        return this.lyricManager.getUserOffset();
    }

    /** 设置用户歌词偏移（秒），正值提前，负值延后 */
    setLyricOffset(offset: number): void {
        this.lyricManager.setUserOffset(offset);
    }

    /** 强制重新加载当前歌曲歌词（关联/取消关联歌词后调用） */
    async refreshLyric(): Promise<void> {
        const musicItem = store.get(currentMusicAtom);
        if (!musicItem) return;
        await this.lyricManager.refreshLyric(musicItem as IMusic.IMusicItem);
    }

    async setAudioOutputDevice(deviceId?: string): Promise<void> {
        await this.audioController.setSinkId(deviceId ?? '');
    }

    // ─── 私有方法 ───

    /**
     * 加载并播放指定位置（内部实现）。
     *
     * 与 playIndex 的区别：失败时静默返回 false，不触发 handlePlayError。
     * 自动换源链需要在一次尝试失败后自行决定「换下一个插件」还是「回退」，
     * 因此必须把错误处理的控制权留在调用方。
     *
     * @returns 是否成功加载音源并开始播放
     */
    private async loadAndPlay(index: number, options: IPlayOptions): Promise<boolean> {
        if (this.playQueue.isEmpty) return false;

        const queue = this.playQueue.queue;
        index = ((index % queue.length) + queue.length) % queue.length;

        const targetSlim = queue[index];

        // 相同歌曲处理
        if (this.playQueue.getCurrentIndex() === index && this.isCurrentMusic(targetSlim)) {
            if (options.restartOnSameMedia) this.audioController.seekTo(0);
            this.audioController.play();
            return true;
        }

        // 切歌
        this.playQueue.setCurrentIndex(index);
        store.set(currentMusicAtom, targetSlim);
        store.set(playerStateAtom, PlayerState.Buffering);
        // 音源状态跟着歌一起重置：不然状态条会继续显示上一首的音源
        store.set(currentSourceAtom, { kind: 'loading' });
        this.audioController.prepareTrack(targetSlim);
        this.resetProgress();

        try {
            // 从 SQLite 获取完整数据（一首，一次 IPC）
            const fullItem = await musicSheet.getRawMusicItem(targetSlim.platform, targetSlim.id);
            const musicItem: IMusic.IMusicItem = fullItem ?? (targetSlim as IMusic.IMusicItem);

            // 获取音源：本地文件 → 云盘同名文件 → 插件
            const quality = store.get(qualityAtom);
            const localSource = await this.tryLocalSource(musicItem);
            const cloudSource =
                localSource || this.isNativeLocalItem(musicItem)
                    ? null
                    : await this.tryCloudSource(musicItem);
            const pluginSource =
                localSource || cloudSource
                    ? null
                    : await pluginManager.adapters.getMediaSource({
                          hash: pluginManager.getPluginByPlatform(musicItem.platform)?.hash ?? '',
                          musicItem,
                          quality,
                          qualityOrder: QUALITY_KEYS,
                          qualityFallbackOrder: this.getQualityFallbackOrder(),
                      });
            const result = localSource ?? cloudSource ?? pluginSource;

            if (!result?.url) throw new Error('No media source');
            this.markSource(musicItem, result, localSource, cloudSource);
            if (!this.isCurrentMusic(targetSlim)) return true; // 加载期间已切歌，不算失败

            // 播放
            store.set(qualityAtom, result.quality ?? quality);
            this.applyTrackSource(result, musicItem);
            this.audioController.play();
            this.consecutiveErrors = 0; // 播放成功，重置错误计数

            this.setCurrentMusic(musicItem);
            syncKV.set('player.currentQuality', result.quality!);

            // 记录到最近播放（异步，不阻塞播放）
            addToRecentlyPlayed(musicItem).catch(() => {});

            // 异步丰富元数据（锦上添花，失败不影响播放）
            // 「封面加载」关掉歌曲封面时这一步也跳过：插件详情接口会带回新封面，
            // 请求本身 + 后续图片都是一笔流量。
            if (isCoverAutoLoadEnabled('song')) {
                pluginManager
                    .callPluginMethod({
                        platform: musicItem.platform,
                        method: 'getMusicInfo',
                        args: [musicItem],
                    })
                    .then((info) => {
                        if (info && typeof info === 'object' && this.isCurrentMusic(targetSlim)) {
                            const enriched = {
                                ...musicItem,
                                ...info,
                                platform: musicItem.platform,
                                id: musicItem.id,
                            };
                            this.setCurrentMusic(enriched, false);
                        }
                    })
                    .catch(() => {});
            }

            return true;
        } catch {
            return false;
        }
    }

    // ─── 事件绑定 ───

    private bindAudioEvents(): void {
        this.audioController.on('stateChange', (state) => {
            store.set(playerStateAtom, state);
            if (state === PlayerState.Paused) {
                syncKV.set('player.currentProgress', store.get(progressAtom).currentTime);
            }
        });

        this.audioController.on('timeUpdate', (progress) => {
            store.set(progressAtom, progress);
            this.lyricManager.updatePosition(progress.currentTime);

            // 每 10 秒写一次 localStorage，最大丢失 10 秒进度
            const now = Date.now();
            if (now - this.lastProgressWriteTime >= this.PROGRESS_WRITE_INTERVAL) {
                syncKV.set('player.currentProgress', progress.currentTime);
                this.lastProgressWriteTime = now;
            }
        });

        this.audioController.on('ended', async () => {
            this.resetProgress();
            const repeatMode = store.get(repeatModeAtom);
            if (repeatMode === RepeatMode.Loop) {
                // 自然播完 + 单曲循环 → 重播
                await this.playIndex(this.playQueue.getCurrentIndex(), {
                    restartOnSameMedia: true,
                });
            } else {
                // 自然播完 → 下一首（不用 skipToNext，因为它是手动操作语义）
                await this.playIndex(this.playQueue.getNextIndex());
            }
        });

        this.audioController.on('error', (_reason, _detail) => {
            // 错误归因：audio 的 error 事件可能来自「已经被换掉的音源」
            // （用户切歌的瞬间，上一首/上一次取源的错误才飘过来）。
            // 不核对「装进去的音源是哪首歌的」就会把它算到刚点的那首头上，
            // 直接触发回退逻辑把用户点的歌跳掉。
            const current = this.playQueue.getCurrentMusic();
            if (
                !current ||
                this.lastSourceMediaKey !== compositeKey(current.platform, current.id)
            ) {
                return;
            }
            this.handlePlayError(current, _detail);
        });

        this.audioController.on('volumeChange', (volume) => {
            store.set(volumeAtom, volume);
            syncKV.set('player.volume', volume);
        });

        this.audioController.on('speedChange', (speed) => {
            store.set(speedAtom, speed);
            syncKV.set('player.speed', speed);
        });
    }

    private bindAppSyncCommands(): void {
        appSync.onCommand('play/pause', () => this.togglePlayPause());
        appSync.onCommand('skip-next', () => this.skipToNext());
        appSync.onCommand('skip-previous', () => this.skipToPrev());
        appSync.onCommand('volume-up', () =>
            this.setVolume(Math.min(1, store.get(volumeAtom) + 0.05)),
        );
        appSync.onCommand('volume-down', () =>
            this.setVolume(Math.max(0, store.get(volumeAtom) - 0.05)),
        );
        appSync.onCommand('set-volume', (volume) => this.setVolume(volume));
        appSync.onCommand('set-progress', (seconds) => this.seekTo(seconds));
        appSync.onCommand('set-repeat-mode', (mode) => this.setRepeatMode(mode));
        appSync.onCommand('like/dislike', () => {
            const music = store.get(currentMusicAtom);
            if (!music) return;
            if (musicSheet.isFavoriteMusic(music)) {
                musicSheet.removeMusicFromFavorite(music);
            } else {
                musicSheet.addMusicToFavorite(music);
            }
        });
    }

    private bindMediaSession(): void {
        navigator.mediaSession.setActionHandler('nexttrack', () => this.skipToNext());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.skipToPrev());
        navigator.mediaSession.setActionHandler('play', () => this.resume());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
    }

    // ─── 错误处理 ───

    // 放在换源相关代码旁边更好读，故不遵循「public 必须在 private 之前」的排序规则
    // eslint-disable-next-line @typescript-eslint/member-ordering
    public stopAutoToggle(): void {
        // 真的把在途的换源链掐掉（不只是「不再跳下一首」）：
        // 否则链子稍后拿到结果仍会替换队列 + 强制切歌，把用户点的歌顶掉
        this.takeOverPlayback();
        this.autoToggleStopped = true;
        store.set(sourceSwitchAtom, {
            tried: [...this.autoToggleTried],
            total: getTogglePlugins(true).length,
            // 「已停止换源」而不是「换源失败」：这是用户主动叫停的
            result: { ok: false, aborted: true },
        });
    }
    private async handlePlayError(musicItem: IMusicItemSlim | null, _error?: any): Promise<void> {
        // 换源链正在跑 → 它仍是这次播放的主人：本次失败要么是链内部尝试引发的
        // （已由链自行处理），要么是同一个错误的重复事件（如 audio.onerror 与 playIndex catch
        // 各触发一次）。此时必须直接返回，否则会与换源链并发地「跳到下一首」，
        // 以及多条链同时向插件发起搜索（请求风暴）。
        //
        // 用户接管播放时会走 takeOverPlayback()，那里当场把 isAutoToggling 交还，
        // 所以这条判断不会把「用户那首歌的失败」也吞掉。
        if (this.isAutoToggling) return;

        this.resetProgress();
        this.consecutiveErrors++;

        // 取源失败：别一直挂着「获取音源中…」，退回「未知」；
        // 自动换源链一旦拿到能播的源，markSource 会把它覆盖成实际音源
        if (store.get(currentSourceAtom)?.kind === 'loading') {
            store.set(currentSourceAtom, null);
        }

        // 播放出错时重置音质为默认，避免因高音质源不可用导致连续失败
        store.set(qualityAtom, 'standard');
        syncKV.set('player.currentQuality', 'standard');

        const behavior = appConfig.getConfigByKey('playMusic.playError') ?? 'skip';

        // 上一次换源刚报成功就失败 → 那份源是哑的：绕开冷却立刻再换一次，
        // 让换源链接着试下一个插件，而不是直接跳到下一首
        if (Date.now() - this.lastToggleSuccessAt < TOGGLE_SUCCESS_GRACE_MS) {
            this.lastAutoToggleAt = 0;
        }

        // ── 自动换插件：优先把当前歌曲换到插件列表中下一个插件的结果 ──
        // 'toggle-replace' = 换源成功后再把各歌单里这条也改成新来源（可选行为）
        const isToggle = behavior === 'toggle' || behavior === 'toggle-replace';
        const writeBackToSheets = behavior === 'toggle-replace';
        if (isToggle && this.consecutiveErrors < this.MAX_CONSECUTIVE_ERRORS) {
            const current = this.playQueue.getCurrentMusic();
            if (current && current.platform !== LOCAL_PLUGIN_NAME) {
                const toggled = await this.runAutoToggleChain(current, { writeBackToSheets });
                // 换源成功且已重新开始播放
                if (toggled) return;
            }
        }

        // 用户点过「停止换源」：不再自动跳下一首，直接暂停等他处理
        if (this.autoToggleStopped) {
            store.set(playerStateAtom, PlayerState.Paused);
            return;
        }

        // 'toggle' / 'toggle-replace' 在无可换音源时沿用 'skip' 的回退策略
        const autoSkip = behavior === 'skip' || isToggle;

        if (
            autoSkip &&
            this.playQueue.queue.length > 1 &&
            this.consecutiveErrors < this.MAX_CONSECUTIVE_ERRORS
        ) {
            // 主路径：跳到下一首
            await delay(500);
            if (musicItem && this.isCurrentMusic(musicItem)) {
                await this.skipToNext();
            }
        } else if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
            // 安全兜底：连续多次失败，停止播放避免无限循环
            store.set(playerStateAtom, PlayerState.Paused);
            this.consecutiveErrors = 0;
        } else {
            // 单曲队列 / 非 skip 配置，暂停
            store.set(playerStateAtom, PlayerState.Paused);
        }
    }

    /**
     * 用户接管播放：作废在途的自动换源链，让它在下个检查点收手。
     *
     * 点歌 / 上一首下一首 / 停止换源 / 改队列都要调一次。除了「不许再抢当前曲目」，
     * 还要**当场交还所有权**：
     *   - 链子若还占着 `isAutoToggling`，用户新点的那首歌既不能自己换源（被挡），
     *     又会被回退逻辑当成「换源失败」直接跳下一首——就是「点了歌却跳到下一首」的来源
     *   - 冷却时间也要清掉，否则新歌的换源会因上一首的冷却被吞
     *   - 状态条立刻收回，别把上一首的换源进度挂在新歌上
     */
    private takeOverPlayback(): void {
        this.autoToggleEpoch++;
        this.isAutoToggling = false;
        this.lastAutoToggleAt = 0;
        this.lastToggleSuccessAt = 0;
        store.set(sourceSwitchAtom, null);
    }

    /**
     * 把音源装进播放器，并记下它是给哪首歌的。
     *
     * 记录用于 `bindAudioEvents` 里给 audio 的错误事件归因（见 lastSourceMediaKey）。
     */
    private applyTrackSource(
        result: IPlugin.IMediaSourceResult,
        musicItem: IMusic.IMusicItem,
    ): void {
        this.lastSourceMediaKey = compositeKey(musicItem.platform, musicItem.id);
        this.audioController.setTrackSource(result, musicItem);
    }

    /**
     * 等音频的起播反馈（目前只用于云盘那一级）。
     *
     * 文件在云盘上 ≠ 这份流播得出来：远端被改名/删除时是 404，
     * 不确认就会谎报「已切到云盘」然后把用户撂在无声状态。
     *
     * 插件那一级故意不用它：audio 的 error 事件可能是上一份源的残留，
     * 靠计时判断会把好好的候选误判成坏的、白换好几个插件。
     *
     * @returns playing = 真的出声了；error = 明确报错（这份源是坏的）；
     *          timeout = 到点还没出声（慢，但不一定是坏）
     */
    private waitForPlaying(timeoutMs: number): Promise<'playing' | 'error' | 'timeout'> {
        if (this.audioController.playerState === PlayerState.Playing) {
            return Promise.resolve('playing');
        }

        return new Promise<'playing' | 'error' | 'timeout'>((resolve) => {
            const finish = (result: 'playing' | 'error' | 'timeout') => {
                clearTimeout(timer);
                this.audioController.off('stateChange', onState);
                this.audioController.off('error', onError);
                resolve(result);
            };
            const onState = (state: PlayerState) => {
                if (state === PlayerState.Playing) finish('playing');
            };
            const onError = () => finish('error');
            const timer = setTimeout(() => finish('timeout'), timeoutMs);

            this.audioController.on('stateChange', onState);
            this.audioController.on('error', onError);
        });
    }

    /** 把当前歌曲加入自动换源的「歌曲组」（换源后歌名/歌手可能略有差异） */
    private markAutoToggleGroup(item: IMusic.IMusicItemBase): void {
        const key = getSongGroupKey(item);
        if (this.autoToggleGroupKeys.size > 0 && !this.autoToggleGroupKeys.has(key)) {
            // 用户切到了另一首歌 → 重置已尝试记录
            this.autoToggleGroupKeys.clear();
            this.autoToggleTried.clear();
        }
        this.autoToggleGroupKeys.add(key);
    }

    /**
     * 自动换插件：把当前播放失败的歌曲切换到插件列表中「下一个」可用音源。
     *
     * 关键设计（避免把主进程打爆）：
     *   - 逐个插件串行搜索（同一时刻只有一个请求），命中即用
     *   - 搜索过的插件立即计入「已尝试」，下次从下一个插件继续，不重复搜索
     *   - 以「歌名 + 歌手」为歌曲组标识累计记录，换源后 id/platform 变化不会导致重来
     *   - 链内播放失败不会触发 handlePlayError，由本方法决定继续换还是放弃
     *   - 冷却时间：避免错误事件密集触发多条换源链
     *
     * @param options.writeBackToSheets 「自动换插件（替换原歌单信息）」模式下为 true：
     *   换源成功后把各歌单里这条引用改成真正播通的来源（下次播放直接按新来源取源）
     * @returns 是否成功换源并重新开始播放
     */
    private async runAutoToggleChain(
        current: IMusicItemSlim,
        options?: { writeBackToSheets?: boolean },
    ): Promise<boolean> {
        if (this.isAutoToggling) return false;

        const now = Date.now();
        if (now - this.lastAutoToggleAt < AUTO_TOGGLE_COOLDOWN_MS) return false;
        this.lastAutoToggleAt = now;

        this.markAutoToggleGroup(current);
        this.autoToggleTried.add(current.platform);

        // 本次链的世代号：用户在任何一步接管播放（点歌 / 停止换源 / 改队列）都会让它失效
        const epoch = this.autoToggleEpoch;
        this.autoToggleChainEpoch = epoch;

        // 发布换源进度（状态条显示「正在换源…」）
        const toggleTotal = getTogglePlugins(true).length;
        const publishProgress = (trying?: string) => {
            store.set(sourceSwitchAtom, {
                tried: [...this.autoToggleTried],
                total: toggleTotal,
                trying,
            });
        };
        publishProgress();

        /** 用户已经接管播放（换源链必须立刻收手，不许再动当前曲目） */
        const takenOver = () => this.autoToggleEpoch !== epoch;

        /** 此刻播的还是 expect 这首歌吗（换源后 platform/id 会变，按歌名+歌手比对） */
        const stillOn = (expect: IMusicItemSlim | IMusic.IMusicItem) => {
            const nowPlaying = this.playQueue.getCurrentMusic();
            return !!nowPlaying && isSameMedia(nowPlaying, expect);
        };

        /** 这一步还该不该继续（用户没接管 + 还在放这首歌） */
        const aborted = (expect: IMusicItemSlim | IMusic.IMusicItem) =>
            takenOver() || !stillOn(expect);

        /**
         * 主动中止这次换源。
         *
         * 接管时状态条已经由 takeOverPlayback() 清空了，这里**不能再写**：
         * 用户新点的那首歌可能已经开始自己的换源并发布了进度，写一下会把它盖掉。
         * 只兜「没接管、但当前已经不是这首歌」这种情况下的进度残留。
         */
        const abortByTakeover = (): false => {
            if (!takenOver() && store.get(sourceSwitchAtom)) {
                store.set(sourceSwitchAtom, null);
            }
            return false;
        };

        this.isAutoToggling = true;
        try {
            let cur: IMusicItemSlim | null = current;
            let target: IMusic.IMusicItem = await this.resolveRawItem(current);

            for (let attempt = 0; attempt < AUTO_TOGGLE_MAX_PLAY_ATTEMPTS; attempt++) {
                if (!cur || aborted(cur)) return abortByTakeover();

                // 换源同样遵守「本地 → 云盘 → 插件」：先看云盘上有没有同一首歌。
                // 本地文件在 loadAndPlay 阶段已经试过（下载记录），这里只补云盘这一级。
                if (attempt === 0) {
                    const cloudSource = await this.tryCloudSource(target);
                    if (cloudSource?.url) {
                        if (aborted(cur)) return abortByTakeover();

                        // 云盘这一级也要确认流真的能用：文件在云盘上 ≠ 这份流播得出来
                        // （远端文件被改名/删除时返回 404，直接播会停在无声状态还谎报「已切到云盘」）
                        this.audioController.prepareTrack(target as IMusicItemSlim);
                        const pending = this.waitForPlaying(CLOUD_SOURCE_VERIFY_MS);
                        this.applyTrackSource(cloudSource, target);
                        this.audioController.play();
                        // 云盘这一级要真的出声才算数：远端文件被改名/删除时会 404，
                        // 直接当成功就会停在无声状态还显示「已切到云盘」。
                        // 只是起播慢（大文件走 WebDAV）不算坏——只有明确报错才放弃，
                        // 否则会把好好的云盘音源误判成不可用、平白换去插件
                        const verdict = await pending;
                        const playable = verdict !== 'error';

                        if (playable) {
                            if (aborted(cur)) return abortByTakeover();
                            store.set(qualityAtom, cloudSource.quality ?? store.get(qualityAtom));
                            this.consecutiveErrors = 0;
                            this.lastToggleSuccessAt = Date.now();
                            store.set(currentSourceAtom, {
                                kind: 'cloud',
                                quality: cloudSource.quality ?? undefined,
                            });
                            store.set(sourceSwitchAtom, {
                                tried: [...this.autoToggleTried],
                                total: toggleTotal,
                                // 状态条/toast 显示「云端」而不是内部平台名
                                result: { ok: true, platform: i18n.t('common.cloud') },
                            });
                            showToast(
                                i18n.t('playback.auto_toggle_source_success', {
                                    platform: i18n.t('common.cloud'),
                                }),
                            );
                            return true;
                        }
                        // 播不出来 → 掉到下面继续搜插件
                    }
                    // 云盘没命中也要确认用户没接管，再继续搜插件
                    if (aborted(cur)) return abortByTakeover();
                }

                const { candidate, searchedPlatforms } = await findNextSourceSequential(
                    target,
                    this.autoToggleTried,
                    { maxAttempts: AUTO_TOGGLE_MAX_PLAY_ATTEMPTS },
                );
                // 搜索过的插件一律计入已尝试，避免下一条链重复搜索同样的插件
                for (const platform of searchedPlatforms) {
                    this.autoToggleTried.add(platform);
                }
                publishProgress(searchedPlatforms[searchedPlatforms.length - 1]);
                // 没搜到：静默收尾（清掉进度，别把状态条挂在「正在换源」上）
                if (!candidate) return abortByTakeover();

                // 搜索期间用户已切歌 / 已点停止 → 放弃本次换源
                if (aborted(cur)) return abortByTakeover();

                // 静默替换：由本方法显式重新加载播放并能拿到成功/失败结果
                const applied = await this.replaceMusicInQueue(
                    [{ old: cur, new: candidate.item }],
                    { silent: true },
                );
                if (!applied) return abortByTakeover();

                // 替换是异步的，期间用户可能又点了别的歌 → 立刻收手，绝不强切
                if (aborted(candidate.item)) return abortByTakeover();

                // 按「候选在这条队列里的位置」加载，而不是 getCurrentIndex()：
                // 后者在队列刚被替换 / 用户切歌时未必指向候选，会把别人的歌顶掉
                const candidateIndex = this.playQueue.queue.findIndex((it) =>
                    isSameMedia(it, candidate.item),
                );
                if (candidateIndex < 0) return abortByTakeover();
                if (this.playQueue.getCurrentIndex() !== candidateIndex) return abortByTakeover();

                this.markAutoToggleGroup(candidate.item);

                const played = await this.loadAndPlay(candidateIndex, {
                    restartOnSameMedia: true,
                });
                if (played) {
                    // 加载期间用户抢走了播放 → 不算换源成功，也不再写结果
                    if (takenOver()) return abortByTakeover();
                    // 这一级是否真的能播不在这里靠计时判断：audio 的 error 事件可能是
                    // 上一份源的残留，等它会把好好的候选误判成坏的、白换好几个插件。
                    // 真播不出来时 error 会走 handlePlayError，那边看到「刚换源成功」
                    // 会立刻放行下一次换源（见 TOGGLE_SUCCESS_GRACE_MS）。
                    this.lastToggleSuccessAt = Date.now();
                    store.set(currentSourceAtom, {
                        kind: 'plugin',
                        platform: candidate.platform,
                        quality: store.get(qualityAtom),
                    });
                    store.set(sourceSwitchAtom, {
                        tried: [...this.autoToggleTried],
                        total: toggleTotal,
                        result: { ok: true, platform: candidate.platform },
                    });
                    showToast(
                        i18n.t('playback.auto_toggle_source_success', {
                            platform: candidate.platform,
                        }),
                    );
                    // 「替换原歌单信息」模式：把各歌单里这条引用改成真正播通的来源。
                    // 歌单里原本记的是**失败那条**的身份（批量切源改写过的还要还原回 origin），
                    // 所以 oldBase 取 originPlatform/originId。作品级状态（歌词偏移、
                    // 下载识别）都挂在作品键上，不随这次改写丢。
                    if (options?.writeBackToSheets) {
                        const originalBase = {
                            platform: current.originPlatform ?? current.platform,
                            id: current.originId ?? String(current.id),
                        };
                        const sheets = await musicSheet.replaceInAllSheets(
                            originalBase,
                            candidate.item,
                        );
                        console.log(
                            `[trackPlayer] 换源回写歌单：${originalBase.platform}/${originalBase.id} → ${candidate.item.platform}/${candidate.item.id}，命中 ${sheets} 个歌单`,
                        );
                    }
                    return true;
                }

                // 该音源同样无法播放 → 换到下一个插件继续尝试
                if (aborted(candidate.item)) return abortByTakeover();
                cur = this.playQueue.getCurrentMusic();
                target = candidate.item;
            }

            store.set(sourceSwitchAtom, {
                tried: [...this.autoToggleTried],
                total: toggleTotal,
                result: { ok: false },
            });
            return false;
        } finally {
            // 只有仍是「本次链」的所有者才复位：用户接管时所有权已经交还出去了，
            // 这之后可能已经有新链把它置为 true，不能被这条旧链关掉
            if (this.autoToggleChainEpoch === epoch) {
                this.isAutoToggling = false;
                this.autoToggleChainEpoch = -1;
            }
        }
    }

    /**
     * 读取歌曲的完整数据（失败时退回 slim 对象，保证换源搜索仍可进行）
     */
    private async resolveRawItem(item: IMusicItemSlim): Promise<IMusic.IMusicItem> {
        try {
            return (
                (await musicSheet.getRawMusicItem(item.platform, item.id)) ??
                (item as IMusic.IMusicItem)
            );
        } catch {
            return item as IMusic.IMusicItem;
        }
    }

    /**
     * 确认当前播放歌曲——更新 atom、持久化、加载歌词。
     * @param fetchLyric 默认 true；元数据更新时传 false 避免重复加载
     */
    private setCurrentMusic(musicItem: IMusic.IMusicItem, fetchLyric = true): void {
        store.set(currentMusicAtom, musicItemToSlim(musicItem));
        syncKV.set('player.currentMusic', musicItem);
        if (fetchLyric) {
            this.lyricManager.fetchLyric(musicItem);
        }
    }

    /** 清空播放状态（空队列等场景） */
    private clearPlayback(): void {
        this.audioController.reset();
        this.lyricManager.reset();
        this.lastSourceMediaKey = null;
        store.set(currentMusicAtom, null);
        store.set(currentSourceAtom, null);
        store.set(playerStateAtom, PlayerState.None);
        this.resetProgress();
        syncKV.remove('player.currentMusic');
    }

    private resetProgress(): void {
        store.set(progressAtom, { currentTime: 0, duration: Infinity });
        syncKV.remove('player.currentProgress');
    }

    private isCurrentMusic(item: IMedia.IMediaBase | null): boolean {
        return isSameMedia(store.get(currentMusicAtom), item);
    }

    /**
     * 启动时恢复上次播放的歌曲（best-effort）。
     *
     * 故意**不**被 setup() await：插件取音源没有可靠的超时保障，
     * 一旦挂死（死接口 / 挂住的系统代理 / 插件自身无超时），
     * await 它会让 bootstrap 永不完成、界面永不渲染（只剩底色的黑屏）。
     * 这里在后台执行，并给每个异步步骤加限时，超时只记一条 warn 就放弃。
     */
    private async restoreCurrentMusic(
        savedMusic: IMusic.IMusicItem,
        validQuality: IMusic.IQualityKey,
        savedProgress: number,
    ): Promise<void> {
        store.set(currentMusicAtom, musicItemToSlim(savedMusic));
        // 恢复播放同样从「获取音源中」开始，取到源后 markSource 会覆盖
        store.set(currentSourceAtom, { kind: 'loading' });
        let musicItem: IMusic.IMusicItem = savedMusic;

        try {
            const fullItem = await this.withTimeout(
                musicSheet.getRawMusicItem(savedMusic.platform, savedMusic.id),
                RESTORE_STEP_TIMEOUT_MS,
                'getRawMusicItem',
            );
            musicItem = fullItem ?? savedMusic;

            // 优先使用已下载的本地文件
            const localSource = await this.tryLocalSource(musicItem);
            const cloudSource =
                localSource || this.isNativeLocalItem(musicItem)
                    ? null
                    : await this.tryCloudSource(musicItem);
            const pluginSource =
                localSource || cloudSource
                    ? null
                    : await this.withTimeout(
                          pluginManager.adapters.getMediaSource({
                              hash:
                                  pluginManager.getPluginByPlatform(musicItem.platform)?.hash ?? '',
                              musicItem,
                              quality: validQuality,
                              qualityOrder: QUALITY_KEYS,
                              qualityFallbackOrder: this.getQualityFallbackOrder(),
                          }),
                          RESTORE_STEP_TIMEOUT_MS,
                          'getMediaSource',
                      );
            const result = localSource ?? cloudSource ?? pluginSource;

            if (result?.url && this.isCurrentMusic(savedMusic)) {
                // 恢复播放同样要设置系统媒体控件（Windows 音量浮层里的媒体卡片）的元数据：
                // 正常点播路径在 loadAndPlay 里做了这件事，恢复路径以前漏了 ——
                // 表现就是「开机直接恢复播放」时，媒体卡片只有应用名 MusicFree、没有歌名/封面。
                this.audioController.prepareTrack(musicItemToSlim(musicItem));
                this.markSource(musicItem, result, localSource, cloudSource);
                this.applyTrackSource(result, musicItem);
                this.audioController.seekTo(savedProgress);
                store.set(qualityAtom, result.quality!);
            }
        } catch (err: any) {
            // 恢复失败不影响启动：只记录，不抛出
            console.warn(
                `[trackPlayer] 恢复上次播放失败（已跳过）: ${musicItem.platform}/${musicItem.id}`,
                err?.message ?? err,
            );
        }

        // 加载歌词（同样限时，避免慢接口拖住后台任务）
        try {
            await this.withTimeout(
                this.lyricManager.fetchLyric(musicItem) as unknown as Promise<unknown>,
                RESTORE_STEP_TIMEOUT_MS,
                'fetchLyric',
            );
        } catch {
            // 歌词失败无所谓
        }
    }

    /** 给 Promise 加超时：超时抛错（调用方负责兜住） */
    private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            );
        });
    }

    /**
     * 记录实际命中的音源（驱动播放状态栏上方的音源条）。
     *
     * @param local 命中本地下载文件时传该结果
     * @param cloud 命中云盘同名文件时传该结果
     */
    private markSource(
        musicItem: IMusic.IMusicItem,
        result: IPlugin.IMediaSourceResult,
        local?: unknown,
        cloud?: unknown,
    ): void {
        // 本地音乐库里的条目由「本地插件」取流，也算本地音源，别显示成插件名
        const isLocal = !!local || this.isNativeLocalItem(musicItem);
        store.set(currentSourceAtom, {
            kind: isLocal ? 'local' : cloud ? 'cloud' : 'plugin',
            platform: !isLocal && !cloud ? musicItem.platform : undefined,
            quality: result.quality ?? undefined,
        });
    }

    /**
     * 把整个播放队列切到「本地」或「云盘」。
     *
     * 规则（按需求）：
     *   - 命中的：用该音源播放
     *   - **未命中的也一样把 platform 标成 本地 / 云盘**，只是 `sourceMatched = false`，
     *     列表里用亮/暗区分；播放时交给自动换源去找（按歌名+歌手搜插件）
     *   - 原始来源记在 `originPlatform` / `originId`，所以下载记录、手动关联的歌词、
     *     以及「还原来源」都还能反查
     *
     * @returns 队列总数 / 命中数 / 未命中数
     */
    // 与取源逻辑放在一起更好读，故不遵循「public 必须在 private 之前」的排序规则
    // eslint-disable-next-line @typescript-eslint/member-ordering
    public async switchQueueSource(
        kind: TSourceSwitchKind,
    ): Promise<{ total: number; matched: number; unmatched: number }> {
        // 整条队列换来源 = 用户接管：作废在途的换源链
        this.takeOverPlayback();

        const queue = this.playQueue.queue;
        if (queue.length === 0) return { total: 0, matched: 0, unmatched: 0 };

        // 匹配规则与单曲/批量换源的「本地 / 云端」完全一致，见 core/sourceSwitch
        const { items: next, matched } = await switchItemsToSource(queue, kind);

        this.playQueue.setQueue(next, { playIndex: this.playQueue.getCurrentIndex() });

        return { total: next.length, matched, unmatched: next.length - matched };
    }

    /**
     * 把整个队列里「被切到本地/云盘」的歌一次性还原回原始来源。
     *
     * 未切换过的歌（没有 originPlatform）原样保留。
     *
     * @returns 实际还原的歌曲数
     */
    // eslint-disable-next-line @typescript-eslint/member-ordering
    public restoreAllQueueSources(): number {
        this.takeOverPlayback();

        const queue = this.playQueue.queue;
        let restored = 0;

        const next = queue.map((item) => {
            if (!item.originPlatform) return item;
            restored++;
            return {
                ...item,
                platform: item.originPlatform,
                id: item.originId ?? String(item.id),
                originPlatform: undefined,
                originId: undefined,
                sourceMatched: undefined,
            } as IMusicItemSlim;
        });

        if (!restored) return 0;

        this.playQueue.setQueue(next, { playIndex: this.playQueue.getCurrentIndex() });
        return restored;
    }

    /**
     * 把队列里某首歌恢复到切换前的原始来源。
     */
    // eslint-disable-next-line @typescript-eslint/member-ordering
    public restoreQueueSource(target: IMusic.IMusicItemBase): boolean {
        this.takeOverPlayback();

        const queue = this.playQueue.queue;
        const idx = queue.findIndex((i) => isSameMedia(i, target));
        if (idx < 0) return false;

        const item = queue[idx];
        if (!item.originPlatform) return false;

        const next = [...queue];
        next[idx] = {
            ...item,
            platform: item.originPlatform,
            id: item.originId ?? String(item.id),
            originPlatform: undefined,
            originId: undefined,
            sourceMatched: undefined,
        } as IMusicItemSlim;

        this.playQueue.setQueue(next, { playIndex: this.playQueue.getCurrentIndex() });
        return true;
    }

    /**
     * 尝试使用云盘上的同名文件作为音源。
     *
     * 取源优先级：本地文件 → 云盘同名文件 → 插件（见 loadAndPlay / setQuality / restoreCurrentMusic）。
     * 匹配规则由主进程实现（歌手+歌名精确匹配，歌名唯一时也认）。
     *
     * @returns 命中时返回 { url }；云盘未配置/无同名文件/本身是云盘条目时返回 null
     */
    private async tryCloudSource(
        musicItem: IMusic.IMusicItem,
    ): Promise<IPlugin.IMediaSourceResult | null> {
        // 本身就是云盘条目 → 走插件取源即可，避免自我匹配
        if (musicItem.platform === CLOUD_PLUGIN_NAME) return null;
        if (!musicItem.title) return null;

        try {
            const url = await cloudDisk.resolveStreamUrl({
                title: musicItem.title,
                artist: musicItem.artist,
            });
            if (!url) return null;
            return { url, quality: 'standard' };
        } catch (err) {
            // 云盘不可用不应影响正常播放
            console.warn('[trackPlayer] 云盘取源失败（已忽略）:', err);
            return null;
        }
    }

    /**
     * 是不是「本地音乐库」里的原生条目。
     *
     * `platform === 本地` 有两种来源：
     *   - 本地扫描入库的真文件（原生条目）→ 它本身就是本地音源
     *   - 「批量切到本地」把未命中的队列项改写出来的（带 originPlatform）→ 其实没有本地文件
     *
     * 前者不该再去云盘拿「同名文件」顶掉本地那份（同名同歌手时就会变成「本地明明有
     * 却在放云盘」）；后者仍要按 本地 → 云盘 → 插件 的顺序继续找。
     */
    private isNativeLocalItem(musicItem: { platform: string; originPlatform?: string }): boolean {
        return musicItem.platform === LOCAL_PLUGIN_NAME && !musicItem.originPlatform;
    }

    /**
     * 尝试使用本地文件作为音源。
     *
     * 判定完全走**文件真值索引** `localSource`（下载记录 ∪ 本地音乐库 + 存在性校验）。
     * 与「📁✓ 已下载」图标、换源弹窗的「本地」判定共用同一个来源，三处不可能再算出
     * 不同答案 —— 以前取源只认下载记录，删掉记录（文件保留）后本地文件就被漏掉，
     * 按 `本地 → 云端 → 插件` 的顺序掉到云端同名文件上，表现就是「本地有文件却播云端」。
     *
     * 匹配口径见 `localSource`：主键 → 原始身份 → 作品键 → 歌名+歌手 → 歌名唯一兜底。
     * 下载记录只提供**登记音质**：切音质（`setQuality`）时音质未知的本地文件不参与匹配
     * —— 用户明确要换一份音质，未知音质满足不了这个要求。
     *
     * @returns 成功时返回 IMediaSourceResult；本地没有这份文件时返回 null
     */
    private async tryLocalSource(
        musicItem: {
            platform: string;
            id: string;
            originPlatform?: string;
            originId?: string;
            title?: string;
            artist?: string;
            localPath?: string;
        },
        targetQuality?: IMusic.IQualityKey,
    ): Promise<IPlugin.IMediaSourceResult | null> {
        // 索引要异步 stat 每个候选文件才能建好，启动恢复播放可能跑在它前面
        await localSource.whenReady(LOCAL_SOURCE_READY_MS);

        const entry = localSource.getEntry(musicItem);
        if (!entry?.path) return null;

        const quality = entry.quality ?? null;
        if (targetQuality && quality !== targetQuality) return null;

        // 索引里的路径在建索引时校验过；外部删文件不发事件，这里再确认一次
        if (!(await fsUtil.isFile(entry.path))) return null;

        return {
            url: fsUtil.addFileScheme(entry.path),
            quality: quality ?? store.get(qualityAtom),
        };
    }

    /** 获取音质回退策略，'skip' 降级为 'lower' */
    private getQualityFallbackOrder(): 'higher' | 'lower' {
        const config = appConfig.getConfigByKey('playMusic.whenQualityMissing');
        return config === 'higher' ? 'higher' : 'lower';
    }
}

// ─── 单例导出 ───

const trackPlayer = new TrackPlayer();
export default trackPlayer;
