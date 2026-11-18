import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#14202E", 2: "#22324A", 3: "#4A5A70", 4: "#7A8699" },
        paper: "#F3F5F7",
        line: { DEFAULT: "#DCE2E8", 2: "#E9EDF1" },
        signal: { DEFAULT: "#0F7B6C", 2: "#0B5F54", soft: "#E3F2EF" },
        rest: { DEFAULT: "#2D5BD3", soft: "#E8EEFC" },
        gql: { DEFAULT: "#B8326F", soft: "#FBE9F1" },
        mcp: { DEFAULT: "#6447D6", soft: "#EEEAFB" },
        warn: { DEFAULT: "#9A6212", soft: "#FBF1DF" },
        danger: { DEFAULT: "#B42318", soft: "#FCEBEA" },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", "16px"],
        xs: ["12px", "18px"],
        sm: ["13px", "20px"],
        base: ["14px", "22px"],
        lg: ["16px", "24px"],
        xl: ["20px", "28px"],
        "2xl": ["26px", "34px"],
      },
      borderRadius: { sm: "4px", DEFAULT: "6px", md: "8px", lg: "12px" },
      boxShadow: {
        pop: "0 12px 32px -12px rgba(20,32,46,0.28), 0 2px 6px -2px rgba(20,32,46,0.12)",
      },
    },
  },
  plugins: [],
} satisfies Config;
