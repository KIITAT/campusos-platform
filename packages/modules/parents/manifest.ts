import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'parents',
  name: 'Parent Portal',
  description:
    'A read-only lens for parents across whichever modules an institution has enabled: attendance, results, fees, library and hostel. Owns the verified parent-student link and which child a guardian invitation is for; every figure it shows is read through the owning module.',
  version: '0.2.1',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  // Everything the portal shows degrades: a section simply does not appear.
  softDependsOn: ['attendance', 'examinations', 'fees', 'library', 'hostel'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'parent'],

  navEntries: [
    { label: 'My children', href: '/m/parents', roles: ['parent'] },
    { label: 'Parent links', href: '/m/parents/links', roles: ['institution_admin', 'super_admin'] },
    { label: 'Guardians', href: '/m/parents/guardians', roles: ['institution_admin', 'super_admin'] },
  ],

  apiBasePath: '/api/v1/modules/parents',
}
