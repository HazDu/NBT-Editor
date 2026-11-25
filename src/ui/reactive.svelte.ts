import { app } from './state.svelte';
import type { Command } from './commands';

/**
 * Command `enabled()` checks read non-reactive document state, so components call this inside
 * template expressions: it touches every reactive signal that can change command availability.
 */
export function isEnabled(c: Command): boolean {
  const t = app.active;
  void app.clipboardTick;
  if (t) {
    void t.version;
    void t.focusKey;
    void t.selection;
    void t.rows;
  }
  return c.enabled ? c.enabled() : true;
}
