export interface RenderAbcOptions {
  staffwidth?: number
  responsive?: 'resize'
}

export async function renderAbc(
  target: HTMLElement,
  abc: string,
  opts: RenderAbcOptions = {},
): Promise<void> {
  const mod = await import('abcjs')
  const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
  abcjs.renderAbc(target, abc, opts)
}
