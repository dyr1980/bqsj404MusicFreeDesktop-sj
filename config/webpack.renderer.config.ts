import type { Configuration } from 'webpack';
import path from 'path';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

const rendererRules = [...rules];

rendererRules.push({
    test: /\.css$/,
    use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
});

rendererRules.push({
    test: /\.s[ac]ss$/,
    use: [{ loader: 'style-loader' }, { loader: 'css-loader' }, { loader: 'sass-loader' }],
});

rendererRules.push({
    test: /\.(png|jpe?g|gif|webp|ico)$/i,
    type: 'asset/resource',
});

// zxing-wasm 的 reader 模块：把 wasm 作为静态资源产出，运行时 fetch 成 ArrayBuffer
// 交给 zxing 实例化，不依赖 jsDelivr CDN（离线可用，也无需给渲染进程放行外域）
rendererRules.push({
    test: /\.wasm$/i,
    type: 'asset/resource',
});

export const rendererConfig: Configuration = {
    module: {
        rules: rendererRules,
    },
    plugins,
    resolve: {
        extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.sass'],
        alias: {
            '@renderer': path.join(__dirname, '../src/renderer'),
            '@assets': path.join(__dirname, '../src/assets'),
            // res/ 是主进程的运行时资源目录（forge 的 extraResource）。
            // 默认封面这类「主进程与渲染进程都要用」的素材只放这一份，
            // 避免两边各存一张、只更新了一张。
            '@res': path.join(__dirname, '../res'),
            '@common': path.join(__dirname, '../src/common'),
            '@infra': path.join(__dirname, '../src/infra'),
            '@appTypes': path.join(__dirname, '../src/types'),
        },
    },
};
