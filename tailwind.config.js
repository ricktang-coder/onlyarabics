/** Tailwind build config.
 *
 * Mirrors the inline `tailwind.config` that used to live in public/index.html
 * (so the self-hosted build produces the same utilities as the Play CDN did).
 */
module.exports = {
  content: ["./public/**/*.html", "./public/**/*.js"],
  theme: {
    extend: {
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      colors: {
        stone: {
          50: "#FAF8F5",
          100: "#F5F2EB",
          200: "#E7E2D6",
          300: "#D5CDBF",
          800: "#2C2A29",
          900: "#1C1917",
        },
        amber: {
          50: "#FFFBEB",
          100: "#FEF3C7",
          500: "#F59E0B",
          600: "#D97706",
        },
        emerald: {
          50: "#ECFDF5",
          500: "#10B981",
          600: "#059669",
        },
      },
    },
  },
  plugins: [],
};
