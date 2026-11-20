import { sql, type SQL } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/** The Parents module owns the guardian function; without it nobody is inferred as a parent. */
export async function guardiansAvailable(tx: Tx): Promise<boolean> {
  const rows = (await tx.execute(sql`select to_regprocedure('public.campusos_guardians_of(text[])') is not null as ok`)).rows as { ok: boolean }[]
  return rows[0]?.ok === true
}

/**
 * Everybody a department's notices can reach, as a set of user ids (D927).
 *
 * A student belongs through every active declaration already effective today
 * (Kolkata), or through a section of the department's programmes if they have
 * never had a declaration. A head, a class teacher of the department's
 * sections and the faculty of its courses this term are its staff. Parents come
 * through verified guardian links to those students, when the function exists.
 * Erased accounts are left out. Role audience is intersected by the caller.
 *
 * `department` is a column or a bound uuid, so the same set serves delivery (one
 * insert-select) and the readers' checks (correlated to a notice's department).
 */
export function departmentRecipientsSql(tenant: string, department: SQL, withGuardians: boolean): SQL {
  const today = sql`(now() at time zone 'Asia/Kolkata')::date`
  const guardians = withGuardians
    ? sql`
      union
      select g.guardian_id from public.campusos_guardians_of(array(select user_id from department_students)) g
        join users u on u.id = g.guardian_id and u.institution_id = ${tenant} and u.role = 'parent' and u.erased_at is null`
    : sql``
  return sql`
    with target as (
      select d.id, d.hod_user_id from academic_departments d
       where d.institution_id = ${tenant} and d.id = ${department}
    ), dept_programmes as (
      select p.id from academic_programs p
       where p.institution_id = ${tenant} and p.department_id in (select id from target)
    ), department_students(user_id) as (
      select sp.student_id from academic_student_programs sp
        join users u on u.id = sp.student_id and u.institution_id = ${tenant} and u.role = 'student' and u.erased_at is null
       where sp.institution_id = ${tenant} and sp.program_id in (select id from dept_programmes)
         and sp.status = 'active' and sp.declared_on <= ${today}
      union
      select m.user_id from academic_sections s
        join academic_section_members m on m.section_id = s.id and m.institution_id = ${tenant}
        join users u on u.id = m.user_id and u.institution_id = ${tenant} and u.role = 'student' and u.erased_at is null
       where s.institution_id = ${tenant} and s.program_id in (select id from dept_programmes)
         and not exists (select 1 from academic_student_programs x where x.institution_id = ${tenant} and x.student_id = m.user_id)
    ), department_staff(user_id) as (
      select u.id from target t
        join users u on u.id = t.hod_user_id and u.institution_id = ${tenant} and u.role = 'hod' and u.erased_at is null
      union
      select u.id from academic_sections s
        join users u on u.id = s.class_teacher_id and u.institution_id = ${tenant} and u.role in ('hod', 'faculty') and u.erased_at is null
       where s.institution_id = ${tenant} and s.program_id in (select id from dept_programmes)
      union
      select u.id from academic_offerings o
        join academic_courses c on c.id = o.course_id and c.institution_id = ${tenant} and c.department_id in (select id from target)
        join academic_terms te on te.id = o.term_id and te.institution_id = ${tenant} and ${today} between te.starts_on and te.ends_on
        join users u on u.id = o.faculty_user_id and u.institution_id = ${tenant} and u.role in ('hod', 'faculty') and u.erased_at is null
       where o.institution_id = ${tenant}
    )
    select user_id from department_students
    union
    select user_id from department_staff${guardians}`
}

/**
 * The departments, among those with a notice, whose audience includes this
 * person today. Evaluated once per request with the same audience query that
 * delivers, then handed to the board and inbox as a plain list: a per-row
 * correlated copy of the audience query makes the planner's cost estimate high
 * enough for the server to JIT-compile every board page (5 s at 100,000 notices).
 */
export async function memberDepartments(tx: Tx, tenant: string, userId: string): Promise<string[]> {
  const withGuardians = await guardiansAvailable(tx)
  const rows = (await tx.execute(sql`
    select dep.id from academic_departments dep
     where dep.institution_id = ${tenant}
       and exists (select 1 from notices n where n.department_id = dep.id)
       and ${userId} in (${departmentRecipientsSql(tenant, sql`dep.id`, withGuardians)})`)).rows as { id: string }[]
  return rows.map((r) => r.id)
}
