/** @type {import('tailwindcss').Config} */
// Every color token below resolves to a CSS custom property defined in
// src/webview/sidebar.css (the --rig-* scale), which in turn derives from
// VS Code's own semantic theme variables (--vscode-*). Nothing here is a
// hardcoded hex value, so the sidebar automatically follows whatever theme
// (dark, light, or high-contrast) is active in the editor — see the
// "Theme support" section of README.md.
module.exports = {
  content: ["./src/**/*.ts", "./src/**/*.tsx", "./src/**/*.html"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--rig-bg)",
        surface: "var(--rig-surface)",
        "surface-container": "var(--rig-surface-container)",
        "surface-container-low": "var(--rig-surface-container-low)",
        "surface-container-lowest": "var(--rig-surface-container-lowest)",
        "surface-container-high": "var(--rig-surface-container-high)",
        "surface-container-highest": "var(--rig-surface-container-highest)",
        "on-surface": "var(--rig-fg)",
        "on-surface-variant": "var(--rig-fg-muted)",
        outline: "var(--rig-border)",
        "outline-variant": "var(--rig-border)",
        "outline-strong": "var(--rig-border-strong)",
        primary: "var(--rig-primary)",
        "on-primary": "var(--rig-on-primary)",
        "primary-container": "var(--rig-primary-container)",
        "on-primary-container": "var(--rig-primary)",
        error: "var(--rig-error)",
        "on-error": "var(--rig-button-fg)",
        "error-container": "var(--rig-error-bg)",
        "on-error-container": "var(--rig-error)",
        tertiary: "var(--rig-warning)",
        "on-tertiary": "var(--rig-button-fg)",
        "tertiary-container": "var(--rig-warning-bg)",
        "on-tertiary-container": "var(--rig-warning)",
        success: "var(--rig-success)",
        "success-container": "var(--rig-success-bg)",
        "on-success-container": "var(--rig-success)",
        "input-bg": "var(--rig-input-bg)",
        "input-fg": "var(--rig-input-fg)",
        "input-border": "var(--rig-input-border)",
        chip: "var(--rig-chip-bg)",
      },
      borderRadius: {
        DEFAULT: "2px",
        lg: "4px",
        xl: "6px",
        full: "9999px",
      },
      spacing: {
        "sidebar-padding": "9px",
        lg: "9px",
        sm: "8px",
        unit: "4px",
        xs: "4px",
        gutter: "10px",
        md: "8px",
      },
      fontFamily: {
        "label-caps": ["var(--vscode-font-family)"],
        "headline-md": ["var(--vscode-font-family)"],
        "body-bold": ["var(--vscode-font-family)"],
        "body-base": ["var(--vscode-font-family)"],
        "code-mono": ["var(--vscode-editor-font-family)", "monospace"],
        "headline-lg": ["var(--vscode-font-family)"],
      },
      fontSize: {
        "label-caps": ["10px", { lineHeight: "14px", letterSpacing: "0.06em", fontWeight: "700" }],
        "headline-md": ["14px", { lineHeight: "20px", fontWeight: "600" }],
        "body-bold": ["13px", { lineHeight: "18px", fontWeight: "600" }],
        "body-base": ["12px", { lineHeight: "17px", fontWeight: "400" }],
        "code-mono": ["11px", { lineHeight: "16px", fontWeight: "400" }],
        "headline-lg": ["16px", { lineHeight: "22px", letterSpacing: "-0.01em", fontWeight: "600" }],
      },
    },
  },
  plugins: [],
};
