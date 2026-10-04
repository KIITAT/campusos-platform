import type { PluginPage } from '@campusos/module-framework'
import { classesPage } from './screens/classes'
import { setupPages } from './screens/setup'
import { timetablePages } from './screens/timetables'

export const pages: PluginPage[] = [timetablePages[0]!, ...setupPages, classesPage, ...timetablePages.slice(1)]
