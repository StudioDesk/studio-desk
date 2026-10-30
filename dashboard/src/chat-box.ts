// The chat box preview: a switch kept in this browser, off until turned on. With it on, New idea opens a chat box
// beside the page; with it off, New idea works as it always has. Nothing about it is sent to the controller.
import { useSyncExternalStore } from 'react';

export const chatBoxKey = 'studio-chat-box';

// Off unless this browser's storage says on, and off when the browser keeps no storage.
export function chatBoxOn(): boolean {
  try {
    return localStorage.getItem(chatBoxKey) === 'on';
  } catch {
    return false;
  }
}

const readers = new Set<() => void>();

export function setChatBox(on: boolean) {
  try {
    if (on) localStorage.setItem(chatBoxKey, 'on');
    else localStorage.removeItem(chatBoxKey);
  } catch {
    // Without browser storage the switch stays off.
  }
  for (const changed of readers) changed();
}

// A change in this page reaches every mounted reader at once; a change in another tab arrives as a storage event.
function watch(changed: () => void) {
  readers.add(changed);
  const stored = (event: StorageEvent) => {
    if (event.key === chatBoxKey || event.key === null) changed();
  };
  window.addEventListener('storage', stored);
  return () => {
    readers.delete(changed);
    window.removeEventListener('storage', stored);
  };
}

export function useChatBox() {
  return useSyncExternalStore(watch, chatBoxOn);
}
