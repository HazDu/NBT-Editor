<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from './state.svelte';

  const ICON = { info: 'info', ok: 'check_circle', error: 'error', warn: 'warning' } as const;
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={ICON[t.kind]} size={18} fill />
      <span class="text">{t.text}</span>
      {#if t.action}<button class="btn ghost" onclick={() => { t.action!.run(); app.dismiss(t.id); }}>{t.action.label}</button>{/if}
      <button class="x" aria-label="Dismiss" onclick={() => app.dismiss(t.id)}><Icon name="close" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 14px;
    bottom: 34px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: min(440px, calc(100vw - 28px));
  }
  .toast {
    --c: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--c);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    animation: in 0.15s ease-out;
  }
  .toast > :global(.icon) {
    color: var(--c);
  }
  .ok { --c: var(--ok); }
  .error { --c: var(--danger); }
  .warn { --c: var(--warn); }
  .info { --c: var(--t-int); }
  .text {
    flex: 1;
  }
  .x {
    border: 0;
    background: none;
    color: var(--muted);
    display: inline-flex;
    padding: 2px;
  }
  @keyframes in {
    from {
      transform: translateY(6px);
      opacity: 0;
    }
  }
</style>
