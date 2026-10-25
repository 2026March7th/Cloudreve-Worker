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
            // MUI + Emotion 是首屏就要用、但很少变动的代码。单独切出来后，
            // 每次部署变的只有应用自己的 chunk，老用户复访直接从浏览器缓存
            // 命中这两块（合计约两百 KB brotli），不用跟着主包重下一次。
            // ⚠️ 必须排在下面的 `react` 之前：那段是 id.includes("node_modules/react")，
            // 会连带匹配 react-router / react-redux / react-i18next，顺序反了就被吞掉。
            mui: ["node_modules/@mui"],
            emotion: ["node_modules/@emotion"],
            i18n: ["node_modules/i18next", "node_modules/react-i18next"],
            redux: ["node_modules/redux", "node_modules/react-redux", "node_modules/@reduxjs"],
            router: ["node_modules/react-router", "node_modules/@remix-run"],
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
