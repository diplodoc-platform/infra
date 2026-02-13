declare module 'esbuild' {
    import {sassPlugin} from 'esbuild-sass-plugin';

    export * from 'esbuild';
    export {sassPlugin};
}
