/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 内容编译产物随构建产出，不需要 next 去追踪
  outputFileTracingIncludes: {},
}

export default nextConfig
