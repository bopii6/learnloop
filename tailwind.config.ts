import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#0F6E56",
          soft: "#E1F5EE",
          border: "#5DCAA5",
        },
        ink: {
          DEFAULT: "#1a1a18",
          soft: "#5F5E5A",
          faint: "#888780",
        },
        paper: "#FAFAF7",
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
