import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/dashboard-read.ts', 'src/dashboard-runtime.ts'],
  format: 'esm',
  target: 'node18',
  outDir: 'dist',
  clean: false,
  dts: true,
  deps: { neverBundle: ['@temporalio/client'] },
});
