import type { PluginPage } from '@campusos/module-framework'
import { ADMIN, MEMBERS, listAssignments, listRoutes, listStops, listVehicles } from './api'
import { field, form, people, pick, screen, table } from './ui'

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Transport assignments', menu: 'Assignments', roles: MEMBERS,
    load: async actor => {
      const office = ADMIN.includes(actor.role)
      const [assignments, routes, stops, identities] = await Promise.all([listAssignments(actor), listRoutes(actor), listStops(actor), office ? people(actor) : []])
      return {
        office, assignments,
        routeOptions: routes.map(row => ({ value: row.id, label: `${row.name} · ${row.registration} · ${row.capacity} seats` })),
        stopOptions: stops.map(row => ({ value: row.id, label: `${routes.find(route => route.id === row.routeId)?.name} · ${row.position}. ${row.name}` })),
        studentOptions: identities.filter(row => row.role === 'student').map(row => ({ value: row.id, label: `${row.name} · ${row.email}` })),
        assignmentOptions: assignments.filter(row => row.status === 'active').map(row => ({ value: row.id, label: `${row.student} · ${row.route} · ${row.stop}` })),
      }
    },
    sections: data => [
      table(data.office ? 'Student transport' : 'My transport', 'assignments', [{ key: 'student', label: 'Student' }, { key: 'route', label: 'Route' }, { key: 'stop', label: 'Stop' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'releaseReason', label: 'Release reason' }]),
      ...(data.office ? [
        { kind: 'shortcuts' as const, items: [{ label: 'Routes and stops', href: '/m/transport/routes' }, { label: 'Vehicles', href: '/m/transport/vehicles' }] },
        form('Assign transport', '/assignments', [pick('studentId', 'Student', 'studentOptions'), pick('routeId', 'Route', 'routeOptions'), pick('stopId', 'Stop on this route', 'stopOptions')]),
        form('Release seat', '/assignments/release', [pick('assignmentId', 'Active assignment', 'assignmentOptions'), field('reason', 'Release reason', 'textarea')]),
      ] : []),
    ],
  }),
  screen({
    path: '/routes', title: 'Routes and stops', menu: 'Routes', roles: ADMIN,
    load: async actor => {
      const [routes, stops, vehicles] = await Promise.all([listRoutes(actor), listStops(actor), listVehicles(actor)])
      return {
        routes, stops: stops.map(row => ({ ...row, route: routes.find(route => route.id === row.routeId)?.name })),
        routeOptions: routes.map(row => ({ value: row.id, label: row.name })),
        vehicleOptions: vehicles.filter(row => !routes.some(route => route.vehicleId === row.id)).map(row => ({ value: row.id, label: `${row.registration} · ${row.capacity} seats` })),
      }
    },
    sections: () => [
      { kind: 'note', text: 'One vehicle serves one route. Seats are allocated against that vehicle’s capacity. Select a stop belonging to the chosen route.' },
      table('Routes', 'routes', [{ key: 'name', label: 'Route' }, { key: 'registration', label: 'Vehicle' }, { key: 'capacity', label: 'Seats' }]),
      table('Stops', 'stops', [{ key: 'route', label: 'Route' }, { key: 'position', label: 'Order' }, { key: 'name', label: 'Stop' }]),
      form('Create route', '/routes', [field('name', 'Route name'), pick('vehicleId', 'Unassigned vehicle', 'vehicleOptions')]),
      form('Add stop', '/stops', [pick('routeId', 'Route', 'routeOptions'), field('name', 'Stop name'), field('position', 'Stop order', 'number')]),
    ],
  }),
  screen({
    path: '/vehicles', title: 'Transport vehicles', menu: 'Vehicles', roles: ADMIN,
    load: async actor => ({ vehicles: await listVehicles(actor) }),
    sections: () => [
      table('Vehicles', 'vehicles', [{ key: 'registration', label: 'Registration' }, { key: 'capacity', label: 'Seating capacity' }]),
      form('Register vehicle', '/vehicles', [field('registration', 'Registration number'), field('capacity', 'Seating capacity', 'number')]),
    ],
  }),
]
