import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const buildVersion = process.env.UNKEEP_BUILD_VERSION?.trim() || 'dev';
const buildRevision = process.env.UNKEEP_BUILD_REVISION?.trim() || 'unknown';
const releaseRevision = /^[0-9a-f]{40}$/.test(buildRevision);

if (buildRevision !== 'unknown' && !releaseRevision) {
  throw new Error('UNKEEP_BUILD_REVISION must be "unknown" or a lowercase 40-character Git commit');
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: 'index.html'
    }),
    csp: {
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'base-uri': ['none'],
        'connect-src': ['self', 'https:'],
        'font-src': ['self'],
        'form-action': ['none'],
        'img-src': ['self', 'data:', 'blob:'],
        'object-src': ['none'],
        'script-src': ['self'],
        'script-src-attr': ['none'],
        // Svelte components use a small number of deliberate style
        // attributes for note colours and safe-area layout.
        'style-src': ['self', 'unsafe-inline']
      }
    },
    // SvelteKit otherwise uses the build timestamp. Release containers bind the
    // service-worker cache identity to the immutable version and source commit;
    // ordinary local builds use one explicit non-release cache namespace.
    version: {
      name: releaseRevision ? `${buildVersion}-${buildRevision}` : 'dev'
    },
    alias: {
      '$lib': './src/lib',
      '$lib/*': './src/lib/*'
    }
  }
};

export default config;
