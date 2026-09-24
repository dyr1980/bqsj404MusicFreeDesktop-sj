/**
 * LyricIcons — 「歌词管理」用的一组组合图标
 *
 * 六个语义（与弹窗里的状态列 / 操作列一一对应）：
 *   LocalLyricIcon      本地歌词   文件夹主图 + 文件右下角标（P2）
 *   CloudLyricIcon      云端歌词   应用那朵云 + 文件右下角标（K2）
 *   LinkLyricIcon       关联歌词   lucide link（A2）
 *   UnlinkLyricIcon     取消关联   lucide link + 一道 ↘ 斜线（S1）
 *   ViewLyricIcon       查看歌词   lucide file-search-corner + 三条横线（W2）
 *   DeleteCloudLyricIcon 删除云端 应用那朵云 + 缩小版 Trash2 右下角标（X3）
 *
 * 组合手法：后景图形被前景遮住的部分用 <mask> 抠掉一个 gap ——
 * 不靠背景色填充，所以悬停/选中底色上都干净。mask id 走 useId，
 * 同一个图标在列表里出现几百次也不会互相串。
 *
 * 路径数据取自 lucide 本体（folder / file-text / file-search-corner / trash-2 / link），
 * 云朵取自 SourceStateIcons，笔画风格与全应用一致。
 */

import { useId, type ReactNode } from 'react';

import { CLOUD_PATH, CLOUD_STROKE } from '../SourceStateIcons';

/** lucide folder */
const FOLDER_PATH =
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';

/** lucide file-text：文件本体 + 折角 + 三条横线 */
const FILE_DOC_PATH =
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z';
const FILE_CORNER_PATH = 'M14 2v5a1 1 0 0 0 1 1h5';

/** 文件（L1 样式） */
const fileNodes = (
    <>
        <path d={FILE_DOC_PATH} />
        <path d={FILE_CORNER_PATH} />
        <path d="M10 9H8" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
    </>
);

/** lucide trash-2 */
const trashNodes = (
    <>
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
);

/** lucide link（关联 / 取消关联共用同一条链） */
const linkNodes = (
    <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
);

/** 一层图形：变换 + 在 24 格里的缩放比（抹除笔画要按缩放补偿） */
interface IIconLayer {
    transform: string;
    scale: number;
    nodes: ReactNode;
}

interface IIconProps {
    size?: number | string;
    className?: string;
}

const LAYER_IDENTITY: IIconLayer = { transform: '', scale: 1, nodes: null };

/**
 * 组合图标：`back` 被 `front` 遮住的部分抠掉一个 gap。
 */
function ComposedIcon({
    size,
    back,
    front,
    gap = 1.2,
    className,
}: {
    size: number | string;
    back: IIconLayer;
    front: IIconLayer[];
    gap?: number;
    className?: string;
}) {
    const maskId = `lyric-icon-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32">
                    <rect x="-4" y="-4" width="32" height="32" fill="white" />
                    {front.map((layer, index) => (
                        <g
                            key={index}
                            transform={layer.transform}
                            fill="black"
                            stroke="black"
                            strokeWidth={2 + gap / layer.scale}
                        >
                            {layer.nodes}
                        </g>
                    ))}
                </mask>
            </defs>
            <g mask={`url(#${maskId})`}>
                <g transform={back.transform}>{back.nodes}</g>
            </g>
            {front.map((layer, index) => (
                <g key={index} transform={layer.transform}>
                    {layer.nodes}
                </g>
            ))}
        </svg>
    );
}

/** 单层图标 */
function PlainIcon({
    size,
    nodes,
    strokeWidth = 2,
    className,
}: {
    size: number | string;
    nodes: ReactNode;
    strokeWidth?: number;
    className?: string;
}) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            {nodes}
        </svg>
    );
}

/** 本地歌词：文件夹主图 + 文件右下角标（P2） */
export function LocalLyricIcon({ size = '100%', className }: IIconProps) {
    return (
        <ComposedIcon
            size={size}
            className={className}
            back={{ ...LAYER_IDENTITY, nodes: <path d={FOLDER_PATH} /> }}
            front={[
                { transform: 'translate(12.06 11.08) scale(0.56)', scale: 0.56, nodes: fileNodes },
            ]}
        />
    );
}

/** 云端歌词：云 + 文件右下角标（K2） */
export function CloudLyricIcon({ size = '100%', className }: IIconProps) {
    return (
        <ComposedIcon
            size={size}
            className={className}
            back={{
                ...LAYER_IDENTITY,
                nodes: <path d={CLOUD_PATH} strokeWidth={CLOUD_STROKE} />,
            }}
            front={[
                { transform: 'translate(12.36 11.28) scale(0.56)', scale: 0.56, nodes: fileNodes },
            ]}
        />
    );
}

/** 关联歌词：lucide link（A2） */
export function LinkLyricIcon({ size = '100%', className }: IIconProps) {
    return <PlainIcon size={size} nodes={linkNodes} className={className} />;
}

/** 取消关联：link + ↘ 斜线，交叉处留缝（S1） */
export function UnlinkLyricIcon({ size = '100%', className }: IIconProps) {
    return (
        <ComposedIcon
            size={size}
            className={className}
            back={{ ...LAYER_IDENTITY, nodes: linkNodes }}
            front={[{ ...LAYER_IDENTITY, nodes: <path d="M3 3 21 21" /> }]}
        />
    );
}

/** 查看歌词：file-search-corner + 三条横线（W2） */
export function ViewLyricIcon({ size = '100%', className }: IIconProps) {
    return (
        <PlainIcon
            size={size}
            className={className}
            nodes={
                <>
                    <path d="M11.1 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.589 3.588A2.4 2.4 0 0 1 20 8v3.25" />
                    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
                    <path d="M10 8H8" />
                    <path d="M16 11.5H8" />
                    <path d="M13 15H8" />
                    <path d="m21 22-2.88-2.88" />
                    <circle cx="16" cy="17" r="3" />
                </>
            }
        />
    );
}

/** 删除云端歌词：云 + 缩小版 Trash2 右下角标（X3） */
export function DeleteCloudLyricIcon({ size = '100%', className }: IIconProps) {
    return (
        <ComposedIcon
            size={size}
            className={className}
            back={{
                ...LAYER_IDENTITY,
                nodes: <path d={CLOUD_PATH} strokeWidth={CLOUD_STROKE} />,
            }}
            front={[
                { transform: 'translate(11.9 11.4) scale(0.52)', scale: 0.52, nodes: trashNodes },
            ]}
        />
    );
}
