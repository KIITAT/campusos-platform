import type { Role } from '@campusos/module-framework'

export const OFFICE: Role[] = ['institution_admin', 'super_admin', 'accounts_staff']
export const ADMIN: Role[] = ['institution_admin', 'super_admin']
export const STAFF: Role[] = [...OFFICE, 'hod', 'faculty', 'library_staff', 'hostel_staff']
