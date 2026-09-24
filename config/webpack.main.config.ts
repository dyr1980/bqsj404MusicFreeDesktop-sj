import type { Configuration } from 'webpack';
import path from 'path';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const mainConfig: Configuration = {
    /**
     * This is the main entry point for your application, it's the first file
     * that runs in the main process.
     */
    entry: {
        index: './src/main/index.ts',
        requestForwarderWorker: './src/infra/requestForwarder/worker.ts',
    },
    output: {
        filename: '[name].js',
    },
    // Put your normal webpack config below here
    module: {
        rules,
    },
    plugins,
    // 不打包进 bundle 的模块：
    //   sharp       —— 原生模块（N-API 预编译分发），必须保留为运行时 require
    //   node:sqlite —— Node/Electron 内置模块（Electron 自带 SQLite），由运行时提供
    //                  electron-main target 本就会外部化内置模块，这里显式写出避免被误打包
    externals: ['sharp', 'node:sqlite'],
    resolve: {
        extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json', '.node'],
        // music-metadata 等纯 ESM 包的 exports 只有 import 条件，
        // 而 electron-main + commonjs2 输出默认只匹配 require 条件，
        // 需要显式加入 import 才能正确解析这类包。
        conditionNames: ['node', 'import', 'require', 'default'],
        alias: {
            '@main': path.join(__dirname, '../src/main'),
            '@infra': path.join(__dirname, '../src/infra'),
            '@common': path.join(__dirname, '../src/common'),
            '@appTypes': path.join(__dirname, '../src/types'),
        },
    },
};
