// 基于上游 c7b6fa5 的 vite.config.ts，唯一改动是 workbox 的预缓存范围。
//
// ⚠️ 这是整文件覆盖：上游以后改了这个文件，必须把改动合并进来，否则会被本文件盖掉。
import react from "@vitejs/plugin-react-swc";
import { promises as fs } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
// import mkcert from "vite-plugin-mkcert";
import { VitePWA } from "vite-plugin-pwa";
import { viteStaticCopy } from "vite-plugin-static-copy";

const backend = "http://localhost:5212";
const backendProxyOption = { target: backend, headers: { host: new URL(backend).host } };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: "auto",
      manifest: false,
      workbox: {
        /**
         * 只预缓存「首屏真的会用到」的资源。
         *
         * 上游把全部 chunk 都塞进预缓存（maximumFileSizeToCacheInBytes 还放到了
         * 10MB），连 ts.worker(4.8MB)、excalidraw(4.2MB)、monaco(3.9MB)、
         * mermaid(3.4MB)、Lightbox(2.3MB)、codemirror(1.6MB) 都在内 —— 首次访问
         * 会在后台悄悄下二十多 MB，抢首屏带宽和 CPU，手机上尤其明显。
         *
         * 这些都是「点开某个文件才按需加载」的分片，走普通网络请求即可，
         * 不需要离线可用。排除后预缓存降到几 MB。
         */
        globIgnores: [
          "**/*leaflet*",
          "**/*mapbox*",
          "**/*Leaflet*",
          "**/*Mapbox*",
          "**/ts.worker-*",
          "**/css.worker-*",
          "**/html.worker-*",
          "**/json.worker-*",
          "**/editor.worker-*",
          // 大小写都要写：rollup 的 chunk 名有时是 `MonacoEditor-`、`Excalidraw-`
          // （大驼峰来自组件名），glob 在 Linux 上区分大小写
          "**/monaco-*",
          "**/MonacoEditor-*",
          "**/excalidraw-*",
          "**/Excalidraw-*",
          "**/ImageEditor-*",
          "**/mermaid-*",
          "**/codemirror-*",
          "**/Lightbox-*",
          "**/Artplayer-*",
          "**/Editor-*",
          // 管理后台只在进 /admin 时才加载，普通用户完全用不到，别预缓存（720KB）
          "**/AdminBundle-*",
        ],
        // 兜底：以后再有新的超大文件也不会被无意塞进预缓存
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        /**
         * 新 SW 直接接管，不等页面点「刷新」。
         *
         * 上游是 `registerType: "prompt"`：新版本装好后进入 waiting，要页面里的
         * 「有新版本，刷新？」提示来触发 skipWaiting。问题是**页面一旦崩了就永远
         * 弹不出那个提示** —— 2026-10-26 那次白屏，坏版本连同 index.html 被一起
         * 预缓存，用户每次打开都拿到坏的，又没法升级，只能 Ctrl+F5。死锁。
         *
         * 注意这里**不开 clientsClaim**：老页面继续由老 SW 控制，它懒加载的旧分片
         * 仍然由老 SW 的预缓存供给（新部署里那些文件已经没了，claim 过去就会 404）。
         * 只让新 SW 在后台激活，用户下一次打开自然就是新版本。
         */
        skipWaiting: true,
        navigateFallbackDenylist: [/^\/pdfviewer.html/, /^\/api\/(.+)/, /^\/f\/(.+)/, /^\/s\/(.+)/],
      },
      devOptions: {
        enabled: true,
      },
    }),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/pdfjs-dist/build/*.mjs",
          dest: "assets/pdfjs",
        },
      ],
    }),
    {
      name: "load-stylesheet-async",
      transformIndexHtml(html) {
        return html.replace(
          /<link rel="stylesheet" crossorigin href="(.+?)">/g,
          `<link rel="stylesheet" crossorigin href="$1" media="print" onload="this.media='all'">`,
        );
      },
    },
    {
      name: "generate-version",
      async writeBundle(outputOptions) {
        const version = {
          name: process.env.npm_package_name,
          version: process.env.npm_package_version,
        };
        const path = resolve(__dirname, outputOptions.dir, "version.json");
        await fs.writeFile(path, JSON.stringify(version));
      },
    },
    // mkcert({
    //   hosts: ["devv5.cloudreve.org"],
    // }),
  ],
  define: {
    __ASSETS_VERSION__: JSON.stringify(process.env.npm_package_version),
  },
  build: {
    outDir: "build", // keep same as v3 with minimal changes
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          const chunkMap = {
            common: [
              "vite/preload-helper",
              "vite/modulepreload-polyfill",
              "vite/dynamic-import-helper",
              "commonjsHelpers",
              "commonjs-dynamic-modules",
              "__vite-browser-external",
            ],
            monaco: ["monaco-editor"],
            codemirror: ["@codemirror"],
            excalidraw: [
              "node_modules/@excalidraw",
              "node_modules/browser-fs-access",
              "node_modules/image-blob-reduce",
              "node_modules/pica/",
            ],
            mermaid: ["node_modules/mermaid", "node_modules/katex"],
            leaflet: ["node_modules/leaflet", "node_modules/react-leaflet"],
            // ⚠️ 别打 MUI / Emotion / react-router 这些的主意（2026-10-26 线上事故）：
            // 拆成独立 chunk 后它们与下面的 `react` 分片形成**循环依赖** ——
            // `node_modules/react-*` 里有的包用 @emotion，于是 react 分片依赖
            // emotion 分片、emotion 分片又依赖 react 分片，rollup 只能挑一个顺序，
            // 结果 emotion 先执行、拿到的 react 命名空间还没初始化：
            //   Uncaught TypeError: Cannot read properties of undefined (reading 'ForwardRef')
            // 全站白屏。想省复访带宽就整块 vendor 一起切（react + mui + emotion
            // 同一个 chunk），别拆细。
            react: ["node_modules/react", "node_modules/react-dom"],
            mapbox: ["node_modules/mapbox-gl"],
          };

          // https://github.com/vitejs/vite/issues/5189#issuecomment-2175410148
          for (const [chunkName, patterns] of Object.entries(chunkMap)) {
            if (patterns.some((pattern) => id.includes(pattern))) {
              return chunkName;
            }
          }
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    cors: false,
    proxy: {
      "/api": backendProxyOption,
      "/s/": backendProxyOption,
      "/f/": backendProxyOption,
      "/manifest.json": backendProxyOption,
    },
  },
});
