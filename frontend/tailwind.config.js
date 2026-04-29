/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#ecfeff",
          100: "#cffafe",
          200: "#a5f3fc",
          300: "#67e8f9",
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
          700: "#0e7490",
          800: "#155e75",
          900: "#164e63",
        },
        accent: {
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
        },
        ink: {
          900: "#020617",
          800: "#0b1220",
          700: "#0f172a",
        },
      },
      boxShadow: {
        glow:    "0 0 0 1px rgba(34,211,238,0.18), 0 12px 36px -10px rgba(34,211,238,0.30)",
        glowLg:  "0 0 0 1px rgba(34,211,238,0.20), 0 30px 80px -20px rgba(34,211,238,0.45)",
        inner1:  "inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(0,0,0,0.4)",
        soft:    "0 1px 0 rgba(255,255,255,0.04), 0 8px 28px -10px rgba(2,6,23,0.6)",
      },
      backgroundImage: {
        "grid-fade": "linear-gradient(to bottom, rgba(2,6,23,0) 0%, rgba(2,6,23,1) 90%)",
      },
      keyframes: {
        fadeIn:    { "0%": { opacity: 0, transform: "translateY(4px)" }, "100%": { opacity: 1, transform: "translateY(0)" } },
        slideUp:   { "0%": { opacity: 0, transform: "translateY(10px)" }, "100%": { opacity: 1, transform: "translateY(0)" } },
        shimmer:   { "0%": { backgroundPosition: "-400px 0" }, "100%": { backgroundPosition: "400px 0" } },
        pulseDot:  { "0%,100%": { boxShadow: "0 0 0 0 rgba(34,211,238,0.55)" }, "70%": { boxShadow: "0 0 0 8px rgba(34,211,238,0)" } },
        floatSlow: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-3px)" } },
      },
      animation: {
        "fade-in":   "fadeIn .35s ease-out both",
        "slide-up":  "slideUp .45s cubic-bezier(.2,.7,.2,1) both",
        "shimmer":   "shimmer 1.6s linear infinite",
        "pulse-dot": "pulseDot 1.8s ease-out infinite",
        "float-slow":"floatSlow 4.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
