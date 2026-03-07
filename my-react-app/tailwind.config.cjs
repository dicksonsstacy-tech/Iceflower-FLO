/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        mauve: {
          50: '#fbf7ff',
          100: '#f6effa',
          200: '#eed8f5',
          300: '#e4bff0',
          400: '#d597ea',
          500: '#c46be8',
          600: '#9b45d6',
          700: '#7630a8',
          800: '#4f1f77',
          900: '#2b0f44',
        },
      },
    },
  },
  plugins: [],
}
