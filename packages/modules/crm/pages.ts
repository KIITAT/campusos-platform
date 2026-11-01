import type { PluginPage } from '@campusos/module-framework'
import { STAFF } from './api/core'

// Placeholder until step 7 builds the screens (the nav entry needs a page at '/').
export const pages: PluginPage[] = [{ path: '/', title: 'Sales CRM', menu: 'Pipeline', roles: [...STAFF], load: async () => ({}), sections: () => [{ kind: 'note', text: 'The sales pipeline is coming.' }] }]
