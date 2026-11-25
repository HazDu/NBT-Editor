<script lang="ts">
  import { ICONS } from './icons';

  let { name, size = 18, fill = false, class: cls = '', title }: {
    name: string; size?: number; fill?: boolean; class?: string; title?: string;
  } = $props();

  const d = $derived(ICONS[fill ? `${name}-fill` : name] ?? ICONS[name] ?? '');
</script>

<svg
  class="icon {cls}"
  width={size}
  height={size}
  viewBox="0 -960 960 960"
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
>
  {#if title}<title>{title}</title>{/if}
  <path {d} />
</svg>

<style>
  .icon {
    flex: none;
    fill: currentColor;
    display: inline-block;
    vertical-align: middle;
  }
</style>
