/**
 * 音量相关的共享逻辑
 *
 * 主窗口 PlayerBar 的音量气泡和迷你模式窗口的音量条都用这一份，
 * 避免同一个「按音量挑图标」的规则写两遍、两边不一致。
 */
import { Volume1, Volume2, VolumeX, type LucideIcon } from 'lucide-react';

/**
 * 按音量大小挑图标。
 *
 * @param volume 0~1
 *  - 0        静音
 *  - < 0.4    小音量
 *  - 其余     正常
 */
export function getVolumeIcon(volume: number): LucideIcon {
    if (volume === 0) return VolumeX;
    if (volume < 0.4) return Volume1;
    return Volume2;
}
