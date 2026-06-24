import esbuild from 'esbuild'

esbuild.build({
  entryPoints: ['src/client/timeline.js'],
  bundle: true,
  format: 'iife',
  outfile: 'client/timeline.js',
  sourcemap: true,
  minify: true,
}).then(() => {
  console.log('built client/timeline.js')
}).catch(() => process.exit(1))
