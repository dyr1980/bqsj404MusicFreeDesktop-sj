declare module '*.svg?url' {
    const content: string;
    export default content;
}

declare module '*.png' {
    const content: string;
    export default content;
}

declare module '*.jpg' {
    const content: string;
    export default content;
}

declare module '*.ico' {
    const content: string;
    export default content;
}

/** webpack asset/resource 会把 wasm 变成可 fetch 的 URL */
declare module '*.wasm' {
    const content: string;
    export default content;
}
