/**
 * TrackPlayer — jotai atoms + AppSync 桥接
 */
import { atom, getDefaultStore, type PrimitiveAtom } from 'jotai';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { PlayerState, RepeatMode } from '@common/constant';
import type { ICurrentLyric, ICurrentSource, ISourceSwitchState } from './types';

const store = getDefaultStore();

// ─── Atoms ───

export const currentMusicAtom: PrimitiveAtom<IMusicItemSlim | null> = atom(
    null as IMusicItemSlim | null,
);
export const musicQueueAtom: PrimitiveAtom<IMusicItemSlim[]> = atom<IMusicItemSlim[]>([]);
export const playerStateAtom: PrimitiveAtom<PlayerState> = atom<PlayerState>(PlayerState.None);
export const repeatModeAtom: PrimitiveAtom<RepeatMode> = atom<RepeatMode>(RepeatMode.Queue);
export const progressAtom: PrimitiveAtom<{ currentTime: number; duration: number }> = atom<{
    currentTime: number;
    duration: number;
}>({
    currentTime: 0,
    duration: Infinity,
});
export const volumeAtom: PrimitiveAtom<number> = atom<number>(1);
export const speedAtom: PrimitiveAtom<number> = atom<number>(1);
export const qualityAtom: PrimitiveAtom<IMusic.IQualityKey> = atom<IMusic.IQualityKey>('standard');
export const currentLyricAtom: PrimitiveAtom<ICurrentLyric | null> = atom(
    null as ICurrentLyric | null,
);
export const associatedLyricAtom: PrimitiveAtom<IMusic.IMusicItem | null> = atom(
    null as IMusic.IMusicItem | null,
);

/** 当前实际音源（本地 / 云盘 / 插件），驱动播放状态栏上方的音源条 */
export const currentSourceAtom: PrimitiveAtom<ICurrentSource | null> = atom(
    null as ICurrentSource | null,
);

/** 自动换源进度（非空 = 正在换源 / 刚出结果） */
export const sourceSwitchAtom: PrimitiveAtom<ISourceSwitchState | null> = atom(
    null as ISourceSwitchState | null,
);

export { store };
