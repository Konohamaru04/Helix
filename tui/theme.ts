export const colors = {
  bg: '#020617',
  fg: '#e2e8f0',
  accent: '#6366f1',
  muted: '#64748b',
  error: '#ef4444',
  success: '#22c55e',
  warning: '#f59e0b',
  dim: '#334155',
  sidebar: '#0f172a',
  input: '#1e293b',
  border: '#1e293b'
} as const;

export const tags = {
  bold: (text: string) => `{bold}${text}{/bold}`,
  accent: (text: string) => `{${colors.accent}-fg}${text}{/${colors.accent}-fg}`,
  error: (text: string) => `{${colors.error}-fg}${text}{/${colors.error}-fg}`,
  success: (text: string) => `{${colors.success}-fg}${text}{/${colors.success}-fg}`,
  muted: (text: string) => `{${colors.muted}-fg}${text}{/${colors.muted}-fg}`,
  dim: (text: string) => `{${colors.dim}-fg}${text}{/${colors.dim}-fg}`,
  warning: (text: string) => `{${colors.warning}-fg}${text}{/${colors.warning}-fg}`
};

export const screenDefaults = {
  smartCSR: true,
  fullUnicode: true,
  forceUnicode: true,
  dockBorders: true
};

export const boxStyle = {
  bg: colors.bg,
  fg: colors.fg,
  border: { bg: colors.bg, fg: colors.border },
  focus: { border: { fg: colors.accent } }
};

export const inputStyle = {
  bg: colors.input,
  fg: colors.fg,
  border: { bg: colors.input, fg: colors.border },
  focus: { border: { fg: colors.accent } }
};