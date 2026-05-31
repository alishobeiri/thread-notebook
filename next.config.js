/** @type {import('next').NextConfig} */
const nextConfig = {
	basePath: "/thread-notebook",
	assetPrefix: process.env.NODE_ENV === "production" ? "/thread-notebook/" : "",
	output: "export",
	images: {
		unoptimized: true,
	},
	reactStrictMode: false,
	// @jupyter-widgets/base ships untranspiled ESM and must be compiled by Next.
	// Turbopack (default in Next 16) handles this natively via transpilePackages,
	// replacing the old next-transpile-modules + custom webpack config.
	transpilePackages: ["@jupyter-widgets/base"],
};

module.exports = nextConfig;
