<script lang="ts">
  import { TAG_META, type TagType } from '../lib/nbt/types';

  let { type, size = 'md' }: { type: TagType; size?: 'sm' | 'md' | 'lg' } = $props();
  const meta = $derived(TAG_META[type]);
</script>

<span class="badge {size}" style="--c: var(--t-{meta.color})" title="{meta.name} tag">{meta.short}</span>

<style>
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 17px;
    padding: 0 3px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
  }
  .sm { min-width: 18px; height: 15px; font-size: 9.5px; }
  .lg { min-width: 30px; height: 24px; font-size: 12px; padding: 0 6px; }
</style>
