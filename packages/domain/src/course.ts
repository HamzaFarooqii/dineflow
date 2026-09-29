// Course-based kitchen firing (Ahmad's A3 work). Mirrors the check constraint on
// public.pos_products.course exactly (added by 202609210001_restaurant_foundation.sql) and its
// snapshot copy on public.kitchen_ticket_items.course (added by
// 202609290001_kitchen_operations_depth.sql) -- do not add a value here without matching
// migrations on both columns, and do not add one there without updating this file.
export type Course = 'appetizer' | 'main' | 'dessert' | 'side' | 'beverage'

export const COURSES: readonly Course[] = ['appetizer', 'main', 'dessert', 'side', 'beverage']

export const COURSE_LABELS: Record<Course, string> = {
  appetizer: 'Appetizer',
  main: 'Main',
  dessert: 'Dessert',
  side: 'Side',
  beverage: 'Beverage',
}

// Which courses fire immediately when a check closes/pays, matching today's existing behavior
// (every item goes straight to 'preparing') -- starters, sides and drinks are typically served as
// soon as they're ready regardless of the rest of the table, so they're never held back. Mains and
// dessert are the ones a course-based firing workflow actually holds until explicitly fired.
export function firesImmediately(course: Course | null): boolean {
  return course === null || course === 'appetizer' || course === 'side' || course === 'beverage'
}
