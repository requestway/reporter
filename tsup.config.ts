import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node20',
  platform: 'neutral',
  sourcemap: true,
  clean: true,
  treeshake: true,
})
