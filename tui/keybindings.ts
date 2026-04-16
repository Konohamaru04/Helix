export const keybindings = {
  submit: 'enter',
  newLine: 'C-enter',
  newConversation: 'C-n',
  switchWorkspace: 'C-w',
  listConversations: 'C-l',
  toggleSidebar: 'tab',
  cancelStream: 'C-c',
  quit: 'C-q',
  screenChat: '1',
  screenWorkspace: '2',
  screenGeneration: '3',
  screenCapabilities: '4',
  scrollUp: 'up',
  scrollDown: 'down',
  pageUp: 'pageup',
  pageDown: 'pagedown'
} as const;

export type KeyAction = keyof typeof keybindings;

export function describeKey(action: KeyAction): string {
  const labels: Record<KeyAction, string> = {
    submit: 'Enter',
    newLine: 'Ctrl+Enter',
    newConversation: 'Ctrl+N',
    switchWorkspace: 'Ctrl+W',
    listConversations: 'Ctrl+L',
    toggleSidebar: 'Tab',
    cancelStream: 'Ctrl+C',
    quit: 'Ctrl+Q',
    screenChat: '1',
    screenWorkspace: '2',
    screenGeneration: '3',
    screenCapabilities: '4',
    scrollUp: 'Up',
    scrollDown: 'Down',
    pageUp: 'PageUp',
    pageDown: 'PageDown'
  };
  return labels[action];
}