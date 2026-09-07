/** @type {import('next').NextConfig} */
const nextConfig = {
  // 原生/动态加载的包不能进 webpack 打包：OCR 的本地渲染（原生二进制）与 tesseract worker
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js"],
};

export default nextConfig;
