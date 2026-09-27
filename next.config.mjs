/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@huggingface/transformers",
    "onnxruntime-web",
  ],

  serverExternalPackages: [
    "@moss-dev/moss",
    "@moss-dev/moss-core",
  ],

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "onnxruntime-node": "onnxruntime-web",
        sharp: false,
      };
    }

    return config;
  },
};

export default nextConfig;