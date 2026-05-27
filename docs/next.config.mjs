import nextra from 'nextra'

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
})

const basePath = process.env.BASE_PATH ?? ''

/** @type {import('next').NextConfig} */
export default withNextra({
  output: 'export',
  images: { unoptimized: true },
  basePath,
  assetPrefix: basePath,
  trailingSlash: true,
})
